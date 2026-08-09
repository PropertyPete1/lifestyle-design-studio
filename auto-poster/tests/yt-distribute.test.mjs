import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  videoIdFromPost, playlistTitleFor, ensurePlaylist, addToPlaylist,
  postComment, videoStatus, distributeVideo, completedSteps, accessToken,
} from "../src/yt-distribute.js";

/** A fake YouTube API: routes by URL substring, records every call. */
function fakeYouTube(state = {}) {
  const calls = [];
  const playlists = state.playlists || [];
  const playlistItems = state.playlistItems || [];
  const comments = state.comments || [];
  const impl = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    calls.push({ url: u, method });
    const json = (body, ok = true, status = 200) => ({
      ok, status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    if (u.includes("oauth2.googleapis.com")) return json({ access_token: "tok" });
    if (u.includes("/videos?")) {
      return json({ items: state.videoMissing ? [] : [{ status: { privacyStatus: state.privacy || "private" } }] });
    }
    if (u.includes("/playlists?") && method === "GET") return json({ items: playlists });
    if (u.includes("/playlists?") && method === "POST") {
      const body = JSON.parse(opts.body);
      playlists.push({ id: "PL_NEW", snippet: body.snippet });
      return json({ id: "PL_NEW" });
    }
    if (u.includes("/playlistItems?") && method === "GET") return json({ items: playlistItems });
    if (u.includes("/playlistItems?") && method === "POST") {
      playlistItems.push(JSON.parse(opts.body));
      return json({ id: "PLI_NEW" });
    }
    if (u.includes("/commentThreads?") && method === "GET") {
      if (state.commentsDisabled) {
        return json({ error: { errors: [{ reason: "commentsDisabled" }] } }, false, 403);
      }
      return json({ items: comments });
    }
    if (u.includes("/commentThreads?") && method === "POST") {
      comments.push({ snippet: { topLevelComment: { snippet: { textOriginal: JSON.parse(opts.body).snippet.topLevelComment.snippet.textOriginal } } } });
      return json({ id: "COMMENT_NEW" });
    }
    if (u.includes("/thumbnails/set")) {
      if (state.thumbnailReject) return json({ error: { errors: [{ reason: "forbidden" }] } }, false, 403);
      return json({ kind: "youtube#thumbnailSetResponse" });
    }
    throw new Error(`fake API has no route for ${method} ${u}`);
  };
  return { impl, calls, playlists, playlistItems, comments };
}

describe("videoIdFromPost — the providers[].id read-back", () => {
  test("accepts an 11-character watch id", () => {
    assert.equal(videoIdFromPost({ providers: [{ network: "youtube", id: "dQw4w9WgXcQ" }] }), "dQw4w9WgXcQ");
  });

  test("rejects a Metricool internal id rather than 404ing every later call", () => {
    assert.equal(videoIdFromPost({ providers: [{ network: "youtube", id: "1234567" }] }), null);
    assert.equal(videoIdFromPost({ providers: [{ network: "youtube", id: "" }] }), null);
  });

  test("ignores other networks and survives junk", () => {
    assert.equal(videoIdFromPost({ providers: [{ network: "tiktok", id: "dQw4w9WgXcQ" }] }), null);
    assert.equal(videoIdFromPost(null), null);
    assert.equal(videoIdFromPost({}), null);
  });
});

describe("playlist naming is deterministic", () => {
  test("market and intent map to stable titles", () => {
    assert.equal(playlistTitleFor({ market: "san_antonio", intent: "relocation" }), "Moving to San Antonio");
    assert.equal(playlistTitleFor({ market: "austin", intent: "new_build" }), "New Construction in Austin");
  });
  test("unknown intent falls back to the relocation playlist", () => {
    assert.equal(playlistTitleFor({ market: "san_antonio", intent: "mystery" }), "Moving to San Antonio");
    assert.equal(playlistTitleFor({}), "Moving to San Antonio");
  });
});

describe("ensurePlaylist / addToPlaylist are idempotent", () => {
  test("an existing playlist is reused, case-insensitively", async () => {
    const api = fakeYouTube({ playlists: [{ id: "PL_OLD", snippet: { title: "moving to san antonio" } }] });
    const r = await ensurePlaylist("Moving to San Antonio", { fetchImpl: api.impl, token: "t" });
    assert.deepEqual(r, { id: "PL_OLD", created: false });
    assert.ok(!api.calls.some((c) => c.method === "POST"), "must not create a duplicate");
  });

  test("a missing playlist is created public", async () => {
    const api = fakeYouTube();
    const r = await ensurePlaylist("Moving to San Antonio", { fetchImpl: api.impl, token: "t" });
    assert.equal(r.created, true);
  });

  test("a video already in the playlist is not added twice", async () => {
    const api = fakeYouTube({ playlistItems: [{ snippet: {} }] });
    const r = await addToPlaylist("PL", "dQw4w9WgXcQ", { fetchImpl: api.impl, token: "t" });
    assert.deepEqual(r, { added: false, already: true });
  });
});

describe("postComment", () => {
  test("posts once and never twice — content-keyed idempotency", async () => {
    const api = fakeYouTube({ privacy: "public" });
    const text = "Comment MATH and I'll reply with the breakdown.\nText me: 210-555-0142.";
    const first = await postComment("dQw4w9WgXcQ", text, { fetchImpl: api.impl, token: "t" });
    assert.equal(first.posted, true);
    const second = await postComment("dQw4w9WgXcQ", text, { fetchImpl: api.impl, token: "t" });
    assert.deepEqual(second, { posted: false, already: true });
  });

  test("a disabled comment section reports rather than throwing", async () => {
    const api = fakeYouTube({ commentsDisabled: true });
    const r = await postComment("dQw4w9WgXcQ", "line", { fetchImpl: api.impl, token: "t" });
    assert.equal(r.posted, false);
    assert.match(r.why, /disabled/);
  });

  test("refuses an empty comment", async () => {
    await assert.rejects(() => postComment("dQw4w9WgXcQ", "  ", { fetchImpl: fakeYouTube().impl, token: "t" }));
  });
});

describe("distributeVideo — the sweep", () => {
  const png = join(tmpdir(), `dist-thumb-${Date.now()}.png`);
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const entry = { youtubeVideoId: "dQw4w9WgXcQ", market: "san_antonio", intent: "relocation" };

  test("thumbnail and playlist run while private; the comment WAITS", async () => {
    const api = fakeYouTube({ privacy: "private" });
    const r = await distributeVideo(entry, { token: "t", fetchImpl: api.impl, thumbnailPath: png, pinnedComment: "Comment MATH and I'll reply." });
    assert.equal(r.steps.thumbnail.done, true);
    assert.equal(r.steps.playlist.done, true);
    assert.equal(r.steps.comment.done, true, "waiting is a completed CHECK");
    assert.ok(r.steps.comment.waiting, "but the comment itself must wait for publish");
    assert.equal(r.pendingPublic, true);
    // And a waiting comment must NOT be marked completed for the log.
    assert.equal(completedSteps(r).comment, undefined);
    assert.ok(completedSteps(r).thumbnail);
    assert.ok(completedSteps(r).playlist);
  });

  test("once public, the comment posts", async () => {
    const api = fakeYouTube({ privacy: "public" });
    const r = await distributeVideo(entry, { token: "t", fetchImpl: api.impl, thumbnailPath: png, pinnedComment: "Comment MATH and I'll reply." });
    assert.equal(r.steps.comment.posted, true);
    assert.ok(completedSteps(r).comment);
  });

  test("one failing step does not stop the others", async () => {
    const api = fakeYouTube({ privacy: "public", thumbnailReject: true });
    const r = await distributeVideo(entry, { token: "t", fetchImpl: api.impl, thumbnailPath: png, pinnedComment: "Comment MATH." });
    assert.equal(r.steps.thumbnail.done, false, "the rejection is recorded");
    assert.match(r.steps.thumbnail.error, /forbidden/);
    assert.equal(r.steps.playlist.done, true, "playlist still ran");
    assert.equal(r.steps.comment.posted, true, "comment still ran");
  });

  test("already-completed steps are never re-run", async () => {
    const api = fakeYouTube({ privacy: "public" });
    const done = { ...entry, distribution: { thumbnail: { done: true }, playlist: { done: true }, comment: { done: true } } };
    const r = await distributeVideo(done, { token: "t", fetchImpl: api.impl, thumbnailPath: png, pinnedComment: "x" });
    assert.equal(api.calls.length, 0, `no API call should fire, got ${api.calls.length}`);
    assert.ok(r.steps.thumbnail.already && r.steps.playlist.already && r.steps.comment.already);
  });

  test("a missing video id blocks with a reason instead of guessing", async () => {
    const r = await distributeVideo({ market: "san_antonio" }, { token: "t", fetchImpl: fakeYouTube().impl });
    assert.match(r.blocked, /no YouTube video id/);
  });

  test("a video the API cannot see yet is an error on the comment step only", async () => {
    const api = fakeYouTube({ videoMissing: true });
    const r = await distributeVideo(entry, { token: "t", fetchImpl: api.impl, thumbnailPath: png, pinnedComment: "x" });
    assert.equal(r.steps.comment.done, false);
    assert.match(r.steps.comment.error, /not visible/);
  });
});

describe("accessToken", () => {
  test("names every missing credential rather than failing downstream", async () => {
    await assert.rejects(
      () => accessToken({ fetchImpl: fakeYouTube().impl, env: {} }),
      /GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and YT_REFRESH_TOKEN/
    );
  });

  test("returns the token on success", async () => {
    const tok = await accessToken({
      fetchImpl: fakeYouTube().impl,
      env: { GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", YT_REFRESH_TOKEN: "c" },
    });
    assert.equal(tok, "tok");
  });
});
