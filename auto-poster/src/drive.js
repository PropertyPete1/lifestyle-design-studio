/**
 * Google Drive API — list folders, download videos, token refresh
 */

const CITY_FOLDER_IDS = {
  san_antonio: "1O5lL5rWjuzj3kg5kRMqY7E4CdcnDz4bY",
  austin: "1GgKKUJFzV39JQ3oTRoe7aTdZwqqMbba8",
  dallas: "1nNrGjhHeMG3B25Cj3o7T2cLRAJM-9RX2",
};

let cachedAccessToken = null;

/**
 * Exchange refresh token for a fresh access token.
 * Falls back to GOOGLE_ACCESS_TOKEN env var if available (for testing/sandbox).
 */
async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;

  // Direct access token override (for testing or Manus sandbox)
  const directToken = process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
  if (directToken) {
    cachedAccessToken = directToken;
    return directToken;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to refresh Google token (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  console.log("[Drive] Access token refreshed successfully");
  return cachedAccessToken;
}

/**
 * List all video files in a city's Drive folder.
 */
export async function listCityVideos(city) {
  const folderId = CITY_FOLDER_IDS[city];
  if (!folderId) throw new Error(`No Drive folder configured for city: ${city}`);

  const token = await getAccessToken();
  const videos = [];
  let pageToken = undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,videoMediaMetadata)",
      pageSize: "100",
      orderBy: "name",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const err = await res.text().then(t => t.slice(0, 200));
      throw new Error(`Drive API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    if (data.files) videos.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`[Drive] Found ${videos.length} videos in ${city} folder`);
  return videos;
}

/**
 * Download a video file from Drive. Returns a Buffer.
 */
export async function downloadVideo(fileId, fileName) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  console.log(`[Drive] Downloading ${fileName}...`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text().then(t => t.slice(0, 200));
    throw new Error(`Drive download failed (${res.status}): ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 10240) {
    throw new Error(`File too small (${buffer.length} bytes) — likely an error response`);
  }

  console.log(`[Drive] Downloaded ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return buffer;
}

/**
 * Get a direct download URL for a Drive file (requires auth header).
 * Used as a fallback if Metricool can accept authenticated URLs.
 */
export function getDriveDownloadUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

/**
 * Get file metadata by ID (for FORCE_VIDEO_ID when file isn't in the city folder).
 */
export async function getFileMetadata(fileId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

/**
 * Find one file by name inside a folder. Returns its id, or null.
 *
 * Exact-name lookup rather than a listing, because the callers are caches: they
 * know the filename they wrote and only want to know whether it is still there.
 * The name is quoted into a Drive query, so an apostrophe in it would break the
 * query — escaped rather than trusted, since cache keys are built from track and
 * clip titles that come from other people's catalogues.
 */
export async function findInFolder(folderId, name) {
  const token = await getAccessToken();
  const safe = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name = '${safe}' and trashed = false`,
    fields: "files(id,name,size)",
    pageSize: "1",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive lookup failed (${res.status})`);
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

/** Download any file by id. Returns a Buffer. */
export async function downloadFileById(fileId) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload a buffer into a folder, as a multipart create.
 *
 * The boundary is a fixed string rather than a random one — the payloads here
 * are binary audio and a random boundary that happened to occur inside the
 * bytes would corrupt the upload. A fixed improbable string has the same
 * collision odds and is reproducible when one goes wrong.
 */
export async function uploadToFolder(folderId, name, buffer, mimeType = "application/octet-stream") {
  const token = await getAccessToken();
  const boundary = "-----ldr-drive-boundary-9f3a2c";
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const err = await res.text().then((t) => t.slice(0, 200));
    throw new Error(`Drive upload failed (${res.status}): ${err}`);
  }
  return res.json();
}

// ─── arbitrary folders ──────────────────────────────────────────────────────
//
// Everything above is scoped to the three city folders and the caches. The
// manual edit queue watches a folder Peter names, and writes its output to a
// folder it creates — neither of which is a city — so it needs the generic
// forms. Added here rather than in the queue's own module because "how this
// system talks to Drive" has one home, and a second uploader would be a second
// place for the multipart boundary and the error handling to be got wrong.

/**
 * List a folder's contents.
 *
 * `videoOnly` filters on mimeType IN THE QUERY, which is what the city lister
 * does — but the queue calls this with it OFF on purpose. A phone or a desktop
 * sync client routinely uploads .mov as application/octet-stream, and a
 * server-side mimeType filter would make those files invisible: not skipped
 * with a reason, invisible. The queue would report an empty folder over a
 * folder with three videos in it, which is the worst answer available. So the
 * listing is unfiltered and `looksLikeVideo` decides locally, where a rejection
 * can be reported.
 */
export async function listFolderFiles(folderId, { videoOnly = false, accessToken = null } = {}) {
  const token = accessToken || (await getAccessToken());
  const files = [];
  let pageToken = undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false` + (videoOnly ? " and mimeType contains 'video/'" : ""),
      fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,videoMediaMetadata)",
      pageSize: "100",
      orderBy: "createdTime",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text().then((t) => t.slice(0, 200));
      throw new Error(`Drive list failed for folder ${folderId} (${res.status}): ${err}`);
    }
    const data = await res.json();
    if (data.files) files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Find a subfolder by name, creating it if it is not there. Returns the id.
 *
 * Searched before created, every time, because this runs on a schedule: a
 * create-first version would leave Drive with fourteen folders of the same name
 * and the links in old cards pointing at whichever one that run happened to
 * make.
 */
