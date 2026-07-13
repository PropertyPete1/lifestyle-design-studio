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
      fields: "nextPageToken,files(id,name,mimeType,size)",
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

export { CITY_FOLDER_IDS, getAccessToken };
