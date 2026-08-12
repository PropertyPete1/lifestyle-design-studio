/**
 * Manual-Assist Delivery — BULLETPROOF edition
 * 
 * Uploads finished video to "Ready to Post" Drive folder and notifies owner
 * via TWO independent channels:
 *   1. Dashboard webhook (push notification)
 *   2. Email backup (Gmail API via same Google OAuth token)
 * 
 * Each channel retries 3x with exponential backoff.
 * If BOTH channels fail: writes a manifest file to Drive and throws
 * (caller exits workflow red → GitHub sends email alert).
 * 
 * CRITICAL: No auto-publish fallback. Main IG is NEVER posted via Metricool.
 * Video stays in "Ready to Post" until owner posts or hits Skip — never auto-deleted.
 */

import { readFileSync, statSync } from "fs";
import { basename } from "path";

const READY_TO_POST_FOLDER_NAME = "Ready to Post";
const OWNER_EMAIL = "peter@lifestyledesignrealty.com";
const MAX_RETRIES = 3;
/**
 * 2s, 4s, 8s in production.
 *
 * Overridable so the tests that exercise a channel failing all three attempts
 * do not spend fourteen real seconds each doing it. Never set in any workflow —
 * a retry that does not wait is not a retry.
 */
const BACKOFF_BASE_MS = Number(process.env.DELIVERY_BACKOFF_BASE_MS) || 2000;

let readyToPostFolderId = null;

/**
 * Sleep helper for backoff
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Retry wrapper with exponential backoff.
 * Returns { ok: true, result } or { ok: false, lastError }
 */
async function withRetry(label, fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { ok: true, result };
    } catch (err) {
      lastError = err;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[Delivery] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`[Delivery] Retrying ${label} in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }
  return { ok: false, lastError };
}

/**
 * Drive's public thumbnail endpoint for a file.
 *
 * Verified serving image/png to an unauthenticated request for carousel slides.
 * A /file/d/<id>/view link does NOT — that is an HTML viewer page.
 */
export function driveThumbnailUrl(fileId, width = 800) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${width}`;
}

/**
 * Grant link-view access to one Drive file.
 *
 * Only ever called on files this flow just uploaded — finished social content
 * that is about to be posted publicly anyway. Nothing else in Drive is touched.
 *
 * The response is checked. It previously was not, so a failure here would have
 * been silent and the first symptom would have been thumbnails mysteriously
 * not rendering somewhere downstream.
 */
async function grantLinkViewAccess(accessToken, fileId, label = "") {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.log(
      `::warning::[Delivery] could not grant link-view access to ${label || fileId} ` +
      `(${res.status}) — dashboard thumbnails will not load for it. ${err.slice(0, 200)}`
    );
    return false;
  }
  return true;
}

/**
 * Get or create the "Ready to Post" folder in Google Drive root.
 */
async function getOrCreateFolder(accessToken) {
  if (readyToPostFolderId) return readyToPostFolderId;

  // Search for existing folder
  const searchParams = new URLSearchParams({
    q: `name='${READY_TO_POST_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
  });

  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?${searchParams}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.files && data.files.length > 0) {
      readyToPostFolderId = data.files[0].id;
      console.log(`[Delivery] Found existing "Ready to Post" folder: ${readyToPostFolderId}`);
      return readyToPostFolderId;
    }
  }

  // Create the folder
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: READY_TO_POST_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create Ready to Post folder: ${createRes.status} ${err}`);
  }

  const folder = await createRes.json();
  readyToPostFolderId = folder.id;
  console.log(`[Delivery] Created "Ready to Post" folder: ${readyToPostFolderId}`);

  // Make it accessible via link (anyone with link can view)
  await fetch(`https://www.googleapis.com/drive/v3/files/${readyToPostFolderId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });

  return readyToPostFolderId;
}

/**
 * Upload the finished video to the "Ready to Post" folder (with 3x retry).
 * Returns { fileId, fileName, webViewLink, directLink }
 */
async function uploadToReadyFolder(accessToken, videoPath, city, mimeType = "video/mp4") {
  const folderId = await getOrCreateFolder(accessToken);
  const fileName = `${city.toUpperCase()}_${new Date().toISOString().slice(0, 10)}_${basename(videoPath)}`;
  const fileSize = statSync(videoPath).size;
  const fileBuffer = readFileSync(videoPath);

  console.log(`[Delivery] Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB) to Ready to Post...`);

  const uploadResult = await withRetry("Drive upload", async () => {
    // Resumable upload for large files
    const initRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Length": String(fileSize),
          "X-Upload-Content-Type": mimeType,
        },
        body: JSON.stringify({
          name: fileName,
          parents: [folderId],
          mimeType,
        }),
      }
    );

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`Drive resumable upload init failed: ${initRes.status} ${err}`);
    }

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) throw new Error("No upload URL returned from Drive");

    // Upload the file content
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": mimeType,
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Drive upload failed: ${uploadRes.status} ${err}`);
    }

    return uploadRes.json();
  });

  if (!uploadResult.ok) {
    throw new Error(`Drive upload failed after ${MAX_RETRIES} attempts: ${uploadResult.lastError.message}`);
  }

  const file = uploadResult.result;
  const fileId = file.id;

  // Readable by anyone with the link: required for the dashboard to render a
  // thumbnail, and these are public social assets by design.
  await grantLinkViewAccess(accessToken, fileId, fileName);

  const webViewLink = `https://drive.google.com/file/d/${fileId}/view`;
  const directLink = `https://drive.google.com/uc?export=download&id=${fileId}`;

  console.log(`[Delivery] ✓ Uploaded to Drive: ${webViewLink}`);
  return { fileId, fileName, webViewLink, directLink };
}

