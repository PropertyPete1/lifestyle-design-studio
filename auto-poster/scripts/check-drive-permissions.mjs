#!/usr/bin/env node
/**
 * check-drive-permissions.mjs — do the carousel slides actually have
 * link-view access?
 *
 * uploadToReadyFolder already POSTs {type:'anyone', role:'reader'} for every
 * file it uploads, but it never checks the response. So "the thumbnails do not
 * render" has two possible causes and they need different fixes:
 *   a) the permission call is silently failing, or
 *   b) permissions are fine and the thumbnail problem is elsewhere.
 *
 * READ ONLY. Reports what Drive currently holds; changes nothing.
 */

import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();


// These IDs are committed deliberately, and this repo is public. They are carousel
// slides that uploadToReadyFolder explicitly shares as {type:'anyone', role:'reader'}
// so the dashboard and the owner's email can render thumbnails — public by design,
// not a leak. Flagged and cleared in the 2026-08-06 hygiene audit; no need to re-raise.
const FILE_IDS = [
  "1vBT_qxTX0fbJjtudpqovbdJQMChoTSF4",
  "1UNCYAvZrRou_koGFHZvuwMrWAwx-oZHj",
  "1einq1B51qXtf9Cany_vSt_q9GTgGBKSu",
  "1hU5sOHrOFlwN5u1rlAS67Jr5iMbM4V-N",
];

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function main() {
  const token = await getAccessToken();
  const h = { Authorization: `Bearer ${token}` };

  for (const id of FILE_IDS) {
    const meta = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,thumbnailLink,hasThumbnail`,
      { headers: h }
    );
    const m = await meta.json();

    const perms = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}/permissions?fields=permissions(id,type,role)`,
      { headers: h }
    );
    const p = await perms.json();
    const list = p.permissions || [];
    const anyoneReader = list.some((x) => x.type === "anyone" && (x.role === "reader" || x.role === "writer"));

    console.log(`\n${m.name || id}`);
    console.log(`  mimeType:     ${m.mimeType}`);
    console.log(`  hasThumbnail: ${m.hasThumbnail}`);
    console.log(`  thumbnailLink present: ${Boolean(m.thumbnailLink)}`);
    console.log(`  permissions:  ${JSON.stringify(list)}`);
    console.log(`  anyone/reader: ${anyoneReader ? "YES" : "NO  <-- thumbnails will not load"}`);

    // The endpoint a dashboard would actually hit, unauthenticated.
    const pub = await fetch(`https://drive.google.com/thumbnail?id=${id}&sz=w400`, { redirect: "follow" });
    console.log(`  unauthenticated thumbnail fetch: HTTP ${pub.status} ${pub.headers.get("content-type") || ""}`);
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
