/**
 * reel-verify.js — confirm what the REELS path actually published.
 *
 * The reels path carried the blind spot the carousel path was fixed for on
 * 2026-08-03: the scheduler returning 200 means Metricool ACCEPTED the post, not
 * that Instagram, TikTok or YouTube published it. main.js did read a status back
 * for its own alerting, but it recorded only a pass/fail summary — so the log
 * entry's evidence of destination stayed `platforms: ["tiktok","youtube",
 * "satellite_ig"]`, a hardcoded literal written whenever the run reached that
 * line. Nothing downstream could tell an accepted post from a published one, and
 * social-telemetry.js therefore reported tiktok and youtube_shorts as unknown
 * every single day. That was the truth, and this module is what changes it.
 *
 * It turns Metricool's per-provider status into the SAME per-network verdict rows
 * carousel-verify.js writes — { network, verdict, label, postId } — so one
 * reader in social-telemetry.js counts both pipelines and a reel publication
 * finally counts as a publication.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO HARD RULES, because this runs on the live posting path.
 *
 * 1. IT NEVER POSTS. The only Metricool call it can reach is the GET behind
 *    verifyPostStatus, and it only ever runs AFTER createPost has returned.
 *    Nothing here retries, re-uploads or reschedules: a post that did not
 *    publish is reported to Peter for a manual fix and never re-sent, because
 *    a re-send against a post that actually did publish is a double-post.
 *
 * 2. IT NEVER FAILS THE RUN. A verification error is an absence of evidence, not
 *    evidence of absence — an unreachable API, a 500, a body that does not
 *    parse all land as `unknown`, and the entry keeps the "accepted by the
 *    scheduler" claim it already had. The video is posted by the time this code
 *    runs; nothing it observes can un-post it, so nothing it observes is worth
 *    turning a successful post red. The one exception is a provider Metricool
 *    ITSELF reports as FAILED: that is an observed lost slot, a publication
 *    problem rather than a verification one, and main.js keeps alerting on it
 *    exactly as it did before.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERDICTS — one per (brand, network), the same four the carousel writes:
 *
 *   published — Metricool reports that provider PUBLISHED
 *   failed    — Metricool reports FAILED / ERROR / REJECTED
 *   pending   — accepted, still in flight when the polls ran out
 *   unknown   — we could not read a status at all (the API erred)
 *
 * `pending` and `unknown` are deliberately distinct. Both mean "not confirmed",
 * but one says the post is queued and the other says we are blind, and a
 * dashboard that cannot tell those apart is the thing this repo keeps fixing.
 */

import { verifyAfterSettling, verdictFor } from "./carousel-verify.js";

/**
 * How long to let the post settle before the first check.
 *
 * 7 minutes, unchanged from the value main.js used inline, so this rewiring does
 * not alter when anything happens. verifyAfterSettling then polls the stragglers
 * — publishing is neither instant nor uniform, and AWAITING_CONFIRMATION was
 * measured resolving to PUBLISHED ~60s later.
 */
export const REEL_VERIFY_WAIT_MS = 7 * 60 * 1000;

/** Every verdict this module can record, for tests and for readers. */
export const VERDICTS = ["published", "failed", "pending", "unknown"];

/**
 * createPost's per-brand results → the posts worth reading back.
 *
 * A brand whose scheduler call failed has nothing to verify, and "unknown" is
 * the literal string createPost uses when a 200 carried no readable id. Both are
 * dropped rather than queried, which is also what stops this module inventing a
 * postId and reading back somebody else's post.
 */
export function verifyTargets(brands) {
  return (brands || [])
    .filter((b) => b && b.ok && b.postId && b.postId !== "unknown" && !b.skipped)
    .map((b) => ({
      label: b.label,
      blogId: b.blogId,
      postId: b.postId,
      // The networks createPost actually submitted, when it reported them.
      // `networks` is the brand's full connected set and is the fallback: it
      // over-reports for the main brand, whose Instagram is withheld
      // (mainBrandSkipIG) so Peter can post it natively.
      networks: normaliseNetworks(b.providers || b.networks),
      // Read as one row per network in the log, but logged as one line here —
      // a reel is a single Metricool post fanned out across its providers.
      network: "reel",
    }));
}

