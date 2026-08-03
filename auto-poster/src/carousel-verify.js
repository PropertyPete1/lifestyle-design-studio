/**
 * carousel-verify.js — confirm what actually published.
 *
 * The scheduler returning 200 means it ACCEPTED the post, not that the network
 * published it. On 2026-08-03 the TikTok carousel was logged ok:true and never
 * appeared: Metricool had recorded `status: ERROR, "The 'image/png' type is not
 * allowed"`, and nothing ever read it back. This module closes that gap.
 *
 * Two passes, because publishing is not instant:
 *   1. Shortly after distribution, once the scheduled time has passed.
 *   2. At the start of the next day's run, sweeping anything still pending.
 *
 * A provider that failed logs an Actions ::warning:: carrying the reason
 * Metricool recorded, so the cause is in the run summary rather than buried.
 *
 * Note on states: PENDING and AWAITING_CONFIRMATION are both intermediate.
 * AWAITING_CONFIRMATION looks alarming but was measured resolving to PUBLISHED
 * ~60s later, so it must not be treated as a failure.
 */

import { verifyPostStatus } from "./metricool.js";

/** Terminal states — no later pass will change these. */
const TERMINAL = new Set(["published", "failed", "error", "cancelled", "rejected"]);

export function isTerminal(status) {
  return TERMINAL.has(String(status || "").toLowerCase());
}

/** Normalise a provider block into the shape the log records. */
export function summariseProviders(providers = []) {
  return providers.map((p) => ({
    network: p.network,
    status: p.status,
    detail: p.detailedStatus || null,
    url: p.publicUrl || null,
  }));
}

/**
 * Collapse a post's providers into one verdict.
 *   published — every provider published
 *   failed    — at least one provider errored or failed
 *   pending   — still in flight
 */