// ─── CHANNEL 1: Dashboard Webhook ────────────────────────────────────────────

/**
 * Notify the dashboard to create a delivery record and push notification to owner.
 * Retries 3x with exponential backoff.
 */
async function notifyDashboard(deliveryData) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  const dashboardSecret = process.env.DASHBOARD_WEBHOOK_SECRET;

  if (!dashboardUrl || !dashboardSecret) {
    console.warn("[Delivery] DASHBOARD_URL or DASHBOARD_WEBHOOK_SECRET not set — channel 1 unavailable");
    return { ok: false, lastError: new Error("Dashboard env vars not configured") };
  }

  return withRetry("Dashboard webhook", async () => {
    const res = await fetch(`${dashboardUrl}/api/delivery/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": dashboardSecret,
      },
      body: JSON.stringify(deliveryData),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Dashboard returned ${res.status}: ${err}`);
    }

    console.log("[Delivery] ✓ Channel 1 (Dashboard) — owner notified via push");
    return true;
  });
}
// ─── TRIAL VARIANT WEBHOOK ─────────────────────────────────────────────────

async function notifyTrialDashboard(trialData) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  const dashboardSecret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (!dashboardUrl || !dashboardSecret) {
    console.warn("[Delivery] DASHBOARD_URL or DASHBOARD_WEBHOOK_SECRET not set — trial webhook unavailable");
    return { ok: false, lastError: new Error("Dashboard env vars not configured") };
  }
  return withRetry("Trial dashboard webhook", async () => {
    const res = await fetch(`${dashboardUrl}/api/delivery/trial-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": dashboardSecret,
      },
      body: JSON.stringify(trialData),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Trial dashboard returned ${res.status}: ${err}`);
    }
    console.log("[Delivery] ✓ Trial webhook — owner notified via push");
    return true;
  });
}
// ─── CHANNEL 2: Email Backup ─────────────────────────────────────────────────

/**
 * Send email via Gmail API (uses the same Google OAuth token as Drive).
 * The token scope is drive.readonly, so we use a simple SMTP-free approach:
 * Gmail API requires gmail.send scope. Since we only have drive scope,
 * we use the Google Apps Script web app as a relay, OR we fall back to
 * a simple fetch to a Gmail-compatible endpoint.
 * 
 * Actually: we'll use the Gmail API with the same OAuth token. If the token
 * doesn't have gmail.send scope, this will fail gracefully and the dashboard
 * channel is the primary. The email is the BACKUP.
 * 
 * Fallback strategy: Use Gmail API if scope allows, otherwise use the
 * Manus notification API from the dashboard as the email relay.
 */
/**
 * Send one plain-text email to the owner over the Gmail API.
 *
 * Split out of sendEmailBackup so the approval channel can send a message that
 * is not shaped like a reel delivery. Only the Gmail half is shared — the
 * dashboard email-relay fallback below it takes a fixed delivery payload that
 * the dashboard defines, so it stays where it is.
 */
/**
 * Subject-line prefixes, so twenty automated emails a day are scannable.
 *
 * Peter's inbox takes clock-in and clock-out mails for six agents, health
 * reports, lead alerts and delivery notices. A held-back script landed in that
 * stream twice and was never seen, because nothing about it looked different
 * from the rest. A prefix is the cheapest thing that makes a class filterable.
 */
