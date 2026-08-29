/**
 * The LDT self-made content lane — carousels, cards, text-motion reels.
 *
 * The property under test above all others: EVERY visible line of every
 * generated surface, across every angle × every hook style × every format,
 * is claim-compliant — no banned phrase, no figure the pinned claims list
 * doesn't back. The copy is authored, so this suite is what turns "authored
 * carefully" into "cannot drift": an edit that adds an unpinned number or a
 * banned phrase fails here, in CI, before it renders anywhere.
 *
 * The claims FIXTURE below mirrors auto-poster/ldt-claims.json (the pinned
 * list vendored from the sales site). At runtime the real file is passed in
 * by the runner; the fixture keeps this suite hermetic.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
import sharp from "sharp";

import { sourceFigureValues, checkNumberHonesty } from "../src/source-respect.js";
import { HOOK_STYLE_IDS } from "../src/hook-styles.js";
import { planVariation } from "../src/variation.js";
import { loadBrandRegistry } from "../src/brands.js";
import { instagramCarouselBody, tiktokCarouselBody, facebookCarouselBody } from "../src/carousel-distribute.js";
import {
  carouselAngles, pickAngle, hookLineFor, deckText, narrativeDeckSvgs, renderNarrativeDeck, DECK_SLIDES,
} from "../src/ldt-carousel-gen.js";
import { cardText, cardCopy, renderCard } from "../src/ldt-card-gen.js";
import {
  reelText, reelPlateSvgs, reelAssemblyArgs, plannedDuration, renderTextReel,
  PLATE_SECONDS, CROSSFADE_SECONDS,
} from "../src/ldt-text-reel.js";
import {
  selfMadePlan, fillPlan, previousSelfMadeKind, previousLdtHookStyle, previousSelfMadeAngle,
  kindOfEntry, planNeverEmpty, selfMadeAllowed, todaysSelfMadeAngle, todaysSelfMadeAngles, SELF_MADE_KINDS,
} from "../src/ldt-slot-filler.js";

// ─── Fixture: mirror of the pinned claims list ───────────────────────────────

const CLAIMS = {
  product: "PRIMARY",
  site: "lifestyledesigntechnologies.com",
  claims: [
    "Meet PRIMARY. Your business's brain.",
    "A voice-operated AI command center that watches your pipeline, runs your follow-up, briefs you every morning at 7:05, and answers to its name.",
    "Born inside a working Texas brokerage. Running live today.",
    "Answers to 'Hey Primary' — or two claps — and talks back in a voice.",
    "Morning briefing at 7:05 AM, pushed to your phone.",
    "Automated nurture works your cold database daily, with instant human handoff the moment a lead replies.",
    "New leads contacted in under five minutes, around the clock, weekends included.",
    "Email sent from your own address, signed in your name — and nothing goes out until you approve it.",
    "If PRIMARY can't verify a number, it says so. Every claim carries its evidence.",
    "0 numbers invented. Ever.",
    "Works for any business that books customers.",
    "Follow Up Boss connects instantly; other CRMs by custom build. Every business can start day one with a simple import.",
  ],
  pricing: [
    "Solo: $99/mo, $0 setup.",
    "Cancel anytime. No contracts.",
  ],
  bannedPatterns: [
    { pattern: "never\\s+lies" }, { pattern: "guarantee" },
    { pattern: "free\\s+(trial|forever|plan|tier)" },
    { pattern: "no\\s+approval\\s+needed|fully\\s+autonomous|hands[\\s-]?off" },
    { pattern: "\\b(the\\s+)?(#\\s*1|number\\s+one|best|leading)\\s+(ai|crm|assistant|platform)" },
    { pattern: "unlimited\\s+(ai|usage|automation|messages)" },
    { pattern: "replaces?\\s+your\\s+(team|agents|staff)" },
  ],
  metaAngle: {
    enabled: true,
    line: "This post was scheduled and captioned by the product it's about.",
  },
};

const BRAND = { cta: { keyword: "PRIMARY" }, palette: { accent: "#5EE0A0", ink: "#F2F2F2", muted: "#9A9A9A" } };

/** The gate, replicated: banned patterns + exact-figure honesty. */
function gateCheck(text) {
  const violations = [];
  for (const { pattern } of CLAIMS.bannedPatterns) {
    const m = text.match(new RegExp(pattern, "i"));
    if (m) violations.push(`banned: "${m[0]}"`);
  }
  const allowed = sourceFigureValues([...CLAIMS.claims, ...CLAIMS.pricing, CLAIMS.metaAngle.line]);
  const honesty = checkNumberHonesty(text, allowed);
  if (!honesty.ok) {
    for (const v of honesty.violations) violations.push(`unpinned figure: ${v.raw}`);
  }
  return violations;
}

