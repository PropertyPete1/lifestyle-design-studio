/**
 * yt-distribute.js — what happens to a video after Peter publishes it.
 *
 * WHAT THE YOUTUBE DATA API ACTUALLY SUPPORTS, verified before building
 * (sources and detail in longform/probe/DISTRIBUTION-API.md):
 *
 *   playlists           YES  playlists.list/insert, playlistItems.list/insert
 *   thumbnails.set      YES  works while the video is still private
 *   post a comment      YES  commentThreads.insert — but only once the video
 *                            is public; private videos cannot receive comments
 *   PIN a comment       NO   not exposed by the API, Studio only
 *   end screens         NO   not exposed by the API, Studio only
 *   community posts     NO   no public API at all
 *
 * So this module automates the three that exist, and the review checklist
 * carries the two one-click Studio steps (pin the posted comment, add the end
 * screen) rather than pretending they are automated.
 *
 * NOTHING HERE PUBLISHES, same invariant as yt-publish.js. Distribution runs
 * on the schedule AFTER Peter has approved, and the comment step additionally
 * waits until it can SEE the video is public — which only Peter, in Studio,
 * can make happen.
 *
 * EVERY STEP IS IDEMPOTENT AND RECORDED. The sweep runs on a cron, so each
 * step checks before it acts (is the video already in the playlist? did we
 * already post the comment?) and records what it did in youtube-log.json.
 * A step that fails is reported and retried next run; a step that fails
 * FOREVER is visible in the log as never-completed, not silently absent.
 */

import { readFileSync, existsSync } from "fs";

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

/**
 * The real YouTube video id, out of a Metricool post read-back.
 *
 * Ported from probe-youtube-video-id.mjs, which established the shape:
 * `providers[]` on the post, network "youtube", `id` carrying the watch id.
 * WHETHER a real private long-form post actually carries it is on the
 * known-unknowns register — the probe proved the shape on what it could
 * create, and video 1 is the first real subject.
 */
export function videoIdFromPost(post) {
  const yt = (post?.providers || []).find((p) => String(p?.network || "").toUpperCase() === "YOUTUBE");
  const id = String(yt?.id || "").trim();
  // A watch id is 11 URL-safe base64 characters. Anything else is a Metricool
  // internal id, and treating one as a YouTube id would 404 every API call.
  return /^[\w-]{11}$/.test(id) ? id : null;
}

/** Playlist per market — how binge sessions happen. Deterministic, no model. */
export function playlistTitleFor({ market, intent } = {}) {
  const city = market === "austin" ? "Austin" : "San Antonio";
  const angle = {
    relocation: `Moving to ${city}`,
    comparison: `${city} Compared`,
    cost_of_living: `What ${city} Actually Costs`,
    neighborhood: `${city} Neighborhoods`,
    new_build: `New Construction in ${city}`,
  }[intent];
  return angle || `Moving to ${city}`;
}

// ─── the API client, injectable everywhere ──────────────────────────────────

