/**
 * Where approval requests are sent.
 *
 * This exists because the poster was pointed at the WRONG endpoint —
 * /api/delivery/webhook, which renders delivery cards — while the dashboard
 * serves approvals from /api/delivery/approval-webhook.
 *
 * That failure mode is nasty precisely because it is quiet. The request goes
 * somewhere, the handler answers, and no approval card is ever raised. Peter
 * gets no push, the pipeline waits forever, and every scheduled run reports a
 * perfectly healthy "still waiting on Peter".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_WEBHOOK_PATH, DELIVERY_WEBHOOK_PATH, approvalPayload } from "../src/delivery.js";

describe("the approval endpoint", () => {
  test("is the deployed approval path", () => {
    assert.equal(APPROVAL_WEBHOOK_PATH, "/api/delivery/approval-webhook");
  });

  test("is NOT the delivery path", () => {
    assert.notEqual(APPROVAL_WEBHOOK_PATH, DELIVERY_WEBHOOK_PATH);
  });

  test("the delivery path is unchanged — deliveries still work", () => {
    assert.equal(DELIVERY_WEBHOOK_PATH, "/api/delivery/webhook");
  });
});

describe("the approval payload", () => {
  const body = approvalPayload({
    requestId: "topic_pick-2026-08-06-abcd1234",
    kind: "topic_pick",
    payload: { candidates: [{ title: "one" }] },
    requestedAt: "2026-08-06T12:00:00.000Z",
  });

  test("carries exactly the fields the card needs", () => {
    assert.deepEqual(Object.keys(body).sort(), ["kind", "payload", "requestId", "requestedAt", "stage", "type"]);
  });

  test("a brief carries stage null — it is asking for a decision", () => {
    assert.equal(body.stage, null);
    assert.ok("stage" in body, "the key is always present, so routing never sees undefined");
  });

  test("declares itself an approval", () => {
    assert.equal(body.type, "approval");
  });

  test("carries the requestId the decision will be keyed to", () => {
    assert.equal(body.requestId, "topic_pick-2026-08-06-abcd1234");
  });

  test("carries the kind, so the card knows which shape to render", () => {
    assert.equal(body.kind, "topic_pick");
  });

  test("nests the card data under payload rather than spreading it", () => {
    assert.equal(body.payload.candidates.length, 1);
  });

  test("stamps when it was raised", () => {
    assert.equal(body.requestedAt, "2026-08-06T12:00:00.000Z");
  });
});


describe("stage — the flat routing field", () => {
  // Five different things ship as kind:"topic_pick". Only payload.stage told
  // them apart, and the two that render are the two without one — which is how
  // a delivered recording kit and two hold notices all arrived with no surface.
  const envelope = (payload) =>
    approvalPayload({ requestId: "r1", kind: "topic_pick", payload, requestedAt: "t" });

  test("lifts every stage the pipeline actually sends", () => {
    for (const stage of ["recording_kit", "held_below_bar", "no_usable_draft"]) {
      assert.equal(envelope({ stage }).stage, stage, `${stage} must reach the envelope`);
    }
  });

  test("KEEPS payload.stage for compatibility — nothing reading it has to change", () => {
    const e = envelope({ stage: "recording_kit", takes: [] });
    assert.equal(e.stage, "recording_kit");
    assert.equal(e.payload.stage, "recording_kit", "the nested copy stays");
  });

  test("null for a brief, so stage===null means 'a decision is wanted'", () => {
    assert.equal(envelope({ candidates: [{ title: "a" }] }).stage, null);
  });

  test("the two brief shapes and the three stage shapes are now distinguishable", () => {
    const brief = envelope({ candidates: [] });
    const kit = envelope({ stage: "recording_kit" });
    assert.notEqual(brief.stage, kit.stage, "same kind, different stage — routable on one field");
    assert.equal(brief.kind, kit.kind, "kind alone was never enough");
  });

  test("junk in payload.stage degrades to null rather than propagating", () => {
    assert.equal(envelope({ stage: "" }).stage, null);
    assert.equal(envelope({ stage: 42 }).stage, null);
    assert.equal(envelope(null).stage, null);
    assert.equal(envelope(undefined).stage, null);
  });
});