// ─── Claims compliance, exhaustively ─────────────────────────────────────────

describe("every generated surface passes the claims gate", () => {
  const angles = carouselAngles(CLAIMS);

  test("deck copy: every angle × every hook style", () => {
    for (const angle of angles) {
      for (const style of HOOK_STYLE_IDS) {
        const violations = gateCheck(deckText(angle, style, { claims: CLAIMS, brand: BRAND }));
        assert.deepEqual(violations, [], `deck ${angle.key}/${style}: ${violations.join("; ")}`);
      }
    }
  });

  test("card copy: every angle × every hook style", () => {
    for (const angle of angles) {
      for (const style of HOOK_STYLE_IDS) {
        const violations = gateCheck(cardText(angle, style, { claims: CLAIMS, brand: BRAND }));
        assert.deepEqual(violations, [], `card ${angle.key}/${style}: ${violations.join("; ")}`);
      }
    }
  });

  test("reel copy: every angle × every hook style", () => {
    for (const angle of angles) {
      for (const style of HOOK_STYLE_IDS) {
        const violations = gateCheck(reelText(angle, style, { claims: CLAIMS, brand: BRAND }));
        assert.deepEqual(violations, [], `reel ${angle.key}/${style}: ${violations.join("; ")}`);
      }
    }
  });

  test("problem slides carry NO numbers, digit or spelled — figures belong to pinned claims only", () => {
    for (const angle of angles) {
      for (const line of angle.problem) {
        assert.ok(!/\d/.test(line), `${angle.key} problem line has a digit: "${line}"`);
        assert.ok(
          !/\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million)\b/i.test(line),
          `${angle.key} problem line has a spelled number: "${line}"`
        );
      }
    }
  });
});

// ─── The angle table ─────────────────────────────────────────────────────────

describe("the angle table", () => {
  test("every angle has a hook for every canonical style and a 3+3 narrative", () => {
    for (const angle of carouselAngles(CLAIMS)) {
      for (const style of HOOK_STYLE_IDS) {
        assert.ok(angle.hooks[style], `${angle.key} missing a ${style} hook`);
      }
      assert.equal(angle.problem.length, 3, `${angle.key} problem beats`);
      assert.equal(angle.solution.length, 3, `${angle.key} solution beats`);
    }
  });

  test("the meta angle appears only while metaAngle is enabled", () => {
    const withMeta = carouselAngles(CLAIMS).map((a) => a.key);
    assert.ok(withMeta.includes("meta"));
    const without = carouselAngles({ ...CLAIMS, metaAngle: { enabled: false } }).map((a) => a.key);
    assert.ok(!without.includes("meta"), "meta angle offered while disabled — the line would be a lie on a hand-posted deck");
  });

  test("pickAngle is deterministic and never repeats the previous angle", () => {
    const first = pickAngle({ claims: CLAIMS, dateStr: "2026-08-29" });
    assert.equal(first.key, pickAngle({ claims: CLAIMS, dateStr: "2026-08-29" }).key);
    for (let d = 1; d <= 28; d++) {
      const dateStr = `2026-09-${String(d).padStart(2, "0")}`;
      const prev = pickAngle({ claims: CLAIMS, dateStr }).key;
      const next = pickAngle({ claims: CLAIMS, dateStr, previousAngle: prev });
      assert.notEqual(next.key, prev, `repeated angle ${prev} on ${dateStr}`);
    }
  });

  test("hookLineFor falls back to the bold claim for an unknown style", () => {
    const angle = carouselAngles(CLAIMS)[0];
    assert.equal(hookLineFor(angle, "not_a_style"), angle.hooks.bold_claim);
  });
});

// ─── Renders ─────────────────────────────────────────────────────────────────

