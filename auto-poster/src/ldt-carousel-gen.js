/**
 * ldt-carousel-gen.js — self-made 8-slide narrative carousels for LDT.
 *
 * The shape of the posted "leads going cold" deck, generalised:
 *
 *   slide 1      THE HOOK — one line, huge, written in the hook style the
 *                variation engine chose for this post (all six canonical
 *                styles have an authored line per angle, so style rotation
 *                works exactly as it does for reel captions)
 *   slides 2-4   THE PROBLEM — the reader's pain, one beat per slide.
 *                Deliberately claim-free: these lines describe the reader's
 *                world, never the product, so they can be vivid without
 *                touching the claims list. NO NUMBERS here, spelled or
 *                numeric — a figure belongs to a pinned claim or nowhere.
 *   slides 5-7   THE SOLUTION — pinned claims, essentially verbatim. The
 *                product may only be described in sentences the sales site's
 *                own tests pin.
 *   slide 8      THE CTA — comment keyword, pinned price, site.
 *
 * EVERY visible line of every deck is exposed via deckText() and must pass
 * the claims gate — at runtime before rendering (the runner's job) and in CI
 * across every angle × style combination (tests), so a copy edit that drifts
 * from the claims list fails before it ever renders.
 *
 * COPY IS AUTHORED, NOT GENERATED. A model writing slide copy would put the
 * claims gate in the retry-loop business every single run; a fixed table the
 * gate has already blessed makes the deck safe by construction and the gate
 * a tripwire rather than a bottleneck. Angles rotate; the variation engine
 * rotates hook styles on top; the brief measures which combinations work.
 */

import {
  FEED_W, FEED_H, ldtFrame, progressDots, bigType, accentRule, resolvePalette, renderLdtSlides, esc, fitSize,
} from "./ldt-design.js";
import { SANS } from "./carousel-render.js";

export const DECK_SLIDES = 8;

/**
 * The angle table. `hooks` carries one authored line per canonical style —
 * the variation engine picks the style, this table supplies the words.
 * `meta:true` marks the self-referential angle; it is only offered when the
 * claims file has metaAngle.enabled (true only while posting stays fully
 * automated — ldt-claims.json documents the rule).
 */
export function carouselAngles(claims) {
  const angles = [
    {
      key: "leads_going_cold",
      hooks: {
        question: "How many of your leads went cold this week?",
        bold_claim: "Your follow-up is the leak in your pipeline.",
        pov: "POV: a lead finally replies — and a human takes over instantly.",
        stat: "New leads contacted in under five minutes.",
        story_open: "A lead replied after dinner. Nobody answered until morning.",
        pattern_interrupt: "Stop scrolling. Your database is going cold right now.",
      },
      problem: [
        "You paid for each of those leads.",
        "They go cold while you work — showings, closings, dinner, sleep.",
        "Working the whole database by hand isn't a plan. It's a hope.",
      ],
      solution: [
        "Automated nurture works your cold database daily, with instant human handoff the moment a lead replies.",
        "New leads contacted in under five minutes, around the clock, weekends included.",
        "Email sent from your own address, signed in your name — and nothing goes out until you approve it.",
      ],
    },
    {
      key: "after_hours",
      hooks: {
        question: "Who answers your leads after you close the laptop?",
        bold_claim: "Business hours are when your competitors work. Leads don't keep them.",
        pov: "POV: it's the weekend and your follow-up is still working.",
        stat: "Morning briefing at 7:05 AM, pushed to your phone.",
        story_open: "The reply came in late on a Sunday. The follow-up had already gone out.",
        pattern_interrupt: "Wait. Your pipeline doesn't sleep just because you do.",
      },
      problem: [
        "Leads don't arrive on your schedule.",
        "The ones that come in late get the slowest answer — and remember it.",
        "Catching up every morning means starting every day behind.",
      ],
      solution: [
        "New leads contacted in under five minutes, around the clock, weekends included.",
        "Morning briefing at 7:05 AM, pushed to your phone.",
        "Automated nurture works your cold database daily, with instant human handoff the moment a lead replies.",
      ],
    },
    {
      key: "honest_numbers",
      hooks: {
        question: "What if your assistant refused to make numbers up?",
        bold_claim: "0 numbers invented. Ever.",
        pov: "POV: every number on your dashboard carries its evidence.",
        stat: "0 numbers invented. Ever.",
        story_open: "Somebody asked for a stat it couldn't verify. It said so.",
        pattern_interrupt: "Stop trusting dashboards that guess.",
      },
      problem: [
        "Every tool promises magic.",
        "Most of them round up, guess, or gloss when the data runs out.",
        "A number you can't trace is a decision you can't trust.",
      ],
      solution: [
        "If PRIMARY can't verify a number, it says so. Every claim carries its evidence.",
        "Born inside a working Texas brokerage. Running live today.",
        "Answers to 'Hey Primary' — or two claps — and talks back in a voice.",
      ],
    },
    {
      key: "any_business",
      hooks: {
        question: "What does a business's brain actually do all day?",
        bold_claim: "Meet PRIMARY. Your business's brain.",
        pov: "POV: your CRM finally works your list instead of just holding it.",
        stat: "Solo starts at $99/mo. $0 setup.",
        story_open: "It started inside one Texas brokerage. Then a cleaning company borrowed it.",
        pattern_interrupt: "Don't hire another admin before you read this.",
      },
      problem: [
        "The list keeps growing. The follow-up doesn't.",
        "Every booked customer starts as a message someone had to remember to send.",
        "Software that just stores contacts is a filing cabinet with a login.",
      ],
      solution: [
        "A voice-operated AI command center that watches your pipeline, runs your follow-up, briefs you every morning at 7:05, and answers to its name.",
        "Works for any business that books customers.",
        "Follow Up Boss connects instantly; other CRMs by custom build. Every business can start day one with a simple import.",
      ],
    },
  ];

  if (claims?.metaAngle?.enabled) {
    angles.push({
      key: "meta",
      meta: true,
      hooks: {
        question: "Who do you think scheduled this post?",
        bold_claim: "This post was scheduled and captioned by the product it's about.",
        pov: "POV: the product is doing its own marketing right now.",
        stat: "This post was scheduled and captioned by the product it's about.",
        story_open: "Nobody sat down to design this carousel today.",
        pattern_interrupt: "Stop. Read this one twice.",
      },
      problem: [
        "Most software demos are staged.",
        "Screenshots get polished. Numbers get rounded.",
        "The demo that can't lie is the demo running in front of you.",
      ],
      solution: [
        "This post was scheduled and captioned by the product it's about.",
        "Automated nurture works your cold database daily, with instant human handoff the moment a lead replies.",
        "If PRIMARY can't verify a number, it says so. Every claim carries its evidence.",
      ],
    });
  }
  return angles;
}

