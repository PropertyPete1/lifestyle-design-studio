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
async function uploadToReadyFolder(accessToken, videoPath, city) {
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
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify({
          name: fileName,
          parents: [folderId],
          mimeType: "video/mp4",
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
        "Content-Type": "video/mp4",
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
export async function deliverToOwner(accessToken, videoPath, city, caption) {
  console.log(`[Delivery] Starting bulletproof delivery for ${city}...`);

  // Step 1: Upload to Drive (3x retry — if this fails, nothing else matters)
  const upload = await uploadToReadyFolder(accessToken, videoPath, city);

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
