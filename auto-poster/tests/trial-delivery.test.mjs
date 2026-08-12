/**
 * Trial variant delivery + outcome reporting.
 *
 * THE BUG THESE EXIST FOR.
 *
 * `deliverToOwner`'s trial branch returned a hardcoded `delivered: true` and had
 * exactly one notification channel. `withRetry` resolves to `{ ok: false }`
 * rather than throwing, so a trial webhook that failed all three attempts
 * produced: a green workflow, a "✓ Delivered to Drive + dashboard" log line, a
 * recorded variant whose angle would never be retried, and no card on the Trial
 * tab. The city-reel path next to it had two channels and threw when both died.
 *
 * Every test below fails against that old shape.
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** uploadToReadyFolder stats the path, so the stub needs a real file. */
const VIDEO = join(mkdtempSync(join(tmpdir(), "trial-delivery-")), "variant.mp4");
writeFileSync(VIDEO, "not really an mp4");

// Several tests below drive a channel through all three retries. At the real
// 2s/4s/8s that is 14 seconds each; the retry logic is identical either way.
process.env.DELIVERY_BACKOFF_BASE_MS = "1";

/**
 * Stub Drive, the trial webhook and Gmail so the channel-reporting logic runs
 * without the network. `deliverToOwner` takes the access token as an argument on
 * this path, so no OAuth is involved.
 */
async function loadTrialDeliveryWithStubs({ dashboardOk, emailOk }) {
  const calls = { trialPayloads: [], manifests: [] };
  const realFetch = globalThis.fetch;
  const realEnv = {
    url: process.env.DASHBOARD_URL,
    secret: process.env.DASHBOARD_WEBHOOK_SECRET,
  };
  // notifyTrialDashboard bails before fetching if these are unset.
  process.env.DASHBOARD_URL = "https://dashboard.test";
  process.env.DASHBOARD_WEBHOOK_SECRET = "test-secret";

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/api/delivery/trial-webhook")) {
      calls.trialPayloads.push(JSON.parse(opts.body));
      return dashboardOk
        ? { ok: true, status: 200, text: async () => "ok", json: async () => ({}) }
        : { ok: false, status: 500, text: async () => "trial tab exploded" };
    }
    if (u.includes("gmail") || u.includes("/api/delivery/email-backup")) {
      return emailOk
        ? { ok: true, status: 200, text: async () => "ok", json: async () => ({}) }
        : { ok: false, status: 500, text: async () => "smtp down" };
    }
    // Drive: upload, permissions, manifest writes all succeed blandly.
    if (u.includes("upload") || u.includes("drive")) {
      const body = String(opts.body || "");
      if (body.includes("MANIFEST") || body.includes("manifest")) calls.manifests.push(body);
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "https://upload.example/session" },
      text: async () => "ok",
      json: async () => ({
        id: "drive-file-1",
        name: "variant.mp4",
        webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
        files: [{ id: "folder1", name: "Ready to Post" }],
      }),
    };
  };

  const mod = await import(`../src/delivery.js?trial=${Math.random()}`);

  return {
    calls,
    deliverToOwner: mod.deliverToOwner,
    TEST_PREFIX: mod.TEST_PREFIX,
    isTestArtifact: mod.isTestArtifact,
    restore: () => {
      globalThis.fetch = realFetch;
      if (realEnv.url === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = realEnv.url;
      if (realEnv.secret === undefined) delete process.env.DASHBOARD_WEBHOOK_SECRET;
      else process.env.DASHBOARD_WEBHOOK_SECRET = realEnv.secret;
    },
  };
}

const TRIAL_OPTS = {
  isTrial: true,
  trialLabel: "TRIAL #2 of source.mp4",
  trialAngle: "price_hook",
  trialVariantNumber: 2,
  window: "am",
  sourceVideoId: "src-1",
  sourceViews: 4200,
};

