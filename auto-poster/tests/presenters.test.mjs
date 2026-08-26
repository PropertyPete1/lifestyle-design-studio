/**
 * presenters.test.mjs — the registry's invariants, attacked.
 *
 * Everything the presenter system promises lives or dies on this file's
 * subjects: one presenter per email, codes never reused, "next" consumed
 * exactly once, assignments surviving concurrent merges, TEST- inertness,
 * and never-default-to-the-owner.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  emptyRegistry,
  normalisePresenters,
  isValidEmail,
  isTestPresenter,
  addPresenter,
  rotateAccessCode,
  generateAccessCode,
  resolvePresenter,
  parseAssignee,
  setNextAssignment,
  consumeNextAssignment,
  presenterStamp,
  presenterForRequest,
  findByEmail,
  OWNER_ID,
  ROLE_OWNER,
  ROLE_GUEST,
} from "../src/presenters.js";
import { mergePresenters, mergeYtApprovals } from "../merge-strategies.mjs";
import { appendRequest, setRequestPresenter, updateActedScript, KIND_TOPIC_PICK } from "../src/yt-approvals.js";

const quiet = () => {};

function seeded() {
  let reg = emptyRegistry();
  // A pinned timestamp, well before every explicit `now` the tests use —
  // the real clock must never decide which side of a merge is "newer".
  const added = addPresenter(
    reg,
    { name: "Peter Allen", email: "peter@lifestyledesignrealty.com", role: ROLE_OWNER },
    { now: "2026-08-20T00:00:00Z" }
  );
  assert.ok(added.ok);
  // The pre-seeded owner's id must be the well-known one defaults resolve to.
  assert.equal(added.presenter.id, OWNER_ID);
  return added.registry;
}

describe("adding presenters", () => {
  test("one action adds a guest with a fresh 6-digit code", () => {
    const reg = seeded();
    const r = addPresenter(reg, { name: "Steven Van Orden", email: "steven@lifestyledesignrealty.com" });
    assert.ok(r.ok);
    assert.equal(r.presenter.role, ROLE_GUEST);
    assert.match(r.presenter.accessCode, /^\d{6}$/);
    assert.equal(r.presenter.cta.framing, "team");
    assert.equal(r.presenter.id, "steven-van-orden");
  });

  test("duplicate email is refused, case-insensitively", () => {
    const reg = seeded();
    const r = addPresenter(reg, { name: "Pete Again", email: "PETER@lifestyledesignrealty.com" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /already belongs/);
  });

  test("malformed emails are refused", () => {
    const reg = seeded();
    for (const bad of ["steven", "steven@", "@x.com", "steven@lifestyle", "a b@c.com", ""]) {
      const r = addPresenter(reg, { name: "Somebody Real", email: bad });
      assert.equal(r.ok, false, `"${bad}" should have been refused`);
    }
  });

  test("a name too short to be a name is refused", () => {
    const r = addPresenter(seeded(), { name: "S", email: "s@x.com" });
    assert.equal(r.ok, false);
  });

  test("TEST- names are flagged test and carry the marker in their id", () => {
    const r = addPresenter(seeded(), { name: "TEST-Ghost Presenter", email: "ghost@example.com" });
    assert.ok(r.ok);
    assert.equal(r.presenter.test, true);
    assert.ok(r.presenter.id.startsWith("TEST-"), r.presenter.id);
    assert.ok(isTestPresenter(r.presenter));
  });

  test("a real presenter is not test", () => {
    const reg = seeded();
    assert.equal(isTestPresenter(findByEmail(reg, "peter@lifestyledesignrealty.com")), false);
  });
});

describe("access codes", () => {
  test("codes are 6 digits and skip anything ever issued", () => {
    const reg = {
      ...emptyRegistry(),
      presenters: [{ id: "a", email: "a@x.com", accessCode: "000001" }],
      retiredCodes: [{ code: "000002", presenterId: "a", retiredAt: "t" }],
    };
    // An rng that offers the two burned codes first proves the skip.
    const feed = [1, 2, 3];
    const code = generateAccessCode(reg, () => feed.shift());
    assert.equal(code, "000003");
  });

  test("rotation retires the old code and the ledger blocks its reissue", () => {
    let reg = seeded();
    const before = findByEmail(reg, "peter@lifestyledesignrealty.com").accessCode;
    const r = rotateAccessCode(reg, "peter");
    assert.ok(r.ok);
    assert.notEqual(r.presenter.accessCode, before);
    assert.equal(r.oldCode, before);
    assert.ok(r.registry.retiredCodes.some((c) => c.code === before));
    // The retired code can never come back, even if the rng insists on it.
    const feed = [Number(before), 424242];
    assert.equal(generateAccessCode(r.registry, () => feed.shift()), "424242");
  });

  test("rotating an unknown presenter is refused", () => {
    const r = rotateAccessCode(seeded(), "nobody");
    assert.equal(r.ok, false);
  });
});

describe("resolution — never default to the owner", () => {
  test("resolves by email, id, and unique name", () => {
    let reg = seeded();
    reg = addPresenter(reg, { name: "Steven Van Orden", email: "steven@lifestyledesignrealty.com" }).registry;
    assert.equal(resolvePresenter(reg, "steven@lifestyledesignrealty.com").presenter.id, "steven-van-orden");
    assert.equal(resolvePresenter(reg, "steven-van-orden").presenter.id, "steven-van-orden");
    assert.equal(resolvePresenter(reg, "Steven Van Orden").presenter.id, "steven-van-orden");
  });

  test("an unknown name is a refusal carrying unknown:true, not a fallback", () => {
    const r = resolvePresenter(seeded(), "Some Stranger");
    assert.equal(r.ok, false);
    assert.equal(r.unknown, true);
  });

  test("an ambiguous name demands the email", () => {
    let reg = seeded();
    reg = addPresenter(reg, { name: "Sam Lee", email: "sam1@x.com" }).registry;
    reg = addPresenter(reg, { name: "Sam Lee", email: "sam2@x.com" }).registry;
    const r = resolvePresenter(reg, "Sam Lee");
    assert.equal(r.ok, false);
    assert.match(r.reason, /email/);
  });

  test('parseAssignee handles "Name <email>", bare email, bare name', () => {
    assert.deepEqual(parseAssignee("Steven Van Orden <steven@x.com>"), { name: "Steven Van Orden", email: "steven@x.com" });
    assert.deepEqual(parseAssignee("steven@x.com"), { name: null, email: "steven@x.com" });
    assert.deepEqual(parseAssignee("Steven"), { name: "Steven", email: null });
  });

  test("a request with no stamp resolves to the owner; a stamp naming a stranger refuses", () => {
    const reg = seeded();
    const ok = presenterForRequest(reg, { requestId: "r1" });
    assert.ok(ok.ok);
    assert.equal(ok.presenter.id, OWNER_ID);
    const bad = presenterForRequest(reg, { requestId: "r1", presenter: { id: "vanished" } });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /vanished/);
  });
});

describe('the standing "next" assignment', () => {
  test("set, consumed exactly once, second consumer gets nothing", () => {
    let reg = seeded();
    reg = addPresenter(reg, { name: "Steven Van Orden", email: "steven@lifestyledesignrealty.com" }).registry;
    const set = setNextAssignment(reg, "steven-van-orden", { now: "2026-08-25T01:00:00Z" });
    assert.ok(set.ok);
    const first = consumeNextAssignment(set.registry, "topic_pick-A");
    assert.equal(first.presenter.id, "steven-van-orden");
    assert.equal(first.registry.nextAssignment.consumedBy, "topic_pick-A");
    const second = consumeNextAssignment(first.registry, "topic_pick-B");
    assert.equal(second.presenter, null);
    // And the tombstone still names the FIRST consumer.
    assert.equal(second.registry.nextAssignment.consumedBy, "topic_pick-A");
  });

  test("assigning next to an unknown presenter is refused", () => {
    const r = setNextAssignment(seeded(), "stranger");
    assert.equal(r.ok, false);
  });
});

describe("mergePresenters — the registry survives concurrent runners", () => {
  test("concurrent adds union; neither runner erases the other's presenter", () => {
    const base = seeded();
    const a = addPresenter(base, { name: "Steven Van Orden", email: "steven@x.com" }).registry;
    const b = addPresenter(base, { name: "Dana Cruz", email: "dana@x.com" }).registry;
    const merged = mergePresenters(a, b, quiet);
    assert.equal(merged.presenters.length, 3);
  });

  test("a rotation beats the stale copy that never heard about it", () => {
    const base = seeded();
    const rotated = rotateAccessCode(base, "peter", { now: "2026-08-26T00:00:00Z" }).registry;
    // Merge in both orders — the winner must be the rotation both times.
    for (const [l, r] of [[rotated, base], [base, rotated]]) {
      const merged = mergePresenters(l, r, quiet);
      const peter = merged.presenters.find((p) => p.id === "peter");
      assert.equal(peter.accessCode, rotated.presenters[0].accessCode);
      assert.ok(merged.retiredCodes.some((c) => c.code === base.presenters[0].accessCode));
    }
  });

  test("a racing double-add of one email resolves deterministically: earliest kept, loser's code retired", () => {
    const base = seeded();
    const a = addPresenter(base, { name: "Steven Van Orden", email: "steven@x.com" }, { now: "2026-08-25T01:00:00Z" }).registry;
    const b = addPresenter(base, { name: "Steve VO", email: "STEVEN@x.com" }, { now: "2026-08-25T02:00:00Z" }).registry;
    const loserCode = b.presenters.find((p) => p.id === "steve-vo").accessCode;
    const merged = mergePresenters(a, b, quiet);
    const survivors = merged.presenters.filter((p) => String(p.email).toLowerCase() === "steven@x.com");
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].id, "steven-van-orden", "earliest added must win");
    assert.ok(merged.retiredCodes.some((c) => c.code === loserCode), "the dropped copy's code must be retired");
  });

  test("consumption beats the stale unconsumed copy; a newer assignment beats an old consumption", () => {
    let reg = seeded();
    reg = addPresenter(reg, { name: "Steven Van Orden", email: "steven@x.com" }).registry;
    reg = addPresenter(reg, { name: "Dana Cruz", email: "dana@x.com" }).registry;
    const setA = setNextAssignment(reg, "steven-van-orden", { now: "2026-08-25T01:00:00Z" }).registry;
    const consumedA = consumeNextAssignment(setA, "topic_pick-A", { now: "2026-08-25T02:00:00Z" }).registry;

    // Stale runner still holds the unconsumed copy: consumption must win both ways.
    for (const [l, r] of [[consumedA, setA], [setA, consumedA]]) {
      assert.equal(mergePresenters(l, r, quiet).nextAssignment.consumedBy, "topic_pick-A");
    }

    // A genuinely newer assignment (later assignedAt) beats the old consumption.
    const setB = setNextAssignment(consumedA, "dana-cruz", { now: "2026-08-26T01:00:00Z" }).registry;
    const merged = mergePresenters(setB, consumedA, quiet);
    assert.equal(merged.nextAssignment.presenterId, "dana-cruz");
    assert.equal(merged.nextAssignment.consumedAt, null);
  });

  test("normalise degrades garbage to null and load-shape survives", () => {
    assert.equal(normalisePresenters([1, 2, 3]), null);
    assert.equal(normalisePresenters("nope"), null);
    const n = normalisePresenters({ presenters: [{ id: "x", email: "x@x.com" }, { bogus: true }], retiredCodes: "no", extra: 1 });
    assert.equal(n.presenters.length, 1);
    assert.deepEqual(n.retiredCodes, []);
    assert.equal(n.extra, 1);
  });
});

describe("the presenter stamp on approval records", () => {
  const stamp = (id, at) => ({ id, name: id, role: "guest", assignedAt: at, via: "assigned" });

  test("appendRequest carries the stamp and the merge keeps it two-sided", () => {
    const withStamp = appendRequest({ requests: [] }, {
      requestId: "topic_pick-X", kind: KIND_TOPIC_PICK, payload: {},
      presenter: stamp("steven", "2026-08-25T01:00:00Z"),
    });
    // The other writer (dashboard) holds a decision-only copy of the record.
    const dashboardSide = { requests: [{ requestId: "topic_pick-X", decision: "approve", decidedAt: "t", selection: 1 }] };
    for (const [l, r] of [[withStamp, dashboardSide], [dashboardSide, withStamp]]) {
      const merged = mergeYtApprovals(l, r, quiet);
      const rec = merged.requests.find((q) => q.requestId === "topic_pick-X");
      assert.equal(rec.presenter?.id, "steven", "the stamp must survive a two-sided merge");
      assert.equal(rec.decision, "approve", "and the decision must too");
    }
  });

  test("reassignment: later assignedAt wins the merge, history unions", () => {
    let log = appendRequest({ requests: [] }, {
      requestId: "topic_pick-X", kind: KIND_TOPIC_PICK, payload: {},
      presenter: stamp("peter", "2026-08-25T01:00:00Z"),
    });
    const reassigned = setRequestPresenter(log, "topic_pick-X", stamp("steven", "2026-08-25T03:00:00Z"), { now: "2026-08-25T03:00:00Z" });
    assert.ok(reassigned.ok);
    assert.equal(reassigned.previous.id, "peter");
    for (const [l, r] of [[reassigned.log, log], [log, reassigned.log]]) {
      const rec = mergeYtApprovals(l, r, quiet).requests[0];
      assert.equal(rec.presenter.id, "steven", "the reassignment must beat the stale copy");
      assert.equal(rec.presenterHistory?.[0]?.id, "peter", "the trail must survive");
    }
  });

  test("assigning the same presenter twice is a refusal, not a silent restamp", () => {
    const log = appendRequest({ requests: [] }, {
      requestId: "topic_pick-X", kind: KIND_TOPIC_PICK, payload: {},
      presenter: stamp("steven", "t1"),
    });
    const again = setRequestPresenter(log, "topic_pick-X", stamp("steven", "t2"));
    assert.equal(again.ok, false);
  });

  test("updateActedScript replaces only the script, and the adaptation wins the merge", () => {
    let log = appendRequest({ requests: [] }, { requestId: "topic_pick-X", kind: KIND_TOPIC_PICK, payload: {} });
    // Not acted yet: refused.
    assert.equal(updateActedScript(log, "topic_pick-X", { title: "t" }).ok, false);

    log = {
      requests: [{
        requestId: "topic_pick-X", kind: KIND_TOPIC_PICK, requestedAt: "t0",
        actedAt: "t1", actedAction: "kit_delivered",
        actedResult: { selectedTitle: "T", script: { title: "T", hook: "old words" } },
      }],
    };
    const updated = updateActedScript(log, "topic_pick-X", { title: "T", hook: "new words" }, { now: "t2" });
    assert.ok(updated.ok);
    const rec = updated.log.requests[0];
    assert.equal(rec.actedResult.script.hook, "new words");
    assert.equal(rec.actedAt, "t1", "the latch must not move");
    // The stale side would win the acted-group tie (same actedAt) without the
    // adaptation marker — prove the marker carries it both ways.
    for (const [l, r] of [[updated.log, log], [log, updated.log]]) {
      const m = mergeYtApprovals(l, r, quiet).requests[0];
      assert.equal(m.actedResult.script.hook, "new words");
    }
  });
});

describe("presenters.yml stays consistent with what its scripts need", () => {
  const WF = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "presenters.yml");
  const text = readFileSync(WF, "utf-8");

  test("the admin job sets YT_NARRATION_MODE (it rebuilds kits via takesToRecord)", () => {
    assert.match(text, /YT_NARRATION_MODE:\s*peter/);
  });

  test("it shares the approvals concurrency group and commits through merge-log-push", () => {
    assert.match(text, /group:\s*youtube-longform-approvals/);
    assert.match(text, /merge-log-push\.mjs/);
  });

  test("presenters.json is a managed merge file", async () => {
    const { MERGE_FILES } = await import("../merge-strategies.mjs");
    assert.ok(MERGE_FILES.includes("presenters.json"));
  });
});

describe("email validity", () => {
  test("accepts normal addresses, rejects the junk a typo produces", () => {
    assert.ok(isValidEmail("steven@lifestyledesignrealty.com"));
    assert.ok(isValidEmail("a.b+c@sub.domain.co"));
    assert.equal(isValidEmail("steven@lifestyledesignrealty"), false);
    assert.equal(isValidEmail("steven at x.com"), false);
  });
});

describe("presenterStamp", () => {
  test("carries identity only — never the code, never the email", () => {
    const s = presenterStamp({ id: "x", name: "X", role: "guest", email: "x@x.com", accessCode: "123456" });
    assert.equal(s.accessCode, undefined);
    assert.equal(s.email, undefined);
    assert.equal(s.id, "x");
    assert.ok(s.assignedAt);
  });
});