describe("renders", () => {
  test(`the narrative deck renders exactly ${DECK_SLIDES} slides at 1080x1350, PNG and JPEG`, async () => {
    const angle = carouselAngles(CLAIMS)[0];
    const svgs = narrativeDeckSvgs(angle, "question", { claims: CLAIMS, brand: BRAND });
    assert.equal(svgs.length, DECK_SLIDES);
    const deck = await renderNarrativeDeck(angle, "question", { claims: CLAIMS, brand: BRAND });
    assert.equal(deck.pngs.length, DECK_SLIDES);
    assert.equal(deck.jpegs.length, DECK_SLIDES);
    const meta = await sharp(deck.pngs[0]).metadata();
    assert.equal(`${meta.width}x${meta.height}`, "1080x1350");
    assert.equal(deck.hookLine, carouselAngles(CLAIMS)[0].hooks.question);
  });

  test("the card renders one 1080x1350 image and its copy carries one idea", async () => {
    const angle = carouselAngles(CLAIMS)[1];
    const card = await renderCard(angle, "stat", { claims: CLAIMS, brand: BRAND });
    assert.equal(card.pngs.length, 1);
    const meta = await sharp(card.pngs[0]).metadata();
    assert.equal(`${meta.width}x${meta.height}`, "1080x1350");
    const copy = cardCopy(angle, "stat", { brand: BRAND });
    assert.equal(copy.proof, angle.solution[0]);
  });
});

// ─── The reel assembly ───────────────────────────────────────────────────────

describe("text-reel assembly arguments", () => {
  const paths = ["a.png", "b.png", "c.png", "d.png", "e.png"];
  const args = reelAssemblyArgs(paths, "out.mp4");
  const filter = args[args.indexOf("-filter_complex") + 1];

  test("plates enter as single frames — no -loop (the zoompan frame-explosion trap)", () => {
    assert.ok(!args.includes("-loop"));
  });

  test("xfade offsets step by hold-minus-fade", () => {
    assert.match(filter, /xfade=transition=fade:duration=0\.4:offset=2\[/);
    assert.match(filter, /offset=4\[/);
    assert.match(filter, /offset=8\[v\]/);
  });

  test("silent on purpose, CRF 18, faststart", () => {
    assert.ok(args.includes("-an"), "the reel must ship no audio — music licensing");
    assert.equal(args[args.indexOf("-crf") + 1], "18");
    assert.ok(args.includes("+faststart"));
  });

  test("planned duration math", () => {
    assert.equal(plannedDuration(5), 5 * PLATE_SECONDS - 4 * CROSSFADE_SECONDS);
  });
});

describe("a real text reel", () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), "ldtreel-test-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test("renders, hits the planned duration, stays silent, and holds 1080x1920", async () => {
    const angle = carouselAngles(CLAIMS)[0];
    const result = await renderTextReel(angle, "pattern_interrupt", { claims: CLAIMS, brand: BRAND, outputDir: dir });
    assert.equal(result.ok, true, `reel failed: ${result.reason}`);

    const probe = JSON.parse(execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${result.videoPath}"`,
      { encoding: "utf-8", timeout: 30000 }
    ));
    const kinds = probe.streams.map((s) => s.codec_type);
    assert.ok(kinds.includes("video"));
    assert.ok(!kinds.includes("audio"), "an audio stream appeared on a deliberately silent reel");
    const v = probe.streams.find((s) => s.codec_type === "video");
    assert.equal(`${v.width}x${v.height}`, "1080x1920");
    const planned = plannedDuration(5);
    assert.ok(Math.abs(parseFloat(probe.format.duration) - planned) <= 1.0,
      `duration ${probe.format.duration}s vs planned ${planned}s`);
  });

  test("an ffmpeg failure returns a reasoned skip, never throws", async () => {
    const angle = carouselAngles(CLAIMS)[0];
    const result = await renderTextReel(angle, "question", {
      claims: CLAIMS, brand: BRAND, outputDir: dir,
      runFfmpeg: () => { throw new Error("boom"); },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /assembly failed: boom/);
  });
});

// ─── The slot filler ─────────────────────────────────────────────────────────

