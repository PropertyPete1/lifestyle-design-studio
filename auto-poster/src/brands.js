/**
 * brands.js — the multi-brand registry and the two guards built on it.
 *
 * WHY THIS EXISTS
 *
 * Both posting fan-outs (metricool.js createPost and carousel-distribute.js
 * distributeCarousel) discover their targets by enumerating EVERY profile on
 * the Metricool account. Brand membership was "whatever is connected", so the
 * day a second company's Instagram/TikTok gets connected to Metricool, the
 * realty pipeline starts publishing realty reels to it — automatically, within
 * the hour, autoPublish:true. brands.json turns membership into config:
 *
 *   - A brand with `handles` CLAIMS the Metricool profiles matching those
 *     handles. Its lane posts to exactly those profiles and refuses to post
 *     anywhere else (fail-closed: no matching profile = no post).
 *   - The realty brand (`discovery: "unclaimed"`) posts to everything NOT
 *     claimed by another brand — which today is every profile, so realty
 *     behavior is byte-identical until another brand's accounts exist.
 *
 * ENABLED is the pause switch: a brand with `"enabled": false` keeps its
 * claim, its handles and its cadence but posts nothing. It is read ONLY by
 * that brand's own runner — never by the claim path — because an unclaimed
 * profile is a profile the realty fan-out will happily adopt. See
 * brandPostingEnabled below.
 *
 * CADENCE is the anti-spam guard: per-brand, per-platform posts per Chicago
 * calendar day. Default 2. Anything above the hard cap (6) is REFUSED at
 * config-load time — resolveCadence throws, the run goes red before a single
 * byte is uploaded. 3-6 is allowed only because the config file says so
 * explicitly, and every run that honors it logs a warning saying it did.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validPosts } from "./state.js";

const BRANDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "brands.json");

export const DEFAULT_CADENCE_PER_DAY = 2;
export const CADENCE_HARD_CAP_PER_DAY = 6;

/**
 * Built-in fallback registry. If brands.json is missing or unparseable the
 * posting pipelines must not crash — but they must not leak either, so the
 * fallback carries the SAME claim handles as the shipped file. Defense in
 * depth: a corrupted config degrades to identical isolation, loudly.
 */
const FALLBACK_REGISTRY = {
  version: 1,
  cadenceHardCapPerDay: CADENCE_HARD_CAP_PER_DAY,
  brands: {
    realty: { label: "Lifestyle Design Realty", lane: "realty", discovery: "unclaimed" },
    ldt: {
      label: "Lifestyle Design Technologies",
      lane: "ldt",
      // The pause travels with the fallback. If brands.json goes missing or
      // unparseable, the LDT lane must stay DOWN — a config file that fails to
      // read is not consent to start posting again. Flipping the lane back on
      // means editing both, and the test suite says so out loud.
      enabled: false,
      handles: {
        instagram: ["lifestyledesigntechnologies"],
        tiktok: ["lifestyledesigntech"],
      },
      labelPatterns: ["\\bldt\\b", "lifestyle\\s*design\\s*tech"],
      cadence: { instagram: 2, tiktok: 2 },
    },
  },
};

let cachedRegistry = null;

export function loadBrandRegistry() {
  if (cachedRegistry) return cachedRegistry;
  try {
    const parsed = JSON.parse(readFileSync(BRANDS_PATH, "utf-8"));
    if (!parsed || typeof parsed.brands !== "object" || !parsed.brands) {
      throw new Error("brands.json has no brands object");
    }
    cachedRegistry = parsed;
  } catch (err) {
    console.warn(`[Brands] Could not read brands.json (${err.message}) — using built-in fallback registry (same isolation rules)`);
    cachedRegistry = FALLBACK_REGISTRY;
  }
  return cachedRegistry;
}

