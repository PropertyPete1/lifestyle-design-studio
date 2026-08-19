#!/usr/bin/env node
/**
 * probe-distribution-identity.mjs — WHOSE channel does YT_REFRESH_TOKEN act
 * as, and does that channel own the video Metricool created?
 *
 * READ ONLY. Lists channels, videos and playlists; creates nothing, changes
 * nothing, publishes nothing.
 *
 * WHY THIS PROBE EXISTS. Video 1's first live distribution sweep
 * (run 32202427105, 2026-08-19) failed all four steps with one symptom in
 * three costumes:
 *
 *     thumbnail   thumbnails.set failed: forbidden
 *     playlist    GET playlistItems failed: videoNotFound
 *     publish     video not visible to the API yet
 *     comment     video not visible to the API yet
 *
 * while an anonymous oEmbed check on the same id returned 403 — the code
 * YouTube serves for a video that EXISTS and is PRIVATE (a garbage id gets
 * 400). So the id Metricool reported is real; the API token simply cannot see
 * it. A private video is visible only to credentials acting as the channel
 * that owns it. And the same run's ensurePlaylist SUCCEEDED — the token has a
 * perfectly working channel of its own. Everything points at one mismatch:
 * the channel the token acts as is not the channel Metricool uploads to.
 * That is exactly what a Brand Account makes easy to get wrong: the OAuth
 * consent screen offers the personal identity and the brand-channel identity,
 * and a token minted as the wrong one passes every capability probe against
 * its own channel while failing against the real one.
 *
 * WHAT IT REPORTS
 *   1. the channel the token acts as — channels.list?mine=true, id + title
 *   2. whether that identity can see the target video at all, and if so whose
 *      channel the video says it belongs to
 *   3. whether the target id appears in the token channel's own uploads
 *   4. the playlists on the token channel — if sweep runs created "Moving to
 *      San Antonio" on the WRONG channel, it shows up here
 *   5. the Metricool post's provider block, so the id we are chasing is read
 *      fresh from the source of truth, not from a log entry
 *   6. a one-line VERDICT combining the above
 *
 * The probe exits 0 whenever it managed to gather the evidence — a mismatch
 * is a finding, not a probe failure. It exits 1 only when it could not answer
 * the question (missing credentials, network failure).
 */

const VIDEO_ID = process.env.PROBE_VIDEO_ID || "zVijHgm-rLc"; // video 1's resolved id
const POST_ID = process.env.PROBE_POST_ID || "362618989"; //     video 1's Metricool post

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;
const M_TOKEN = process.env.METRICOOL_API_TOKEN;
const M_USER = process.env.METRICOOL_USER_ID;
const M_BLOG = process.env.METRICOOL_BLOG_ID;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YT_REFRESH_TOKEN");
  process.exit(1);
}

const API = "https://www.googleapis.com/youtube/v3";

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.access_token;
}

async function yt(token, path, query) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || json?.error?.message || res.status;
    throw new Error(`GET ${path} failed: ${reason}`);
  }
  return json;
}