describe("the A/B/C hook line reaches the Trial tab", () => {
  /**
   * The manual edit queue's variants differ by an actual LINE OF TEXT written
   * for that video, and "which line won" is the entire question its A/B exists
   * to answer. The trial pipeline's variants differ by a named strategy
   * (`hookAngle`), which is all the tab needed until now — so a queue variant
   * sent with only an angle would put three cards on the tab that are
   * indistinguishable to the person deciding between them.
   */
  test("a hook line is passed through when one is given", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: true, emailOk: true });
    try {
      await h.deliverToOwner("token", VIDEO, "austin", "caption", {
        ...TRIAL_OPTS,
        trialAngle: "edit_queue_B",
        trialHookLine: "Taxes here catch most buyers out",
      });
      const payload = h.calls.trialPayloads.at(-1);
      assert.equal(payload.hookLine, "Taxes here catch most buyers out");
      assert.equal(payload.hookAngle, "edit_queue_B", "the label must survive too");
    } finally {
      h.restore();
    }
  });

  test("the trial pipeline's own payload is unchanged — the field is null, not missing logic", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: true, emailOk: true });
    try {
      await h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS);
      const payload = h.calls.trialPayloads.at(-1);
      assert.equal(payload.hookLine, null, "an existing caller must not start sending undefined");
      assert.equal(payload.hookAngle, "price_hook");
      assert.equal(payload.variantNumber, 2);
      assert.equal(payload.window, "am");
    } finally {
      h.restore();
    }
  });
});

describe("trial delivery reports the Trial tab honestly", () => {
  test("a dead trial webhook is reported, not swallowed behind delivered:true", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: false, emailOk: true });
    try {
      const res = await h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS);

      // The old code returned dashboardOk-less `delivered: true` here and the
      // caller printed "✓ Delivered to Drive + dashboard".
      assert.equal(res.dashboardOk, false, "a failed webhook must be reported as such");
      assert.ok(res.dashboardError, "the caller needs the reason to put in the alert");
      assert.ok(
        !res.channels.includes("trial-dashboard"),
        "a channel that failed must not be listed as one that carried the variant"
      );
      assert.ok(res.channels.includes("email"), "the surviving channel should still be reported");
    } finally {
      h.restore();
    }
  });

  test("losing BOTH channels throws — the old trial path could not fail", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: false, emailOk: false });
    try {
      await assert.rejects(
        () => h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS),
        /[Bb]oth trial notification channels failed/,
        "with no way to tell Peter, the run has to go red"
      );
    } finally {
      h.restore();
    }
  });

  test("a healthy run reports both channels and a verified tab", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: true, emailOk: true });
    try {
      const res = await h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS);
      assert.equal(res.dashboardOk, true);
      assert.equal(res.dashboardError, null);
      assert.deepEqual(res.channels, ["trial-dashboard", "email"]);
      assert.equal(h.calls.trialPayloads.length, 1);
      assert.equal(h.calls.trialPayloads[0].hookAngle, "price_hook");
    } finally {
      h.restore();
    }
  });

  test("the trial path has a second channel at all", async () => {
    // The webhook was the only way a variant could reach Peter. If the email
    // backup is ever dropped from this branch again, this fails.
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: false, emailOk: true });
    try {
      const res = await h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS);
      assert.ok(
        res.channels.length > 0,
        "a trial with a dead webhook and working mail must still reach Peter"
      );
    } finally {
      h.restore();
    }
  });
});

