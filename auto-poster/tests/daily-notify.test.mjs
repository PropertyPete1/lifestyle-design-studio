import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { alertBody, alertSubject, runUrl, OUTCOME, notifyDailyFailure } from "../src/daily-notify.js";
import { remedyFor, remedyIdFor } from "../src/failure-remedy.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * The EXACT body ElevenLabs returned on every failed run from 2026-07-27 to
 * 2026-08-09, copied from run 31317105335. Pinned verbatim: the remedy rule is
 * matched on provider text, so a reworded rule that stops matching this string
 * would silently return the system to "diagnosis with no fix", which is the
 * state that made the outage last a fortnight.
 */
const REAL_403 =
  'ElevenLabs TTS failed (403): {"detail":{"type":"authorization_error",' +
  '"code":"subscription_required","message":"Professional voices require a Creator tier ' +
  'subscription or above.","status":"only_for_creator+","request_id":"1e0305a0';

describe("the remedy names the fix, not just the fault", () => {
  test("the real ElevenLabs 403 from the outage is recognised", () => {
    assert.equal(remedyIdFor(REAL_403), "elevenlabs_voice_tier");
  });

  test("and its remedy names BOTH ways out", () => {
    const r = remedyFor(REAL_403);
    assert.match(r, /Creator/i, "must name the subscription");
    assert.match(r, /ELEVENLABS_VOICE_ID/, "must name the env override that needs no deploy");
  });

  test("it says what stays broken until someone acts", () => {
    assert.match(remedyFor(REAL_403), /trial variant/i);
  });

  test("an Error object works as well as a string", () => {
    assert.equal(remedyIdFor(new Error(REAL_403)), "elevenlabs_voice_tier");
  });

  test("a dead Google token is called out as breaking the alerts themselves", () => {
    const r = remedyFor("Failed to refresh Google token (400): invalid_grant");
    assert.match(r, /alert/i, "a dead Google token also kills the email channel — say so");
  });

  test("an unknown error returns null rather than inventing advice", () => {
    assert.equal(remedyFor("something nobody has seen before"), null);
    assert.equal(remedyFor(""), null);
    assert.equal(remedyFor(undefined), null);
  });

  test("a 403 that is not ElevenLabs does not match the ElevenLabs rule", () => {
    assert.notEqual(remedyIdFor("Dashboard returned 403: forbidden"), "elevenlabs_voice_tier");
  });
});

describe("the alert reads like something a human can act on", () => {
  const base = {
    pipeline: "Trial variant",
    label: "am · san_antonio · price_hook",
    outcome: OUTCOME.FAILED,
    reason: `Could not generate the variant: ${REAL_403}`,
    remedy: remedyFor(REAL_403),
    url: "https://github.com/o/r/actions/runs/123",
  };

  test("the subject says which pipeline and how it ended", () => {
    const s = alertSubject(base);
    assert.match(s, /Trial variant/);
    assert.match(s, /FAILED/);
  });

  test("the body carries the cause, the fix and the run link", () => {
    const b = alertBody(base);
    assert.match(b, /WHAT HAPPENED/);
    assert.match(b, /WHAT FIXES IT/);
    assert.match(b, /ELEVENLABS_VOICE_ID/);
    assert.match(b, /actions\/runs\/123/);
  });

  test("it says that its own silence means the alerting is broken", () => {
    // The whole point: Peter must be able to treat "no mail" as a signal.
    assert.match(alertBody(base), /If this stops arriving/i);
  });

  test("a missing remedy omits the section instead of printing an empty heading", () => {
    const b = alertBody({ ...base, remedy: null });
    assert.ok(!/WHAT FIXES IT/.test(b), "an empty remedy section trains the reader to skip it");
  });

  test("outside Actions the run URL degrades honestly", () => {
    assert.equal(runUrl({}), null);
    assert.match(alertBody({ ...base, url: null }), /not running in GitHub Actions/);
  });
});

describe("notifying never makes a bad run worse", () => {
  test("with no credentials it still annotates, and does not throw", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      // accessToken: null == "there is no token" — skips the network entirely,
      // which is what a dead Google OAuth setup looks like from here.
      const res = await notifyDailyFailure({
        pipeline: "Reels",
        label: "austin pm",
        outcome: OUTCOME.FAILED,
        reason: REAL_403,
        accessToken: null,
      });
      assert.equal(res.notified, false, "no token means no inbox");
      assert.deepEqual(res.channels, ["annotation"]);
    } finally {
      console.log = realLog;
    }
    const joined = lines.join("\n");
    assert.match(joined, /^::error title=Reels run FAILED::/m, "the run page must name the cause");
    assert.match(joined, /::error title=ALERTING DEGRADED::/, "a failed alert must itself be reported");
  });

  test("the annotation is a single line — a newline would truncate it in the UI", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await notifyDailyFailure({
        pipeline: "Reels",
        outcome: OUTCOME.NOTHING_TO_POST,
        reason: "line one\nline two\nline three",
        accessToken: null,
      });
    } finally {
      console.log = realLog;
    }
    const ann = lines.find((l) => l.startsWith("::error title=Reels"));
    assert.ok(ann, "no annotation emitted");
    assert.ok(!ann.includes("\n"), "annotation must not contain a raw newline");
    assert.match(ann, /line one line two line three/);
  });
});

