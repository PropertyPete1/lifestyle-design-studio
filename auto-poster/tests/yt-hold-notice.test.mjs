import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  heldBackPayload,
  renderHeldBackText,
  heldBackSubject,
  noDraftPayload,
  renderNoDraftText,
  noDraftSubject,
} from "../src/yt-hold-notice.js";

/** The shape the real pipeline hands over — 2026-08-07's actual held-back run. */
const REAL = {
  title: "Best Neighborhoods in North San Antonio (Veteran Honest Guide)",
  scores: {
    clarity: 8,
    retention: 7,
    authenticity: 6,
    worst_problem:
      "A video titled 'Best Neighborhoods in North San Antonio' never names a single neighborhood.",
    worst_boundary: "Start with the older stuff inside the loop.",
    fix: "Name six to eight actual subdivisions and attach each claim to a named place.",
  },
  attemptsUsed: 3,
  belowBar: true,
  criticUnavailable: false,
  takeCount: 37,
  onCameraCount: 13,
  estimatedMinutes: 11,
};

const TOPIC = "Best neighborhoods in North San Antonio, honestly compared";

describe("heldBackPayload — a stage update, never a new question", () => {
  test("carries stage held_below_bar, mirroring the recording kit", () => {
    const p = heldBackPayload({ requestId: "r1", topicTitle: TOPIC, scriptResult: REAL, why: "w" });
    assert.equal(p.stage, "held_below_bar");
    assert.equal(p.requestId, "r1");
  });

  test("names exactly the axes that failed", () => {
    const p = heldBackPayload({ requestId: "r1", topicTitle: TOPIC, scriptResult: REAL, why: "w" });
    assert.deepEqual(p.failingAxes, ["retention", "authenticity"], "clarity=8 met the bar");
  });

  test("carries the critic's reasoning — the whole point of the notice", () => {
    const p = heldBackPayload({ requestId: "r1", topicTitle: TOPIC, scriptResult: REAL, why: "w" });
    assert.match(p.critic.worstProblem, /never names a single neighborhood/);
    assert.match(p.critic.fix, /six to eight actual subdivisions/);
    assert.ok(p.critic.worstBoundary);
  });

  test("says a retry is coming, so the notice cannot read as terminal", () => {
    const p = heldBackPayload({ requestId: "r1", scriptResult: REAL, why: "w" });
    assert.equal(p.retrying, true);
  });

  test("survives a critic outage without inventing scores", () => {
    const unscored = { title: "T", scores: { clarity: 0, retention: 0, authenticity: 0 }, criticUnavailable: true };
    const p = heldBackPayload({ requestId: "r1", scriptResult: unscored, why: "no critic" });
    assert.equal(p.criticUnavailable, true);
    assert.equal(p.critic.worstProblem, null);
  });

  test("does not throw on a malformed scriptResult", () => {
    const p = heldBackPayload({ requestId: "r1", scriptResult: undefined, why: null });
    assert.equal(p.scores.clarity, null);
    assert.deepEqual(p.failingAxes, []);
  });
});

describe("renderHeldBackText — readable on a phone, by someone who did not ask", () => {
  const body = renderHeldBackText({ topicTitle: TOPIC, scriptResult: REAL, why: "below bar" });

  test("leads with the fact that nothing is required of him", () => {
    const head = body.split("\n").slice(0, 6).join("\n");
    assert.match(head, /Nothing is needed from you/i);
  });

  test("shows every axis against the bar, and marks the failing ones", () => {
    assert.match(body, /clarity\s+8 \/ 8/);
    assert.match(body, /retention\s+7 \/ 8\s+<- below/);
    assert.match(body, /authenticity\s+6 \/ 8\s+<- below/);
  });

  test("includes the critic's problem and fix verbatim", () => {
    assert.ok(body.includes(REAL.scores.worst_problem));
    assert.ok(body.includes(REAL.scores.fix));
  });

  test("names the topic Peter actually picked", () => {
    assert.ok(body.includes(TOPIC));
  });

  test("points at the run when one is known", () => {
    const withUrl = renderHeldBackText({
      topicTitle: TOPIC, scriptResult: REAL, why: "w",
      runUrl: "https://github.com/o/r/actions/runs/123",
    });
    assert.match(withUrl, /actions\/runs\/123/);
  });

  test("still says where the draft is when there is no run URL", () => {
    assert.match(body, /script-diagnostics/);
  });

  test('calls the count "drafts scored", never "attempts"', () => {
    // yt-script.js counts this off `attempts`, which only collects drafts that
    // reached scoring. On 2026-08-07 three attempts produced one scored draft,
    // so "attempts used: 1" would have read as a clean first pass.
    assert.match(body, /Drafts scored:\s+3/);
    assert.doesNotMatch(body, /Attempts used/i);
  });

  test("a critic outage explains itself rather than printing zeroes as scores", () => {
    const out = renderHeldBackText({
      topicTitle: TOPIC,
      scriptResult: { title: "T", scores: { clarity: 0, retention: 0, authenticity: 0 }, criticUnavailable: true },
      why: "critic unreachable",
    });
    assert.match(out, /critic could not be reached/i);
    assert.doesNotMatch(out, /0 \/ 8/, "zeroes are an absence of a score, not a score");
  });
});