export function verdictFor(providers = []) {
  if (providers.length === 0) return "unknown";
  const states = providers.map((p) => String(p.status || "").toLowerCase());
  if (states.some((s) => s === "failed" || s === "error" || s === "rejected")) return "failed";
  if (states.every((s) => s === "published")) return "published";
  return "pending";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify every distribution result that carries a postId.
 *
 * @param {Array}  entries  distribution results — { label, blogId, network, postId }
 * @param {object} opts
 * @param {Function} opts.verify  injectable verifyPostStatus, for tests
 * @param {Function} opts.warn    injectable warning sink, for tests
 * @returns {Array} one record per verified post
 */
export async function verifyDistribution(entries, { verify = verifyPostStatus, warn = defaultWarn } = {}) {
  const out = [];

  for (const entry of entries || []) {
    if (!entry?.postId || entry.postId === "unknown" || entry.skipped) continue;

    let providers = [];
    let error = null;
    try {
      const res = await verify(entry.postId, entry.blogId);
      providers = res?.providers || [];
      if (res?.error) error = res.error;
    } catch (err) {
      error = err.message;
    }

    const verdict = error && providers.length === 0 ? "unknown" : verdictFor(providers);
    const record = {
      label: entry.label,
      network: entry.network,
      postId: entry.postId,
      blogId: entry.blogId,
      verdict,
      providers: summariseProviders(providers),
      checkedAt: new Date().toISOString(),
    };
    if (error) record.error = error;
    out.push(record);

    if (verdict === "failed") {
      const reasons = providers
        .filter((p) => ["failed", "error", "rejected"].includes(String(p.status || "").toLowerCase()))
        .map((p) => `${p.network}: ${p.detailedStatus || p.status}`)
        .join("; ");
      warn(`${entry.label} ${entry.network} did NOT publish (post ${entry.postId}) — ${reasons}`);
    } else if (verdict === "published") {
      console.log(`[Verify] ✓ ${entry.label} ${entry.network} published (post ${entry.postId})`);
    } else {
      console.log(`[Verify] … ${entry.label} ${entry.network} ${verdict} (post ${entry.postId})`);
    }
  }

  return out;
}

/** GitHub Actions surfaces ::warning:: in the run summary. */
function defaultWarn(message) {
  console.log(`::warning::[Carousel] ${message}`);
}

/**
 * Wait for the scheduled posts to settle, then verify — polling, because
 * publishing is not instant and not uniform.
 *
 * Timings come from a live measurement: a TikTok photo post scheduled 120s out
 * sat at PENDING, moved to AWAITING_CONFIRMATION at ~143s, and only reached
 * PUBLISHED at ~204s past its scheduled time. AWAITING_CONFIRMATION is an
 * intermediate state, not a terminal one, so a single early check would record
 * a healthy post as pending and defer it a whole day for no reason.
 *
 * Anything still unsettled when the attempts run out is left pending for the
 * next run to sweep.
 */
export async function verifyAfterSettling(entries, {
  waitMs = 180_000,
  pollIntervalMs = 90_000,
  maxPolls = 3,
  sleepFn = sleep,
  ...opts
} = {}) {
  if (!entries?.some((e) => e.postId && e.postId !== "unknown" && !e.skipped)) {
    console.log("[Verify] nothing to verify");
    return [];
  }

  console.log(`[Verify] waiting ${Math.round(waitMs / 1000)}s for the scheduled posts to publish...`);
  await sleepFn(waitMs);

  let records = await verifyDistribution(entries, opts);
  for (let poll = 1; poll < maxPolls; poll++) {
    const unsettled = records.filter((r) => r.verdict === "pending");
    if (unsettled.length === 0) break;
    console.log(`[Verify] ${unsettled.length} still unsettled — re-checking in ${Math.round(pollIntervalMs / 1000)}s`);
    await sleepFn(pollIntervalMs);

    const retried = await verifyDistribution(
      entries.filter((e) => unsettled.some((u) => String(u.postId) === String(e.postId))),
      opts
    );
    const byId = new Map(retried.map((r) => [String(r.postId), r]));
    records = records.map((r) => byId.get(String(r.postId)) || r);
  }
  return records;
}

/**
 * Merge verification records into a log entry's distribution array.
 *
 * Matched on postId. `ok` is left as the scheduler reported it, because it
 * means "accepted" and that is still true — `verified` is the separate,
 * stronger claim, and conflating them is what hid the TikTok failure.
 */
export function applyVerification(entry, records) {
  if (!entry || !Array.isArray(entry.distribution)) return entry;
  const byId = new Map((records || []).map((r) => [String(r.postId), r]));

  const distribution = entry.distribution.map((d) => {
    const rec = d.postId ? byId.get(String(d.postId)) : null;
    if (!rec) return d;
    return {
      ...d,
      verified: rec.verdict === "published",
      verdict: rec.verdict,
      verifiedAt: rec.checkedAt,
      ...(rec.verdict === "failed" ? { failureReason: failureReasonOf(rec) } : {}),
      ...(publicUrlOf(rec) ? { publicUrl: publicUrlOf(rec) } : {}),
    };
  });

  const anyFailed = distribution.some((d) => d.verdict === "failed");
  const anyPending = distribution.some((d) => d.verdict === "pending");

  return {
    ...entry,
    distribution,
    verification: {
      checkedAt: new Date().toISOString(),
      anyFailed,
      // Something still in flight needs the next run to look again.
      pendingRecheck: anyPending,
    },
  };
}

function failureReasonOf(rec) {
  const bad = (rec.providers || []).find((p) =>
    ["failed", "error", "rejected"].includes(String(p.status || "").toLowerCase())
  );
  return bad ? bad.detail || bad.status : "unknown";
}

function publicUrlOf(rec) {
  const ok = (rec.providers || []).find((p) => p.url);
  return ok ? ok.url : null;
}

/**
 * Re-check the previous run's entries that were still pending.
 *
 * Runs at the start of the next day's job, so a post that published slowly, or
 * failed after the first pass gave up, still gets recorded truthfully.
 */
export async function recheckPending(log, opts = {}) {
  const posts = log?.posts || [];
  const stale = posts.filter((p) => p.verification?.pendingRecheck || !p.verification);
  if (stale.length === 0) return { log, rechecked: 0 };

  // Only the most recent few are worth re-reading; older ones are settled.
  const targets = stale.slice(-3);
  let rechecked = 0;
  const updated = [...posts];

  for (const entry of targets) {
    const pending = (entry.distribution || []).filter(
      (d) => d.postId && !d.skipped && d.verdict !== "published" && d.verdict !== "failed"
    );
    if (pending.length === 0) continue;

    console.log(`[Verify] re-checking ${pending.length} unresolved post(s) from ${entry.date}`);
    const records = await verifyDistribution(pending, opts);
    const idx = updated.indexOf(entry);
    if (idx !== -1) updated[idx] = applyVerification(entry, records);
    rechecked += records.length;
  }

  return { log: { ...log, posts: updated }, rechecked };
}
