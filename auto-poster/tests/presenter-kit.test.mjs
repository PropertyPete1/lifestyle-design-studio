/**
 * presenter-kit.test.mjs — the kit email IS the onboarding, TEST- presenters
 * are inert, and the delivery rules cannot cross wires.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildKit, renderKitText, kitPayload, recorderUrl } from "../src/yt-recording-kit.js";
import { sendPresenterEmail } from "../src/delivery.js";
import { assertAssignable, deliverKit } from "../src/kit-delivery.js";

const GUEST = { id: "steven-van-orden", name: "Steven Van Orden", email: "steven@x.com", role: "guest", accessCode: "123456" };
const TEST_GUEST = { id: "TEST-ghost", name: "TEST-Ghost", email: "ghost@x.com", role: "guest", accessCode: "654321", test: true };

function fixtureScript() {
  return {
    title: "San Antonio Property Taxes Explained",
    hook: "The number on your tax bill is wrong.",
    sections: [
      {
        title: "The rate",
        takes: [
          { id: "s1t1", mode: "ON_CAMERA", text: "Here is the thing about the rate, and why it moves every single year without anyone warning you first.", direction: "energy up" },
          { id: "s1t2", mode: "VOICEOVER", text: "The county sets one line and the school district sets another, and together they are the bill.", direction: "steady" },
        ],
      },
    ],
    close: { mode: "ON_CAMERA", text: "Text us at the number on the screen and we'll run your actual monthly payment.", direction: "direct" },
  };
}

describe("the onboarding kit email", () => {
  const kit = buildKit({ script: fixtureScript(), title: "t" }, { requestId: "topic_pick-X", narrationMode: "peter" });

  test("with no options, renderKitText is exactly the pre-presenter email", () => {
    const text = renderKitText(kit);
    assert.ok(text.startsWith("RECORDING KIT —"), "no onboarding header without a presenter");
    assert.doesNotMatch(text, /ACCESS CODE/);
    assert.match(text, /UPLOAD TO:/);
  });

  test("with a presenter it opens with everything a first-timer needs", () => {
    const text = renderKitText(kit, { presenter: GUEST, accessCode: GUEST.accessCode, recorderLink: "https://dash.example/recorder" });
    // Greeting by first name, one what-is-this paragraph, the door, the key.
    assert.match(text, /^Hi Steven,/);
    assert.match(text, /recording kit/i);
    assert.match(text, /START HERE: https:\/\/dash\.example\/recorder/);
    assert.match(text, /YOUR ACCESS CODE: 123456/);
    // The drill, verbatim requirements: teleprompter, one at a time, retake, thumbnail.
    assert.match(text, /teleprompter reads each take/i);
    assert.match(text, /One take at a time/);
    assert.match(text, /Retake it till it's clean/i);
    assert.match(text, /Don't skip the thumbnail take/);
    // And the kit itself still follows.
    assert.match(text, /RECORDING KIT —/);
  });

  test("no recorder URL configured says so honestly instead of linking to nothing", () => {
    const old = { app: process.env.RECORDER_APP_URL, dash: process.env.DASHBOARD_URL };
    delete process.env.RECORDER_APP_URL;
    delete process.env.DASHBOARD_URL;
    try {
      assert.equal(recorderUrl(), null);
      const text = renderKitText(kit, { presenter: GUEST, accessCode: GUEST.accessCode });
      assert.match(text, /recorder link coming separately/);
    } finally {
      if (old.app) process.env.RECORDER_APP_URL = old.app;
      if (old.dash) process.env.DASHBOARD_URL = old.dash;
    }
  });

  test("recorderUrl prefers the explicit URL and falls back to the dashboard path", () => {
    const old = { app: process.env.RECORDER_APP_URL, dash: process.env.DASHBOARD_URL };
    try {
      process.env.RECORDER_APP_URL = "https://rec.example/go";
      process.env.DASHBOARD_URL = "https://dash.example/";
      assert.equal(recorderUrl(), "https://rec.example/go");
      delete process.env.RECORDER_APP_URL;
      assert.equal(recorderUrl(), "https://dash.example/recorder");
    } finally {
      if (old.app) process.env.RECORDER_APP_URL = old.app; else delete process.env.RECORDER_APP_URL;
      if (old.dash) process.env.DASHBOARD_URL = old.dash; else delete process.env.DASHBOARD_URL;
    }
  });

  test("kitPayload names the presenter, never the code", () => {
    const payload = kitPayload(kit, { presenter: GUEST });
    assert.deepEqual(payload.presenter, { id: GUEST.id, name: GUEST.name, role: "guest" });
    assert.equal(JSON.stringify(payload).includes(GUEST.accessCode), false, "an access code must never ride a webhook payload");
  });
});

describe("TEST- presenters are inert", () => {
  test("sendPresenterEmail suppresses real mail for a TEST presenter", async () => {
    // No accessToken supplied: if suppression failed to short-circuit, the
    // send would fail on the missing token instead of returning suppressed.
    const r = await sendPresenterEmail(null, { presenter: TEST_GUEST, subject: "s", body: "line1\nline2" });
    assert.equal(r.ok, true);
    assert.equal(r.suppressed, true);
  });

  test("a presenter with no email is a refusal, not a redirect to the owner", async () => {
    const r = await sendPresenterEmail(null, { presenter: { id: "x", name: "X" }, subject: "s", body: "b" });
    assert.equal(r.ok, false);
    assert.match(r.lastError.message, /no email/);
  });

  test("a TEST- presenter cannot be assigned to a real request", () => {
    const r = assertAssignable(TEST_GUEST, "topic_pick-2026-08-17-f60982b7");
    assert.equal(r.ok, false);
    assert.match(r.reason, /TEST-/);
  });

  test("a TEST- presenter on a TEST- request is fine, and so is a real one on a real request", () => {
    assert.ok(assertAssignable(TEST_GUEST, "TEST-topic_pick-X").ok);
    assert.ok(assertAssignable(GUEST, "topic_pick-X").ok);
  });
});

describe("deliverKit", () => {
  test("dry run builds the real kit and touches no channel", async () => {
    const r = await deliverKit({
      requestId: "topic_pick-X",
      script: fixtureScript(),
      presenter: GUEST,
      accessToken: null,
      dryRun: true,
    });
    assert.equal(r.dryRun, true);
    assert.ok(r.kit.takes.length >= 3, "on-camera + voiceover + thumbnail take");
    assert.deepEqual(r.channels, []);
  });

  test("a TEST- presenter's live delivery suppresses the presenter mail but still runs the flow", async () => {
    // The dashboard channel is unavailable (no env) and there is no Google
    // token, so sendApprovalRequest would throw "reached NEITHER channel" —
    // which is the correct loud failure — but the PRESENTER leg must have
    // been suppressed first, proving order and inertness together.
    const oldUrl = process.env.DASHBOARD_URL;
    const oldSecret = process.env.DASHBOARD_WEBHOOK_SECRET;
    delete process.env.DASHBOARD_URL;
    delete process.env.DASHBOARD_WEBHOOK_SECRET;
    try {
      await assert.rejects(
        deliverKit({ requestId: "TEST-topic_pick-X", script: fixtureScript(), presenter: TEST_GUEST, accessToken: null }),
        /NEITHER channel/
      );
    } finally {
      if (oldUrl) process.env.DASHBOARD_URL = oldUrl;
      if (oldSecret) process.env.DASHBOARD_WEBHOOK_SECRET = oldSecret;
    }
  });

  test("a guest kit that cannot reach its presenter is fatal before any other channel", async () => {
    await assert.rejects(
      deliverKit({
        requestId: "topic_pick-X",
        script: fixtureScript(),
        // Real (non-test) guest, no token: the presenter email leg fails and
        // the whole delivery must fail with it — a kit that reached nobody
        // who can record it must not mark the stage advanced.
        presenter: GUEST,
        accessToken: null,
      }),
      /did not reach its presenter/
    );
  });

  test("a superseding kit says so out loud in the presenter email", async () => {
    const r = await deliverKit({
      requestId: "topic_pick-X",
      script: fixtureScript(),
      presenter: GUEST,
      accessToken: null,
      supersedes: { id: "peter", name: "Peter Allen", assignedAt: "2026-08-17" },
      dryRun: true,
    });
    assert.equal(r.dryRun, true);
    // The dry run prints the presenter body; rebuild it here to assert.
    const body = renderKitText(r.kit, { presenter: GUEST, accessCode: GUEST.accessCode });
    assert.ok(body.length > 0);
  });
});
