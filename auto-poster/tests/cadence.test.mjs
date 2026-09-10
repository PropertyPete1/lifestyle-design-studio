/**
 * The daily cadence cap and the loop that moves it.
 *
 * THE UNIT IS ONE PIPELINE PUBLISH PER CHICAGO DAY, pooled across cities, and
 * most of these tests exist to pin what is NOT counted. One run publishes one
 * video, which the Metricool fan-out turns into five platform publications; the
 * pipeline decides the publish, not the five. Counting anything else either
 * double-counts a single decision or counts lanes that never reach an audience.
 *
 * The loop is deliberately reluctant. The decision file's headline evidence —
 * 1,543 views at one post/day against 544 at six — reproduces only on the MAIN
 * Instagram account, whose one-post arm is n=1 to 3, and which the pipeline
 * never posts to (mainBrandSkipIG withholds it so Peter posts natively). This
 * repo's own data has the opposite sign. So the loop moves one step, rarely,
 * and records every refusal.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRealtyPublish,
  countPublishesToday,
  dailyPublishSeries,
  cadenceGate,
  clampTarget,
  proposeCadence,
  recordCadenceChange,
  recordCadenceHold,
  loadCadence,
  chicagoDay,
  CADENCE_HARD_CEILING,
  MIN_DAYS_BETWEEN_CHANGES,
  yieldingSlotsFor,
  isYieldingToday,
  ROTATION_SLOTS,
} from "../src/cadence.js";
import { announcementText, loadCadenceRecord, recordForPrimary } from "../src/cadence-announce.js";
import { MERGE_STRATEGIES, MERGE_FILES, mergeCadence } from "../merge-strategies.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cadence-test-"));
/** 14:00 UTC is 09:00 CT — safely mid-day, so no test straddles a day boundary. */
const at = (day, hour = 14) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const publish = (day, city = "san_antonio", hour = 14) => ({
  driveFileId: "d" + day + city + hour, fileName: "f.mp4", city,
  platforms: ["tiktok", "youtube", "satellite_ig"], timestamp: at(day, hour), success: true,
});
const state = (over = {}) => ({ target: 3, floor: 1, ceiling: 4, changed_at: null, history: [], holds: [], ...over });

describe("what counts as a publish — and what must not", () => {
  test("a realty main-lane row counts", () => {
    assert.equal(isRealtyPublish(publish("2026-09-09")), true);
  });

  test("trial_variant does NOT count — it posts nowhere", () => {
    // trial-variant-main.js imports no Metricool posting function and records
    // platforms: [] on all 51 rows ever written; it delivers to Drive for
    // manual posting. Counting it would cap the real lane against renders.
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), type: "trial_variant", platforms: [] }), false);
  });

  test("manual_confirm does NOT count — it is a leg of a publish already counted", () => {
    // 78 of 81 such rows pair with a same-day same-city main-lane row. They
    // carry the DELIVERED file's Drive id, not the source's, which is why a
    // naive driveFileId join shows zero overlap and looks like a separate post.
    assert.equal(isRealtyPublish({
      city: "austin", timestamp: at("2026-09-09"), success: true,
      platform: "instagram_main_native", source: "manual_confirm", driveFileId: "x",
    }), false);
  });

  test("linkedin and ldt_* rows do not count", () => {
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), type: "linkedin" }), false);
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), type: "ldt_clip" }), false);
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), brand: "ldt" }), false);
  });

  test("a failed run does not count", () => {
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), success: false }), false);
  });

  test("an empty platforms array does not count", () => {
    assert.equal(isRealtyPublish({ ...publish("2026-09-09"), platforms: [] }), false);
  });

  test("the fan-out does not multiply the count — one publish is one", () => {
    // The row says ["tiktok","youtube","satellite_ig"] and the real fan-out is
    // five publications. Neither number is what we cap.
    const log = { posts: [publish("2026-09-09")] };
    assert.equal(countPublishesToday(log, new Date(at("2026-09-09"))), 1);
  });
});