/**
 * Is this brand's posting lane enabled?
 *
 * The pause switch. A brand with `"enabled": false` in brands.json still
 * exists, still CLAIMS its Metricool profiles, still carries its cadence and
 * handles — it simply does not post. One key, one edit, fully reversible.
 *
 * DEFAULT TRUE: a brand with no `enabled` key is enabled, so introducing this
 * flag changes no existing brand's behavior (realty has no key and never
 * gains one). Only an explicit `true` keeps a lane running once the key is
 * present: any other value — `false`, the STRING "false", 0, null, a typo —
 * reads as PAUSED. The asymmetry is deliberate. The expensive failure here is
 * a lane that keeps publishing to live accounts because someone fat-fingered
 * the value they meant to stop it with; a lane that rests when it should not
 * is noticed by a human within a day and costs nothing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DO NOT CALL THIS FROM THE CLAIM PATH. profileClaimedBy, claimingBrandKey,
 * excludeClaimedProfiles and findBrandProfiles must all behave IDENTICALLY for
 * a paused brand as for a running one. Realty is `discovery: "unclaimed"` — it
 * posts to every profile no other brand claims. The moment a paused brand
 * stops claiming its profiles, the LDT Instagram, TikTok and Facebook Page
 * become "unclaimed" and the REALTY lane starts publishing realty reels to the
 * LDT accounts within the hour, autoPublish:true. Pausing a lane must never be
 * the thing that hands its accounts to another brand.
 * tests/ldt-pause.test.mjs pins exactly this.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function brandPostingEnabled(brand) {
  if (!brand || typeof brand !== "object") return false;
  if (!("enabled" in brand)) return true;
  return brand.enabled === true;
}

/** Convenience inverse, for the reading that makes the call site clearest. */
export function brandIsPaused(brand) {
  return !brandPostingEnabled(brand);
}

/** Test seam: clear the cache so tests can exercise the loader. */
export function _resetRegistryCache() {
  cachedRegistry = null;
}

/**
 * Normalize a social handle for comparison: strip @, URLs, trailing slashes,
 * lowercase. Metricool's simpleProfiles returns bare handles today, but a
 * profile edited by hand in their UI has been seen carrying a full URL.
 */
export function normalizeHandle(raw) {
  let h = String(raw || "").trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/\/+$/, "");
  if (h.includes("/")) h = h.slice(h.lastIndexOf("/") + 1);
  return h.replace(/^@+/, "");
}

function brandHandles(brand, network) {
  const list = brand?.handles?.[network];
  return Array.isArray(list) ? list.map(normalizeHandle).filter(Boolean) : [];
}

/**
 * Does this Metricool profile belong to this brand?
 *
 * A handle match is authoritative: the profile's connected IG/TikTok handle
 * equals one the brand claims. Label patterns are the backup signal for the
 * window where a brand exists in Metricool but its networks are still
 * connecting (a profile with NO networks yet can still be recognized by name).
 */
export function profileClaimedBy(profile, brand) {
  if (!profile || !brand) return false;
  // Every network axis a fan-out posts to is a claim axis: the carousel
  // distributes to facebook and linkedinCompany too, so a brand connected
  // FB-first must still be recognized (config the handles when known).
  const NETWORK_FIELDS = { instagram: "instagram", tiktok: "tiktok", facebook: "facebook", linkedin: "linkedinCompany" };
  for (const [network, field] of Object.entries(NETWORK_FIELDS)) {
    const handle = normalizeHandle(profile[field]);
    if (handle && brandHandles(brand, network).includes(handle)) return true;
  }
  const label = String(profile.label || "");
  for (const pat of brand.labelPatterns || []) {
    try {
      if (new RegExp(pat, "i").test(label)) return true;
    } catch {
      // A bad pattern in config must not take down discovery; handles still match.
    }
  }
  return false;
}

/**
 * Which configured brand claims this profile, if any. Brands with
 * `discovery: "unclaimed"` (realty) never claim — they are the remainder.
 */
export function claimingBrandKey(profile, registry = loadBrandRegistry()) {
  for (const [key, brand] of Object.entries(registry.brands || {})) {
    if (brand?.discovery === "unclaimed") continue;
    if (profileClaimedBy(profile, brand)) return key;
  }
  return null;
}

/**
 * The realty-lane filter: drop every profile claimed by another brand,
 * preserving order and the profile objects themselves. With no claimed
 * profiles present this returns the input list unchanged — that identity is
 * what keeps realty behavior byte-identical (tests/brand-isolation.test.mjs).
 */
export function excludeClaimedProfiles(profiles, registry = loadBrandRegistry(), log = console.log) {
  const kept = [];
  for (const p of profiles || []) {
    const claimedBy = claimingBrandKey(p, registry);
    if (claimedBy) {
      log(`[Brands] Skipping Metricool profile "${p?.label ?? p?.id}" — claimed by brand '${claimedBy}' in brands.json`);
      continue;
    }
    kept.push(p);
  }
  return kept;
}

/**
 * The profiles a claiming brand may post to. Empty = fail closed, do not
 * post. Deleted/demo rows are skipped like both realty fan-outs do — a
 * lingering deleted LDT profile must not swallow the live one's slot.
 */