describe("heldBackSubject — front-loads the verdict", () => {
  test("carries the scores, since it may be all he reads", () => {
    assert.equal(
      heldBackSubject({ topicTitle: TOPIC, scriptResult: REAL }),
      "Script held back (8/7/6) — Best Neighborhoods in North San Antonio (Veteran Honest Guide)"
    );
  });

  test("says unscored rather than 0/0/0 on a critic outage", () => {
    const s = heldBackSubject({ scriptResult: { title: "T", criticUnavailable: true } });
    assert.match(s, /unscored/);
    assert.doesNotMatch(s, /0\/0\/0/);
  });

  test("falls back to the topic when the script has no title", () => {
    assert.match(heldBackSubject({ topicTitle: TOPIC, scriptResult: { scores: {} } }), /North San Antonio/);
  });
});

describe("no usable draft — the other silence", () => {
  // 2026-08-07, third run: all three attempts failed FORMAT validation, so
  // generateScript threw, the run exited red, and the below-bar notice was never
  // reached. Peter got a GitHub "workflow failed" mail that does not say a
  // script was attempted, let alone why it did not survive.
  const FAILURES = [
    { attempt: 1, kind: "unparseable", message: "Expected ',' or ']' after array element in JSON at position 15644" },
    { attempt: 2, kind: "unparseable", message: "Expected ',' or ']' after array element in JSON at position 16412" },
    { attempt: 3, kind: "structure", failures: ["9 sections, max 7", "section 9: missing title"] },
  ];
  const TOPIC = "Best neighborhoods in North San Antonio, honestly compared";

  test("payload marks the stage and counts the attempts", () => {
    const p = noDraftPayload({ requestId: "r1", topicTitle: TOPIC, attemptFailures: FAILURES });
    assert.equal(p.stage, "no_usable_draft");
    assert.equal(p.attempts, 3);
    assert.equal(p.retrying, true);
  });

  test("payload carries each failure's detail, structure ones joined verbatim", () => {
    const p = noDraftPayload({ requestId: "r1", topicTitle: TOPIC, attemptFailures: FAILURES });
    assert.match(p.failures[0].detail, /position 15644/);
    assert.equal(p.failures[2].detail, "9 sections, max 7; section 9: missing title");
  });

  test("the email says this is our problem, not his topic", () => {
    const body = renderNoDraftText({ topicTitle: TOPIC, attemptFailures: FAILURES });
    assert.match(body, /Nothing is needed from you/i);
    assert.match(body, /not a problem with your\s*\n?\s*topic/i);
    assert.match(body, /pick and your notes are untouched/i);
  });

  test("the email lists every attempt verbatim", () => {
    const body = renderNoDraftText({ topicTitle: TOPIC, attemptFailures: FAILURES });
    assert.match(body, /Attempt 1 — unparseable/);
    assert.match(body, /Attempt 3 — structure: 9 sections, max 7/);
  });

  test("subject front-loads the attempt count", () => {
    assert.match(noDraftSubject({ topicTitle: TOPIC, attemptFailures: FAILURES }), /No usable script after 3 attempts/);
  });

  test("survives an empty failure list rather than throwing", () => {
    assert.doesNotThrow(() => renderNoDraftText({ topicTitle: TOPIC }));
    assert.equal(noDraftPayload({ requestId: "r1" }).attempts, 0);
  });
});