async function main() {
  const token = await accessToken();
  console.log("token refresh: OK\n");

  // ── 1. who is the token? ──────────────────────────────────────────────────
  const chans = await yt(token, "channels", { part: "snippet,contentDetails", mine: "true" });
  const chan = chans.items?.[0];
  if (!chan) {
    // A Google account with no YouTube channel — the token cannot own ANY
    // video. This alone explains every symptom.
    console.log("TOKEN CHANNEL: *** NONE — channels.list?mine=true returned zero items ***");
    console.log("\nVERDICT: the token's Google identity has no YouTube channel at all.");
    console.log("Re-mint YT_REFRESH_TOKEN and pick the channel account on the consent screen.");
    return;
  }
  const uploadsPl = chan.contentDetails?.relatedPlaylists?.uploads || null;
  console.log(`TOKEN CHANNEL: "${chan.snippet?.title}" (${chan.id})`);
  if (chans.items.length > 1) {
    console.log(`  NOTE: token sees ${chans.items.length} channels; using the first.`);
  }

  // ── 2. can it see the video? ──────────────────────────────────────────────
  const vids = await yt(token, "videos", { part: "status,snippet", id: VIDEO_ID });
  const vid = vids.items?.[0];
  if (vid) {
    console.log(`\nVIDEO ${VIDEO_ID}: VISIBLE`);
    console.log(`  title:    ${vid.snippet?.title}`);
    console.log(`  channel:  "${vid.snippet?.channelTitle}" (${vid.snippet?.channelId})`);
    console.log(`  privacy:  ${vid.status?.privacyStatus}`);
  } else {
    console.log(`\nVIDEO ${VIDEO_ID}: NOT VISIBLE to this token (videos.list returned no items)`);
  }

  // ── 3. is it among the token channel's own uploads? ───────────────────────
  let inUploads = false;
  if (uploadsPl) {
    const up = await yt(token, "playlistItems", { part: "contentDetails,snippet", playlistId: uploadsPl, maxResults: "50" });
    const rows = (up.items || []).map((i) => ({
      id: i.contentDetails?.videoId,
      title: (i.snippet?.title || "").slice(0, 60),
    }));
    inUploads = rows.some((r) => r.id === VIDEO_ID);
    console.log(`\nTOKEN CHANNEL'S LAST ${rows.length} UPLOADS (target ${inUploads ? "PRESENT" : "ABSENT"}):`);
    for (const r of rows.slice(0, 10)) console.log(`  ${r.id}  ${r.title}`);
    if (rows.length === 0) console.log("  (none — this channel has no uploads)");
  }

  // ── 4. playlists on the token channel — did sweeps build on the wrong one? ─
  const pls = await yt(token, "playlists", { part: "snippet", mine: "true", maxResults: "50" });
  const plRows = (pls.items || []).map((p) => `"${p.snippet?.title}" (${p.id})`);
  console.log(`\nTOKEN CHANNEL'S PLAYLISTS (${plRows.length}):`);
  for (const p of plRows) console.log(`  ${p}`);

  // ── 5. the Metricool post's provider block, fresh ─────────────────────────
  if (M_TOKEN && M_USER && M_BLOG) {
    // Same URL and auth shape as metricool.js verifyPostStatus.
    const url = `https://app.metricool.com/api/v2/scheduler/posts/${POST_ID}?blogId=${M_BLOG}&userId=${M_USER}`;
    const res = await fetch(url, { headers: { "X-Mc-Auth": M_TOKEN } });
    const body = await res.json().catch(() => ({}));
    const providers = body?.data?.providers || [];
    console.log(`\nMETRICOOL POST ${POST_ID}: HTTP ${res.status}, ${providers.length} provider(s)`);
    for (const p of providers) {
      const clean = JSON.stringify(p).split(M_TOKEN).join("<TOKEN>");
      console.log(`  ${clean}`);
    }
  } else {
    console.log("\nMETRICOOL POST: skipped (no Metricool credentials on this job)");
  }

  // ── 6. verdict ────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────────");
  if (vid && vid.snippet?.channelId === chan.id) {
    console.log("VERDICT: token and video are the SAME channel — identity is NOT the problem.");
    console.log("The sweep's failures need another explanation; re-run it and read the evidence.");
  } else if (vid) {
    console.log(`VERDICT: MISMATCH — the video belongs to "${vid.snippet?.channelTitle}" but the token acts as "${chan.snippet?.title}".`);
    console.log("Re-mint YT_REFRESH_TOKEN choosing the channel that owns the video on the consent screen.");
  } else {
    console.log(`VERDICT: MISMATCH — the token's channel "${chan.snippet?.title}" cannot see ${VIDEO_ID}${inUploads ? "" : " and it is not among that channel's uploads"}.`);
    console.log("The video exists (anonymous oEmbed returns 403 = private, not 400 = absent), so it");
    console.log("lives on a channel this token does not act as. Re-mint YT_REFRESH_TOKEN via");
    console.log("  node scripts/get-refresh-token.js --youtube");
    console.log("and on Google's account picker choose the CHANNEL identity Metricool uploads to");
    console.log("(the brand account, not the personal account).");
  }
}

main().catch((err) => {
  console.error(`probe failed before it could answer: ${err.message}`);
  process.exit(1);
});