describe("the slot filler", () => {
  const ldtEntry = (over = {}) => ({ brand: "ldt", timestamp: "2026-08-29T15:00:00.000Z", success: true, ...over });

  test("clips always lead; the self-made chain always follows", () => {
    const plan = fillPlan({ log: { posts: [] }, intakeEligible: [{ id: "c1" }, { id: "c2" }] });
    assert.equal(plan[0].kind, "clip");
    assert.equal(plan[1].kind, "clip");
    assert.deepEqual(plan.slice(2).map((p) => p.kind), ["carousel", "card", "text_reel"]);
  });

  test("an empty intake folder still yields a full plan — the account never goes silent", () => {
    const plan = fillPlan({ log: { posts: [] }, intakeEligible: [] });
    assert.ok(planNeverEmpty(plan));
    assert.equal(plan[0].kind, "carousel");
  });

  test("the previous self-made kind is demoted to last resort, not banned", () => {
    const log = { posts: [ldtEntry({ type: "ldt_carousel", angle: "after_hours" })] };
    assert.deepEqual(selfMadePlan({ log }), ["card", "text_reel", "carousel"]);
  });

  test("a clip between self-made posts resets the rotation", () => {
    const log = { posts: [ldtEntry({ type: "ldt_carousel" }), ldtEntry({ type: "ldt_clip" })] };
    assert.equal(previousSelfMadeKind(log), null);
    assert.equal(selfMadePlan({ log })[0], "carousel");
  });

  test("realty entries never influence the LDT rotation", () => {
    const log = { posts: [{ city: "austin", slot: "pm", caption: "x", type: undefined, timestamp: "2026-08-29T15:00:00.000Z" }] };
    assert.equal(previousSelfMadeKind(log), null);
    assert.equal(previousLdtHookStyle(log), null);
  });

  test("previousLdtHookStyle reads the tag, the lane's field, or classifies — in that order", () => {
    assert.equal(previousLdtHookStyle({ posts: [ldtEntry({ type: "ldt_card", generation: { hook_style: "stat" } })] }), "stat");
    assert.equal(previousLdtHookStyle({ posts: [ldtEntry({ type: "ldt_clip", hook_style: "vibe" })] }), "pov");
    assert.equal(previousLdtHookStyle({ posts: [ldtEntry({ type: "ldt_clip", caption: "would you believe this?" })] }), "question");
  });

  test("previousSelfMadeAngle surfaces the last deck's story", () => {
    const log = { posts: [ldtEntry({ type: "ldt_carousel", angle: "leads_going_cold" })] };
    assert.equal(previousSelfMadeAngle(log), "leads_going_cold");
  });

  test("kindOfEntry only matches the lane's own types", () => {
    assert.equal(kindOfEntry({ type: "ldt_carousel" }), "carousel");
    assert.equal(kindOfEntry({ type: "ldt_clip" }), null);
    assert.equal(kindOfEntry({ type: "linkedin" }), null);
  });
});

// ─── Angle rotation across days ──────────────────────────────────────────────

