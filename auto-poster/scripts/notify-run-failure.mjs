#!/usr/bin/env node
/**
 * notify-run-failure.mjs — a failed scheduled run must reach Peter's phone.
 *
 * THE GAP THE LAUNCH AUDIT FOUND: when the pipeline job failed, the workflow
 * committed its state, uploaded its diagnostics, and told NOBODY. The only
 * notification was GitHub's default failure email — a repo setting outside
 * this codebase, which is exactly the kind of "someone probably gets told"
 * that the audit's rule (silence must be structurally impossible) exists to
 * kill. Every other outcome of the pipeline already notifies through the
 * dashboard webhook; failure is now no different.
 *
 * Called from `if: failure()` steps. Deliberately EXITS 0 even when delivery
 * fails: the job is already failing for the real reason, and replacing that
 * exit code with a notification error would bury the diagnosis. If the
 * webhook is down too, GitHub's default email is still the backstop.
 *
 *   node scripts/notify-run-failure.mjs <job-name>
 */

const job = process.argv[2] || "unknown-job";
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "(no run url — not on Actions)";

const dashboardUrl = process.env.DASHBOARD_URL;
const secret = process.env.DASHBOARD_WEBHOOK_SECRET;

if (!dashboardUrl || !secret) {
  console.log("::warning::failure notification skipped — DASHBOARD_URL / DASHBOARD_WEBHOOK_SECRET not set on this job");
  process.exit(0);
}

try {
  const res = await fetch(`${dashboardUrl}/api/delivery/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify({
      kind: "run_failure",
      requestId: `run-failure-${process.env.GITHUB_RUN_ID || Date.now()}`,
      subject: `YT pipeline: the ${job} job FAILED`,
      body:
        `The scheduled ${job} job failed and stopped.\n\n` +
        `Log: ${runUrl}\n\n` +
        `The next scheduled run will retry from the last recorded state. ` +
        `If this repeats, the log above says exactly where it died.`,
      payload: { job, runUrl, failedAt: new Date().toISOString() },
    }),
  });
  if (!res.ok) throw new Error(`dashboard returned ${res.status}`);
  console.log(`[NotifyFailure] Peter notified: ${job} failed (${runUrl})`);
} catch (err) {
  console.log(`::warning::failure notification could not be delivered (${err.message}) — GitHub's default email is the backstop`);
}
process.exit(0);
