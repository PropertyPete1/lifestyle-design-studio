/**
 * presenters.js — who fronts a video, and how they get into the recorder.
 *
 * The registry is presenters.json, a managed state file like yt-approvals.json:
 * scheduled jobs read it, dispatch jobs write it, and merge-log-push commits it
 * through mergePresenters (merge-strategies.mjs). The dashboard READS it to
 * verify access codes — it never writes it. That one-writer-class design is what
 * keeps the merge simple.
 *
 * THREE INVARIANTS THIS MODULE OWNS:
 *
 * 1. One presenter per email. An email is the delivery address for a kit and
 *    the identity the recorder login is scoped to; two presenters sharing one
 *    would make "whose kit is this" unanswerable. Duplicates are refused at
 *    add time and resolved deterministically at merge time (earliest wins).
 *
 * 2. An access code is never reused across presenters. A code that once
 *    belonged to somebody must not later open somebody else's kit, so every
 *    retired code goes into a ledger and generation checks active AND retired.
 *
 * 3. The standing "next" assignment is consumed exactly once. It is modelled
 *    as a record with a consumption tombstone rather than a nullable field,
 *    because null cannot win a merge: a stale runner still carrying the
 *    assignment would resurrect it. Consumed-with-a-timestamp can win.
 *
 * TEST- presenters (name prefixed "TEST-") follow the same convention as
 * TEST- request ids: they exercise every code path but are inert where it
 * matters — no real mail is ever sent to one, and one may not be assigned to
 * a real video. See isTestPresenter and the checks in kit-delivery.js.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomInt } from "crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PRESENTERS_PATH = join(ROOT, "presenters.json");

export const ROLE_OWNER = "owner";
export const ROLE_GUEST = "guest";
export const ROLES = [ROLE_OWNER, ROLE_GUEST];

/** Same marker convention as TEST- request ids — one filter rule everywhere. */
export const TEST_PRESENTER_PREFIX = "TEST-";

/** The pre-seeded owner. His id is load-bearing: defaults resolve to it. */
export const OWNER_ID = "peter";

// ─── load / save ────────────────────────────────────────────────────────────

/**
 * Normalise whatever is in the file. Same defensive posture as yt-approvals:
 * anything unrecognisable degrades to empty, and empty means "no presenters",
 * which stalls presenter-dependent work rather than guessing at it.
 */
export function normalisePresenters(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return {
    ...parsed,
    presenters: (Array.isArray(parsed.presenters) ? parsed.presenters : []).filter(isPresenterRecord),
    retiredCodes: (Array.isArray(parsed.retiredCodes) ? parsed.retiredCodes : []).filter(
      (r) => r && typeof r === "object" && typeof r.code === "string"
    ),
    nextAssignment:
      parsed.nextAssignment && typeof parsed.nextAssignment === "object"
        ? parsed.nextAssignment
        : null,
  };
}

export function emptyRegistry() {
  return { presenters: [], retiredCodes: [], nextAssignment: null };
}

export function loadPresenters(path = PRESENTERS_PATH) {
  if (!existsSync(path)) return emptyRegistry();
  try {
    const normalised = normalisePresenters(JSON.parse(readFileSync(path, "utf-8")));
    if (!normalised) {
      console.warn("[Presenters] presenters.json is not a registry object — treating as empty");
      return emptyRegistry();
    }
    return normalised;
  } catch (err) {
    console.warn(`[Presenters] presenters.json unreadable (${err.message}) — treating as empty`);
    return emptyRegistry();
  }
}

export function savePresenters(registry, path = PRESENTERS_PATH) {
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n");
}

function isPresenterRecord(p) {
  return (
    Boolean(p) &&
    typeof p === "object" &&
    typeof p.id === "string" && p.id.length > 0 &&
    typeof p.email === "string" && p.email.length > 0
  );
}

// ─── identity ───────────────────────────────────────────────────────────────

/**
 * Deliberately stricter than RFC 5322 and looser than nothing: a local part, an
 * @, a dotted domain with a real TLD. The failure this exists to stop is a typo
 * becoming a kit silently mailed into the void.
 */
export function isValidEmail(email) {
  const s = String(email || "").trim();
  if (!s || s.length > 254) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(s);
}

export function isTestPresenter(p) {
  const name = typeof p === "string" ? p : p?.name || p?.id || "";
  return String(name).startsWith(TEST_PRESENTER_PREFIX) || p?.test === true;
}

export function findById(registry, id) {
  return (registry?.presenters || []).find((p) => p.id === id) || null;
}

export function findByEmail(registry, email) {
  const needle = String(email || "").trim().toLowerCase();
  return (registry?.presenters || []).find((p) => String(p.email).toLowerCase() === needle) || null;
}