describe("the angle rotation reaches every angle in the table", () => {
  const dayStr = (i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);

  test("as the runner drives it, 30 consecutive days use ALL angles", () => {
    // The regression this pins: feeding the PREVIOUS DAY's angle into
    // pickAngle shrinks the pool to n-1, and the day-number modulo over that
    // smaller pool settles into a fixed (n-1)-cycle that never reaches one
    // angle at all. The runner therefore excludes only an angle already used
    // TODAY (todaysSelfMadeAngle), which is the sole repeat the date rotation
    // cannot prevent by itself.
    const all = carouselAngles(CLAIMS).map((a) => a.key);
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(pickAngle({ claims: CLAIMS, dateStr: dayStr(i) }).key);
    }
    assert.deepEqual([...seen].sort(), [...all].sort(),
      `every angle must reach the feed; missing: ${all.filter((k) => !seen.has(k)).join(", ")}`);
  });

  test("THE PRODUCTION REGIME: one self-made post a day, log fed forward, still reaches every angle", () => {
    // The regime that starved an angle: a clip fills one slot and a self-made
    // piece fills the other, so exactly one angle is chosen per Chicago day
    // and the previous choice is in the log. This walks that loop the way the
    // runner does — recording each pick and re-deriving the exclusion from the
    // log — so a re-wiring back to a cross-day exclusion fails HERE rather
    // than silently dropping a fifth of the authored table from the feed.
    const all = carouselAngles(CLAIMS).map((a) => a.key);
    const posts = [];
    const picked = [];
    for (let i = 0; i < 60; i++) {
      const dateStr = dayStr(i);
      const now = new Date(`${dateStr}T20:00:00Z`); // 3 PM CT, same Chicago day
      const angle = pickAngle({
        claims: CLAIMS,
        dateStr,
        previousAngle: todaysSelfMadeAngle({ posts }, "ldt", now),
      });
      picked.push(angle.key);
      posts.push({
        brand: "ldt", type: "ldt_carousel", angle: angle.key,
        timestamp: now.toISOString(), success: true,
      });
    }
    const counts = Object.fromEntries(all.map((k) => [k, picked.filter((p) => p === k).length]));
    for (const key of all) {
      assert.ok(counts[key] > 0, `angle '${key}' never reached the feed over 60 days: ${JSON.stringify(counts)}`);
    }
  });

  test("EVERY self-made post in one day tells a different story, at the real cadence", () => {
    // The regression this pins: excluding only the NEWEST of today's angles
    // lets slot 3 exclude slot 2's and land straight back on slot 1's. At
    // the 3/day schedule that repeated a story on 7 days in 14 — half the
    // days showing the same copy twice, in different wrappers. The slot
    // count is read from brands.json so this scales with the cadence rather
    // than pinning today's number.
    const slotsPerDay = Math.max(...Object.values(loadBrandRegistry().brands.ldt.cadence));
    assert.ok(slotsPerDay >= 2, "the guard is only meaningful with 2+ slots");
    for (let d = 0; d < 30; d++) {
      const dateStr = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
      const posts = [];
      const picked = [];
      for (let s = 0; s < slotsPerDay; s++) {
        const now = new Date(`${dateStr}T${String(15 + s * 4).padStart(2, "0")}:00:00Z`);
        const angle = pickAngle({
          claims: CLAIMS, dateStr,
          previousAngle: todaysSelfMadeAngles({ posts }, "ldt", now),
        });
        picked.push(angle.key);
        posts.push({
          brand: "ldt", type: `ldt_${SELF_MADE_KINDS[s % SELF_MADE_KINDS.length]}`,
          angle: angle.key, timestamp: now.toISOString(), success: true,
        });
      }
      assert.equal(new Set(picked).size, picked.length,
        `${dateStr} repeated a story within the day: ${picked.join(" → ")}`);
    }
  });

  test("todaysSelfMadeAngles returns the whole day's set, newest first", () => {
    const NOW = new Date("2026-08-29T23:30:00Z");
    const at = (ts, angle) => ({
      brand: "ldt", type: "ldt_carousel", angle, timestamp: ts, success: true,
    });
    const posts = [
      at("2026-08-28T20:00:00.000Z", "meta"),            // yesterday — excluded
      at("2026-08-29T15:00:00.000Z", "leads_going_cold"),
      at("2026-08-29T19:00:00.000Z", "after_hours"),
    ];
    assert.deepEqual(todaysSelfMadeAngles({ posts }, "ldt", NOW), ["after_hours", "leads_going_cold"]);
    // The singular helper stays the newest of that set, for any caller that
    // only needs one.
    assert.equal(todaysSelfMadeAngle({ posts }, "ldt", NOW), "after_hours");
    assert.deepEqual(todaysSelfMadeAngles({ posts: [] }, "ldt", NOW), []);
  });

  test("consecutive days never repeat, so no cross-day exclusion is needed", () => {
    for (let i = 1; i < 30; i++) {
      assert.notEqual(
        pickAngle({ claims: CLAIMS, dateStr: dayStr(i) }).key,
        pickAngle({ claims: CLAIMS, dateStr: dayStr(i - 1) }).key,
      );
    }
  });

  test("todaysSelfMadeAngle excludes only a story already told TODAY", () => {
    const NOW = new Date("2026-08-29T22:00:00Z"); // 5 PM CT
    const entry = (ts) => ({
      brand: "ldt", type: "ldt_carousel", angle: "meta", timestamp: ts, success: true,
    });
    // Posted this morning, Chicago time — the evening slot must not retell it.
    assert.equal(todaysSelfMadeAngle({ posts: [entry("2026-08-29T15:05:00.000Z")] }, "ldt", NOW), "meta");
    // Yesterday's story is fair game again; the date rotation handles spacing.
    assert.equal(todaysSelfMadeAngle({ posts: [entry("2026-08-28T15:05:00.000Z")] }, "ldt", NOW), null);
    // Another brand's post is never this brand's history.
    assert.equal(todaysSelfMadeAngle({ posts: [entry("2026-08-29T15:05:00.000Z")] }, "otherbrand", NOW), null);
  });
});

// ─── The walk's admission policy ─────────────────────────────────────────────

