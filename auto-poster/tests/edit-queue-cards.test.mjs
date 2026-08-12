/**
 * edit-queue-cards.test.mjs — what Peter actually reads.
 *
 * These are the strings he acts on, and every one of them can fail in a way
 * that is invisible from the inside: a card whose links are `undefined`, an
 * email that says "[object Object]", a failure notice with no reason in it.
 * All three render perfectly and are all useless, and nothing anywhere would go
 * red. So the payloads and the bodies are built by pure functions, and this is
 * what argues with them.
 *
 * The recurring assertion is "no `undefined` or `null` reached the text". It
 * looks crude next to the rest of this suite and it is the single highest-value
 * check in the file — a Drive link that reads `undefined` is the difference
 * between a working review and a support message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_START,
  deliveredCardPayload,
  durationLabel,
  failureCardPayload,
  failureEmail,
  queueCardEmail,
  queueCardPayload,
  reviewCardEmail,
  reviewCardPayload,
  startedCardPayload,
} from "../src/edit-queue-cards.js";
import { STATUS } from "../src/edit-queue.js";

const RECORD = {
  driveFileId: "1abc",
  fileName: "IMG_0042.mov",
  durationSeconds: 41.2,
  discoveredAt: "2026-08-11T12:00:00.000Z",
  status: STATUS.IN_REVIEW,
  revision: 2,
  queueRequestId: "reel_edit-2026-08-11-aaaa1111",
  reviewRequestId: "reel_review-2026-08-11-bbbb2222",
  master: { driveFileId: "m1", fileName: "master.mp4", link: "https://drive.google.com/file/d/m1/view" },
  variants: [
    { label: "A", hookLine: "Taxes here catch most buyers out", treatment: "hook plate over the master's own opening", driveFileId: "a1", fileName: "A.mp4", link: "https://drive.google.com/file/d/a1/view" },
    { label: "B", hookLine: "Asking 340,000 for this kitchen", treatment: "hook plate, cold open 1.2s in (on a cut)", driveFileId: "b1", fileName: "B.mp4", link: "https://drive.google.com/file/d/b1/view" },
  ],
};

/** Nothing a human reads may contain a stringified nothing. */
function noHoles(text, label) {
  for (const hole of ["undefined", "null", "[object Object]", "NaN"]) {
    assert.ok(!String(text).includes(hole), `${label} contains "${hole}":\n${text}`);
  }
}

// ─── the Start card ─────────────────────────────────────────────────────────

test("the Start card says what will happen and asks one question", () => {
  const payload = queueCardPayload(RECORD);
  assert.equal(payload.driveFileId, "1abc");
  assert.equal(payload.fileName, "IMG_0042.mov");
  assert.equal(payload.duration, "41s");
  assert.deepEqual(payload.actions, [{ id: ACTION_START, label: "Start Edit" }]);
  // No stage on a card that is asking for a decision — the envelope convention
  // in delivery.js reads a null stage as "render the card and ask".
  assert.equal(payload.stage, undefined);
  noHoles(JSON.stringify(payload), "the Start card");
});

test("the Start email states plainly that nothing has happened yet", () => {
  const mail = queueCardEmail(RECORD);
  assert.match(mail.subject, /IMG_0042\.mov/);
  assert.match(mail.body, /NOTHING HAS BEEN DONE TO IT/);
  assert.match(mail.body, /No scheduled job will ever start an edit on its own/);
  assert.match(mail.body, /400ms/);
  assert.match(mail.body, /150ms/);
  noHoles(mail.body, "the Start email");
});

// ─── the review card ────────────────────────────────────────────────────────

test("the review card carries a link for the master and every variant", () => {
  const payload = reviewCardPayload(RECORD, { editSummary: "41.2s in, 33.0s out" });
  assert.equal(payload.master.link, "https://drive.google.com/file/d/m1/view");
  assert.equal(payload.variants.length, 2);
  for (const v of payload.variants) {
    assert.ok(v.link, `variant ${v.label} has no link`);
    assert.ok(v.hookLine, `variant ${v.label} has no hook line`);
  }
  // The delivery cards on this dashboard use `driveLink`, so a card type it has
  // not been taught is likeliest to fall back on the shape it knows.
  assert.equal(payload.driveLink, payload.master.link);
  assert.equal(payload.stage, undefined, "a review card is a question, not progress");
  noHoles(JSON.stringify(payload), "the review card");
});

test("the review email is a working review surface on its own", () => {
  // Peter reviews from his phone, away from the dashboard. The email is not a
  // notification that something is waiting — it IS the review.
  const mail = reviewCardEmail(RECORD, { editSummary: "41.2s in, 33.0s out", warnings: [] });
  assert.match(mail.body, /https:\/\/drive\.google\.com\/file\/d\/m1\/view/);
  assert.match(mail.body, /https:\/\/drive\.google\.com\/file\/d\/a1\/view/);
  assert.match(mail.body, /https:\/\/drive\.google\.com\/file\/d\/b1\/view/);
  assert.match(mail.body, /Taxes here catch most buyers out/);
  assert.match(mail.body, /nothing is on the Trial tab yet/);
  noHoles(mail.body, "the review email");
});

