#!/usr/bin/env node
/**
 * probe-youtube-video-id.mjs — can we learn the YouTube video ID of something
 * Metricool posted, WITHOUT calling the YouTube API?
 *
 * READ ONLY. Creates nothing, uploads nothing, deletes nothing, publishes
 * nothing. It reads scheduler posts that already exist.
 *
 * WHY THIS DECIDES THE FEATURE. Setting a custom thumbnail is one call —
 * youtube.videos.thumbnails.set — and it needs YouTube's video id. We do not
 * have one. What the long-form path records is:
 *
 *     youtubeUrl: upload.mediaUrl     <- Metricool's MEDIA LIBRARY url
 *
 * and `videoId` in youtube-log.json is our own internal key, not YouTube's.
 * Metricool creates the video on the channel, so Metricool is the only party
 * that knows the id it got back. If the scheduler post does not expose it, the
 * only way to find the video is to ask the YouTube API to list the channel's
 * uploads and match on title — which is a second YouTube call, is a guess, and
 * is explicitly out of scope. So: either the id is in this response, or the
 * thumbnail stays manual.
 *
 * WHAT IT REPORTS
 *   1. every YOUTUBE provider block on recent posts, in full, so we can see
 *      what fields exist rather than guessing at names
 *   2. whether anything in it yields an 11-character YouTube video id
 *   3. the same for any PRIVATE youtube post it finds — which is the case that
 *      actually matters, because long-form uploads private and a private video
 *      may well have no public url at all
 *
 * A caveat this probe cannot remove: the reels path publishes PUBLIC shorts, so
 * most of what it finds will be public. Public posts prove the field NAME.
 * They do not prove the field is populated for a private upload. If no private
 * youtube post exists yet, this says so rather than implying the question is
 * settled.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing Metricool credentials");
  process.exit(1);
}

const redact = (s) =>
  String(s ?? "")
    .split(TOKEN).join("<TOKEN>")
    .split(USER_ID).join("<USER>")
    .split(String(BLOG_ID)).join("<BLOG>");

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", "X-Mc-Auth": TOKEN },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

/** A YouTube id is 11 chars of [A-Za-z0-9_-]. Pull one out of any string. */
function extractVideoId(value) {
  const s = String(value ?? "");
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})\b/,
    /youtu\.be\/([A-Za-z0-9_-]{11})\b/,
    /\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\b/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return null;
}

/** Walk an object and report every leaf that yields a video id. */
function findIdsDeep(obj, path = "") {
  const hits = [];
  if (obj === null || obj === undefined) return hits;
  if (typeof obj !== "object") {
    const id = extractVideoId(obj);
    if (id) hits.push({ path, value: String(obj).slice(0, 120), id });
    return hits;
  }
  for (const [k, v] of Object.entries(obj)) {
    hits.push(...findIdsDeep(v, path ? `${path}.${k}` : k));
  }
  return hits;
}

const fmt = (d) => d.toISOString().slice(0, 19);

async function main() {
  console.log("=".repeat(68));
  console.log("Can we get a YouTube video id from Metricool? (READ ONLY)");
  console.log("=".repeat(68));

  const from = fmt(new Date(Date.now() - 90 * 86400_000));
  const to = fmt(new Date(Date.now() + 7 * 86400_000));
  const res = await api(
    `/v2/scheduler/posts?blogId=${BLOG_ID}&userId=${USER_ID}&start=${from}&end=${to}`
  );

  if (res.status !== 200) {
    console.error(`scheduler/posts returned ${res.status}: ${redact(res.text || "")}`);
    process.exit(1);
  }

  const posts = Array.isArray(res.json) ? res.json : res.json?.data || [];
  console.log(`\n${posts.length} scheduler posts in the last 90 days.\n`);

  const youtubePosts = posts.filter((p) =>
    (p.providers || []).some((pr) => String(pr.network || "").toUpperCase() === "YOUTUBE")
  );
  console.log(`${youtubePosts.length} of them target YouTube.\n`);

  if (youtubePosts.length === 0) {
    console.log("Nothing to inspect. The question stays open.");
    return;
  }

  let anyId = false;
  let privateSeen = false;
  let privateWithId = false;

  for (const post of youtubePosts.slice(-8)) {
    const yt = (post.providers || []).find(
      (pr) => String(pr.network || "").toUpperCase() === "YOUTUBE"
    );
    const privacy =
      post.youtubeData?.privacy || post.youtubeData?.privacyStatus || "(not stated)";
    const isPrivate = String(privacy).toLowerCase() === "private";
    if (isPrivate) privateSeen = true;

    console.log("─".repeat(68));
    console.log(`postId   ${post.id}`);
    console.log(`when     ${post.publicationDate?.dateTime || post.publicationDate || "?"}`);
    console.log(`privacy  ${privacy}${isPrivate ? "   <-- the case that matters" : ""}`);
    console.log(`status   ${yt.status}${yt.detailedStatus ? ` (${yt.detailedStatus})` : ""}`);
    console.log(`provider block, every field:`);
    for (const [k, v] of Object.entries(yt)) {
      const shown = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      console.log(`   ${k.padEnd(18)} ${redact(shown).slice(0, 140)}`);
    }

    // Look everywhere on the post, not just the provider block — the id may sit
    // on youtubeData or somewhere unadvertised.
    const hits = findIdsDeep(post);
    if (hits.length) {
      anyId = true;
      if (isPrivate) privateWithId = true;
      console.log(`   >>> VIDEO ID FOUND:`);
      for (const h of hits.slice(0, 5)) {
        console.log(`         ${h.path} = ${redact(h.value)}  ->  ${h.id}`);
      }
    } else {
      console.log(`   >>> no video id anywhere on this post`);
    }
  }

  console.log("\n" + "=".repeat(68));
  console.log("VERDICT");
  console.log("=".repeat(68));
  console.log(`  a video id is reachable at all      : ${anyId ? "YES" : "NO"}`);
  console.log(`  a PRIVATE youtube post was found    : ${privateSeen ? "YES" : "NO"}`);
  console.log(`  ...and it carried a video id        : ${privateWithId ? "YES" : privateSeen ? "NO" : "n/a"}`);
  console.log("");
  if (privateWithId) {
    console.log("  thumbnails.set is BUILDABLE as specified — the id is on the post,");
    console.log("  no YouTube API call needed to find it.");
  } else if (anyId && !privateSeen) {
    console.log("  The field exists on public posts, but no private post was available");
    console.log("  to test. The long-form case is UNPROVEN — re-run this after the");
    console.log("  first private long-form upload before building on it.");
  } else if (anyId && privateSeen && !privateWithId) {
    console.log("  Public posts carry an id; the private one does NOT. As specified,");
    console.log("  the thumbnail cannot be targeted before Peter publishes. Either it");
    console.log("  is set AFTER he makes it public, or it stays manual.");
  } else {
    console.log("  No id anywhere. thumbnails.set cannot be targeted without asking");
    console.log("  YouTube to list the channel's uploads, which is out of scope.");
    console.log("  Recommend accepting auto-frames.");
  }
}

main().catch((err) => {
  console.error(`FAILED: ${redact(err?.stack || String(err))}`);
  process.exit(1);
});