/**
 * THE COVERAGE GUARD.
 *
 * The trial pipeline died silently because a `process.exit(1)` with a
 * console.error above it looks, in review, exactly like a handled failure. This
 * asserts that every terminal exit in a daily entry point either notifies or is
 * listed below with a stated reason for not needing to.
 *
 * If you add an exit to one of these files, this test fails until you decide
 * which of the two it is. That decision is the entire point.
 */
describe("no daily pipeline can exit without a human hearing about it", () => {
  const ENTRIES = ["main.js", "trial-variant-main.js", "carousel-main.js"];

  /**
   * Exits that deliberately do NOT notify, each with the reason it is silent.
   * Keyed by the source line so a moved exit re-opens the question.
   */
  const ALLOWED_SILENT = {
    "main.js": [
      { match: /BLOCKED: \$\{guard\.reason\}/, why: "idempotency guard — the backup cron doing its job is not news" },
      { match: /race detected/, why: "another run already posted this slot; that run reports for itself" },
      { match: /Could not resolve file\. Aborting/, why: "manual FORCE_VIDEO_ID typo; the operator is watching the run" },
    ],
    "trial-variant-main.js": [
      { match: /Already generated for today/, why: "idempotency guard — expected on the second cron" },
      { match: /is not a posted video/, why: "manual FORCE_SOURCE_VIDEO_ID typo; operator is watching" },
    ],
    "carousel-main.js": [],
  };

  /**
   * The window for an exit is the code since the PREVIOUS exit — never a fixed
   * lookback.
   *
   * A fixed 30-line window was the first version of this test, and it was wrong
   * in the dangerous direction: the allow-list reason for one exit leaked
   * forward and silently exempted an unrelated exit twenty lines later. The
   * fault was found by deleting the notify calls and watching this test pass
   * anyway. Bounding each window at the previous exit makes a reason apply to
   * exactly the exit it was written for.
   */
  function exitWindows(text) {
    const lines = text.split("\n");
    const out = [];
    let start = 0;
    lines.forEach((line, i) => {
      if (!/process\.exit\(|process\.exitCode\s*=/.test(line)) return;
      out.push({ line: i + 1, source: line.trim(), window: lines.slice(start, i + 1).join("\n") });
      start = i + 1;
    });
    return out;
  }

  for (const file of ENTRIES) {
    test(`${file}: every exit either notifies or is explicitly allowed to be silent`, () => {
      const text = readFileSync(join(SRC, file), "utf-8");
      const unexplained = [];

      for (const ex of exitWindows(text)) {
        if (/notifyDailyFailure\(/.test(ex.window)) continue;
        if ((ALLOWED_SILENT[file] || []).some((a) => a.match.test(ex.window))) continue;
        unexplained.push(`${file}:${ex.line}  ${ex.source}`);
      }

      assert.deepEqual(unexplained, [], `exits with no notification and no stated reason:\n${unexplained.join("\n")}`);
    });
  }

  /**
   * The windows must not overlap and must cover every exit — otherwise the test
   * above could be checking a subset while reporting a clean sweep.
   */
  test("the windows are disjoint and cover every exit in every entry point", () => {
    for (const file of ENTRIES) {
      const text = readFileSync(join(SRC, file), "utf-8");
      const windows = exitWindows(text);
      const rawCount = (text.match(/process\.exit\(|process\.exitCode\s*=/g) || []).length;
      assert.equal(windows.length, rawCount, `${file}: ${windows.length} windows for ${rawCount} exits`);
      // Reassembling every window must reproduce the file up to the last exit.
      const rejoined = windows.map((w) => w.window).join("\n");
      assert.ok(text.startsWith(rejoined), `${file}: windows do not tile the source`);
    }
  });

  test("the guard has teeth: it finds the exits it is meant to be checking", () => {
    // A regex that matched nothing would pass this suite forever while checking
    // nothing — the exact failure this codebase keeps paying for.
    let total = 0;
    for (const file of ENTRIES) {
      const text = readFileSync(join(SRC, file), "utf-8");
      total += (text.match(/process\.exit\(|process\.exitCode\s*=/g) || []).length;
    }
    assert.ok(total >= 10, `expected to be checking at least 10 exits, found ${total}`);
  });

  test("every daily entry point actually imports the notifier", () => {
    for (const file of ENTRIES) {
      const text = readFileSync(join(SRC, file), "utf-8");
      assert.match(text, /daily-notify\.js/, `${file} cannot notify anything`);
    }
  });
});