describe("selfMadeAllowed — when the generated chain may run at all", () => {
  const CONFIGURED = { contentSources: { promoWhenNoClip: true } };

  test("a FORCE_VIDEO_ID pin short-circuits ALL self-made fallback, whatever the mode", () => {
    for (const mode of ["auto", "clip", "selfmade"]) {
      assert.equal(selfMadeAllowed({ mode, forceVideoId: "abc123", brand: CONFIGURED }), false,
        `a pin names a clip — mode '${mode}' must not generate around it`);
    }
  });

  test("MODE=selfmade runs the chain even without the config opt-in", () => {
    assert.equal(selfMadeAllowed({ mode: "selfmade", forceVideoId: "", brand: {} }), true);
  });

  test("MODE=auto generates only when the brand config opts in", () => {
    assert.equal(selfMadeAllowed({ mode: "auto", forceVideoId: "", brand: CONFIGURED }), true);
    assert.equal(selfMadeAllowed({ mode: "auto", forceVideoId: "", brand: {} }), false);
    assert.equal(selfMadeAllowed({ mode: "auto", forceVideoId: "", brand: { contentSources: { promoWhenNoClip: false } } }), false);
  });

  test("MODE=clip never generates", () => {
    assert.equal(selfMadeAllowed({ mode: "clip", forceVideoId: "", brand: CONFIGURED }), false);
  });

  // Source-text guard, same idiom as ldt-learning.test.mjs's stamp guard: the
  // runner's exit codes are integration behavior, and the failure this pins is
  // silent by construction — a slot where every clip broke and every format
  // was already used would exit 0, so the workflow writes post_success=true
  // and a broken slot reads as a healthy one in the Actions list.
  test("a walk that tries NOTHING after a clip failure exits red, not green", () => {
    const src = readFileSync(join(SRC_ROOT, "ldt-main.js"), "utf-8");
    const branch = src.slice(src.indexOf("if (attempted === 0)"));
    assert.ok(branch.length > 0, "the attempted===0 branch exists");
    const green = branch.indexOf("process.exit(0)");
    const red = branch.indexOf("process.exit(1)");
    assert.ok(red !== -1, "the branch has a red exit at all");
    assert.ok(red < green, "the clipError red exit must come BEFORE the green one");
    assert.match(branch.slice(0, red), /if \(clipError\)/,
      "the red exit is guarded on a clip failure having happened");
  });
});

// ─── The variation-engine seam ───────────────────────────────────────────────

describe("planVariation's previousStyle override (the LDT seam)", () => {
  const seq = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

  test("a supplied previous style is excluded without scanning the log", () => {
    for (let i = 0; i < 100; i++) {
      const plan = planVariation({ log: { posts: [] }, brief: null, previousStyle: "stat", rand: seq(i / 100, i / 100, i / 100) });
      assert.notEqual(plan.hook_style, "stat");
      assert.equal(plan.excluded_style, "stat");
    }
  });

  test("an explicit null excludes nothing", () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      seen.add(planVariation({ log: { posts: [] }, brief: null, previousStyle: null, rand: seq(0.9, i / 60, i / 60) }).hook_style);
    }
    assert.equal(seen.size, HOOK_STYLE_IDS.length, "with no exclusion, exploration reaches every style");
  });
});

// ─── Facebook payload shapes, per medium ─────────────────────────────────────

