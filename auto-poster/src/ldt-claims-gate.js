/**
 * ldt-claims-gate.js — the honest-claims gate for every generated LDT caption.
 *
 * DOCTRINE: nothing is promised that isn't built. The pinned claims list
 * (ldt-claims.json, mirrored from the sales site's test-pinned copy) is the
 * ONLY permitted source of factual claims, and this gate is the code that
 * makes the doctrine mechanical rather than a prompt suggestion:
 *
 *   1. BANNED PATTERNS — overclaims the site itself bans ("never lies",
 *      "guarantee", retired tier names), volatile facts that go stale
 *      ("2 spots remaining"), and promises that invert the approval-gated
 *      design ("fully autonomous"). Any hit fails the caption.
 *   2. NUMBER HONESTY — reuses the source-respect Gate 3 machinery: every
 *      enforceable figure in the caption must appear, EXACTLY, in the figure
 *      pool derived from the pinned claim sentences. $99 passes because
 *      "Solo: $99/mo" is pinned; $98 fails because nothing pins it. Same
 *      exact-equality rule that keeps voiceovers from saying $2,500,000
 *      over a $2,500 overlay.
 *
 * The gate is deterministic and hermetic — no model may overrule it, and a
 * caption that cannot pass it does not post (the pinned fallback caption is
 * itself gate-checked in tests, so the fallback can never dodge the rules).
 *
 * KNOWN LIMIT — the figure pool is context-free, like the voiceover gate it
 * reuses: a pinned NUMBER passes regardless of the unit or role the caption
 * gives it ("$449 setup" launders the monthly price; "$5K/mo" matches the
 * pinned 5,000-contact count). The prompt carries the unit discipline; the
 * gate guarantees only that no figure exists outside the pinned pool. Claim
 * classes that can be banned mechanically (percent-off discounts, free
 * months, scarcity counts) are banned by pattern instead.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sourceFigureValues, checkNumberHonesty } from "./source-respect.js";

const CLAIMS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "ldt-claims.json");

let cachedClaims = null;

export function loadLdtClaims() {
  if (cachedClaims) return cachedClaims;
  // No fallback here on purpose: a missing/corrupt claims file means the gate
  // cannot know what is true, and a gate that cannot run must stop the lane,
  // not wave it through.
  cachedClaims = JSON.parse(readFileSync(CLAIMS_PATH, "utf-8"));
  return cachedClaims;
}

/** Test seam. */
export function _resetClaimsCache() {
  cachedClaims = null;
}

/**
 * The allowed-figure pool: every number that appears in a pinned claim or
 * pricing line (with the K/M and digit-run expansions sourceFigureValues
 * already knows), plus explicitly listed derived numbers (per-person math the
 * site computes from its own constants).
 */
export function buildAllowedFigures(claims = loadLdtClaims()) {
  const texts = [
    ...(claims.claims || []),
    ...(claims.pricing || []),
    claims.metaAngle?.line || "",
  ];
  for (const n of claims.extraAllowedNumbers || []) texts.push(String(n));
  return sourceFigureValues(texts);
}

/**
 * Check one caption (or any generated LDT copy) against the claims doctrine.
 * Returns { ok, violations: [{ type, detail, why? }] } — empty violations
 * means the text makes no claim the pinned list doesn't back.
 */
export function checkClaimsCompliance(text, claims = loadLdtClaims(), allowedFigures = null) {
  const violations = [];
  const body = String(text || "");

  for (const entry of claims.bannedPatterns || []) {
    let re;
    try {
      re = new RegExp(entry.pattern, "i");
    } catch {
      continue;
    }
    const m = body.match(re);
    if (m) {
      violations.push({ type: "banned_phrase", detail: m[0], why: entry.why || entry.pattern });
    }
  }

  const allowed = allowedFigures || buildAllowedFigures(claims);
  const honesty = checkNumberHonesty(body, allowed);
  if (!honesty.ok) {
    for (const v of honesty.violations) {
      violations.push({ type: "number", detail: `${v.raw} (${v.value})`, why: "figure not backed by the pinned claims list" });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** One line per violation, for retry prompts and run logs. */
export function describeViolations(violations) {
  return (violations || [])
    .map(v => v.type === "number"
      ? `stated figure ${v.detail} is not on the pinned claims list — remove it or use a pinned figure`
      : `banned phrase "${v.detail}" — ${v.why}`)
    .join("; ");
}