export const MAIL_PREFIX = {
  REELS: "[REELS]",
  CAROUSEL: "[CAROUSEL]",
  YT: "[YT PIPELINE]",
  /**
   * The manual edit queue — a video Peter dropped in "Videos To Edit".
   *
   * Its own prefix rather than REELS, because REELS marks the daily delivery he
   * skims and this mail is the opposite: it is either asking him to press
   * something or telling him a render died. Filing it with the routine is how
   * it would stop being read, which is the failure MAIL_PREFIX exists for.
   */
  EDIT: "[EDIT QUEUE]",
  /**
   * Something broke and nobody is coming unless Peter does.
   *
   * Deliberately NOT one of the above: the reels and carousel prefixes mark mail
   * he expects daily and skims past, which is exactly how a fortnight of failed
   * trial runs went unread. An alert has to look unlike the routine.
   */
  ALERT: "[DAILY ALERT]",
};

/**
 * Marks an artifact produced by a test run so real surfaces can filter it out.
 *
 * Same literal the YouTube approvals path uses for `TEST-` request ids. It is
 * duplicated rather than imported because that module belongs to the long-form
 * pipeline, and a delivery-time constant should not drag it into every trial and
 * city run.
 */
export const TEST_PREFIX = "TEST-";

/** True for any artifact name carrying the test marker. */
export function isTestArtifact(name) {
  return String(name ?? "").startsWith(TEST_PREFIX);
}

/**
 * RFC 2047 encoded-word for a MIME header.
 *
 * A header is ASCII-only by RFC 5322. `Subject: ${subject}` wrote raw UTF-8
 * bytes into one, so every em dash arrived as "Ã¢Â€Â”" — on the brief, on the
 * delivery notices, on everything this system sends. A subject that looks like
 * mojibake reads as spam, which is the exact opposite of what a notification
 * needs to do.
 *
 * Pure-ASCII subjects are left untouched, so nothing that already worked
 * changes. Anything else is base64 encoded-word, FOLDED: an encoded-word may
 * not exceed 75 characters, so the bytes are chunked to fit — and chunked on
 * UTF-8 character boundaries, because splitting a multi-byte sequence across
 * two encoded-words produces a different flavour of the same mojibake.
 */
export function encodeSubject(subject) {
  const s = String(subject ?? "");
  if (!s) return "";
  // Printable ASCII only — no encoding needed, and no reason to obscure it.
  if (/^[\x20-\x7E]*$/.test(s)) return s;

  // 75 char limit - "=?UTF-8?B?" (10) - "?=" (2) = 63 for base64, and base64
  // length is a multiple of 4, so 60 chars => 45 bytes of input per word.
  const MAX_BYTES = 45;
  const words = [];
  let chunk = [];
  let size = 0;
  for (const ch of s) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (size + bytes > MAX_BYTES) {
      words.push(Buffer.from(chunk.join(""), "utf8").toString("base64"));
      chunk = [];
      size = 0;
    }
    chunk.push(ch);
    size += bytes;
  }
  if (chunk.length) words.push(Buffer.from(chunk.join(""), "utf8").toString("base64"));

  // Continuation lines are folded with CRLF + a space, per RFC 5322.
  return words.map((w) => `=?UTF-8?B?${w}?=`).join("\r\n ");
}

/**
 * Exported as `sendOwnerEmail` for daily-notify.js, which needs to send a
 * message that is neither a delivery nor an approval. Kept as one function so
 * there is exactly one place that knows how to put mail in Peter's inbox.
 */
export { sendOwnerEmailViaGmail as sendOwnerEmail };