export function findBrandProfiles(profiles, brand) {
  return (profiles || []).filter(p =>
    p && p.deleted !== true && p.isDemo !== true && profileClaimedBy(p, brand));
}

// ─── Cadence ────────────────────────────────────────────────────────────────

/**
 * Validate and resolve a brand's per-platform daily cadence.
 *
 * REFUSES (throws) any platform configured above the hard cap — the run dies
 * at startup, before discovery, before upload. Values above the default are
 * honored (the config file IS the explicit change) but every resolution logs
 * a warning naming them, so a raised cadence is never silent.
 */
export function resolveCadence(brand, registry = loadBrandRegistry(), log = console.warn) {
  // The CODE constant is the true ceiling. The registry may only LOWER the
  // cap — otherwise one edit to brands.json (the same file that sets a
  // brand's cadence) would raise both numbers and hollow out the refusal.
  const hardCap = Math.min(Number(registry?.cadenceHardCapPerDay) || CADENCE_HARD_CAP_PER_DAY, CADENCE_HARD_CAP_PER_DAY);
  const configured = brand?.cadence && typeof brand.cadence === "object" ? brand.cadence : {};
  const perPlatform = {};
  const warnings = [];
  for (const [platform, rawValue] of Object.entries(configured)) {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`[Cadence] Brand "${brand?.label}" has invalid cadence for ${platform}: ${JSON.stringify(rawValue)} (must be an integer >= 1)`);
    }
    if (value > hardCap) {
      throw new Error(
        `[Cadence] REFUSED: brand "${brand?.label}" configures ${value}/day on ${platform}, above the hard cap of ${hardCap}/day. ` +
        `This cap exists to keep the accounts out of spam enforcement; the system will not run at this cadence.`
      );
    }
    if (value > DEFAULT_CADENCE_PER_DAY) {
      const w = `[Cadence] WARNING: brand "${brand?.label}" runs ${value}/day on ${platform} — above the default ${DEFAULT_CADENCE_PER_DAY}/day, allowed only by explicit config (hard cap ${hardCap}/day).`;
      warnings.push(w);
      log(w);
    }
    perPlatform[platform] = value;
  }
  return { perPlatform, warnings, hardCap, defaultPerDay: DEFAULT_CADENCE_PER_DAY };
}

/** Cadence for one platform: configured value, else the default. */
export function cadenceFor(resolved, platform) {
  const v = resolved?.perPlatform?.[platform];
  return Number.isInteger(v) ? v : DEFAULT_CADENCE_PER_DAY;
}

/** "YYYY-MM-DD" of an instant in America/Chicago — cadence days are CT days. */
export function chicagoDayOf(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** Successful posts by this brand on this platform during today's CT day. */
export function countBrandPostsToday(log, brandKey, platform, now = new Date()) {
  const today = chicagoDayOf(now);
  let count = 0;
  for (const p of validPosts(log)) {
    if (p.brand !== brandKey) continue;
    if (p.success === false) continue;
    if (!Array.isArray(p.platforms) || !p.platforms.includes(platform)) continue;
    if (chicagoDayOf(p.timestamp) !== today) continue;
    count += 1;
  }
  return count;
}

/**
 * May this brand post to this platform right now?
 * Counts today's CT-day posts against the resolved cadence.
 */
export function cadenceAllows(log, brandKey, platform, resolved, now = new Date()) {
  const limit = cadenceFor(resolved, platform);
  const used = countBrandPostsToday(log, brandKey, platform, now);
  return { allowed: used < limit, used, limit };
}

/**
 * Minimum spacing between any two posts of one brand, regardless of platform.
 * A second guard under the daily cadence so two slots can never bunch up.
 */
export function minGapOk(log, brandKey, minGapHours, now = new Date()) {
  const gapMs = Number(minGapHours) > 0 ? Number(minGapHours) * 3600 * 1000 : 0;
  if (!gapMs) return { ok: true };
  let newest = 0;
  for (const p of validPosts(log)) {
    if (p.brand !== brandKey || p.success === false) continue;
    const ts = new Date(p.timestamp).getTime();
    if (!Number.isNaN(ts) && ts > newest) newest = ts;
  }
  if (!newest) return { ok: true };
  const elapsed = now.getTime() - newest;
  return { ok: elapsed >= gapMs, lastPostAt: new Date(newest).toISOString(), waitMs: Math.max(0, gapMs - elapsed) };
}