export async function ensureFolder(name, parentId, { accessToken = null } = {}) {
  const token = accessToken || (await getAccessToken());
  const safe = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id,name)",
    pageSize: "1",
  });
  const found = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (found.ok) {
    const data = await found.json();
    if (data.files?.[0]?.id) return data.files[0].id;
  }

  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!res.ok) {
    const err = await res.text().then((t) => t.slice(0, 200));
    throw new Error(`Drive folder create failed for "${name}" (${res.status}): ${err}`);
  }
  return (await res.json()).id;
}

/**
 * Upload a file and return a link that actually opens.
 *
 * TWO THINGS BEYOND uploadToFolder, and both are the difference between a link
 * in an email and a link in an email that works:
 *
 *   - `webViewLink` is REQUESTED. Drive's create response returns id/name/kind
 *     by default, so a caller that built its own /file/d/<id>/view URL would be
 *     guessing at a format Drive owns.
 *   - LINK-VIEW ACCESS IS GRANTED, and the grant is CHECKED. Peter opens these
 *     from his phone, often signed into a different Google account than the one
 *     the bot uploads with, and an ungranted link is a permission wall. The
 *     result is returned rather than logged: a review card whose links need a
 *     login is a review card that cannot be actioned, and the caller needs to
 *     be able to say so out loud rather than discover it from Peter.
 */
export async function uploadAndShare(folderId, name, buffer, mimeType = "video/mp4", { accessToken = null } = {}) {
  const token = accessToken || (await getAccessToken());
  const boundary = "-----ldr-drive-boundary-9f3a2c";
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) {
    const err = await res.text().then((t) => t.slice(0, 200));
    throw new Error(`Drive upload failed for "${name}" (${res.status}): ${err}`);
  }
  const file = await res.json();

  let shared = true;
  let shareError = null;
  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!perm.ok) {
    shared = false;
    shareError = `${perm.status} ${await perm.text().then((t) => t.slice(0, 160)).catch(() => "")}`;
  }

  return {
    id: file.id,
    name: file.name,
    // Drive returns webViewLink when asked; the fallback is the documented URL
    // shape and exists so a link is never literally undefined in an email.
    link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    shared,
    shareError,
  };
}

export { CITY_FOLDER_IDS, getAccessToken };