/**
 * Deterministic angle rotation with a no-immediate-repeat rule, mirroring the
 * hook-style rule one level up: two consecutive self-made decks never share
 * an angle, so the feed cannot show the same story twice in a row.
 */
export function pickAngle({ claims, dateStr, previousAngle = null }) {
  const angles = carouselAngles(claims);
  const pool = angles.filter((a) => a.key !== previousAngle);
  const usable = pool.length > 0 ? pool : angles;
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y || 0, (m || 1) - 1, d || 1) / 86_400_000);
  return usable[((dayNumber % usable.length) + usable.length) % usable.length];
}

/** The hook line for a chosen style, with a safe fallback to bold_claim. */
export function hookLineFor(angle, hookStyle) {
  return angle.hooks[hookStyle] || angle.hooks.bold_claim;
}

/** All visible copy of a deck, one line per slide element, for the gate. */
export function deckText(angle, hookStyle, { claims, brand = null }) {
  const keyword = brand?.cta?.keyword || "PRIMARY";
  return [
    hookLineFor(angle, hookStyle),
    ...angle.problem,
    ...angle.solution,
    "Solo starts at $99/mo. $0 setup. Cancel anytime, no contracts.",
    `Comment ${keyword} and we'll send you the demo.`,
    claims.product,
    claims.site,
  ].join("\n");
}

// ─── Slides ──────────────────────────────────────────────────────────────────

const MARGIN = Math.round(FEED_W * 0.11);

function slide({ palette, claims, index, inner }) {
  return ldtFrame({
    w: FEED_W, h: FEED_H, palette,
    product: claims.product, site: claims.site,
    inner: inner + progressDots({ w: FEED_W, h: FEED_H, palette, index, total: DECK_SLIDES }),
  });
}

/** Slide 1 — the hook, huge. */
export function hookSlideSvg(angle, hookStyle, { palette, claims }) {
  const line = hookLineFor(angle, hookStyle);
  const size = line.length > 60 ? 76 : 92;
  const block = bigType({ text: line, x: MARGIN, startY: 0, size, palette, w: FEED_W });
  const startY = Math.round(FEED_H / 2 - block.height / 2) + Math.round(size * 0.4);
  const placed = bigType({ text: line, x: MARGIN, startY, size, palette, w: FEED_W });
  return slide({
    palette, claims, index: 0,
    inner: accentRule({ x: MARGIN, y: startY - size - 44, palette }) + "\n  " + placed.svg,
  });
}

