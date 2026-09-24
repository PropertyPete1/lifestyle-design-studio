/**
 * The daily cadence cap, the market rotation, and the loop that moves the cap.
 *
 * THE UNIT IS ONE PIPELINE PUBLISH PER CHICAGO DAY, pooled across cities, and
 * most of these tests exist to pin what is NOT counted. One run publishes one
 * video, which the Metricool fan-out turns into five platform publications; the
 * pipeline decides the publish, not the five. Counting anything else either
 * double-counts a single decision or counts lanes that never reach an audience.
 *
 * THE LAW SINCE 2026-09-24 (Instagram rate-limiting): one publish a day, one
 * slot a day, one market a day — San Antonio → Austin → Dallas by Chicago date
 * unless the decision file names the day's market — and THE GATE IS THE LAW:
 * anything else stands down whoever dispatched it. The three pins the operator
 * asked for are the "the gate is the law" block below: never two publishes in
 * one Chicago day; the market sequence holds across three days; a retired slot
 * dispatched by hand publishes nothing.
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
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  MARKETS,
  MARKET_LABELS,
  MARKET_ROTATION_ANCHOR,
  DAILY_SLOT,
  marketForDay,
  resolveMarket,
  normalizeMarket,
  rotationPreview,
  DEFAULT_TARGET,
  DEFAULT_FLOOR,
  DEFAULT_CEILING,
} from "../src/cadence.js";
import { announcementText, loadCadenceRecord, recordForPrimary } from "../src/cadence-announce.js";
import { MERGE_STRATEGIES, MERGE_FILES, mergeCadence } from "../merge-strategies.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
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

describe("the count half of the gate", () => {
  // No city or slot supplied: only the count governs. main.js always supplies
  // both — see "the gate is the law" below for the whole law.
  test("allows while under target", () => {
    const g = cadenceGate({ posts: [publish("2026-09-09")] }, { now: new Date(at("2026-09-09")), state: state({ target: 3 }) });
    assert.equal(g.allowed, true);
    assert.equal(g.used, 1);
  });

  test("blocks at target", () => {
    const posts = [publish("2026-09-09", "san_antonio", 14), publish("2026-09-09", "austin", 16)];
    const g = cadenceGate({ posts }, { now: new Date(at("2026-09-09", 20)), state: state({ target: 2 }) });
    assert.equal(g.allowed, false);
    assert.equal(g.standDown, "cap");
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

  test("UNDER THE 2026-09-24 LAW the loop can climb to 2 and no further", () => {
    // Floor 1, ceiling 2. A decision file proposing 6/day after the dwell
    // period moves the target to 2 — once — and then holds at the ceiling.
    const law = { target: 1, floor: 1, ceiling: 2, changed_at: null, history: [], holds: [] };
    const up = proposeCadence({ state: law, proposed: 6, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(up.change, true);
    assert.equal(up.to, 2);
    const capped = proposeCadence({ state: { ...law, target: 2 }, proposed: 6, rationale: null, log: busyLog(), now: new Date(at("2026-09-09")) });
    assert.equal(capped.change, false);
    assert.match(capped.reason, /ceiling/);
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

  test("a MISSING file reads as the law, not as the old 2/day", () => {
    // The code defaults are what a missing or corrupt file falls back to. If
    // they said 2 the file's operator entry would be one bad merge away from
    // meaning nothing.
    const s = loadCadence(join(tmp(), "nope.json"));
    assert.deepEqual([s.target, s.floor, s.ceiling], [1, 1, 2]);
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

  test("THE OPERATOR ENTRY SURVIVES A RUNNER'S STALE WRITE-BACK", () => {
    // A runner that checked out main before this change carries target 2 with
    // the OLD changed_at; the committed file carries target 1 with the newer
    // one. The merge must keep 1, and keep the operator's history entry.
    const committed = loadCadence();
    const staleRunner = { ...committed, target: 2, ceiling: 3, changed_at: "2026-09-10T21:00:00.000Z", history: committed.history.slice(0, 1) };
    const merged = mergeCadence(staleRunner, committed, () => {});
    assert.equal(merged.target, 1);
    assert.equal(merged.ceiling, 2);
    assert.equal(merged.history.length, committed.history.length, "the 2026-09-24 entry survived");
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

  test("the 2026-09-24 drop to one a day is on the record PRIMARY reads", () => {
    // status/posting_cadence.json is what the assistant answers "why did we
    // drop to one a day?" from. An operator change that skipped it would be
    // a change PRIMARY could not explain.
    const rec = loadCadenceRecord();
    const entry = rec.changes.find((c) => c.from === 2 && c.to === 1);
    assert.ok(entry, "no 2 -> 1 change recorded for PRIMARY");
    assert.match(entry.announcement, /Dropped posting to 1 a day, from 2\./);
    assert.match(entry.rationale, /rate-limit/i);
  });
});

describe("the cap now BINDS AT ONE — the 2026-09-24 operator change", () => {
  test("the code defaults are the law: target 1, floor 1, ceiling 2", () => {
    // 2/day was measured binding on every one of the 7 days to 2026-09-23
    // while Instagram rate-limited the accounts. The defaults moved with the
    // file so a corrupt or missing cadence.json cannot reopen 2/day.
    assert.equal(DEFAULT_TARGET, 1);
    assert.equal(DEFAULT_FLOOR, 1);
    assert.equal(DEFAULT_CEILING, 2, "the loop may step back to 2 and no further");
  });

  test("the committed cadence.json carries the operator entry, not a loop step", () => {
    const s = loadCadence();
    assert.deepEqual([s.target, s.floor, s.ceiling], [1, 1, 2]);
    const last = s.history[s.history.length - 1];
    assert.equal(last.actor, "operator", "a deliberate operator decision, not a one-step loop move");
    assert.deepEqual([last.from, last.to, last.proposed], [2, 1, 1]);
    assert.equal(last.day, "2026-09-24");
    assert.match(last.evidence.rationale, /rate-limit/i);
    assert.equal(s.changed_at, last.at, "the cooldown clock restarts from the operator change");
  });

  test("against the real committed log, the target blocks days it should", () => {
    const log = JSON.parse(readFileSync(new URL("../posted-log.json", import.meta.url), "utf-8"));
    const series = dailyPublishSeries(log, new Date("2026-09-23T20:00:00Z"), 7);
    const over = series.filter((d) => d.posts > DEFAULT_TARGET);
    assert.equal(over.length, 7, "every one of the 7 days to 2026-09-23 published 2 — the cap of 1 must bite on all of them");
  });
});

describe("the market rotation — San Antonio → Austin → Dallas by Chicago date", () => {
  test("the anchor day is San Antonio: 2026-09-24, the day the law shipped", () => {
    assert.equal(MARKET_ROTATION_ANCHOR, "2026-09-24");
    assert.equal(marketForDay(MARKET_ROTATION_ANCHOR), "san_antonio");
  });

  test("THE MARKET SEQUENCE HOLDS ACROSS THREE DAYS — SA today, ATX tomorrow, DFW next, repeat", () => {
    assert.deepEqual(
      ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"].map(marketForDay),
      ["san_antonio", "austin", "dallas", "san_antonio", "austin", "dallas"],
    );
    assert.deepEqual(rotationPreview("2026-09-24", 3).map((r) => r.market), MARKETS);
  });

  test("the sequence is the same whether you count forward or back — no cursor to drift", () => {
    // Derived from the date alone. The day before the anchor is Dallas, so the
    // cycle is a true modulus and not a counter that started on the 24th.
    assert.equal(marketForDay("2026-09-23"), "dallas");
    assert.equal(marketForDay("2026-09-22"), "austin");
    // 2026-12-23 is 90 days after the anchor (a multiple of 3): San Antonio
    // again. The next day is Austin's.
    assert.equal(marketForDay("2026-12-23"), "san_antonio");
    assert.equal(marketForDay("2026-12-24"), "austin");
  });

  test("each market gets exactly one day in three over a long run", () => {
    const counts = {};
    for (let i = 0; i < 90; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const m = marketForDay(day);
      counts[m] = (counts[m] || 0) + 1;
    }
    assert.deepEqual(Object.values(counts).sort(), [30, 30, 30]);
  });

  test("a malformed day is null — a gate that cannot tell the day refuses rather than picks San Antonio", () => {
    assert.equal(marketForDay("not-a-date"), null);
    assert.equal(marketForDay(null), null);
    assert.equal(marketForDay("2026-9-24"), null);
    assert.deepEqual(rotationPreview("nope"), []);
  });

  test("the labels match what merge-log-push puts in commit messages", () => {
    assert.deepEqual(MARKET_LABELS, { san_antonio: "SA", austin: "ATX", dallas: "DFW" });
  });

  test("market names from outside are normalised, never guessed", () => {
    for (const [given, want] of [
      ["San Antonio", "san_antonio"], ["san_antonio", "san_antonio"], ["SA", "san_antonio"], ["SATX", "san_antonio"],
      ["Austin", "austin"], ["ATX", "austin"],
      ["Dallas", "dallas"], ["DFW", "dallas"], ["Dallas / Fort Worth", "dallas"], ["dallas", "dallas"],
    ]) assert.equal(normalizeMarket(given), want, given);
    for (const bad of ["Houston", "", null, undefined, 3, "sanantoniotx"]) assert.equal(normalizeMarket(bad), null, String(bad));
  });

  test("a named market wins the day; an unrecognised or absent one leaves it to the calendar", () => {
    assert.deepEqual(resolveMarket({ day: "2026-09-24", namedMarket: "ATX" }), { market: "austin", source: "decision_file" });
    assert.deepEqual(resolveMarket({ day: "2026-09-24", namedMarket: "Houston" }), { market: "san_antonio", source: "rotation" });
    assert.deepEqual(resolveMarket({ day: "2026-09-24" }), { market: "san_antonio", source: "rotation" });
  });
});

describe("THE GATE IS THE LAW", () => {
  // Everything here runs against the COMMITTED cadence.json unless a state is
  // passed — the file is the law, and these are the operator's three pins.
  const saDay = "2026-09-24";   // San Antonio's day under the rotation
  const dfwDay = "2026-09-26";  // Dallas's
  const noon = (day) => new Date(`${day}T17:45:00Z`); // the daily cron, 12:45 CT
  const empty = { posts: [] };

  test("today's market, on the daily slot, with the day unspent: allowed", () => {
    const g = cadenceGate(empty, { now: noon(saDay), city: "san_antonio", slot: DAILY_SLOT });
    assert.equal(g.allowed, true);
    assert.equal(g.standDown, null);
    assert.equal(g.market, "san_antonio");
    assert.equal(g.marketSource, "rotation");
    assert.equal(g.target, 1);
  });

  test("NEVER TWO PUBLISHES IN ONE CHICAGO DAY", () => {
    // Today's market already published — nothing else gets through, not even
    // today's market again, not from a dispatch, not from the backup cron.
    const log = { posts: [publish(saDay, "san_antonio", 17)] };
    for (const [city, slot] of [["san_antonio", "am"], ["san_antonio", "pm"], ["austin", "am"], ["dallas", "am"], ["dallas", "pm"]]) {
      const g = cadenceGate(log, { now: new Date(`${saDay}T23:30:00Z`), city, slot });
      assert.equal(g.allowed, false, `${city} ${slot} got through after today's publish`);
    }
    const again = cadenceGate(log, { now: new Date(`${saDay}T23:30:00Z`), city: "san_antonio", slot: DAILY_SLOT });
    assert.equal(again.standDown, "cap");
    assert.match(again.reason, /cap reached — 1\/1/);
    // …and the count alone, with no slot identified, is refused too.
    assert.equal(cadenceGate(log, { now: new Date(`${saDay}T23:30:00Z`) }).allowed, false);
  });

  test("never two publishes — also under the CODE DEFAULTS, should the file ever be unreadable", () => {
    const fresh = loadCadence(join(tmp(), "missing.json"));
    const log = { posts: [publish(saDay, "san_antonio", 17)] };
    assert.equal(cadenceGate(log, { now: new Date(`${saDay}T23:30:00Z`), state: fresh, city: "san_antonio", slot: DAILY_SLOT }).allowed, false);
  });

  test("a publish late yesterday (UTC) does not spend today — the day is Chicago's", () => {
    // 2026-09-24T03:00Z is 22:00 CT on the 23rd. Counting it against the 24th
    // would silently skip San Antonio's day.
    const log = { posts: [{ ...publish("2026-09-24", "dallas", 3), timestamp: "2026-09-24T03:00:00.000Z" }] };
    assert.equal(cadenceGate(log, { now: noon(saDay), city: "san_antonio", slot: DAILY_SLOT }).allowed, true);
  });

  test("A RETIRED SLOT DISPATCHED BY HAND PUBLISHES NOTHING — budget untouched or not", () => {
    // SA pm was retired 2026-09-10 and kept publishing until 2026-09-24 because
    // the old gate let a slot it did not model through on the plain count.
    const saPm = cadenceGate(empty, { now: new Date(`${saDay}T19:08:00Z`), city: "san_antonio", slot: "pm" });
    assert.equal(saPm.allowed, false);
    assert.equal(saPm.standDown, "retired_slot");
    assert.equal(saPm.used, 0, "the budget really was untouched — the slot is refused for being retired, not for the count");
    assert.match(saPm.reason, /retired slot/);

    // Dallas's own old slot on Dallas's own day: still retired — Dallas posts
    // at the daily slot now, not at 4pm.
    const dfwPm = cadenceGate(empty, { now: new Date(`${dfwDay}T21:00:00Z`), city: "dallas", slot: "pm" });
    assert.equal(dfwPm.allowed, false);
    assert.equal(dfwPm.standDown, "retired_slot");
  });

  test("a city that is not today's market publishes nothing — Austin and Dallas on San Antonio's day", () => {
    for (const city of ["austin", "dallas"]) {
      const g = cadenceGate(empty, { now: noon(saDay), city, slot: DAILY_SLOT });
      assert.equal(g.allowed, false, `${city} got through on ${saDay}`);
      assert.equal(g.standDown, "off_market");
      assert.match(g.reason, /not today's market/);
      assert.match(g.reason, /san_antonio/);
    }
    // …and Dallas on its own day is fine.
    assert.equal(cadenceGate(empty, { now: noon(dfwDay), city: "dallas", slot: DAILY_SLOT }).allowed, true);
  });

  test("a city the law does not name never publishes", () => {
    assert.equal(cadenceGate(empty, { now: noon(saDay), city: "houston", slot: DAILY_SLOT }).allowed, false);
  });

  test("the market check comes BEFORE the slot check, and both before the count", () => {
    // The reason in the run log has to name the FIRST thing wrong with a run,
    // and "wrong city" is what an external dispatcher most needs to hear.
    const g = cadenceGate(empty, { now: noon(saDay), city: "dallas", slot: "pm" });
    assert.equal(g.standDown, "off_market");
    const h = cadenceGate({ posts: [publish(saDay, "san_antonio", 17)] }, { now: new Date(`${saDay}T23:00:00Z`), city: "san_antonio", slot: "pm" });
    assert.equal(h.standDown, "retired_slot", "a retired slot is refused as retired even when the day is also spent");
  });

  test("THE DECISION FILE'S NAMED MARKET TAKES THE DAY; the calendar takes every day it does not name", () => {
    // Austin named on San Antonio's day: Austin may post, San Antonio may not.
    const atx = cadenceGate(empty, { now: noon(saDay), city: "austin", slot: DAILY_SLOT, namedMarket: "austin" });
    assert.equal(atx.allowed, true);
    assert.equal(atx.marketSource, "decision_file");
    const sa = cadenceGate(empty, { now: noon(saDay), city: "san_antonio", slot: DAILY_SLOT, namedMarket: "austin" });
    assert.equal(sa.allowed, false);
    assert.equal(sa.standDown, "off_market");
    assert.match(sa.reason, /named by today's decision file/);
    // A name the law does not know falls back to the calendar and says so.
    const bad = cadenceGate(empty, { now: noon(saDay), city: "san_antonio", slot: DAILY_SLOT, namedMarket: "Houston" });
    assert.equal(bad.allowed, true);
    assert.equal(bad.marketSource, "rotation");
  });

  test("a named market overrides ONE day — it does not shift the sequence", () => {
    // Austin took the 24th by name; the 25th is still Austin's by the calendar
    // and the 26th still Dallas's. The file overrides a day; the calendar owns
    // the sequence.
    assert.equal(cadenceGate(empty, { now: noon("2026-09-25"), city: "austin", slot: DAILY_SLOT }).allowed, true);
    assert.equal(cadenceGate(empty, { now: noon("2026-09-26"), city: "dallas", slot: DAILY_SLOT }).allowed, true);
  });

  test("the answer is the same all Chicago day long", () => {
    // 05:01Z is 00:01 CT; 04:59Z next day is 23:59 CT. Two runs on one day
    // must agree about whose day it is, or a late run could take a second day.
    const first = cadenceGate(empty, { now: new Date("2026-09-25T05:01:00Z"), city: "austin", slot: DAILY_SLOT });
    const last = cadenceGate(empty, { now: new Date("2026-09-26T04:59:00Z"), city: "austin", slot: DAILY_SLOT });
    assert.equal(first.allowed, true);
    assert.equal(last.allowed, true);
    assert.equal(first.day, last.day);
    assert.equal(cadenceGate(empty, { now: new Date("2026-09-26T05:01:00Z"), city: "austin", slot: DAILY_SLOT }).allowed, false, "00:01 CT on the 26th is Dallas's");
  });
});

describe("main.js runs under the law", () => {
  const main = readFileSync(join(SRC, "main.js"), "utf-8");

  test("the gate is asked with the run's city, slot AND the decision file's named market", () => {
    assert.match(main, /cadenceGate\(log, \{ state: cadenceState, city: CITY, slot: SLOT, namedMarket: decision\.plan\?\.today\?\.market \?\? null \}\)/);
  });

  test("LinkedIn is no longer chained to the retired san_antonio pm slot", () => {
    // Left as it was, retiring SA pm would have silenced the daily recruiting
    // post without anyone deciding to.
    assert.doesNotMatch(main, /CITY === "san_antonio" && SLOT === "pm"/);
    assert.match(main, /if \(SLOT === DAILY_SLOT && !TEST_DELIVERY_ONLY\) \{/);
  });

  test("an unset SLOT means the daily slot, not the retired pm", () => {
    assert.match(main, /const SLOT = process\.env\.SLOT \|\| DAILY_SLOT;/);
  });

  test("a stand-down on the SCHEDULED slot alerts; on a dispatch it only annotates", () => {
    // 7-11 dispatches a day were reaching the gate in the week before this
    // shipped. Mailing Peter for each refusal would teach him to ignore the
    // alerts; staying silent when the cron itself stands down would hide the
    // day the lane went dark.
    assert.match(main, /const scheduled = process\.env\.GITHUB_EVENT_NAME === "schedule";/);
    assert.match(main, /outcome: scheduled \? OUTCOME\.NOTHING_TO_POST : OUTCOME\.SKIPPED,/);
  });
});
