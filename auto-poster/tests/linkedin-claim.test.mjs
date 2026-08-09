import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimLinkedinSlot, finalizeLinkedinClaim, releaseLinkedinClaim } from "../src/linkedin-claim.js";
import { mergePostedLog } from "../merge-strategies.mjs";

/**
 * A fake GitHub Contents API with REAL compare-and-swap semantics: every write
 * bumps a version, the blob sha derives from the version, and a PUT carrying a
 * stale sha gets 409. This is the exact contract the claim relies on, so if
 * these tests pass, the only way production can differ is GitHub itself
 * breaking CAS.
 */
function fakeGitHub(initialLog) {
  const state = {
    raw: JSON.stringify(initialLog, null, 2) + "\n",
    version: 0,
  };
  const shaOf = (v) => `fake-sha-${v}`;
  const calls = { gets: 0, puts: 0 };
  const commits = [];

  const fetchImpl = async (url, init = {}) => {
    if (!init.method || init.method === "GET") {
      calls.gets++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: shaOf(state.version),
          content: Buffer.from(state.raw, "utf-8").toString("base64"),
        }),
      };
    }
    if (init.method === "PUT") {
      calls.puts++;
      const body = JSON.parse(init.body);
      if (body.sha !== shaOf(state.version)) {
        return { ok: false, status: 409, json: async () => ({}) };
      }
      state.raw = Buffer.from(body.content, "base64").toString("utf-8");
      state.version++;
      commits.push(body.message);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected method ${init.method}`);
  };

  return {
    fetchImpl,
    calls,
    commits,
    current: () => JSON.parse(state.raw),
    // Simulate someone else (another job's merge-log-push) landing a commit.
    externalWrite: (mutate) => {
      const log = JSON.parse(state.raw);
      mutate(log);
      state.raw = JSON.stringify(log, null, 2) + "\n";
      state.version++;
    },
  };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const OPTS = (gh, extra = {}) => ({
  fetchImpl: gh.fetchImpl,
  token: "test-token",
  runId: "run-1",
  backoffMs: 0,
  ...extra,
});

describe("claiming the LinkedIn slot", () => {
  test("a clean log gets claimed, and the claim is a blocking linkedin entry", async () => {
    const gh = fakeGitHub({ posts: [] });
    const res = await claimLinkedinSlot(OPTS(gh));

    assert.equal(res.claimed, true);
    const posts = gh.current().posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].type, "linkedin");
    assert.equal(posts[0].status, "claimed");
    assert.equal(posts[0].timestamp, res.timestamp);
    assert.match(gh.commits[0], /LinkedIn slot claim/);
  });

  test("a post 45 minutes ago on main blocks the claim without writing", async () => {
    const gh = fakeGitHub({ posts: [{ type: "linkedin", timestamp: hoursAgo(0.75) }] });
    const res = await claimLinkedinSlot(OPTS(gh));

    assert.equal(res.claimed, false);
    assert.equal(res.conflict, true, "an existing post is a conflict, not an infrastructure failure");
    assert.equal(gh.calls.puts, 0, "a blocked claim must not write anything");
  });

  test("a bare claim from another run blocks exactly like a finished post", async () => {
    const gh = fakeGitHub({
      posts: [{ type: "linkedin", status: "claimed", timestamp: hoursAgo(0.1), runId: "other-run", success: false }],
    });
    const res = await claimLinkedinSlot(OPTS(gh));
    assert.equal(res.claimed, false);
    assert.equal(res.conflict, true);
  });

  test("a post 21 hours ago does not block", async () => {
    const gh = fakeGitHub({ posts: [{ type: "linkedin", timestamp: hoursAgo(21) }] });
    const res = await claimLinkedinSlot(OPTS(gh));
    assert.equal(res.claimed, true);
    assert.equal(gh.current().posts.length, 2);
  });

  test("THE INCIDENT SHAPE: two concurrent runs both read a clean log — exactly one posts", async () => {
    // This is what actually happened six times: two runs, each convinced
    // nothing was posted today, because each read a snapshot from before the
    // other's write. With check-then-act both proceed. With claim-before-post
    // the loser's PUT 409s against the winner's commit, its re-read shows the
    // winner's claim, and it stands down.
    const gh = fakeGitHub({ posts: [] });

    // Barrier: hold the first two GETs until BOTH runs have read the same
    // clean snapshot — the worst-case interleaving.
    const parked = [];
    let raced = false;
    const gatedFetch = (url, init = {}) => {
      const isGet = !init.method || init.method === "GET";
      if (isGet && !raced) {
        return new Promise((resolve) => {
          parked.push(() => resolve(gh.fetchImpl(url, init)));
          if (parked.length === 2) {
            raced = true;
            for (const release of parked) release();
          }
        });
      }
      return gh.fetchImpl(url, init);
    };

    const [a, b] = await Promise.all([
      claimLinkedinSlot(OPTS(gh, { fetchImpl: gatedFetch, runId: "primary" })),
      claimLinkedinSlot(OPTS(gh, { fetchImpl: gatedFetch, runId: "backup" })),
    ]);

    const winners = [a, b].filter((r) => r.claimed);
    const losers = [a, b].filter((r) => !r.claimed);
    assert.equal(winners.length, 1, "exactly one run may hold the slot");
    assert.equal(losers.length, 1);
    assert.equal(losers[0].conflict, true, "the loser saw the winner's claim, not an error");

    const liEntries = gh.current().posts.filter((p) => p.type === "linkedin");
    assert.equal(liEntries.length, 1, "the log must show ONE claim, never two");
  });

  test("an unrelated commit between read and write is retried, not surrendered", async () => {
    // Another city's merge-log-push landing a VIDEO entry mid-claim must not
    // cost the day's recruiting post: 409 → re-read → still no LinkedIn → retry.
    const gh = fakeGitHub({ posts: [] });
    let interfered = false;
    const interferingFetch = (url, init = {}) => {
      if (init.method === "PUT" && !interfered) {
        interfered = true;
        gh.externalWrite((log) => log.posts.push({ city: "austin", timestamp: hoursAgo(0.01) }));
      }
      return gh.fetchImpl(url, init);
    };

    const res = await claimLinkedinSlot(OPTS(gh, { fetchImpl: interferingFetch }));
    assert.equal(res.claimed, true);
    assert.equal(gh.calls.puts, 2, "first PUT 409s against the video commit, second wins");
    const posts = gh.current().posts;
    assert.equal(posts.length, 2, "both the video entry and the claim survive");
  });

  test("FAIL-CLOSED: an unreachable GitHub means no claim and therefore no post", async () => {
    const deadFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    const res = await claimLinkedinSlot({ fetchImpl: deadFetch, token: "t", backoffMs: 0, maxAttempts: 2 });

    assert.equal(res.claimed, false);
    assert.equal(res.conflict, false, "an API failure must surface as a failure, so the caller pages the owner");
    assert.match(res.reason, /2 attempts/);
  });

  test("FAIL-CLOSED: a missing GITHUB_TOKEN cannot post", async () => {
    const res = await claimLinkedinSlot({ token: null });
    assert.equal(res.claimed, false);
    assert.equal(res.conflict, false);
  });

  test("FAIL-CLOSED: a log that cannot be interpreted cannot be claimed", async () => {
    // A guard that can't read the record must not guess. Both directions of
    // garbage: unparseable JSON, and JSON with no posts array.
    for (const raw of ["not json at all", JSON.stringify({ nothing: true })]) {
      const garbledFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sha: "s", content: Buffer.from(raw).toString("base64") }),
      });
      const res = await claimLinkedinSlot({ fetchImpl: garbledFetch, token: "t", backoffMs: 0, maxAttempts: 2 });
      assert.equal(res.claimed, false);
      assert.equal(res.conflict, false);
    }
  });
});

describe("finalizing and releasing a claim", () => {
  test("finalize upgrades the bare claim in place to the full audit record", async () => {
    const gh = fakeGitHub({ posts: [{ city: "san_antonio", timestamp: hoursAgo(3) }] });
    const claim = await claimLinkedinSlot(OPTS(gh));
    assert.equal(claim.claimed, true);

    const fin = await finalizeLinkedinClaim(
      claim,
      { topic: "lead_overflow", brands: [{ label: "Peter", publishAt: "2026-08-10T14:00:00" }] },
      OPTS(gh)
    );
    assert.equal(fin.ok, true);

    const posts = gh.current().posts;
    assert.equal(posts.length, 2, "the claim was replaced, not duplicated");
    const li = posts.find((p) => p.type === "linkedin");
    assert.equal(li.status, undefined, "a finalized entry is a plain post, not a claim");
    assert.equal(li.success, true);
    assert.equal(li.topic, "lead_overflow");
    assert.equal(li.timestamp, claim.timestamp, "the timestamp survives so merge-log-push dedupes the local copy");
  });

  test("finalize survives a CAS conflict from a concurrent unrelated commit", async () => {
    const gh = fakeGitHub({ posts: [] });
    const claim = await claimLinkedinSlot(OPTS(gh));

    let interfered = false;
    const interferingFetch = (url, init = {}) => {
      if (init.method === "PUT" && !interfered) {
        interfered = true;
        gh.externalWrite((log) => log.posts.push({ city: "dallas", timestamp: hoursAgo(0.01) }));
      }
      return gh.fetchImpl(url, init);
    };
    const fin = await finalizeLinkedinClaim(claim, { topic: "team_wins", brands: [] }, OPTS(gh, { fetchImpl: interferingFetch }));
    assert.equal(fin.ok, true);
    assert.equal(gh.current().posts.filter((p) => p.type === "linkedin").length, 1);
  });

  test("release removes OUR bare claim so a re-run can post today", async () => {
    const gh = fakeGitHub({ posts: [] });
    const claim = await claimLinkedinSlot(OPTS(gh));

    const rel = await releaseLinkedinClaim(claim, OPTS(gh));
    assert.equal(rel.ok, true);
    assert.equal(gh.current().posts.length, 0, "the failed run's claim is gone");
  });

  test("release never deletes a finalized post", async () => {
    const gh = fakeGitHub({ posts: [] });
    const claim = await claimLinkedinSlot(OPTS(gh));
    await finalizeLinkedinClaim(claim, { topic: "deal_story", brands: [] }, OPTS(gh));

    const rel = await releaseLinkedinClaim(claim, OPTS(gh));
    assert.equal(rel.ok, true);
    assert.equal(rel.alreadyGone, true);
    assert.equal(gh.current().posts.length, 1, "the real post record survives a spurious release");
  });

  test("a release that cannot reach GitHub reports failure so the caller can page", async () => {
    const gh = fakeGitHub({ posts: [] });
    const claim = await claimLinkedinSlot(OPTS(gh));
    const deadFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });

    const rel = await releaseLinkedinClaim(claim, { fetchImpl: deadFetch, token: "t", backoffMs: 0, maxAttempts: 2 });
    assert.equal(rel.ok, false);
  });
});

describe("the claim and merge-log-push agree on ownership of the entry", () => {
  test("the local mirror of a finalized claim dedupes away in the merge", () => {
    // main.js writes the same record locally under the claim's timestamp; the
    // end-of-run merge must keep exactly one copy (the remote one).
    const ts = hoursAgo(0.5);
    const remote = { posts: [{ type: "linkedin", topic: "wish_i_knew", timestamp: ts, success: true }] };
    const local = { posts: [{ type: "linkedin", topic: "wish_i_knew", timestamp: ts, success: true }] };

    const merged = mergePostedLog(local, remote, () => {});
    assert.equal(merged.posts.filter((p) => p.type === "linkedin").length, 1);
  });
});