async function sendOwnerEmailViaGmail(accessToken, { subject, body, prefix = null }) {
  const labelled = prefix ? `${prefix} ${subject}` : subject;
  const rawEmail = [
    `To: ${OWNER_EMAIL}`,
    `Subject: ${encodeSubject(labelled)}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join("\r\n");

  const encodedEmail = Buffer.from(rawEmail).toString("base64url");

  return withRetry("Email (Gmail API)", async () => {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedEmail }),
    });

    if (!res.ok) {
      const err = await res.text();
      // 403 = insufficient scope, 401 = token issue
      throw new Error(`Gmail API ${res.status}: ${err}`);
    }

    console.log("[Delivery] ✓ Email sent via Gmail API");
    return true;
  });
}

async function sendEmailBackup(accessToken, { city, caption, driveLink, fileName }) {
  // Try Gmail API first (requires gmail.send scope on the token)
  // "carousel" comes through this same path as a pseudo-city, so the class is
  // read off it rather than plumbed through a second argument.
  const prefix = String(city).toLowerCase() === "carousel" ? MAIL_PREFIX.CAROUSEL : MAIL_PREFIX.REELS;
  const subject = `Ready to Post: ${city.toUpperCase()} reel - ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" })}`;
  const body = [
    `Your ${city.replace("_", " ")} reel is ready to post natively on Instagram.`,
    ``,
    `📁 Video: ${driveLink}`,
    `📄 File: ${fileName}`,
    ``,
    `━━━ Caption (copy & paste) ━━━`,
    ``,
    caption,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Post this natively on @lifestyledesignrealtytexas for maximum reach.`,
    `The video will stay in "Ready to Post" until you confirm via the dashboard.`,
    ``,
    `— Lifestyle Design Studio Auto-Poster`,
  ].join("\n");

  const gmailResult = await sendOwnerEmailViaGmail(accessToken, { subject, body, prefix });
  if (gmailResult.ok) return gmailResult;

  // Fallback: try dashboard's notification endpoint (it can send push/email)
  const dashboardUrl = process.env.DASHBOARD_URL;
  const dashboardSecret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (dashboardUrl && dashboardSecret) {
    return withRetry("Email (Dashboard relay)", async () => {
      const res = await fetch(`${dashboardUrl}/api/delivery/email-backup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": dashboardSecret,
        },
        body: JSON.stringify({ city, caption, driveLink, fileName, ownerEmail: OWNER_EMAIL }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Dashboard email relay ${res.status}: ${err}`);
      }

      console.log("[Delivery] ✓ Channel 2 (Email via Dashboard) — backup email sent");
      return true;
    });
  }

  return { ok: false, lastError: new Error("No email channel available (Gmail scope missing + no dashboard relay)") };
}

// ─── MANIFEST FALLBACK ───────────────────────────────────────────────────────

/**
 * Write a manifest JSON file to the "Ready to Post" folder so the owner
 * can manually find the video + caption even if all notification channels fail.
 */
async function writeManifestFile(accessToken, { city, caption, driveLink, fileName, fileId }) {
  try {
    const folderId = await getOrCreateFolder(accessToken);
    const manifestName = `MANIFEST_${city.toUpperCase()}_${new Date().toISOString().slice(0, 10)}.txt`;
    const manifestContent = [
      `═══════════════════════════════════════════════`,
      `  DELIVERY MANIFEST — ${city.toUpperCase()}`,
      `  ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
      `═══════════════════════════════════════════════`,
      ``,
      `⚠️  ALL NOTIFICATION CHANNELS FAILED`,
      `    Dashboard webhook: FAILED (3 attempts)`,
      `    Email backup: FAILED (3 attempts)`,
      ``,
      `📁 Video file: ${fileName}`,
      `🔗 Drive link: ${driveLink}`,
      ``,
      `━━━ Caption (copy & paste) ━━━`,
      ``,
      caption,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Post this natively on @lifestyledesignrealtytexas.`,
      `This workflow run exited RED so you should also`,
      `receive a GitHub Actions failure email.`,
    ].join("\n");

    const boundary = "manifest_boundary_" + Date.now();
    const metadata = JSON.stringify({
      name: manifestName,
      parents: [folderId],
      mimeType: "text/plain",
    });

    const multipartBody = [
      `--${boundary}`,
      `Content-Type: application/json; charset=UTF-8`,
      ``,
      metadata,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      manifestContent,
      `--${boundary}--`,
    ].join("\r\n");

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (res.ok) {
      console.log(`[Delivery] ✓ Manifest written to Drive: ${manifestName}`);
    } else {
      console.error(`[Delivery] Failed to write manifest: ${res.status}`);
    }
  } catch (err) {
    console.error(`[Delivery] Manifest write error: ${err.message}`);
  }
}

// ─── MAIN DELIVERY FUNCTION ─────────────────────────────────────────────────

/**
 * Main delivery function — BULLETPROOF edition.
 * 
 * 1. Upload video to Drive "Ready to Post" (3x retry)
 * 2. Notify via Channel 1 (Dashboard webhook, 3x retry)
 * 3. Notify via Channel 2 (Email backup, 3x retry)
 * 4. If BOTH notification channels fail: write manifest + throw (workflow goes red)
 * 
 * Video is NEVER auto-deleted — stays until owner confirms posted or skips.
 * Main IG is NEVER auto-published — owner posts natively only.
 */
export async function deliverToOwner(accessToken, videoPath, city, caption, options = {}) {
  console.log(`[Delivery] Starting bulletproof delivery for ${city}...`);

  // Step 1: Upload to Drive (3x retry — if this fails, nothing else matters)
  const upload = await uploadToReadyFolder(accessToken, videoPath, city);

  // If this is a trial variant, call the trial webhook instead of the normal one
  if (options.isTrial) {
    // A test run must be identifiable from the payload alone, because the Trial
    // tab renders whatever it is sent. Same `TEST-` convention the YouTube
    // approvals path uses, so one filter rule covers both.
    const trialFileName = options.isTest ? `${TEST_PREFIX}${upload.fileName}` : upload.fileName;

    const ch1 = await notifyTrialDashboard({
      sourceVideoId: options.sourceVideoId || upload.fileId,
      sourceFileName: trialFileName,
      city,
      hookAngle: options.trialAngle,
      variantNumber: options.trialVariantNumber || 1,
      window: options.window || "am",
      caption,
      driveLink: upload.webViewLink,
      driveFileId: upload.fileId,
      sourceViews: options.sourceViews || 0,
      isTest: Boolean(options.isTest),
      // The A/B/C hook line, for variants that HAVE one.
      //
      // The trial pipeline's variants differ by `hookAngle` — a named strategy
      // like "price_hook" — and that is all the tab needed to tell them apart.
      // The manual edit queue's variants differ by an actual LINE OF TEXT
      // written for that video, and "which line won" is the entire question its
      // A/B exists to answer. Sending only the angle would put three cards on
      // the tab that are indistinguishable to the person deciding between them.
      //
      // Optional and null for every existing caller, so nothing about the trial
      // pipeline's payload changes.
      hookLine: options.trialHookLine || null,
    });

    // Channel 2. The trial path used to have exactly one channel and no way to
    // report losing it: on a failed webhook it still returned delivered:true, so
    // the run went green with the variant reachable only by knowing the Drive
    // link existed. Trials get the same two-channel contract as city reels.
    const ch2 = await sendEmailBackup(accessToken, {
      city: options.trialLabel || `${city} (trial)`,
      caption,
      driveLink: upload.webViewLink,
      fileName: trialFileName,
    });

    if (!ch1.ok && !ch2.ok) {
      console.error("[Delivery] ⚠️ BOTH trial notification channels failed!");
      console.error(`[Delivery] Trial webhook: ${ch1.lastError?.message}`);
      console.error(`[Delivery] Email backup:  ${ch2.lastError?.message}`);

      await writeManifestFile(accessToken, {
        city,
        caption,
        driveLink: upload.webViewLink,
        fileName: trialFileName,
        fileId: upload.fileId,
      });

      throw new Error(
        `Both trial notification channels failed after retries. ` +
        `Webhook: ${ch1.lastError?.message || "unknown"}. ` +
        `Email: ${ch2.lastError?.message || "unknown"}. ` +
        `Variant uploaded to Drive (${upload.webViewLink}) and manifest written.`
      );
    }

    const trialChannels = [];
    if (ch1.ok) trialChannels.push("trial-dashboard");
    if (ch2.ok) trialChannels.push("email");
    console.log(`[Delivery] ✓ Trial delivery complete via: ${trialChannels.join(" + ")}`);

    return {
      delivered: true,
      channels: trialChannels,
      // The Trial tab is the surface Peter actually looks at. Whether the card
      // reached it is a separate fact from "something was delivered", and the
      // caller verifies against this one.
      dashboardOk: ch1.ok,
      dashboardError: ch1.ok ? null : ch1.lastError?.message || "unknown",
      driveLink: upload.webViewLink,
      driveFileId: upload.fileId,
      fileName: trialFileName,
      isTest: Boolean(options.isTest),
    };
  }

  const deliveryPayload = {
    city,
    caption,
    driveFileId: upload.fileId,
    driveFileName: upload.fileName,
    driveLink: upload.webViewLink,
    directDownloadLink: upload.directLink,
    deliveredAt: new Date().toISOString(),
  };

  // Step 2: Channel 1 — Dashboard webhook (3x retry)
  const ch1 = await notifyDashboard(deliveryPayload);

  // Step 3: Channel 2 — Email backup (3x retry, always sent regardless of ch1)
  const ch2 = await sendEmailBackup(accessToken, {
    city,
    caption,
    driveLink: upload.webViewLink,
    fileName: upload.fileName,
  });

  // Step 4: Evaluate results
  if (!ch1.ok && !ch2.ok) {
    // BOTH channels failed — write manifest and throw (workflow exits red)
    console.error("[Delivery] ⚠️ BOTH notification channels failed!");
    console.error(`[Delivery] Channel 1 (Dashboard): ${ch1.lastError?.message}`);
    console.error(`[Delivery] Channel 2 (Email): ${ch2.lastError?.message}`);

    await writeManifestFile(accessToken, {
      city,
      caption,
      driveLink: upload.webViewLink,
      fileName: upload.fileName,
      fileId: upload.fileId,
    });

    throw new Error(
      `Both notification channels failed after retries. ` +
      `Video uploaded to Drive (${upload.webViewLink}) and manifest written. ` +
      `Workflow will exit red — GitHub sends failure email.`
    );
  }

  const channels = [];
  if (ch1.ok) channels.push("dashboard");
  if (ch2.ok) channels.push("email");
  console.log(`[Delivery] ✓ Delivery complete via: ${channels.join(" + ")}`);

  // NOTE: No cleanup of old files — video stays until owner confirms posted or skips
  return {
    delivered: true,
    channels,
    driveLink: upload.webViewLink,
    driveFileId: upload.fileId,
    fileName: upload.fileName,
  };
}

/**
 * Deliver a rendered carousel to the owner for native posting.
 *
 * KNOWN BREAKAGE — the dashboard channel fails on every carousel run:
 *
 *   Data truncated for column 'city' at row 1     (params: CAROUSEL, 2026-08-03, ...)
 *
 * This is NOT a column-width problem. "CAROUSEL" is 8 characters and
 * "san_antonio" — which the column stores happily — is 11. In MySQL strict mode
 * that message is what an out-of-range ENUM value produces, so `deliveries.city`
 * is an enum of the three cities and CAROUSEL is simply not one of them.
 *
 * The obvious workaround, sending an accepted city instead, is NOT safe. The
 * webhook's statement is an upsert whose ON DUPLICATE KEY UPDATE list covers
 * status, links, caption and timestamps but not city or date — the signature of
 * a unique key on (city, date). Sending city="san_antonio" for today would
 * therefore overwrite that day's real San Antonio delivery rather than add a
 * row, losing a record silently. Not worth a dashboard tile.
 *
 * The real fix belongs in the dashboard (add CAROUSEL to the enum, or move to a
 * `type` discriminator with city nullable). That repo is not reachable from
 * here, so until it is, carousels reach the owner by email and the dashboard
 * gap is reported loudly rather than papered over.
 *
 * Same contract as deliverToOwner: main Instagram is never auto-published, so
 * the slides go to "Ready to Post" and the owner posts them natively — which is
 * also the only route to genuine trending audio, since the Metricool API has no
 * field that carries it (issue #11).
 *
 * Differs from deliverToOwner in that a carousel is many files, not one: every
 * slide plus the PDF is uploaded, then ONE notification is sent covering the
 * set. Notifying per file would send eight pushes for one post.
 *
 * @param {string} accessToken
 * @param {Array<{path: string, mimeType: string}>} files  slides then PDF, in order
 * @param {object} meta  { caption, keyword, closeType, topic, city }
 */
export async function deliverCarouselToOwner(accessToken, files, meta) {
  const { caption, keyword, closeType = "dm", topic, city = "carousel" } = meta;
  console.log(`[Delivery] Delivering carousel "${topic}" (${files.length} files) to owner...`);

  const uploaded = [];
  for (const file of files) {
    // Individual slide uploads already retry 3x inside uploadToReadyFolder.
    uploaded.push(await uploadToReadyFolder(accessToken, file.path, city, file.mimeType));
  }

  const slideLinks = uploaded.map((u) => u.webViewLink);
  const primary = uploaded[0];

  // Two audiences, two strings.
  //
  // `caption` feeds the dashboard's Copy Caption button, so it must be ONLY what
  // gets pasted into Instagram. It used to carry the posting instructions and a
  // numbered list of raw Drive URLs, which meant one tap of Copy Caption pasted
  // internal notes and file links into a public post.
  //
  // The instructions belong with the email, which is a message to Peter rather
  // than a clipboard. The slide URL list is dropped from both: the dashboard
  // renders slideImages and pdfLink natively now, so it only duplicated the card.
  const socialCaption = caption;

  const postingInstructions = [
    `Carousel: ${uploaded.length} files in Ready to Post. Post the slides in order.`,
    keyword ? `Comment keyword: ${keyword}` : `Close type: ${closeType} (no comment keyword)`,
    `Add trending audio natively when you post.`,
  ].join("\n");

  const emailBody =
    `${socialCaption}\n\n` +
    `— — —\n${postingInstructions}\n\n` +
    slideLinks.map((l, i) => `  ${i + 1}. ${l}`).join("\n");

  const deliveryPayload = {
    city,
    // Clean and paste-ready. Nothing else goes in here.
    caption: socialCaption,
    // Separate field so the card can show the instructions somewhere other than
    // the caption box. The webhook tolerates fields it does not know, so this
    // needs no schema change.
    instructions: postingInstructions,
    driveFileId: primary.fileId,
    driveFileName: primary.fileName,
    driveLink: primary.webViewLink,
    directDownloadLink: primary.directLink,
    deliveredAt: new Date().toISOString(),
    // Forward-compatible fields for a dashboard that can tell a carousel from a
    // video. Safe to send today: the carousel webhook already fails 100% of the
    // time on the `city` enum, so nothing here can make it worse — and once the
    // dashboard accepts carousels it has what it needs to render one.
    type: "carousel",
    // Field names verified against the live webhook on 2026-08-04: it rejects a
    // carousel without `slideImages` (non-empty array), and the deliveries table
    // has columns slideImages / pdfLink / keyword / closeType.
    slideImages: uploaded.slice(0, -1).map((u) => u.webViewLink),
    // slideImages holds Drive VIEWER pages (/file/d/<id>/view) — HTML, which
    // renders nothing in an <img>. These are the thumbnail endpoint itself,
    // verified serving image/png to an unauthenticated request, so the card has
    // something directly displayable without parsing an id out of a viewer link.
    slideThumbnails: uploaded.slice(0, -1).map((u) => driveThumbnailUrl(u.fileId)),
    slideFileIds: uploaded.slice(0, -1).map((u) => u.fileId),
    // pdfLink is the canonical name; the webhook also accepts pdfUrl via a
    // fallback, but there is no reason to send both.
    pdfLink: uploaded.length > 1 ? uploaded[uploaded.length - 1].webViewLink : null,
    slides: uploaded.slice(0, -1).map((u) => ({ fileName: u.fileName, link: u.webViewLink })),
    keyword: keyword || null,
    closeType,
  };

  const ch1 = await notifyDashboard(deliveryPayload);
  const ch2 = await sendEmailBackup(accessToken, {
    city,
    caption: emailBody,
    driveLink: primary.webViewLink,
    fileName: primary.fileName,
  });

  if (!ch1.ok && !ch2.ok) {
    console.error("[Delivery] ⚠️ BOTH notification channels failed for the carousel!");
    await writeManifestFile(accessToken, {
      city,
      caption: emailBody,
      driveLink: primary.webViewLink,
      fileName: primary.fileName,
      fileId: primary.fileId,
    });
    throw new Error(
      `Both notification channels failed after retries. ` +
      `Carousel uploaded to Drive (${primary.webViewLink}) and manifest written. ` +
      `Workflow will exit red — GitHub sends failure email.`
    );
  }

  const channels = [];
  if (ch1.ok) channels.push("dashboard");
  if (ch2.ok) channels.push("email");
  console.log(`[Delivery] ✓ Carousel delivered via: ${channels.join(" + ")}`);

  // One channel failing used to pass in silence because the other covered it.
  // For carousels the dashboard channel fails EVERY run, and without this the
  // only trace is a warn line buried in the log.
  if (!ch1.ok) {
    console.log(
      `::warning::[Delivery] Carousel reached the owner by email only — the dashboard ` +
      `webhook failed and this delivery will not appear in the dashboard. ` +
      `Reason: ${ch1.lastError?.message?.slice(0, 300) || "unknown"}`
    );
  }
  if (!ch2.ok) {
    console.log(`::warning::[Delivery] Carousel email backup failed: ${ch2.lastError?.message?.slice(0, 300) || "unknown"}`);
  }

  return {
    delivered: true,
    channels,
    dashboardOk: Boolean(ch1.ok),
    emailOk: Boolean(ch2.ok),
    files: uploaded.map((u) => ({ fileName: u.fileName, link: u.webViewLink })),
    driveLink: primary.webViewLink,
  };
}

// ─── APPROVAL CHANNEL ────────────────────────────────────────────────────────

/**
 * Ask Peter for a decision, over both channels.
 *
 * The dashboard is the channel of record: it is what renders the request and
 * what writes the decision back into yt-approvals.json. Email is the backup
 * that makes sure he KNOWS there is something waiting, since the pipeline stops
 * dead until he answers.
 *
 * Both channels failing is fatal on purpose. A delivery that reaches nobody
 * wastes one post; an approval request that reaches nobody stalls the whole
 * weekly cycle silently — the Friday job would keep exiting "no decision yet"
 * forever and look perfectly healthy while doing it. Going red here is the only
 * way that surfaces.
 *
 * @param {object} req
 * @param {string} req.requestId   the id the decision will be keyed to
 * @param {"topic_pick"|"video_review"} req.kind
 * @param {object} req.payload     whatever the dashboard needs to render the card
 * @param {string} req.emailSubject
 * @param {string} req.emailBody
 * @param {string} [req.accessToken] Google token; omit to skip the email channel
 */
/**
 * The dashboard's approval endpoint.
 *
 * NOT /api/delivery/webhook — that one renders delivery cards. Approvals have
 * their own endpoint, and pointing at the wrong one is a silent failure: the
 * request is accepted or rejected by a handler that was never going to raise an
 * approval card, so Peter gets no push, the pipeline waits forever, and every
 * scheduled run reports a healthy "still waiting on Peter".
 *
 * A constant rather than an inline string so it is greppable and testable.
 */
export const APPROVAL_WEBHOOK_PATH = "/api/delivery/approval-webhook";

/** Where deliveries go. Kept next to the above so the two cannot be confused. */
export const DELIVERY_WEBHOOK_PATH = "/api/delivery/webhook";

/** The payload the approval endpoint receives. Exported so tests can assert its shape. */
export function approvalPayload({ requestId, kind, payload, requestedAt = new Date().toISOString() }) {
  return { type: "approval", requestId, kind, stage: stageOf(payload), payload, requestedAt };
}

/**
 * The routing field, lifted to the top of the envelope.
 *
 * FIVE DIFFERENT THINGS SHIP AS kind:"topic_pick" — the weekly brief, a reworked
 * brief, the recording kit, a below-bar hold, and a run that produced no usable
 * draft. Only `payload.stage` told them apart, and the two that render are the
 * two that do not carry one. A dashboard routing on `kind` sees five copies of
 * the same thing, which is why a delivered recording kit and two hold notices
 * all arrived with nowhere to go.
 *
 * That shape was a deliberate choice on this side: reusing the request's id and
 * marking a stage, rather than raising a new approval record that would read as
 * an unanswered brief and block the next Monday brief. The state machine was
 * right; handing the dashboard a distinction it had to dig for was not.
 *
 * So `stage` is now a flat field on the envelope. `payload.stage` stays exactly
 * where it was — nothing that reads it needs changing, and the two can be
 * migrated apart later if anyone wants to.
 *
 * NULL IS A VALUE HERE, not an absence. A payload with no stage is a request
 * for a DECISION — a brief. Emitting the key as null on every envelope means a
 * consumer can switch on one always-present field:
 *
 *     stage === null  ->  a decision is being asked for; render the card
 *     stage !== null  ->  progress on a request already decided
 */
function stageOf(payload) {
  const stage = payload && typeof payload === "object" ? payload.stage : null;
  return typeof stage === "string" && stage ? stage : null;
}

export async function sendApprovalRequest({ requestId, kind, payload, emailSubject, emailBody, accessToken = null, mailPrefix = MAIL_PREFIX.YT }) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  const dashboardSecret = process.env.DASHBOARD_WEBHOOK_SECRET;

  let ch1 = { ok: false, lastError: new Error("Dashboard env vars not configured") };
  if (dashboardUrl && dashboardSecret) {
    ch1 = await withRetry("Approval webhook", async () => {
      const res = await fetch(`${dashboardUrl}${APPROVAL_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": dashboardSecret,
        },
        body: JSON.stringify(approvalPayload({ requestId, kind, payload })),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Dashboard returned ${res.status}: ${err}`);
      }
      console.log(`[Approvals] ✓ dashboard notified — ${kind} ${requestId}`);
      return true;
    });
  } else {
    console.warn("[Approvals] DASHBOARD_URL or DASHBOARD_WEBHOOK_SECRET not set — dashboard channel unavailable");
  }

  let ch2 = { ok: false, lastError: new Error("No Google token supplied") };
  if (accessToken) {
    // The prefix used to be fixed at MAIL_PREFIX.YT because every caller was
    // the long-form pipeline. The reels edit queue is the second caller and
    // files under its own prefix, so it is now an argument — defaulted to YT so
    // no long-form call site changes.
    ch2 = await sendOwnerEmailViaGmail(accessToken, {
      subject: emailSubject,
      body: emailBody,
      prefix: mailPrefix,
    });
  }

  if (!ch1.ok && !ch2.ok) {
    throw new Error(
      `Approval request ${requestId} (${kind}) reached NEITHER channel. ` +
      `Dashboard: ${ch1.lastError?.message}. Email: ${ch2.lastError?.message}. ` +
      `The pipeline will stall until Peter can answer, so this exits red rather than waiting silently.`
    );
  }

  const channels = [];
  if (ch1.ok) channels.push("dashboard");
  if (ch2.ok) channels.push("email");
  console.log(`[Approvals] ${kind} ${requestId} sent via: ${channels.join(" + ")}`);
  return { ok: true, channels, requestId, kind };
}