function normaliseNetworks(networks) {
  const seen = [];
  for (const n of Array.isArray(networks) ? networks : []) {
    const name = String(n || "").trim().toLowerCase();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * One target + its verification record → one row per network.
 *
 * Rows come from the networks the post was SUBMITTED to, so a provider Metricool
 * never mentions still gets a row (as `unknown`) instead of vanishing — a
 * silently missing network reads downstream as "we never tried", which is a
 * different and false claim. When the submitted list is empty, the observed
 * providers are all we have and they define the rows.
 */
export function rowsForTarget(target, record) {
  const observed = new Map(
    (record?.providers || [])
      .filter((p) => p && p.network)
      .map((p) => [String(p.network).trim().toLowerCase(), p])
  );
  const networks = target.networks?.length ? target.networks : [...observed.keys()];
  const checkedAt = record?.checkedAt || new Date().toISOString();

  return networks.map((network) => {
    const provider = observed.get(network);
    const verdict = provider ? verdictFor([provider]) : "unknown";
    const row = {
      label: target.label,
      blogId: target.blogId,
      postId: target.postId,
      network,
      // `ok` stays what the scheduler said — it means ACCEPTED, and that is
      // still true. `verified` is the separate, stronger claim. Conflating the
      // two is what hid the TikTok failure on 2026-08-03.
      ok: true,
      verdict,
      verified: verdict === "published",
      verifiedAt: checkedAt,
    };
    if (provider?.status) row.status = provider.status;
    if (verdict === "failed") row.failureReason = provider.detail || provider.status || "unknown";
    if (provider?.url) row.publicUrl = provider.url;
    // An unknown always says WHY it is unknown. "We could not look" and
    // "Metricool did not mention this network" are different problems, and a row
    // that records neither is indistinguishable from an oversight.
    if (verdict === "unknown") {
      row.error = record?.error
        || (record ? "Metricool reported no status for this network" : "no status was read for this post");
    }
    return row;
  });
}

/** Every target's rows, in the order the brands were posted. */
export function distributionFrom(targets, records) {
  const byId = new Map((records || []).map((r) => [String(r.postId), r]));
  return (targets || []).flatMap((t) => rowsForTarget(t, byId.get(String(t.postId))));
}

/**
 * Collapse the rows into the summary main.js logs and alerts on.
 *
 * `allVerified` keeps the name and meaning main.js already used, so the field a
 * human reads in posted-log.json does not change shape under them.
 */
export function summariseVerification(distribution, records, { checkedAt = new Date().toISOString() } = {}) {
  const counts = { published: 0, failed: 0, pending: 0, unknown: 0 };
  for (const row of distribution || []) {
    if (counts[row.verdict] === undefined) counts[row.verdict] = 0;
    counts[row.verdict] += 1;
  }
  const rows = (distribution || []).length;
  const unresolved = counts.pending + counts.unknown;
  return {
    checkedAt,
    allVerified: rows > 0 && counts.published === rows,
    anyFailed: counts.failed > 0,
    // Nothing sweeps posted-log.json on a later run — mergePostedLog is
    // append-only and keeps the REMOTE copy of an already-pushed timestamp, so
    // an update written tomorrow would be discarded. The flag is recorded for
    // the humans and the dashboard reading the entry, not for a retry.
    pendingRecheck: unresolved > 0,
    counts,
    results: (records || []).map((r) => ({
      label: r.label,
      postId: r.postId,
      blogId: r.blogId,
      verdict: r.verdict,
      providers: r.providers || [],
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}

/** GitHub Actions surfaces ::warning:: in the run summary. */
function defaultWarn(message) {
  console.log(`::warning::[Reels] ${message}`);
}

/**
 * Verify a reel's brands and return what should be written to the log entry.
 *
 * Returns { targets, records, distribution, verification }. `verification` is
 * null only when there was nothing to verify, which is not the same as a check
 * that found nothing.
 *
 * NEVER THROWS — see rule 2 in the header. `settle` and `now` are injectable so
 * the tests can drive every branch without a 7-minute wait or a network call.
 */
export async function verifyReelPublication(brands, {
  waitMs = REEL_VERIFY_WAIT_MS,
  settle = verifyAfterSettling,
  warn = defaultWarn,
  now = () => new Date(),
  ...opts
} = {}) {
  const targets = verifyTargets(brands);
  if (targets.length === 0) {
    console.log("[Verify] no reel posts carried a postId — nothing to verify");
    return { targets: [], records: [], distribution: [], verification: null };
  }

  console.log(`[Verify] Checking ${targets.length} brand(s)...`);
  let records = [];
  try {
    records = (await settle(targets, { waitMs, warn, ...opts })) || [];
  } catch (err) {
    // The settle helper catches per-post errors itself, so reaching here means
    // something broader broke (a timer, a bad response shape). Every row falls
    // back to `unknown` and the run carries on: the reel is already posted.
    console.warn(`[Verify] verification could not run (non-fatal): ${err.message}`);
    records = [];
  }

  const checkedAt = new Date(now()).toISOString();
  const distribution = distributionFrom(targets, records);
  const verification = summariseVerification(distribution, records, { checkedAt });

  for (const row of distribution) {
    const where = `${row.label} ${row.network}`;
    if (row.verdict === "published") console.log(`[Verify] ✓ ${where} published`);
    else if (row.verdict === "failed") console.error(`[Verify] ✗ ${where} FAILED: ${row.failureReason}`);
    else console.warn(`[Verify] … ${where} ${row.verdict}${row.error ? ` (${row.error})` : ""}`);
  }
  console.log(
    `[Verify] ${verification.counts.published} published, ${verification.counts.failed} failed, ` +
    `${verification.counts.pending} pending, ${verification.counts.unknown} unknown`
  );

  return { targets, records, distribution, verification };
}

/**
 * Merge a verification result into a posted-log entry.
 *
 * Pure: returns a new entry. Only `distribution` and `verification` are touched
 * — never the timestamp, the city, the slot or `success`, which are what the
 * duplicate guards read. A verification pass must not be able to move a slot.
 *
 * `platforms` is left exactly as recordPost wrote it. It records INTENT and is
 * load-bearing for older entries; the verdict rows are the outcome, and
 * social-telemetry.js prefers them when they exist.
 */
export function applyReelVerification(entry, result) {
  if (!entry || typeof entry !== "object") return entry;
  if (!result?.verification) return entry;
  return {
    ...entry,
    distribution: result.distribution,
    verification: result.verification,
  };
}

/**
 * The most recent reel entry for a city — the one this run just wrote.
 *
 * LinkedIn posts, trial variants and manual-confirm receipts live in the same
 * array and are not reels, so they are skipped exactly as the duplicate guard
 * skips them.
 */
export function findReelEntryIndex(posts, city) {
  for (let i = (posts?.length || 0) - 1; i >= 0; i--) {
    const p = posts[i];
    if (!p || typeof p !== "object") continue;
    if (p.type || p.platform === "instagram_main_native") continue;
    if (p.city === city) return i;
  }
  return -1;
}