/**
 * Resolve "who did you mean" from an id, an email, or a name.
 *
 * A name that matches nobody or matches two people is a QUESTION, not a
 * default — resolving it to the owner would silently give Peter a kit meant
 * for someone else, which is the exact failure the never-default rule bans.
 */
export function resolvePresenter(registry, ref) {
  const s = String(ref || "").trim();
  if (!s) return { ok: false, reason: "empty presenter reference" };
  if (s.includes("@")) {
    const p = findByEmail(registry, s);
    return p ? { ok: true, presenter: p } : { ok: false, reason: `no presenter with email "${s}"`, unknown: true };
  }
  const byId = findById(registry, s);
  if (byId) return { ok: true, presenter: byId };
  const matches = (registry?.presenters || []).filter(
    (p) => String(p.name || "").toLowerCase() === s.toLowerCase()
  );
  if (matches.length === 1) return { ok: true, presenter: matches[0] };
  if (matches.length > 1) {
    return { ok: false, reason: `"${s}" matches ${matches.length} presenters — use the email instead` };
  }
  return { ok: false, reason: `no presenter named "${s}"`, unknown: true };
}

/**
 * Parse the one-line assignee form: "Name <email>", a bare email, or a bare
 * name. Only the first form carries enough to ADD someone unknown — a bare
 * unknown name is refused upstream rather than guessed at.
 */
export function parseAssignee(input) {
  const s = String(input || "").trim();
  const withEmail = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(s);
  if (withEmail) return { name: withEmail[1].trim() || null, email: withEmail[2].trim() };
  if (s.includes("@")) return { name: null, email: s };
  return { name: s || null, email: null };
}

// ─── access codes ───────────────────────────────────────────────────────────

/**
 * A fresh 6-digit code that collides with nothing this registry has ever
 * issued — active codes and the retired ledger both. Cryptographic randomness
 * because the code IS the login; `rng` is injectable so the collision loop is
 * testable without a million-to-one fixture.
 */
export function generateAccessCode(registry, rng = () => randomInt(0, 1000000)) {
  const used = new Set([
    ...(registry?.presenters || []).map((p) => p.accessCode).filter(Boolean),
    ...(registry?.retiredCodes || []).map((r) => r.code).filter(Boolean),
  ]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(rng()).padStart(6, "0");
    if (!used.has(code)) return code;
  }
  // 100 misses against a million-slot space means the ledger, not the luck.
  throw new Error("could not mint an unused access code in 100 attempts — the code space is exhausted or the rng is broken");
}

/**
 * Retire the old code and issue a new one. The old code goes into the ledger,
 * which is both what makes it dead (the dashboard verifies against the ACTIVE
 * code only — see longform/PRESENTERS.md) and what stops it being minted again.
 */
export function rotateAccessCode(registry, ref, { now = new Date().toISOString(), rng } = {}) {
  const resolved = resolvePresenter(registry, ref);
  if (!resolved.ok) return resolved;
  const presenter = resolved.presenter;
  const next = {
    ...registry,
    retiredCodes: [
      ...(registry.retiredCodes || []),
      { code: presenter.accessCode, presenterId: presenter.id, retiredAt: now },
    ],
  };
  const code = generateAccessCode(next, rng);
  const updated = { ...presenter, accessCode: code, codeIssuedAt: now };
  return {
    ok: true,
    registry: {
      ...next,
      presenters: next.presenters.map((p) => (p.id === presenter.id ? updated : p)),
    },
    presenter: updated,
    oldCode: presenter.accessCode,
  };
}

// ─── adding people ──────────────────────────────────────────────────────────