describe("counting is per Chicago day, pooled across cities", () => {
  test("cities pool into one daily count", () => {
    const log = { posts: [publish("2026-09-09", "san_antonio", 14), publish("2026-09-09", "austin", 18)] };
    assert.equal(countPublishesToday(log, new Date(at("2026-09-09", 20))), 2);
  });

  test("a different Chicago day is not counted", () => {
    const log = { posts: [publish("2026-09-08")] };
    assert.equal(countPublishesToday(log, new Date(at("2026-09-09"))), 0);
  });

  test("UTC evening is still the same Chicago day", () => {
    // 2026-09-09T23:00Z is 18:00 CT — same day. A UTC-based counter would roll
    // over five hours early and hand back an extra slot every evening.
    assert.equal(chicagoDay("2026-09-09T23:00:00Z"), "2026-09-09");
    assert.equal(chicagoDay("2026-09-10T02:00:00Z"), "2026-09-09");
  });

  test("the daily series reports zero-publish days rather than omitting them", () => {
    const series = dailyPublishSeries({ posts: [publish("2026-09-09")] }, new Date(at("2026-09-09")), 3);
    assert.equal(series.length, 3);
    assert.equal(series[0].posts, 1);
    assert.equal(series[1].posts, 0);
  });
});

describe("the gate", () => {
  test("allows while under target", () => {
    const g = cadenceGate({ posts: [publish("2026-09-09")] }, { now: new Date(at("2026-09-09")), state: state({ target: 3 }) });
    assert.equal(g.allowed, true);
    assert.equal(g.used, 1);
  });

  test("blocks at target", () => {
    const posts = [publish("2026-09-09", "san_antonio", 14), publish("2026-09-09", "austin", 16)];
    const g = cadenceGate({ posts }, { now: new Date(at("2026-09-09", 20)), state: state({ target: 2 }) });
    assert.equal(g.allowed, false);
    assert.match(g.reason, /cap reached/);
  });

  test("an empty log allows", () => {
    assert.equal(cadenceGate({ posts: [] }, { now: new Date(at("2026-09-09")), state: state() }).allowed, true);
  });
});

describe("clamping", () => {
  test("the code ceiling cannot be raised by config", () => {
    assert.equal(clampTarget(99, { floor: 1, ceiling: 99 }), CADENCE_HARD_CEILING);
  });

  test("floor and ceiling bound the target", () => {
    assert.equal(clampTarget(0, { floor: 2, ceiling: 4 }), 2);
    assert.equal(clampTarget(9, { floor: 2, ceiling: 4 }), 4);
  });

  test("a non-integer target falls back rather than producing NaN", () => {
    assert.equal(Number.isInteger(clampTarget(undefined, { floor: 1, ceiling: 4 })), true);
    assert.equal(Number.isInteger(clampTarget("3", { floor: 1, ceiling: 4 })), true);
  });
});