describe("test runs are marked so real surfaces can filter them", () => {
  test("isTest stamps the TEST- prefix the YouTube approvals path already uses", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: true, emailOk: true });
    try {
      const res = await h.deliverToOwner("token", VIDEO, "austin", "caption", {
        ...TRIAL_OPTS,
        isTest: true,
      });
      const payload = h.calls.trialPayloads[0];
      assert.ok(
        payload.sourceFileName.startsWith(h.TEST_PREFIX),
        `test payload must be identifiable from the payload alone, got ${payload.sourceFileName}`
      );
      assert.equal(payload.isTest, true, "an explicit flag, not just a name convention");
      assert.equal(res.isTest, true);
      assert.ok(h.isTestArtifact(payload.sourceFileName));
    } finally {
      h.restore();
    }
  });

  test("a real run is never marked as a test", async () => {
    const h = await loadTrialDeliveryWithStubs({ dashboardOk: true, emailOk: true });
    try {
      await h.deliverToOwner("token", VIDEO, "austin", "caption", TRIAL_OPTS);
      const payload = h.calls.trialPayloads[0];
      assert.equal(payload.isTest, false);
      assert.ok(!h.isTestArtifact(payload.sourceFileName), "a real variant must not be filtered out");
    } finally {
      h.restore();
    }
  });

  test("a TEST_DELIVERY_ONLY run does not write to trial-variants.json", () => {
    // Step 5 used to run unconditionally, so every delivery test burned a real
    // hook angle for a real source video and left a record the Trial tab renders
    // as a genuine variant.
    const text = readFileSync(join(SRC, "trial-variant-main.js"), "utf-8");
    const step5 = text.slice(text.indexOf("Step 5:"), text.indexOf("Step 6:"));
    assert.match(
      step5,
      /if \(!TEST_DELIVERY_ONLY\)/,
      "the trial-variants.json write must be gated on it not being a test run"
    );
    assert.match(step5, /saveTrialHistory\(history\)/, "guard has teeth: the write it gates still exists");
  });
});

