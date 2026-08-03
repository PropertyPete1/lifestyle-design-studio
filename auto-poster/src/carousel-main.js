#!/usr/bin/env node
/**
 * carousel-main.js — the daily carousel run.
 *
 *   1. Pick the pillar and its close type for today, read the log for anti-examples
 *   2. Write the deck, critic-gate it, regenerate anything under 8/10
 *   3. Render 1080x1350 slides and assemble the LinkedIn PDF
 *   4. Fan out to the proven paths, and deliver to the owner for main Instagram
 *   5. Verify what actually published, and append to carousel-log.json
 *
 * Verification matters: the scheduler returning 200 means ACCEPTED, not
 * published. A run that skips it can log a success for a post the network
 * silently rejected, which is exactly what happened to TikTok on 2026-08-03.
 *
 * DRY_RUN=true generates and renders everything but publishes nothing.
 * SAMPLE_OUT=<dir> writes the rendered slides to disk instead of distributing —
 * used to produce the PR samples.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { generateCarousel, buildSocialCaption, buildLinkedinCaption, todayInChicago } from "./carousel-content.js";
import { renderDeck, buildPdf, accentFor, isNonBlank, toJpegSlides } from "./carousel-render.js";
import { distributeCarousel } from "./carousel-distribute.js";
import { deliverCarouselToOwner } from "./delivery.js";
import { getAccessToken } from "./drive.js";
import {
  loadCarouselLog, recentEntries, alreadyPostedToday, appendEntry, saveCarouselLog, buildEntry,
} from "./carousel-state.js";
import { verifyAfterSettling, applyVerification, recheckPending } from "./carousel-verify.js";

const DRY_RUN = process.env.DRY_RUN === "true";
const SAMPLE_OUT = process.env.SAMPLE_OUT || "";
const FORCE = process.env.FORCE === "true";

export async function runCarousel({ dateStr, sampleOut = SAMPLE_OUT, dryRun = DRY_RUN, verifyWaitMs } = {}) {
  const date = dateStr || todayInChicago();
  let log = loadCarouselLog();

  // Idempotency guard, matching the poster's: the workflow runs on a cron that
  // GitHub sometimes fires twice, and a duplicate carousel is a visible mistake.
  if (!FORCE && !sampleOut && alreadyPostedToday(log, date)) {
    console.log(`[Carousel] Already posted a carousel for ${date} — exiting cleanly.`);
    return { skipped: "already posted today" };
  }

  // Sweep up anything the previous run left unresolved before writing today's.
  if (!dryRun && !sampleOut) {
    const swept = await recheckPending(log);
    if (swept.rechecked > 0) {
      log = swept.log;
      saveCarouselLog(log);
      console.log(`[Carousel] re-checked ${swept.rechecked} unresolved post(s) from previous runs`);
    }
  }

  const recent = recentEntries(log, 14);
  console.log(`[Carousel] ${date} — ${recent.length} prior entries as anti-examples`);

  const result = await generateCarousel({ dateStr: date, recent });
  console.log(`[Carousel] pillar=${result.pillar} close=${result.closeType} topic="${result.topic}"${result.keyword ? ` keyword=${result.keyword}` : ""}`);
  console.log(`[Carousel] hook: ${result.hook}`);
  console.log(`[Carousel] scores: hook=${result.scores.hook} loops=${result.scores.loops} cta=${result.scores.cta}${result.belowBar ? " (BELOW BAR — best-of)" : ""}`);
  if (result.leaksStripped?.length) {
    console.log(`[Carousel] leak scanner stripped ${result.leaksStripped.length} term(s)`);
  }

  const accent = accentFor(date);
  const slides = await renderDeck(result.deck, result.keyword, accent, result.closeType);
  console.log(`[Carousel] rendered ${slides.length} slides`);

  // A blank slide is worse than a failed run — it would publish as a black square.
  for (const [i, png] of slides.entries()) {
    if (!(await isNonBlank(png))) throw new Error(`slide ${i + 1} rendered blank`);
  }

  const pdf = await buildPdf(slides, result.topic);
  const caption = buildSocialCaption(result);
  const linkedinCaption = await buildLinkedinCaption(result);

  // Sample mode: write everything to disk, publish nothing.
  if (sampleOut) {
    if (!existsSync(sampleOut)) mkdirSync(sampleOut, { recursive: true });
    slides.forEach((png, i) => writeFileSync(join(sampleOut, `slide-${String(i + 1).padStart(2, "0")}.png`), png));
    writeFileSync(join(sampleOut, "carousel.pdf"), pdf);
    writeFileSync(join(sampleOut, "meta.json"), JSON.stringify({
      date, pillar: result.pillar, pillarLabel: result.pillarLabel, topic: result.topic,
      hook: result.hook, keyword: result.keyword, closeType: result.closeType, accent, scores: result.scores,
      attemptsUsed: result.attemptsUsed, belowBar: result.belowBar,
      deck: result.deck, caption, linkedinCaption,
    }, null, 2) + "\n");
    console.log(`[Carousel] sample written to ${sampleOut}`);
    return { sample: sampleOut, result };
  }

  // TikTok rejects PNG at publish time, so it gets a JPEG copy of the deck.
  const jpegSlides = dryRun ? [] : await toJpegSlides(slides);

  const distribution = await distributeCarousel({
    slides, jpegSlides, caption, linkedinCaption, documentTitle: result.topic, dryRun,
  });

  // Main Instagram: never auto-published. Owner posts it natively.
  let delivered = false;
  if (!dryRun) {
    const tmp = join("/tmp", `carousel-${date}`);
    if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
    const files = slides.map((png, i) => {
      const p = join(tmp, `slide-${String(i + 1).padStart(2, "0")}.png`);
      writeFileSync(p, png);
      return { path: p, mimeType: "image/png" };
    });
    const pdfPath = join(tmp, "carousel.pdf");
    writeFileSync(pdfPath, pdf);
    files.push({ path: pdfPath, mimeType: "application/pdf" });

    const token = await getAccessToken();
    const delivery = await deliverCarouselToOwner(token, files, {
      caption, keyword: result.keyword, closeType: result.closeType, topic: result.topic, city: "CAROUSEL",
    });
    delivered = delivery.delivered;
  } else {
    console.log("[Carousel] DRY RUN — skipping owner delivery");
  }

  let entry = buildEntry(result, {
    accent, slideCount: slides.length, distribution: distribution.results, delivered,
  });

  // Confirm what actually published rather than trusting the scheduler's 200.
  if (!dryRun) {
    const records = await verifyAfterSettling(distribution.results, {
      ...(verifyWaitMs === undefined ? {} : { waitMs: verifyWaitMs }),
    });
    entry = applyVerification(entry, records);
    const failed = entry.distribution.filter((d) => d.verdict === "failed");
    const pending = entry.distribution.filter((d) => d.verdict === "pending");
    console.log(
      `[Carousel] verified: ${entry.distribution.filter((d) => d.verified).length} published, ` +
      `${failed.length} failed, ${pending.length} still pending`
    );
  }

  if (!dryRun) {
    saveCarouselLog(appendEntry(log, entry));
    console.log(`[Carousel] logged ${date} (${result.closeType} close${result.keyword ? `, keyword ${result.keyword}` : ""})`);
  }

  return { result, distribution, delivered, entry };
}

// Only run when invoked directly, so tests can import the module freely.
if (process.argv[1] && process.argv[1].endsWith("carousel-main.js")) {
  runCarousel().catch((err) => {
    console.error(`[Carousel] FAILED: ${err.message}`);
    process.exit(1);
  });
}
