/**
 * linkedin-claim.js — claim the day's LinkedIn slot ON ORIGIN/MAIN before posting.
 *
 * WHY THIS EXISTS — the duplicate posted six times before this shipped
 * (2026-08-05, 06, 07, 08, and twice-discovered 08-09), same topic twice a day,
 * ~45 minutes apart, on three real LinkedIn accounts. Every prior guard was a
 * CHECK; none of them was a CLAIM, and the gap between checking and being seen
 * is exactly where all six duplicates lived:
 *
 *  1. The in-memory guard reads the checkout's posted-log.json. actions/checkout
 *     pins to the SHA the run was CREATED at — so a backup cron queued behind
 *     its primary by the concurrency group still checks out a log from BEFORE
 *     the primary pushed. Serialization never propagates state. (This is why
 *     the youtube-longform-style concurrency group, in place since 2026-07-12,
 *     did not save us: on 2026-08-09 the queued job started 2 seconds after its
 *     sibling finished and still posted a duplicate 12 minutes later.)
 *
 *  2. The live re-read (checkRemoteLinkedin, shipped 2026-08-09 19:58 UTC —
 *     one minute AFTER that day's duplicate was already in flight on old code)
 *     closes hole 1 but is still check-then-act: the posting run only pushes
 *     its log entry at the END of the job, up to 8 minutes after the post
 *     (there is a 7-minute verification sleep in between), and a cancellation
 *     or a merge-log-push failure in that window loses the entry entirely —
 *     merge-log-push.mjs literally prints "Double-post risk!" on that path.
 *
 * THE FIX: write the log entry FIRST, post SECOND. The GitHub Contents API PUT
 * is compare-and-swap on the file's blob SHA — if anything else touched
 * posted-log.json since we read it, the PUT fails with a conflict, we re-read,
 * re-run the 20-hour guard against the fresh content, and either retry or step
 * back. Two racing runs cannot both win: the loser's conflict IS the winner's
 * claim landing. Once the claim commit is on main, every other guard in the
 * system (checkout, live read, this module) sees it immediately, and a crash
 * or cancellation after the claim can only SKIP a post, never duplicate one.
 *
 * FAIL-CLOSED, deliberately reversing checkRemoteLinkedin's fail-open stance:
 * a claim you cannot take is a lock you do not hold. If GitHub's API is down
 * we skip the day's recruiting post and page the owner (the caller notifies) —
 * after six duplicates, a missed post is the cheaper failure.
 *
 * Lifecycle: claimLinkedinSlot() → postToLinkedin() →
 *   success → finalizeLinkedinClaim() fills in topic/brands on the claim entry
 *   failure → releaseLinkedinClaim() removes it so tomorrow-today isn't blocked.
 * A finalize/release that itself fails leaves the claim in place: duplicates
 * stay impossible and the stale claim expires from the guard after 20 hours.
 *
 * Every function takes an options bag with injectable fetch/token/clock so the
 * CAS behaviour is testable without a network (see tests/linkedin-claim.test.mjs).
 */

import { hasRecentLinkedinPost } from "./state.js";

const API_ROOT = "https://api.github.com";
const DEFAULT_REPO = process.env.GITHUB_REPOSITORY || "PropertyPete1/lifestyle-design-studio";
const FILE_PATH = "auto-poster/posted-log.json";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 2000;

/** Same bot identity the workflow's commit step uses. */
const COMMITTER = { name: "Auto Poster Bot", email: "bot@lifestyle-design.com" };

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function contentsUrl(repo, query = "") {
  return `${API_ROOT}/repos/${repo}/contents/${FILE_PATH}${query}`;
}