function slugOf(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Add one presenter. Refusals return { ok:false, reason } rather than throwing
 * so a dispatch job can print the reason and exit red without a stack trace —
 * every reason here is an operator mistake, not a bug.
 */
export function addPresenter(registry, { name, email, role = ROLE_GUEST }, { now = new Date().toISOString(), rng } = {}) {
  const cleanName = String(name || "").trim();
  const cleanEmail = String(email || "").trim();
  if (cleanName.length < 2) return { ok: false, reason: `presenter name "${name}" is too short to be a name` };
  if (!isValidEmail(cleanEmail)) return { ok: false, reason: `"${email}" is not a valid email address` };
  if (!ROLES.includes(role)) return { ok: false, reason: `role must be one of ${ROLES.join("/")}, got "${role}"` };

  const existing = findByEmail(registry, cleanEmail);
  if (existing) {
    return { ok: false, reason: `${cleanEmail} already belongs to "${existing.name}" (${existing.id}) — one presenter per email` };
  }

  const test = cleanName.startsWith(TEST_PRESENTER_PREFIX);
  // A test presenter's id carries the marker too, so anything filtering on the
  // id alone (the same way TEST- requestIds are filtered) catches it. The
  // FIRST owner takes the well-known OWNER_ID rather than a name slug — that
  // id is what every default resolves to, so it must not depend on how the
  // owner's name happened to be typed.
  let id = test
    ? `${TEST_PRESENTER_PREFIX}${slugOf(cleanName.slice(TEST_PRESENTER_PREFIX.length))}`
    : role === ROLE_OWNER && !findById(registry, OWNER_ID)
      ? OWNER_ID
      : slugOf(cleanName);
  if (!id) return { ok: false, reason: `"${name}" produces an empty id` };
  let n = 2;
  while (findById(registry, id)) id = `${slugOf(cleanName)}-${n++}`;

  const presenter = {
    id,
    name: cleanName,
    email: cleanEmail,
    role,
    ...(test ? { test: true } : {}),
    accessCode: generateAccessCode(registry, rng),
    codeIssuedAt: now,
    addedAt: now,
    // How this presenter's CTAs are framed in scripts. The owner speaks for
    // himself; everyone else speaks for the team ("text us", "our clients").
    cta: { framing: role === ROLE_OWNER ? "personal" : "team" },
  };
  return {
    ok: true,
    registry: { ...registry, presenters: [...(registry.presenters || []), presenter] },
    presenter,
  };
}

// ─── the standing "next" assignment ─────────────────────────────────────────

/**
 * Point the NEXT Monday brief's video at a presenter. Replacing a standing
 * assignment is allowed and deliberate — the caller logs what was replaced.
 */
export function setNextAssignment(registry, presenterId, { now = new Date().toISOString() } = {}) {
  const presenter = findById(registry, presenterId);
  if (!presenter) return { ok: false, reason: `no presenter "${presenterId}" to assign` };
  const previous = registry.nextAssignment && !registry.nextAssignment.consumedAt ? registry.nextAssignment : null;
  return {
    ok: true,
    previous,
    registry: {
      ...registry,
      nextAssignment: { presenterId, assignedAt: now, consumedAt: null, consumedBy: null },
    },
  };
}

/**
 * Consume the standing assignment for a brief that just fired.
 *
 * Exactly-once is carried by the tombstone: the assignment is never nulled,
 * its consumedAt/consumedBy are stamped, and mergePresenters lets a consumed
 * record beat an unconsumed copy of the SAME assignment while a genuinely
 * newer assignment (later assignedAt) beats an old consumption. A second
 * caller sees consumedAt set and gets null.
 */
export function consumeNextAssignment(registry, requestId, { now = new Date().toISOString() } = {}) {
  const na = registry?.nextAssignment;
  if (!na || na.consumedAt) return { registry, presenter: null };
  const presenter = findById(registry, na.presenterId);
  const consumed = { ...na, consumedAt: now, consumedBy: requestId };
  if (!presenter) {
    // The assignment points at somebody who has since vanished from the
    // registry. Consume it anyway — leaving it would re-fire forever — and
    // report null so the brief falls back to the owner, loudly.
    console.warn(`[Presenters] next-assignment presenter "${na.presenterId}" is not in the registry — consuming and falling back`);
    return { registry: { ...registry, nextAssignment: consumed }, presenter: null };
  }
  return { registry: { ...registry, nextAssignment: consumed }, presenter };
}

// ─── the stamp that rides requests and video records ────────────────────────

/**
 * What a request record carries about its presenter: identity, never the
 * access code or email. yt-approvals.json is the dashboard's read surface and
 * codes do not belong on it; the email is looked up from the registry at send
 * time so a corrected address applies to every later send.
 */
export function presenterStamp(presenter, { via = "assigned", now = new Date().toISOString() } = {}) {
  return { id: presenter.id, name: presenter.name, role: presenter.role, assignedAt: now, via };
}

/**
 * The presenter a request resolves to. Default is the owner — every video has
 * a presenter — but an EXPLICIT stamp naming someone the registry does not
 * know is an error, never a silent fallback to Peter: a kit going to the wrong
 * person is the failure this whole system exists to prevent.
 */
export function presenterForRequest(registry, record) {
  const stamp = record?.presenter;
  if (stamp?.id) {
    const p = findById(registry, stamp.id);
    if (p) return { ok: true, presenter: p, stamp };
    return { ok: false, reason: `request ${record.requestId} is assigned to "${stamp.id}", who is not in presenters.json` };
  }
  const owner = findById(registry, OWNER_ID) || (registry?.presenters || []).find((p) => p.role === ROLE_OWNER);
  if (owner) return { ok: true, presenter: owner, stamp: null };
  return { ok: false, reason: "no presenter stamp on the request and no owner in presenters.json" };
}