describe("the loop moves one step, or holds and says why", () => {
  const busyLog = () => ({
    posts: Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.parse(at("2026-09-09")) - i * 86400000);
      return publish(chicagoDay(d));
    }),
  });

  test("NEVER JUMPS: a proposal of 6 against a target of 2 moves to 3", () => {
    const p = proposeCadence({ state: state({ target: 2, ceiling: 6 }), proposed: 6, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(p.change, true);
    assert.equal(p.to, 3);
  });

  test("no proposal holds", () => {
    const p = proposeCadence({ state: state(), proposed: null, log: busyLog() });
    assert.equal(p.change, false);
    assert.match(p.reason, /no posts_per_day/);
  });

  test("a proposal equal to the target holds", () => {
    const p = proposeCadence({ state: state({ target: 3 }), proposed: 3, log: busyLog() });
    assert.equal(p.change, false);
    assert.match(p.reason, /agrees/);
  });

  test("a change inside the cooldown holds and names the shortfall", () => {
    const recent = new Date(Date.parse(at("2026-09-09")) - 3 * 86400000).toISOString();
    const p = proposeCadence({
      state: state({ target: 3, changed_at: recent }), proposed: 4,
      rationale: "views per post were up 40% at four a day over three weeks",
      log: busyLog(), now: new Date(at("2026-09-09")),
    });
    assert.equal(p.change, false);
    assert.match(p.reason, /days since the last change/);
    assert.match(p.reason, new RegExp(String(MIN_DAYS_BETWEEN_CHANGES)));
  });

  test("too few observed publish-days holds", () => {
    const p = proposeCadence({ state: state({ target: 3 }), proposed: 4, log: { posts: [publish("2026-09-09")] }, now: new Date(at("2026-09-09")) });
    assert.equal(p.change, false);
    assert.match(p.reason, /too little at 3\/day/);
  });

  test("already at the ceiling holds rather than pretending to move", () => {
    const p = proposeCadence({ state: state({ target: 4, ceiling: 4 }), proposed: 6, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(p.change, false);
    assert.match(p.reason, /outside the configured range/);
  });

  test("DIRECTION VETO: a decrease with no stated rationale holds", () => {
    // Reach scales at least linearly with posts/day in this data (log-log slope
    // 1.26, CI 0.96-1.55), so a cut is presumed to cost reach.
    const p = proposeCadence({ state: state({ target: 3 }), proposed: 1, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(p.change, false);
    assert.match(p.reason, /DECREASE/);
  });

  test("a decrease WITH a real rationale is allowed, one step", () => {
    const p = proposeCadence({
      state: state({ target: 3 }), proposed: 1,
      rationale: "median views per post rose 60% during the two weeks at two a day",
      log: busyLog(), now: new Date(at("2026-09-09")),
    });
    assert.equal(p.change, true);
    assert.equal(p.to, 2);
  });

  test("a token rationale does not satisfy the veto", () => {
    for (const r of ["", "n/a", "none", "tbd", "short"]) {
      const p = proposeCadence({ state: state({ target: 3 }), proposed: 2, rationale: r, log: busyLog(), now: new Date(at("2026-09-09")) });
      assert.equal(p.change, false, `rationale ${JSON.stringify(r)} should not pass the veto`);
    }
  });

  test("an increase does not need a rationale — only a cut is presumed costly", () => {
    const p = proposeCadence({ state: state({ target: 2 }), proposed: 3, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(p.change, true);
    assert.equal(p.to, 3);
  });
});

describe("every change and every refusal is recorded", () => {
  test("a change records old, new, evidence and date", () => {
    const s = recordCadenceChange(state({ target: 3 }), {
      from: 3, to: 2, proposed: 1, evidence: { source: "decision file", rationale: "x" },
      now: new Date(at("2026-09-09")), runId: "42",
    });
    assert.equal(s.target, 2);
    assert.equal(s.history.length, 1);
    const h = s.history[0];
    assert.deepEqual([h.from, h.to, h.proposed, h.run_id], [3, 2, 1, "42"]);
    assert.equal(h.day, "2026-09-09");
    assert.ok(h.evidence.source);
    assert.equal(s.changed_at, h.at, "the cooldown clock starts from the change");
  });

  test("a HOLD is recorded too — 'did nothing' must not look like 'was never asked'", () => {
    const s = recordCadenceHold(state({ target: 3 }), { at: new Date(at("2026-09-09")), proposed: 6, reason: "cooldown" });
    assert.equal(s.holds.length, 1);
    assert.equal(s.holds[0].proposed, 6);
    assert.equal(s.holds[0].target, 3);
    assert.equal(s.target, 3, "a hold never moves the target");
    assert.equal(s.changed_at, null, "a hold never restarts the cooldown clock");
  });

  test("holds are capped separately so they cannot flush the change history", () => {
    let s = state({ target: 3, history: [{ at: "2026-01-01T00:00:00Z", from: 2, to: 3 }] });
    for (let i = 0; i < 80; i++) {
      s = recordCadenceHold(s, { at: new Date(Date.parse(at("2026-09-09")) + i * 1000), reason: "r" });
    }
    assert.equal(s.holds.length, 50);
    assert.equal(s.history.length, 1, "the change survived 80 holds");
  });
});

describe("persistence never costs a run", () => {
  test("a corrupt cadence.json reads as defaults", () => {
    const dir = tmp();
    const p = join(dir, "cadence.json");
    writeFileSync(p, "{not json");
    const s = loadCadence(p);
    assert.equal(Number.isInteger(s.target), true);
    assert.deepEqual(s.history, []);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a partial file keeps its valid fields and defaults the rest", () => {
    const dir = tmp();
    const p = join(dir, "cadence.json");
    writeFileSync(p, JSON.stringify({ target: 2, history: "nope" }));
    const s = loadCadence(p);
    assert.equal(s.target, 2);
    assert.deepEqual(s.history, []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("write-back — the silent-discard trap", () => {
  test("cadence.json is registered in MERGE_STRATEGIES", () => {
    assert.ok(MERGE_FILES.includes("cadence.json"));
  });

  test("the newer decision wins the target, and no history is lost", () => {
    // Two city runs on the same day both read target 3; one moves it to 2.
    // Taking whichever side we happen to be would let a stale 3 undo a change
    // that has already been announced.
    const older = { target: 3, changed_at: "2026-09-01T00:00:00Z", history: [{ at: "2026-09-01T00:00:00Z", from: 4, to: 3 }], holds: [] };
    const newer = { target: 2, changed_at: "2026-09-09T00:00:00Z", history: [{ at: "2026-09-09T00:00:00Z", from: 3, to: 2 }], holds: [] };
    const merged = mergeCadence(newer, older, () => {});
    assert.equal(merged.target, 2);
    assert.equal(merged.history.length, 2, "both changes survive");
  });

  test("a stale local target does not overwrite a newer remote one", () => {
    const staleLocal = { target: 3, changed_at: "2026-09-01T00:00:00Z", history: [], holds: [] };
    const newerRemote = { target: 2, changed_at: "2026-09-09T00:00:00Z", history: [], holds: [] };
    assert.equal(mergeCadence(staleLocal, newerRemote, () => {}).target, 2);
  });

  test("holds union rather than replace", () => {
    const a = { target: 3, holds: [{ at: "2026-09-08T00:00:00Z", reason: "a" }], history: [] };
    const b = { target: 3, holds: [{ at: "2026-09-09T00:00:00Z", reason: "b" }], history: [] };
    assert.equal(mergeCadence(a, b, () => {}).holds.length, 2);
  });

  test("a missing remote file is tolerated by the dispatch entry", () => {
    const out = MERGE_STRATEGIES["cadence.json"]({ target: 2, changed_at: "2026-09-09T00:00:00Z", history: [], holds: [] }, null, () => {});
    assert.equal(out.target, 2);
  });
});

describe("what PRIMARY is told", () => {
  test("the sentence reads the way Peter would hear it", () => {
    const t = announcementText({ from: 4, to: 3, proposed: 3, rationale: "views per post were up 40% at four a day" });
    assert.match(t, /Dropped posting to 3 a day, from 4\./);
    assert.match(t, /up 40%/);
  });

  test("no rationale means the sentence SAYS there was none, not an invented reason", () => {
    const t = announcementText({ from: 2, to: 3, proposed: 3, rationale: null });
    assert.match(t, /No rationale was given/);
    assert.doesNotMatch(t, /%/, "no effect size is invented to round the sentence out");
  });

  test("a one-step move toward a larger proposal says so", () => {
    const t = announcementText({ from: 2, to: 3, proposed: 6, rationale: "engagement climbed steadily through the trial period" });
    assert.match(t, /asked for 6 a day/);
    assert.match(t, /never jumps/);
  });

  test("the durable record appends and survives a corrupt file", () => {
    const dir = tmp();
    const p = join(dir, "posting_cadence.json");
    writeFileSync(p, "garbage");
    recordForPrimary({ at: "2026-09-09T00:00:00Z", from: 3, to: 2 }, { path: p });
    const rec = loadCadenceRecord(p);
    assert.equal(rec.changes.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the cap now BINDS — that is the point of this change", () => {
  test("the default target is BELOW the observed maximum, so the gate bites", async () => {
    // The inverse of what shipped on 2026-09-09. That default (4 against a
    // measured max of 3) was deliberately inert because the only frequency
    // evidence was an artifact. The 2026-09-10 run replaced it with 213 posts
    // over the full Metricool window, so the cap is meant to bind now.
    const { DEFAULT_TARGET, DEFAULT_FLOOR, DEFAULT_CEILING } = await import("../src/cadence.js");
    assert.equal(DEFAULT_TARGET, 2);
    assert.equal(DEFAULT_FLOOR, 1);
    assert.equal(DEFAULT_CEILING, 3, "above 2 the evidence collapses on 12, 5 and 24 posts");
    assert.ok(DEFAULT_TARGET < 3, "the observed max was 3 — a target of 2 must bite");
  });

  test("against the real committed log, the default target blocks days it should", async () => {
    const { readFileSync } = await import("node:fs");
    const { dailyPublishSeries, DEFAULT_TARGET } = await import("../src/cadence.js");
    const log = JSON.parse(readFileSync(new URL("../posted-log.json", import.meta.url), "utf-8"));
    const series = dailyPublishSeries(log, new Date("2026-09-10T20:00:00Z"), 30);
    const over = series.filter((d) => d.posts > DEFAULT_TARGET);
    assert.ok(over.length > 0, "a cap that blocks nothing on 30 days of real data is not a cap");
  });
});

describe("slot rotation — three slots against a cap of two", () => {
  test("exactly one slot yields per day at target 2", () => {
    for (const day of ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]) {
      assert.equal(yieldingSlotsFor(day, { target: 2 }).length, 1, `on ${day}`);
    }
  });

  test("the yielder ROTATES, so no slot is always the loser", () => {
    // This is the whole reason the rotation exists. Measured over the 30 days to
    // 2026-09-10, a plain first-come cap of 2 would have let san_antonio am
    // publish on 29 of 29 days and dallas pm on 1 of 9 — Dallas dark by accident
    // of clock order rather than on merit.
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const day = new Date(Date.UTC(2026, 8, 10 + i)).toISOString().slice(0, 10);
      yieldingSlotsFor(day, { target: 2 }).forEach((sl) => seen.add(`${sl.city} ${sl.slot}`));
    }
    assert.equal(seen.size, 3, "every slot takes a turn yielding across six days");
  });

  test("each slot yields exactly one day in three over a long run", () => {
    const counts = {};
    for (let i = 0; i < 90; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      yieldingSlotsFor(day, { target: 2 }).forEach((sl) => {
        const k = `${sl.city} ${sl.slot}`;
        counts[k] = (counts[k] || 0) + 1;
      });
    }
    assert.deepEqual(Object.values(counts).sort(), [30, 30, 30]);
  });

  test("the rotation is stable within a Chicago day", () => {
    // Two slots firing hours apart must agree about who is yielding, or both
    // could stand down and the day would publish nothing.
    const a = yieldingSlotsFor("2026-09-11", { target: 2 });
    const b = yieldingSlotsFor("2026-09-11", { target: 2 });
    assert.deepEqual(a, b);
  });

  test("nobody yields when there is room for everyone", () => {
    assert.deepEqual(yieldingSlotsFor("2026-09-10", { target: 3 }), []);
    assert.deepEqual(yieldingSlotsFor("2026-09-10", { target: 9 }), []);
  });

  test("two yield when the target is 1", () => {
    assert.equal(yieldingSlotsFor("2026-09-10", { target: 1 }).length, 2);
  });

  test("a slot outside the rotation never yields — manual dispatch is not blocked", () => {
    // A workflow_dispatch for a retired slot, or a cron someone re-enables,
    // must fall through to the plain cap rather than be refused by a rotation
    // that does not model it.
    assert.equal(isYieldingToday("san_antonio", "pm", "2026-09-10", { target: 2 }), false);
    assert.equal(isYieldingToday("houston", "am", "2026-09-10", { target: 2 }), false);
  });

  test("a malformed day yields nobody rather than blocking everything", () => {
    assert.deepEqual(yieldingSlotsFor("not-a-date", { target: 2 }), []);
    assert.deepEqual(yieldingSlotsFor(null, { target: 2 }), []);
  });
});

describe("the gate honours the rotation before the count", () => {
  const emptyLog = { posts: [] };
  const st = { target: 2, floor: 1, ceiling: 3, changed_at: null, history: [], holds: [] };

  test("a yielding slot stands down even with the budget untouched", () => {
    // It is holding the budget open for a slot that fires later in the day.
    const day = "2026-09-11";
    const yielder = yieldingSlotsFor(day, { target: 2 })[0];
    const g = cadenceGate(emptyLog, {
      now: new Date(`${day}T18:00:00Z`), state: st, city: yielder.city, slot: yielder.slot,
    });
    assert.equal(g.allowed, false);
    assert.equal(g.yielded, true);
    assert.equal(g.used, 0, "the budget really was untouched");
    assert.match(g.reason, /yielding today/);
  });

  test("a non-yielding slot is allowed on the same day", () => {
    const day = "2026-09-11";
    const yielder = yieldingSlotsFor(day, { target: 2 })[0];
    const taker = ROTATION_SLOTS.find((r) => !(r.city === yielder.city && r.slot === yielder.slot));
    const g = cadenceGate(emptyLog, {
      now: new Date(`${day}T18:00:00Z`), state: st, city: taker.city, slot: taker.slot,
    });
    assert.equal(g.allowed, true);
    assert.equal(g.yielded, false);
  });

  test("with no city/slot supplied the plain cap governs — nothing yields by accident", () => {
    const g = cadenceGate(emptyLog, { now: new Date("2026-09-11T18:00:00Z"), state: st });
    assert.equal(g.allowed, true);
    assert.equal(g.yielded, false);
  });

  test("the cap still binds a non-yielding slot once the day is spent", () => {
    const day = "2026-09-11";
    const yielder = yieldingSlotsFor(day, { target: 2 })[0];
    const taker = ROTATION_SLOTS.find((r) => !(r.city === yielder.city && r.slot === yielder.slot));
    const log = { posts: [publish(day, "san_antonio", 14), publish(day, "austin", 15)] };
    const g = cadenceGate(log, { now: new Date(`${day}T18:00:00Z`), state: st, city: taker.city, slot: taker.slot });
    assert.equal(g.allowed, false);
    assert.equal(g.yielded, false, "blocked by the cap, not by the rotation — the reason matters in the log");
    assert.match(g.reason, /cap reached/);
  });
});