export async function accessToken({ fetchImpl = fetch, env = process.env } = {}) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YT_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error("distribution needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and YT_REFRESH_TOKEN");
  }
  const res = await fetchImpl(OAUTH_URL, {
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

async function yt(fetchImpl, token, method, path, { query = {}, body = null, headers = {} } = {}) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetchImpl(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || json?.error?.message || res.status;
    const err = new Error(`${method} ${path} failed: ${reason}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return json;
}

/** The video's privacy status — the gate the comment step waits behind. */
export async function videoStatus(videoId, { fetchImpl = fetch, token }) {
  const res = await yt(fetchImpl, token, "GET", "videos", { query: { part: "status", id: videoId } });
  const item = res.items?.[0];
  if (!item) return { exists: false, privacy: null };
  // The full status object rides along so a videos.update can send it BACK
  // with one field changed — part=status REPLACES the whole part, and an
  // update built from scratch silently resets embeddable, license, and the
  // synthetic-media declaration to their defaults.
  return { exists: true, privacy: item.status?.privacyStatus || null, status: item.status || {} };
}

/**
 * Flip a private upload to PUBLIC — the step that makes Approve mean publish.
 *
 * THE DESIGN CHANGED HERE, on Peter's explicit call (2026-08-19). The shipped
 * flow uploaded private, set the thumbnail and playlist by API, and then
 * stopped: "publishing remains Peter's to do in Studio". He approved video 1,
 * read that line on the card, and overruled it — Approve IS publish; the
 * Studio trip is the violation, not the safety. The privacy flip is one
 * videos.update away and uses the same token the thumbnail already uses.
 *
 * SAFETY DID NOT MOVE, IT MOVED HOUSES. assertPrivate still guards the
 * UPLOAD — nothing reaches YouTube public by accident. What changed is what
 * an explicit human approval does afterwards. This function is only ever
 * reached from the sweep's approved-entries filter, TEST- ids excluded.
 *
 * The synthetic-content declaration rides the same update when the render
 * used the voice clone: YouTube's policy wants it set before the video is
 * public, and `containsSyntheticMedia` is exactly the field the manual
 * checklist used to point at.
 */
export async function publishVideo(videoId, { declareSynthetic = false, fetchImpl = fetch, token }) {
  const current = await videoStatus(videoId, { fetchImpl, token });
  if (!current.exists) throw new Error("video not visible to the API yet");
  if (current.privacy === "public") return { already: "public" };

  const status = { ...current.status, privacyStatus: "public" };
  delete status.publishAt; // a leftover schedule field conflicts with an immediate flip
  if (declareSynthetic) status.containsSyntheticMedia = true;

  const res = await yt(fetchImpl, token, "PUT", "videos", {
    query: { part: "status" },
    body: { id: videoId, status },
  });
  const got = res.items?.[0]?.status?.privacyStatus || res?.status?.privacyStatus;
  return { published: true, privacy: got || "public", declaredSynthetic: Boolean(declareSynthetic) };
}

/**
 * Set the custom thumbnail. Works while the video is still private, so it runs
 * at the first sweep after approval — before Peter even opens Studio.
 */
export async function setThumbnail(videoId, pngPath, { fetchImpl = fetch, token }) {
  if (!existsSync(pngPath)) throw new Error(`thumbnail file missing: ${pngPath}`);
  const png = readFileSync(pngPath);
  // The file may be a JPEG — fitUnderLimit converts when the PNG exceeds
  // YouTube's 2MB thumbnail cap. Declaring a JPEG as image/png is the same
  // wrong-mimeType class the ingest warns about from the other direction.
  const contentType = /\.jpe?g$/i.test(pngPath) ? "image/jpeg" : "image/png";
  const url = `${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType, "Content-Length": String(png.length) },
    body: png,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || res.status;
    // The account-not-verified rejection is a known possibility and belongs in
    // the report, not in a stack trace.
    throw new Error(`thumbnails.set failed: ${reason}`);
  }
  return { set: true };
}

/** Find-or-create the playlist. Public: a private playlist cannot drive binge. */
export async function ensurePlaylist(title, { fetchImpl = fetch, token, description = "" }) {
  let page;
  do {
    page = await yt(fetchImpl, token, "GET", "playlists", {
      query: { part: "snippet", mine: "true", maxResults: "50", ...(page?.nextPageToken ? { pageToken: page.nextPageToken } : {}) },
    });
    const hit = (page.items || []).find((p) => (p.snippet?.title || "").trim().toLowerCase() === title.trim().toLowerCase());
    if (hit) return { id: hit.id, created: false };
  } while (page.nextPageToken);

  const created = await yt(fetchImpl, token, "POST", "playlists", {
    query: { part: "snippet,status" },
    body: { snippet: { title, description }, status: { privacyStatus: "public" } },
  });
  return { id: created.id, created: true };
}

/** Add the video, once. The existence check is what makes the cron safe. */
export async function addToPlaylist(playlistId, videoId, { fetchImpl = fetch, token }) {
  const existing = await yt(fetchImpl, token, "GET", "playlistItems", {
    query: { part: "snippet", playlistId, videoId, maxResults: "1" },
  });
  if ((existing.items || []).length > 0) return { added: false, already: true };

  await yt(fetchImpl, token, "POST", "playlistItems", {
    query: { part: "snippet" },
    body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
  });
  return { added: true, already: false };
}

/**
 * Post the pinned-comment text as a top-level comment.
 *
 * The API cannot pin it — that is Peter's one click in Studio, and the review
 * checklist says so. Idempotency is by content: if a comment from the channel
 * starting with the same first line already exists, it was posted by an
 * earlier sweep and must not be posted twice.
 */
export async function postComment(videoId, text, { fetchImpl = fetch, token }) {
  const firstLine = String(text || "").split("\n")[0].trim();
  if (!firstLine) throw new Error("refusing to post an empty comment");

  const existing = await yt(fetchImpl, token, "GET", "commentThreads", {
    query: { part: "snippet", videoId, maxResults: "50", textFormat: "plainText" },
  }).catch((err) => {
    // commentsDisabled here means the video is still private — the caller
    // gates on status first, so this is belt to that braces.
    if (err.reason === "commentsDisabled") return { items: [], commentsDisabled: true };
    throw err;
  });
  if (existing.commentsDisabled) return { posted: false, why: "comments disabled (video still private?)" };

  const mine = (existing.items || []).some((t) =>
    String(t.snippet?.topLevelComment?.snippet?.textOriginal || "").trim().startsWith(firstLine)
  );
  if (mine) return { posted: false, already: true };

  const res = await yt(fetchImpl, token, "POST", "commentThreads", {
    query: { part: "snippet" },
    body: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
  });
  return { posted: true, commentId: res.id };
}

// ─── the sweep ──────────────────────────────────────────────────────────────

/**
 * Run every outstanding distribution step for one approved video.
 *
 * Returns a per-step report; throws only on setup failures (no token). Steps
 * fail INDIVIDUALLY — a thumbnail rejection must not stop the playlist add —
 * and the caller merges `done` into the log so completed steps never rerun.
 *
 * @param {object} entry   the youtube-log entry (needs youtubeVideoId)
 * @param {object} opts    { token, fetchImpl, thumbnailPath, pinnedComment, market, intent }
 */
export async function distributeVideo(entry, opts) {
  const { token, fetchImpl = fetch } = opts;
  const already = entry.distribution || {};
  const report = { videoId: entry.youtubeVideoId, steps: {}, pendingPublic: false };

  if (!entry.youtubeVideoId) {
    return { ...report, steps: {}, blocked: "no YouTube video id on the log entry yet" };
  }

  const step = async (name, alreadyDone, fn) => {
    if (alreadyDone) {
      report.steps[name] = { done: true, already: true };
      return;
    }
    try {
      report.steps[name] = { done: true, ...(await fn()) };
    } catch (err) {
      report.steps[name] = { done: false, error: err.message };
    }
  };

  // Thumbnail and playlist work while the video is private.
  await step("thumbnail", already.thumbnail?.done, async () => {
    if (!opts.thumbnailPath) return { skipped: "no thumbnail was generated for this video" };
    return setThumbnail(entry.youtubeVideoId, opts.thumbnailPath, { fetchImpl, token });
  });

  await step("playlist", already.playlist?.done, async () => {
    const title = playlistTitleFor({ market: opts.market ?? entry.market, intent: opts.intent ?? entry.intent });
    const playlist = await ensurePlaylist(title, { fetchImpl, token, description: `Real answers for people moving to ${entry.market === "austin" ? "Austin" : "San Antonio"}.` });
    const added = await addToPlaylist(playlist.id, entry.youtubeVideoId, { fetchImpl, token });
    return { playlistId: playlist.id, playlistTitle: title, createdPlaylist: playlist.created, ...added };
  });

  // APPROVE IS PUBLISH. Thumbnail and playlist have already landed above, so
  // the video goes public wearing the right face. Runs only for entries the
  // sweep already filtered to approved.
  await step("publish", already.publish?.done, async () => {
    return publishVideo(entry.youtubeVideoId, { declareSynthetic: Boolean(opts.declareSynthetic), fetchImpl, token });
  });

  // The comment lands in the SAME pass now — publish just made the video
  // public one step up. The waiting branch survives for the odd propagation
  // delay; the sweep comes back on the next cron.
  await step("comment", already.comment?.done, async () => {
    const status = await videoStatus(entry.youtubeVideoId, { fetchImpl, token });
    if (!status.exists) throw new Error("video not visible to the API yet");
    if (status.privacy !== "public" && status.privacy !== "unlisted") {
      report.pendingPublic = true;
      return { waiting: `video is still ${status.privacy} — comment posts after Peter publishes` };
    }
    if (!opts.pinnedComment) return { skipped: "no pinned-comment text on the packaging" };
    return postComment(entry.youtubeVideoId, opts.pinnedComment, { fetchImpl, token });
  });

  return report;
}

/** Which steps are genuinely finished, for merging into the log entry. */
export function completedSteps(report) {
  const out = {};
  for (const [name, r] of Object.entries(report.steps || {})) {
    // "waiting" is not done; "skipped" IS done — there is nothing to retry.
    if (r.done && !r.waiting) out[name] = { done: true, at: new Date().toISOString(), detail: r };
  }
  return out;
}
