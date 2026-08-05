/**
 * yt-brief-main.js — Monday. Write the brief, ask Peter to pick.
 *
 * Idempotent by design: if a brief is already out and unanswered, this does
 * nothing. The workflow has a backup cron like every other job here, and two
 * briefs in one week would not just be noise — the second would supersede the
 * first (latestRequestOfKind takes the newest), quietly discarding a pick Peter
 * had already made.
 *
 * Writes to yt-approvals.json and leaves the commit to merge-log-push, the same
 * as every other managed file.
 */

import { loadLog, getRecentlyPostedIdsAllCities } from "./state.js";
import { listCityVideos, getAccessToken } from "./drive.js";
import { generateBrief, proposeFootage, renderBriefText, briefPayload, priorTitles } from "./yt-brief.js";
import { sendApprovalRequest } from "./delivery.js";
import {
  loadApprovals,
  saveApprovals,
  appendRequest,
  newRequestId,
  latestRequestOfKind,
  hasDecision,
  KIND_TOPIC_PICK,
} from "./yt-approvals.js";
import { BRIEFS_PER_WEEK, TOPIC_CANDIDATES } from "./yt-config.js";

const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE = process.env.FORCE === "true";

async function main() {
  console.log(`[YTBrief] Monday brief — ${BRIEFS_PER_WEEK} brief(s), ${TOPIC_CANDIDATES} candidates each`);

  const approvals = loadApprovals();

  // An unanswered brief blocks a new one. Answering is Peter's move, and
  // sending another would silently supersede the one he has not got to yet.
  const open = latestRequestOfKind(approvals, KIND_TOPIC_PICK);
  if (open && !hasDecision(open) && !FORCE) {
    console.log(
      `[YTBrief] ${open.requestId} is still waiting for a decision (sent ${open.requestedAt}) — ` +
      `not sending another. Use FORCE=true to override.`
    );
    return;
  }

  // Footage the recent posting history has already spent. The long-form log
  // joins this in PR 5; until then the reel history is the honest signal.
  const postedLog = loadLog();
  const usedIds = new Set(getRecentlyPostedIdsAllCities(postedLog, 30));

  const brief = await generateBrief({ recentTitles: priorTitles(approvals) });

  // Attach real Drive clips per candidate so Peter can see it is shootable.
  const byMarket = new Map();
  for (const candidate of brief.candidates) {
    if (!byMarket.has(candidate.market)) {
      try {
        byMarket.set(candidate.market, await listCityVideos(candidate.market));
      } catch (err) {
        console.warn(`[YTBrief] could not list ${candidate.market} footage: ${err.message}`);
        byMarket.set(candidate.market, []);
      }
    }
    candidate.proposedClips = proposeFootage(byMarket.get(candidate.market), usedIds);
  }

  const requestId = newRequestId(KIND_TOPIC_PICK);
  const payload = briefPayload(brief, { requestId });
  const emailBody = renderBriefText(brief, { requestId });

  if (DRY_RUN) {
    console.log(`[YTBrief] DRY RUN — would send ${requestId}`);
    console.log(emailBody);
    return;
  }

  const accessToken = await getAccessToken().catch((err) => {
    console.warn(`[YTBrief] no Google token, email channel unavailable: ${err.message}`);
    return null;
  });

  await sendApprovalRequest({
    requestId,
    kind: KIND_TOPIC_PICK,
    payload,
    emailSubject: `This week's video — pick one (${brief.candidates.length} options)`,
    emailBody,
    accessToken,
  });

  // Recorded only after the request is out. If sending threw, there is nothing
  // to wait on and no record claiming there is.
  saveApprovals(appendRequest(approvals, { requestId, kind: KIND_TOPIC_PICK, payload }));
  console.log(`[YTBrief] ${requestId} recorded — waiting on Peter`);
}

main().catch((err) => {
  console.error(`[YTBrief] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