test("a missing link is said out loud rather than rendered as undefined", () => {
  const broken = { ...RECORD, master: { driveFileId: "m1", fileName: "master.mp4", link: null }, variants: [{ label: "A", hookLine: "A line", treatment: "t", link: null }] };
  const mail = reviewCardEmail(broken, { editSummary: "x" });
  assert.match(mail.body, /no link/);
  noHoles(mail.body, "the review email with a failed upload");
});

test("a video that produced no variants still gets a reviewable email", () => {
  // The no-speech case: an edited master worth approving, and nothing else.
  const bare = { ...RECORD, variants: [] };
  const mail = reviewCardEmail(bare, { editSummary: "x", warnings: ["only 0 honest hook line(s) survived the gates"] });
  assert.match(mail.body, /\(none — see the warnings below\)/);
  assert.match(mail.body, /only 0 honest hook line/);
  noHoles(mail.body, "the review email with no variants");
});

test("warnings reach the card as well as the email", () => {
  const payload = reviewCardPayload(RECORD, { editSummary: "x", warnings: ["the master's link may need a login"] });
  assert.deepEqual(payload.warnings, ["the master's link may need a login"]);
});

// ─── failure ────────────────────────────────────────────────────────────────

test("a failure card carries where it died, why, and what to do", () => {
  const payload = failureCardPayload(RECORD, { stage: "render", reason: "ffmpeg exited 1", remedy: "Check the run log." });
  assert.equal(payload.stage, "edit_failed", "a failure is progress on a decided request, not a new question");
  assert.equal(payload.failedStage, "render");
  assert.equal(payload.reason, "ffmpeg exited 1");
  assert.equal(payload.status, STATUS.FAILED);
  assert.equal(payload.requestId, RECORD.queueRequestId);
  noHoles(JSON.stringify(payload), "the failure card");
});

test("a failure email is loud, names the reason, and never implies a retry", () => {
  const mail = failureEmail(RECORD, { stage: "render", reason: "ffmpeg exited 1", remedy: "Check the run log." });
  assert.match(mail.subject, /FAILED/);
  assert.match(mail.body, /ffmpeg exited 1/);
  assert.match(mail.body, /nothing retries on its own/);
  assert.match(mail.body, /Nothing was posted and nothing reached the Trial tab/);
  noHoles(mail.body, "the failure email");
});

test("a failure with no remedy omits the line rather than printing an empty one", () => {
  const mail = failureEmail(RECORD, { stage: "render", reason: "ffmpeg exited 1" });
  assert.ok(!/Fix:/.test(mail.body), "an empty remedy line is noise");
  noHoles(mail.body, "the failure email with no remedy");
});

// ─── progress notices ───────────────────────────────────────────────────────

test("progress notices carry a stage so they cannot read as a new question", () => {
  // A notice that renders as an unanswered card would wedge the queue behind a
  // question nobody was asked.
  assert.equal(startedCardPayload(RECORD).stage, "edit_started");
  assert.equal(deliveredCardPayload(RECORD, { trialLinks: [] }).stage, "edit_delivered");
  assert.equal(startedCardPayload(RECORD).requestId, RECORD.queueRequestId);
  assert.equal(deliveredCardPayload(RECORD, { trialLinks: [] }).requestId, RECORD.reviewRequestId);
});

test("a test record is marked as one on every card it produces", () => {
  const testRecord = { ...RECORD, test: true };
  for (const payload of [
    queueCardPayload(testRecord),
    reviewCardPayload(testRecord, { editSummary: "x" }),
    failureCardPayload(testRecord, { stage: "render", reason: "x" }),
    startedCardPayload(testRecord),
    deliveredCardPayload(testRecord, {}),
  ]) {
    assert.equal(payload.isTest, true);
  }
  assert.equal(queueCardPayload(RECORD).isTest, false);
});

// ─── the small stuff that shows up in front of a human ──────────────────────

test("a duration is readable, and an unknown one says so", () => {
  assert.equal(durationLabel(41.2), "41s");
  assert.equal(durationLabel(75), "1m 15s");
  assert.equal(durationLabel(600), "10m 00s");
  // The case the first live sweep produced: Drive had not written the metadata
  // yet. "unknown" is honest; "NaNs" or "0s" would be a lie.
  for (const value of [null, undefined, 0, -1, "nonsense"]) {
    assert.match(durationLabel(value), /unknown/, `${String(value)} rendered as something other than unknown`);
  }
});