function withDefaults(options) {
  return {
    fetchImpl: options.fetchImpl || fetch,
    token: options.token !== undefined ? options.token : process.env.GITHUB_TOKEN,
    repo: options.repo || DEFAULT_REPO,
    runId: options.runId !== undefined ? options.runId : (process.env.GITHUB_RUN_ID || "local"),
    now: options.now || (() => new Date()),
    maxAttempts: options.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    backoffMs: options.backoffMs !== undefined ? options.backoffMs : DEFAULT_BACKOFF_MS,
  };
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Read posted-log.json off main via the Contents API (never raw.githubusercontent,
 * which is CDN-cached ~5 min). Returns { log, sha } — the sha is the CAS token.
 */
async function getLogFile({ fetchImpl, token, repo }) {
  const res = await fetchImpl(contentsUrl(repo, `?ref=main&t=${Date.now()}`), {
    headers: apiHeaders(token),
  });
  if (!res.ok) throw new Error(`GET posted-log.json returned ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.sha !== "string") {
    throw new Error("GET posted-log.json returned no blob sha");
  }
  let raw;
  if (typeof body.content === "string" && body.content.length > 0) {
    raw = Buffer.from(body.content, "base64").toString("utf-8");
  } else {
    // Files over ~1MB come back with empty inline content; the raw media type
    // still serves them.
    const rawRes = await fetchImpl(contentsUrl(repo, `?ref=main&t=${Date.now()}`), {
      headers: { ...apiHeaders(token), Accept: "application/vnd.github.raw" },
    });
    if (!rawRes.ok) throw new Error(`raw GET posted-log.json returned ${rawRes.status}`);
    raw = await rawRes.text();
  }
  const log = JSON.parse(raw);
  if (!log || !Array.isArray(log.posts)) {
    // A log we cannot interpret is a guard we cannot run. Fail closed upstream.
    throw new Error("posted-log.json on main has no posts array");
  }
  return { log, sha: body.sha };
}

/**
 * Compare-and-swap write. Returns { ok } on success, { ok:false, conflict:true }
 * when the sha went stale (someone else wrote first — the mechanism working,
 * not an error), and { ok:false, conflict:false, status } for real failures.
 */
async function putLogFile({ fetchImpl, token, repo }, { log, sha, message }) {
  const res = await fetchImpl(contentsUrl(repo), {
    method: "PUT",
    headers: apiHeaders(token),
    body: JSON.stringify({
      message,
      branch: "main",
      sha,
      content: Buffer.from(JSON.stringify(log, null, 2) + "\n", "utf-8").toString("base64"),
      committer: COMMITTER,
    }),
  });
  if (res.ok) return { ok: true };
  // GitHub reports a stale sha as 409; some proxies/older behaviours use 422.
  if (res.status === 409 || res.status === 422) return { ok: false, conflict: true, status: res.status };
  return { ok: false, conflict: false, status: res.status };
}

/**
 * Atomically claim today's LinkedIn slot.
 *
 * Returns exactly one of:
 *   { claimed: true,  timestamp, runId }           — we hold the slot; post now
 *   { claimed: false, conflict: true,  reason }    — already posted/claimed; skip quietly
 *   { claimed: false, conflict: false, reason }    — infrastructure failure; skip LOUDLY
 */
export async function claimLinkedinSlot(options = {}) {
  const cfg = withDefaults(options);
  const hoursAgo = options.hoursAgo || 20;

  if (!cfg.token) {
    return { claimed: false, conflict: false, reason: "no GITHUB_TOKEN — cannot claim the slot" };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (attempt > 1) await sleep(cfg.backoffMs * (attempt - 1));
    try {
      const { log, sha } = await getLogFile(cfg);

      if (hasRecentLinkedinPost(log, hoursAgo)) {
        return {
          claimed: false,
          conflict: true,
          reason: `the live log already has a LinkedIn post or claim within ${hoursAgo}h`,
        };
      }

      const entry = {
        type: "linkedin",
        status: "claimed",
        timestamp: cfg.now().toISOString(),
        runId: cfg.runId,
        success: false,
      };
      log.posts.push(entry);

      const put = await putLogFile(cfg, {
        log,
        sha,
        message: `🔒 LinkedIn slot claim ${entry.timestamp} (run ${cfg.runId})`,
      });
      if (put.ok) {
        console.log(`[LinkedInClaim] ✓ Claimed the daily slot on main (${entry.timestamp})`);
        return { claimed: true, timestamp: entry.timestamp, runId: entry.runId };
      }
      if (put.conflict) {
        // Someone wrote posted-log.json between our read and our write. Loop:
        // the re-read decides whether that someone was a sibling LinkedIn run
        // (guard fires → conflict) or an unrelated video log push (retry).
        console.log(`[LinkedInClaim] CAS conflict on attempt ${attempt} — re-reading the live log`);
        lastError = new Error(`CAS conflict (${put.status})`);
        continue;
      }
      lastError = new Error(`PUT posted-log.json returned ${put.status}`);
      console.warn(`[LinkedInClaim] ${lastError.message} (attempt ${attempt}/${cfg.maxAttempts})`);
    } catch (err) {
      lastError = err;
      console.warn(`[LinkedInClaim] ${err.message} (attempt ${attempt}/${cfg.maxAttempts})`);
    }
  }

  return {
    claimed: false,
    conflict: false,
    reason: `could not claim after ${cfg.maxAttempts} attempts: ${lastError?.message || "unknown error"}`,
  };
}

/** Find the index of OUR claim entry in a posts array, or -1. */
function findClaimIndex(posts, claim) {
  return posts.findIndex(
    (p) => p && p.type === "linkedin" && p.timestamp === claim.timestamp && p.runId === claim.runId
  );
}

/**
 * After a successful post, replace the bare claim with the full audit record
 * (same shape main.js has always written, same timestamp — so the end-of-run
 * merge-log-push dedupes the local copy against it by timestamp).
 *
 * Non-fatal on failure: an unfinalized claim still blocks duplicates; it just
 * carries less audit detail.
 */
export async function finalizeLinkedinClaim(claim, { topic, brands }, options = {}) {
  const cfg = withDefaults(options);
  if (!cfg.token) return { ok: false, reason: "no GITHUB_TOKEN" };

  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (attempt > 1) await sleep(cfg.backoffMs * (attempt - 1));
    try {
      const { log, sha } = await getLogFile(cfg);
      const idx = findClaimIndex(log.posts, claim);
      const record = {
        type: "linkedin",
        topic,
        brands,
        timestamp: claim.timestamp,
        runId: claim.runId,
        success: true,
      };
      if (idx >= 0) log.posts[idx] = record;
      else log.posts.push(record); // claim vanished (log edited?) — the post still happened, record it

      const put = await putLogFile(cfg, {
        log,
        sha,
        message: `🔗 LinkedIn post ${claim.timestamp.slice(0, 10)} (topic: ${topic})`,
      });
      if (put.ok) return { ok: true };
      if (put.conflict) {
        lastError = new Error(`CAS conflict (${put.status})`);
        continue;
      }
      lastError = new Error(`PUT returned ${put.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  console.warn(`[LinkedInClaim] Could not finalize the claim (${lastError?.message}) — it stays as a bare claim, which still blocks duplicates`);
  return { ok: false, reason: lastError?.message };
}

/**
 * After a failed post, remove OUR claim so the slot opens again. Only ever
 * removes an entry still marked status:"claimed" — never a finalized post.
 *
 * If this fails the day's slot stays blocked until the 20h guard expires;
 * the caller should notify, but must NOT post.
 */
export async function releaseLinkedinClaim(claim, options = {}) {
  const cfg = withDefaults(options);
  if (!cfg.token) return { ok: false, reason: "no GITHUB_TOKEN" };

  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (attempt > 1) await sleep(cfg.backoffMs * (attempt - 1));
    try {
      const { log, sha } = await getLogFile(cfg);
      const idx = findClaimIndex(log.posts, claim);
      if (idx < 0 || log.posts[idx].status !== "claimed") {
        return { ok: true, alreadyGone: true };
      }
      log.posts.splice(idx, 1);

      const put = await putLogFile(cfg, {
        log,
        sha,
        message: `🔓 LinkedIn claim released ${claim.timestamp} (post failed)`,
      });
      if (put.ok) {
        console.log(`[LinkedInClaim] Released the claim ${claim.timestamp} after a posting failure`);
        return { ok: true };
      }
      if (put.conflict) {
        lastError = new Error(`CAS conflict (${put.status})`);
        continue;
      }
      lastError = new Error(`PUT returned ${put.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  console.warn(`[LinkedInClaim] Could not release the claim (${lastError?.message}) — today's slot stays blocked (safe direction)`);
  return { ok: false, reason: lastError?.message };
}