describe("Facebook gets the shape Metricool wants, per format", () => {
  const CAPTION = "PRIMARY at work.";
  const AT = "2026-08-29T15:00:00";

  test("IMAGE formats (carousel, card): a per-network body with facebookData type POST", () => {
    // Proven shape: the realty carousel fan-out has posted Facebook
    // multi-image in production with exactly this body, and the 2026-08-01
    // reach probe confirmed FB multi-image is reachable.
    const urls = ["https://cdn.test/1.png", "https://cdn.test/2.png"];
    const body = facebookCarouselBody(urls, CAPTION, AT);
    assert.deepEqual(body.providers, [{ network: "facebook" }], "one network per image call");
    assert.deepEqual(body.media, urls, "carries the slides");
    assert.equal(body.facebookData.type, "POST");
    assert.equal(body.autoPublish, true);
    assert.equal(body.draft, false);
    assert.equal(body.publicationDate.timezone, "America/Chicago");
    // A single-image card is the same body with one URL — not a special case.
    const card = facebookCarouselBody([urls[0]], CAPTION, AT);
    assert.equal(card.media.length, 1);
    assert.equal(card.facebookData.type, "POST");
  });

  test("IMAGE formats: Facebook rides the PNGs, and the deck uploads ONCE", () => {
    // Adding Facebook must cost a scheduler call, not a third upload of the
    // same deck. Instagram and Facebook share the lossless PNG upload; only
    // TikTok needs its own JPEG copy (it rejects PNG at publish time).
    const src = readFileSync(join(SRC_ROOT, "ldt-main.js"), "utf-8");
    const block = src.slice(src.indexOf("const targets = ["), src.indexOf("const failed = results.filter"));
    assert.match(block, /network: "facebook", encoding: "png"/, "facebook takes the PNGs");
    assert.match(block, /network: "instagram", encoding: "png"/, "instagram takes the same PNGs");
    assert.match(block, /network: "tiktok", encoding: "jpeg"/, "tiktok keeps its own JPEG copy");
    // The memo is what makes the sharing real rather than incidental.
    assert.match(src, /if \(!uploads\[encoding\]\)/, "uploads are memoized per encoding");
  });

  test("VIDEO formats (clip, text reel): ONE call carrying every provider, facebookData REEL", () => {
    // The asymmetry is Metricool's: the video endpoint fans out across
    // providers in a single scheduler call, so Facebook rides along as a
    // provider rather than getting its own call. Pinned on the real source
    // because the call is made inside createSingleBrandPost.
    const src = readFileSync(join(SRC_ROOT, "metricool.js"), "utf-8");
    const fn = src.slice(src.indexOf("export async function createSingleBrandPost"));
    const body = fn.slice(0, fn.indexOf("const url ="));
    assert.match(body, /facebookData:\s*\{\s*type:\s*"REEL"/, "video to a Page is a REEL");
    assert.match(body, /instagramData/, "instagram still gets its REEL block");
    assert.match(body, /tiktokData/, "tiktok still gets its VIDEO block");
    assert.match(body, /providers:\s*wanted\.map/, "every wanted network goes in one call");
  });

  test("the two shapes stay distinct — images never fan out, video never splits", () => {
    // If someone 'simplifies' the image path into the video path's single
    // multi-provider call, Facebook and Instagram would share one post body
    // and TikTok would receive PNGs. Pin the distinction.
    const igBody = instagramCarouselBody(["u"], CAPTION, AT);
    const fbBody = facebookCarouselBody(["u"], CAPTION, AT);
    const tkBody = tiktokCarouselBody(["u"], CAPTION, AT);
    for (const [name, b] of [["instagram", igBody], ["facebook", fbBody], ["tiktok", tkBody]]) {
      assert.equal(b.providers.length, 1, `${name} image body targets exactly one network`);
      assert.equal(b.providers[0].network, name);
    }
  });
});

describe("entry stamps record what actually published", () => {
  test("the image path records the networks that SUCCEEDED, not the ones attempted", () => {
    // With three networks, a partial failure is now ordinary (Facebook could
    // reject while Instagram accepts). Recording the attempted list would
    // tell the learn step a post reached a platform it never reached, and
    // would spend cadence budget the lane never used.
    const src = readFileSync(join(SRC_ROOT, "ldt-main.js"), "utf-8");
    const fn = src.slice(src.indexOf("async function postSelfMade"));
    assert.match(fn, /const postedNetworks = okResults\.flatMap\(r => r\.networks\)/,
      "the recorded set is derived from the OK results");
    const record = fn.slice(fn.indexOf("recordPost(log, {"), fn.indexOf("} catch (err) {", fn.indexOf("recordPost(log, {")));
    assert.match(record, /platforms: postedNetworks/, "platforms comes from what published");
    assert.ok(!/platforms: platforms/.test(record), "never the attempted list");
    // Per-network postIds keep the audit trail resolvable per platform.
    assert.match(record, /postIds: okResults\.map/);
  });

  test("a failed network is warned about, not silently dropped from the record", () => {
    const src = readFileSync(join(SRC_ROOT, "ldt-main.js"), "utf-8");
    const fn = src.slice(src.indexOf("async function postSelfMade"));
    assert.match(fn, /for \(const f of failed\)/, "failures are iterated");
    assert.match(fn, /::warning::/, "and surfaced in the Actions log");
  });
});
