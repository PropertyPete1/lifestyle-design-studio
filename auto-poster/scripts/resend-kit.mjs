#!/usr/bin/env node
/**
 * resend-kit.mjs — rebuild and re-deliver the recording kit for a request whose
 * kit was already sent.
 *
 * TWO REASONS THIS EXISTS.
 *
 * The first is narration mode. A kit built in "elevenlabs" mode lists only the
 * ON_CAMERA takes, because ElevenLabs reads the rest. Switching to "peter" means
 * he reads everything, so the voiceover takes have to appear in the kit as
 * audio-only reads — and the kit already in his inbox does not have them. The
 * script does not change; only which of its takes are asked for.
 *
 * The second is delivery. A kit that reached him but had no card to open is a
 * kit that needs sending again once there is one.
 *
 * WHAT IT DOES NOT DO: clear the acted marker. That marker is what stops the
 * poll re-entering deliverKitForApprovedTopic and writing a fresh script over a
 * decision that is already settled. Re-sending a notification and re-opening a
 * pipeline stage are different things, and only the first is wanted here.
 *
 * The script is read back out of actedResult, so what gets re-sent is the exact
 * script that was approved — not a regeneration that might differ.
 *
 *   I_UNDERSTAND_THIS_TOUCHES_LIVE=yes node scripts/resend-kit.mjs <requestId>
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { requireLiveAck } from "./live-guard.mjs";
import { buildKit, renderKitText, kitPayload } from "../src/yt-recording-kit.js";
import { sendApprovalRequest } from "../src/delivery.js";
import { getAccessToken } from "../src/drive.js";
import { ensureRecordingsFolder } from "../src/yt-ingest.js";
import { NARRATION_MODE, disclosureRequired } from "../src/yt-config.js";
import { KIND_TOPIC_PICK } from "../src/yt-approvals.js";
import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

// TOUCHES LIVE: sends a real recording kit to the dashboard and Peter's inbox,
// and ensures the Drive folder exists. Publishes nothing and changes no decision.
requireLiveAck(
  "Re-sends a real recording kit to the dashboard and Peter's inbox, and creates the Drive " +
    "recordings folder if missing. Changes no decision and clears no acted marker."
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "yt-approvals.json");
const DRY_RUN = process.env.DRY_RUN === "true";

const requestId = (process.argv[2] || process.env.REQUEST_ID || "").trim();
if (!requestId) {
  console.error("usage: resend-kit.mjs <requestId>");
  process.exit(1);
}

async function main() {
  const parsed = JSON.parse(readFileSync(PATH, "utf-8"));
  const requests = Array.isArray(parsed) ? parsed : parsed.requests || [];
  const record = requests.find((r) => r?.requestId === requestId);
  if (!record) {
    console.error(`[ResendKit] ${requestId} not found`);
    process.exit(1);
  }

  const script = record?.actedResult?.script;
  if (!script?.title) {
    console.error(
      `[ResendKit] ${requestId} carries no script in actedResult — nothing to rebuild a kit from. ` +
        `A kit can only be re-sent for a request that already produced one.`
    );
    process.exit(1);
  }

  const kit = buildKit({ script, title: script.title }, { requestId, narrationMode: NARRATION_MODE });
  const disclosure = disclosureRequired({ narrationMode: NARRATION_MODE });

  console.log(`[ResendKit] ${requestId} — "${kit.title}"`);
  console.log(`[ResendKit] narration mode: ${NARRATION_MODE}`);
  console.log(
    `[ResendKit] ${kit.stats.takeCount} takes to record ` +
      `(${kit.stats.onCameraCount} on camera, ${kit.stats.voiceoverCount ?? 0} voiceover)`
  );
  console.log(`[ResendKit] synthetic-content disclosure required: ${disclosure}`);
  if (!disclosure) {
    console.log(`[ResendKit]   -> Peter narrates everything, so nothing synthetic is used.`);
  }

  if (DRY_RUN) {
    console.log(`\n[ResendKit] DRY RUN — the kit that WOULD be sent:\n`);
    console.log(renderKitText(kit));
    return;
  }

  const accessToken = await getAccessToken().catch(() => null);
  if (accessToken) await ensureRecordingsFolder(requestId, accessToken);

  await sendApprovalRequest({
    requestId,
    kind: KIND_TOPIC_PICK,
    payload: { stage: "recording_kit", ...kitPayload(kit) },
    emailSubject: `Recording kit — ${kit.title} (${kit.stats.takeCount} takes)`,
    emailBody: renderKitText(kit),
    accessToken,
  });

  console.log(`[ResendKit] ✓ re-sent — acted marker untouched (${record.actedAt})`);
}

main().catch((err) => {
  console.error(`[ResendKit] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
