/**
 * Manual-Assist Delivery — uploads finished video to "Ready to Post" Drive folder
 * and notifies the dashboard to send owner notification.
 */

import { readFileSync, statSync } from "fs";
import { basename } from "path";

const READY_TO_POST_FOLDER_NAME = "Ready to Post";
let readyToPostFolderId = null;

/**
 * Get or create the "Ready to Post" folder in Google Drive root.
 */
async function getOrCreateFolder(accessToken) {
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
 * Upload the finished video to the "Ready to Post" folder.
 * Returns { fileId, webViewLink, directLink }
 */
async function uploadToReadyFolder(accessToken, videoPath, city) {
  const folderId = await getOrCreateFolder(accessToken);
  const fileName = `${city.toUpperCase()}_${new Date().toISOString().slice(0, 10)}_${basename(videoPath)}`;
  const fileSize = statSync(videoPath).size;
  const fileBuffer = readFileSync(videoPath);

  console.log(`[Delivery] Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB) to Ready to Post...`);

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

  const file = await uploadRes.json();
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

/**
 * Notify the dashboard to create a delivery record and push notification to owner.
 * The dashboard handles the notification and reconciliation lifecycle.
 */
async function notifyDashboard(deliveryData) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  const dashboardSecret = process.env.DASHBOARD_WEBHOOK_SECRET;

  if (!dashboardUrl || !dashboardSecret) {
    console.warn("[Delivery] DASHBOARD_URL or DASHBOARD_WEBHOOK_SECRET not set — skipping dashboard notification");
    return false;
  }

  try {
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
      console.warn(`[Delivery] Dashboard notification failed (${res.status}): ${err}`);
      return false;
    }

    console.log("[Delivery] ✓ Dashboard notified — owner will receive push notification");
    return true;
  } catch (err) {
    console.warn(`[Delivery] Dashboard notification error: ${err.message}`);
    return false;
  }
}

/**
 * Clean up old files from the Ready to Post folder (older than 24h).
 */
async function cleanupReadyFolder(accessToken) {
  try {
    const folderId = await getOrCreateFolder(accessToken);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      q: `'${folderId}' in parents and createdTime < '${cutoff}' and trashed=false`,
      fields: "files(id,name,createdTime)",
    });

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) return;
    const data = await res.json();

    for (const file of (data.files || [])) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      console.log(`[Delivery] Cleaned up old file: ${file.name}`);
    }
  } catch (err) {
    console.warn(`[Delivery] Cleanup error (non-fatal): ${err.message}`);
  }
}

/**
 * Main delivery function — called after video processing, before/after createPost.
 * Uploads to Drive, notifies dashboard, cleans up old files.
 */
export async function deliverToOwner(accessToken, videoPath, city, caption) {
  console.log(`[Delivery] Starting manual-assist delivery for ${city}...`);

  // Upload finished video to Ready to Post
  const upload = await uploadToReadyFolder(accessToken, videoPath, city);

  // Notify dashboard
  const notified = await notifyDashboard({
    city,
    caption,
    driveFileId: upload.fileId,
    driveFileName: upload.fileName,
    driveLink: upload.webViewLink,
    directDownloadLink: upload.directLink,
    deliveredAt: new Date().toISOString(),
  });

  // Clean up old files from previous days
  await cleanupReadyFolder(accessToken);

  return {
    delivered: true,
    notified,
    driveLink: upload.webViewLink,
    driveFileId: upload.fileId,
    fileName: upload.fileName,
  };
}