/** Problem/solution slides — an eyebrow, one big beat. */
export function beatSlideSvg(kind, text, slideIndex, beatIndex, beatTotal, { palette, claims }) {
  const eyebrow = kind === "problem" ? "THE PROBLEM" : "WHAT PRIMARY DOES";
  const eyebrowColor = kind === "problem" ? palette.muted : palette.accent;
  const size = text.length > 90 ? 58 : 68;
  const probe = bigType({ text, x: MARGIN, startY: 0, size, palette, w: FEED_W, weight: kind === "problem" ? "bold" : "normal" });
  const startY = Math.round(FEED_H / 2 - probe.height / 2) + Math.round(size * 0.4);
  const placed = bigType({ text, x: MARGIN, startY, size, palette, w: FEED_W, weight: kind === "problem" ? "bold" : "normal" });
  return slide({
    palette, claims, index: slideIndex,
    inner:
      `<text x="${MARGIN}" y="${startY - size - 52}" font-family="${SANS}" font-size="32" letter-spacing="6" fill="${eyebrowColor}">${esc(`${eyebrow} · ${beatIndex + 1}/${beatTotal}`)}</text>\n  ` +
      accentRule({ x: MARGIN, y: startY - size - 30, palette, width: kind === "problem" ? 44 : 84 }) + "\n  " +
      placed.svg,
  });
}

/** Slide 8 — CTA: keyword, pinned price, site. */
export function ctaSlideSvg({ palette, claims, brand = null }) {
  const keyword = brand?.cta?.keyword || "PRIMARY";
  const ctaLine = `Comment ${keyword}`;
  // The keyword line stays single — a longer keyword shrinks the type
  // rather than walking off the canvas.
  const ctaSize = fitSize(ctaLine, 96, FEED_W - MARGIN * 2, { factor: 1 });
  const price = bigType({
    text: "Solo starts at $99/mo. $0 setup. Cancel anytime, no contracts.",
    x: MARGIN, startY: Math.round(FEED_H * 0.62), size: 44, palette, w: FEED_W, weight: "normal", fill: palette.muted,
  });
  return slide({
    palette, claims, index: DECK_SLIDES - 1,
    inner:
      `<text x="${MARGIN}" y="${Math.round(FEED_H * 0.34)}" font-family="${SANS}" font-size="52" fill="${palette.ink}">Want the demo?</text>\n  ` +
      `<text x="${MARGIN}" y="${Math.round(FEED_H * 0.45)}" font-family="${SANS}" font-size="${ctaSize}" font-weight="bold" fill="${palette.accent}">${esc(ctaLine)}</text>\n  ` +
      `<text x="${MARGIN}" y="${Math.round(FEED_H * 0.53)}" font-family="${SANS}" font-size="52" fill="${palette.ink}">and we'll send you the demo.</text>\n  ` +
      accentRule({ x: MARGIN, y: Math.round(FEED_H * 0.57), palette }) + "\n  " +
      price.svg,
  });
}

/** The full 8-slide deck as SVG strings, in posting order. */
export function narrativeDeckSvgs(angle, hookStyle, { claims, brand = null }) {
  const palette = resolvePalette(brand?.palette);
  const ctx = { palette, claims };
  const svgs = [hookSlideSvg(angle, hookStyle, ctx)];
  angle.problem.forEach((text, i) => svgs.push(beatSlideSvg("problem", text, 1 + i, i, angle.problem.length, ctx)));
  angle.solution.forEach((text, i) => svgs.push(beatSlideSvg("solution", text, 1 + angle.problem.length + i, i, angle.solution.length, ctx)));
  svgs.push(ctaSlideSvg({ palette, claims, brand }));
  return svgs;
}

/**
 * Render a deck to PNG + JPEG with the design pack's self-QC. The caller
 * gate-checks deckText() BEFORE calling this — rendering ungated copy is a
 * bug, and the runner treats it as one.
 */
export async function renderNarrativeDeck(angle, hookStyle, { claims, brand = null }) {
  const svgs = narrativeDeckSvgs(angle, hookStyle, { claims, brand });
  if (svgs.length !== DECK_SLIDES) {
    throw new Error(`[LDT Carousel] Deck built ${svgs.length} slides, expected ${DECK_SLIDES}`);
  }
  const rendered = await renderLdtSlides(svgs, { w: FEED_W, h: FEED_H });
  return { ...rendered, slideCount: svgs.length, hookLine: hookLineFor(angle, hookStyle) };
}
