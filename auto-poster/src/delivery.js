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
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

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

  // Make file accessible via link
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });

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
async function sendEmailBackup(accessToken, { city, caption, driveLink, fileName }) {
  // Try Gmail API first (requires gmail.send scope on the token)
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

  // Build RFC 2822 email
  const rawEmail = [
    `To: ${OWNER_EMAIL}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join("\r\n");

  const encodedEmail = Buffer.from(rawEmail).toString("base64url");

  const gmailResult = await withRetry("Email (Gmail API)", async () => {
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

    console.log("[Delivery] ✓ Channel 2 (Email) — backup email sent via Gmail API");
    return true;
  });

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
    const trialResult = await notifyTrialDashboard({
      sourceVideoId: options.sourceVideoId || upload.fileId,
      sourceFileName: upload.fileName,
      city,
      hookAngle: options.trialAngle,
      variantNumber: options.trialVariantNumber || 1,
      window: options.window || "am",
      caption,
      driveLink: upload.webViewLink,
      driveFileId: upload.fileId,
      sourceViews: options.sourceViews || 0,
    });
    return {
      delivered: true,
      channels: trialResult.ok ? ["trial-dashboard"] : [],
      driveLink: upload.webViewLink,
      driveFileId: upload.fileId,
      fileName: upload.fileName,
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
  const { caption, keyword, closeType = "dm", topic, city = "CAROUSEL" } = meta;
  console.log(`[Delivery] Delivering carousel "${topic}" (${files.length} files) to owner...`);

  const uploaded = [];
  for (const file of files) {
    // Individual slide uploads already retry 3x inside uploadToReadyFolder.
    uploaded.push(await uploadToReadyFolder(accessToken, file.path, city, file.mimeType));
  }

  const slideLinks = uploaded.map((u) => u.webViewLink);
  const primary = uploaded[0];

  // The caption carries the posting instructions the owner needs, since the
  // dashboard record is built for a single video and has no slide-list field.
  const ownerNote =
    `${caption}\n\n` +
    `— Carousel: ${uploaded.length} files in Ready to Post. Post slides in order.\n` +
    (keyword ? `— Comment keyword: ${keyword}\n` : `— Close type: ${closeType} (no comment keyword)\n`) +
    `— Add trending audio natively when you post.\n` +
    slideLinks.map((l, i) => `  ${i + 1}. ${l}`).join("\n");

  const deliveryPayload = {
    city,
    caption: ownerNote,
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
    // The DB column is pdfLink; pdfUrl is sent alongside because the webhook's
    // own field name for it could not be confirmed — every insert that got far
    // enough to prove it was rejected first by the city column. Harmless to send
    // both; drop the loser once a carousel row actually lands.
    pdfLink: uploaded.length > 1 ? uploaded[uploaded.length - 1].webViewLink : null,
    pdfUrl: uploaded.length > 1 ? uploaded[uploaded.length - 1].webViewLink : null,
    slides: uploaded.slice(0, -1).map((u) => ({ fileName: u.fileName, link: u.webViewLink })),
    keyword: keyword || null,
    closeType,
  };

  const ch1 = await notifyDashboard(deliveryPayload);
  const ch2 = await sendEmailBackup(accessToken, {
    city,
    caption: ownerNote,
    driveLink: primary.webViewLink,
    fileName: primary.fileName,
  });

  if (!ch1.ok && !ch2.ok) {
    console.error("[Delivery] ⚠️ BOTH notification channels failed for the carousel!");
    await writeManifestFile(accessToken, {
      city,
      caption: ownerNote,
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
