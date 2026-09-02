/**
 * yt-brief-main.js — Monday. Write the brief, ask Peter to pick.
 *
 * Idempotent by design: if a brief is already out and unanswered, this does
 * nothing. The workflow has a backup cron like every other job here, and two
 * briefs in one week would not just be noise — the second would supersede the
 * first (latestRequestOfKind takes the newest), quietly discarding a pick Peter
 * had already made.
 *
 * And it does nothing while a video is still being RECORDED. On 2026-08-31 the
 * previous brief had its decision, so this guard let a fresh Monday brief out
 * twenty-three minutes before Peter finished uploading 35 takes for it — and
 * that newer, unanswered card is what the pipeline then waited on instead of
 * building. One topic gate open at a time, whichever side of it the work is
 * on. See briefBlockedBy in yt-stage.js.
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
  KIND_TOPIC_PICK,
} from "./yt-approvals.js";
import { briefBlockedBy } from "./yt-stage.js";
import { loadLog as loadVideoLog } from "./yt-log.js";
import { BRIEFS_PER_WEEK, TOPIC_CANDIDATES } from "./yt-config.js";
import { loadPresenters, savePresenters, consumeNextAssignment, presenterStamp, findById, OWNER_ID } from "./presenters.js";
import { routeWarnChannel } from "./yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE = process.env.FORCE === "true";

async function main() {
  console.log(`[YTBrief] Monday brief — ${BRIEFS_PER_WEEK} brief(s), ${TOPIC_CANDIDATES} candidates each`);

  const approvals = loadApprovals();

  // An unanswered brief blocks a new one. Answering is Peter's move, and
  // sending another would silently supersede the one he has not got to yet.
  // A kit still being recorded blocks one too — see the header.
  const block = FORCE ? { blocked: false } : briefBlockedBy(approvals, loadVideoLog());
  if (block.blocked) {
    console.log(
      block.reason === "unanswered"
        ? `[YTBrief] ${block.record.requestId} is still waiting for a decision (sent ${block.record.requestedAt}) — ` +
          `not sending another. Use FORCE=true to override.`
        : `[YTBrief] ${block.record.requestId} has a delivered kit and no upload yet — a video is still being ` +
          `recorded, and a second topic card on top of it is what shadowed the 2026-08-31 build. ` +
          `Not sending a brief until it is built. Use FORCE=true to override.`
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

  // THE STANDING "NEXT" ASSIGNMENT IS CONSUMED HERE, and only here: "assign
  // the next brief's video to X" means the next MONDAY brief, and this is
  // where one comes into existence. Consumed exactly once — the tombstone in
  // presenters.json plus this run's send-before-save ordering means a backup
  // cron or a re-brief can never spend it twice. No standing assignment means
  // the owner, by explicit stamp rather than by silence.
  const registry = loadPresenters();
  const consumed = consumeNextAssignment(registry, requestId);
  // Saved whenever consumption changed anything — including the corner where
  // the assigned presenter has vanished from the registry, which consumes the
  // assignment (so it cannot re-fire forever) and falls back to the owner.
  if (consumed.registry !== registry) savePresenters(consumed.registry);
  let presenter = null;
  if (consumed.presenter) {
    presenter = presenterStamp(consumed.presenter, { via: "next-assignment" });
    console.log(`[YTBrief] standing assignment consumed — this video is ${consumed.presenter.name}'s (${consumed.presenter.id})`);
  } else {
    const owner = findById(registry, OWNER_ID);
    if (owner) presenter = presenterStamp(owner, { via: "default" });
    if (registry.nextAssignment?.consumedAt) {
      // Not an error — just say why the assignment did not apply, so a
      // "why did my assignment not take" question has its answer in the log.
      console.log(`[YTBrief] next-assignment already consumed by ${registry.nextAssignment.consumedBy} — defaulting to the owner`);
    }
  }

  // Recorded only after the request is out. If sending threw, there is nothing
  // to wait on and no record claiming there is.
  saveApprovals(appendRequest(approvals, { requestId, kind: KIND_TOPIC_PICK, payload, presenter }));
  console.log(`[YTBrief] ${requestId} recorded — waiting on Peter`);
}

main().catch((err) => {
  console.error(`[YTBrief] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
