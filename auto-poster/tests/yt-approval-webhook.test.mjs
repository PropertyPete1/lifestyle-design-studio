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
    assert.deepEqual(Object.keys(body).sort(), ["kind", "payload", "requestId", "requestedAt", "type"]);
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