describe("every trial outcome reaches a human", () => {
  test("SUCCEEDED and SKIPPED annotate the run page without mailing", async () => {
    const { notifyDailyOutcome, OUTCOME } = await import("../src/daily-notify.js");
    for (const outcome of [OUTCOME.SUCCEEDED, OUTCOME.SKIPPED]) {
      const lines = [];
      const realLog = console.log;
      console.log = (...a) => lines.push(a.join(" "));
      try {
        await notifyDailyOutcome({
          pipeline: "Trial variant",
          outcome,
          reason: "something worth knowing",
          accessToken: null,
        });
      } finally {
        console.log = realLog;
      }
      const joined = lines.join("\n");
      assert.match(joined, /::notice title=Trial variant/, `${outcome} must annotate the run page`);
      assert.ok(
        !joined.includes("::error title=ALERTING DEGRADED"),
        `${outcome} is not an alert, so a missing inbox is not a degradation`
      );
    }
  });

  test("a skip on the cron is promoted to the inbox", async () => {
    const { notifyDailyOutcome, OUTCOME } = await import("../src/daily-notify.js");
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await notifyDailyOutcome({
        pipeline: "Trial variant",
        outcome: OUTCOME.SKIPPED,
        reason: "window already filled",
        forceEmail: true,
        accessToken: null, // no token → the email attempt fails
      });
    } finally {
      console.log = realLog;
    }
    const joined = lines.join("\n");
    assert.match(joined, /::notice title=Trial variant/);
    // It tried to mail and could not, and said so. Silence is the failure mode.
    assert.match(joined, /::error title=ALERTING DEGRADED/);
  });

  test("failure-class outcomes still take the full alert path", async () => {
    const { notifyDailyOutcome, OUTCOME } = await import("../src/daily-notify.js");
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await notifyDailyOutcome({
        pipeline: "Trial variant",
        outcome: OUTCOME.UNVERIFIED,
        reason: "webhook died",
        accessToken: null,
      });
    } finally {
      console.log = realLog;
    }
    const joined = lines.join("\n");
    assert.match(joined, /::error title=Trial variant/, "a bad outcome must be an error annotation");
  });

  test("a skip is escalated only when the cron re-served its own window", async () => {
    const { shouldEscalateSkip } = await import("../src/trial-variant.js");

    // The fault: the cron filled this window and the cron is back. A replay, or
    // a window computation stuck on a slot it already served.
    assert.equal(
      shouldEscalateSkip({ scheduled: true, existing: { trigger: "schedule" } }),
      true,
      "a cron re-serving its own window is the permanent-no-op shape"
    );

    // Benign: a human ran the slot early. The cron finding it filled is correct,
    // and mailing about it is how an alert channel gets muted.
    assert.equal(
      shouldEscalateSkip({ scheduled: true, existing: { trigger: "manual" } }),
      false,
      "a human filling the window early is not a fault"
    );

    // A manual re-run always expects to find something.
    assert.equal(shouldEscalateSkip({ scheduled: false, existing: { trigger: "schedule" } }), false);
    assert.equal(shouldEscalateSkip({ scheduled: false, existing: { trigger: "manual" } }), false);

    // Legacy records predate the field; read them the cautious way.
    assert.equal(
      shouldEscalateSkip({ scheduled: true, existing: { date: "2026-08-10" } }),
      true,
      "a record with no trigger must be read as cron-filled"
    );
    assert.equal(shouldEscalateSkip({ scheduled: true, existing: undefined }), true);
  });

  test("the variant record states what filled the window", () => {
    const text = readFileSync(join(SRC, "trial-variant-main.js"), "utf-8");
    assert.match(
      text,
      /trigger: process\.env\.GITHUB_EVENT_NAME === "schedule" \? "schedule" : "manual"/,
      "without this field the skip rule cannot tell a replay from a human"
    );
  });

  test("trial-variants is newest-first — the order the Trial tab check depends on", async () => {
    // The dashboard-smoke Trial parity check picks "the newest" record and asks
    // whether the tab shows it. It used to index from the END of the array,
    // which is the OLDEST here, so it validated a July record on a day with a
    // fresh variant and would have passed with nothing rendered since. That
    // check now picks by generatedAt; this pins the ordering either way, so a
    // flipped sort surfaces here rather than as a silently useless smoke test.
    const { mergeTrialVariants } = await import("../merge-strategies.mjs");
    const merged = mergeTrialVariants(
      { variants: [{ date: "2026-08-10", window: "pm", generatedAt: "2026-08-10T15:00:00Z" }] },
      { variants: [{ date: "2026-07-26", window: "am", generatedAt: "2026-07-26T20:00:00Z" }] },
      () => {}
    );
    assert.equal(merged.variants[0].date, "2026-08-10", "trial-variants must stay newest-first");
    assert.equal(
      merged.variants[merged.variants.length - 1].date,
      "2026-07-26",
      "indexing from the end of this log yields the OLDEST record"
    );
  });

  test("the success path actually calls the notifier", () => {
    const text = readFileSync(join(SRC, "trial-variant-main.js"), "utf-8");
    const tail = text.slice(text.lastIndexOf("✓ DONE"));
    assert.match(tail, /OUTCOME\.SUCCEEDED/, "the only unreported outcome was success");
  });

  test("the two deaths main().catch() cannot see are handled", () => {
    const text = readFileSync(join(SRC, "trial-variant-main.js"), "utf-8");
    assert.match(text, /process\.on\("uncaughtException"/, "an uncaught exception bypasses main().catch()");
    assert.match(text, /process\.on\("unhandledRejection"/, "so does a rejection with no handler");
    // Registered before the consts, or a module-eval throw hits the temporal
    // dead zone and reports a ReferenceError instead of the real cause.
    assert.ok(
      text.indexOf('process.on("uncaughtException"') < text.indexOf("const DRY_RUN"),
      "the handler must be registered before the consts it must not reference"
    );
  });

  test("the fatal handler reads env, not the consts below it", () => {
    const text = readFileSync(join(SRC, "trial-variant-main.js"), "utf-8");
    const handler = text.slice(text.indexOf("async function reportFatal"), text.indexOf("const DRY_RUN"));
    assert.match(handler, /process\.env\.TRIAL_WINDOW/, "must not reference the WINDOW const");
    assert.ok(!/\bWINDOW\b(?!\s*\|\|)/.test(handler.replace(/TRIAL_WINDOW/g, "")), "no TDZ references");
  });
});
