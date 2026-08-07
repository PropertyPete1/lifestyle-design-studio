/**
 * The weekly brief.
 *
 * The brief is where a bad video is cheapest to prevent, so the tests are about
 * what gets rejected: titles nobody would search for, three candidates that are
 * really the same candidate, and the usual guards.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateCandidate,
  validateBrief,
  applyGuards,
  proposeFootage,
  generateBrief,
  renderBriefText,
  briefPayload,
  candidateText,
  resolveTopicSelection,
  priorTitles,
  SEARCH_INTENTS,
  briefSystem,
  gatedDevelopmentNames,
} from "../src/yt-brief.js";

function candidate(overrides = {}) {
  return {
    title: "Moving to San Antonio: what $300k actually gets you",
    intent: "relocation",
    market: "san_antonio",
    query: "moving to san antonio",
    hook: "Everyone quotes you the price. Nobody quotes you the number that decides if you can afford it.",
    outline: "What $300k buys\nWhere it buys it\nThe tax surprise\nWhat I'd actually do",
    why: "Buyers relocating from California start their search on price and get blindsided by the tax rate.",
    footage: "newer subdivisions, wide streets, a walkthrough of a spec home",
    ...overrides,
  };
}

function brief(n = 3) {
  const intents = ["relocation", "comparison", "cost_of_living"];
  const markets = ["san_antonio", "austin", "san_antonio"];
  return Array.from({ length: n }, (_, i) =>
    candidate({
      title: `Moving to San Antonio: option ${i + 1}`,
      intent: intents[i % intents.length],
      market: markets[i % markets.length],
      query: `query ${i + 1} san antonio`,
    })
  );
}

describe("validateCandidate — titles are search queries", () => {
  test("a query-shaped title passes", () => {
    assert.equal(validateCandidate(candidate()).valid, true);
  });

  test("rejects a title with no city — it cannot rank for a relocation query", () => {
    const r = validateCandidate(candidate({ title: "What $300k actually gets you in 2026" }));
    assert.ok(r.failures.some((f) => f.includes("names no city")));
  });

  test("rejects clickbait shapes", () => {
    for (const title of [
      "You won't believe these San Antonio homes",
      "My top 5 tips for Austin buyers",
      "SHOCKING San Antonio market news",
    ]) {
      const r = validateCandidate(candidate({ title }));
      assert.equal(r.valid, false, `should have rejected: ${title}`);
    }
  });

  test("rejects a title too long for YouTube to show", () => {
    const r = validateCandidate(candidate({ title: `Moving to San Antonio ${"x".repeat(60)}` }));
    assert.ok(r.failures.some((f) => f.includes("max 70")));
  });

  test("rejects an unknown intent or market", () => {
    assert.ok(validateCandidate(candidate({ intent: "vibes" })).failures.some((f) => f.includes("intent")));
    assert.ok(validateCandidate(candidate({ market: "dallas" })).failures.some((f) => f.includes("market")));
  });

  test("rejects a thin outline", () => {
    const r = validateCandidate(candidate({ outline: "One\nTwo" }));
    assert.ok(r.failures.some((f) => f.includes("fewer than 4 chapters")));
  });

  test("names every missing field rather than failing on the first", () => {
    const r = validateCandidate({});
    assert.ok(r.failures.length >= 8);
  });
});

describe("validateBrief — three candidates must be three real choices", () => {
  test("a spread brief passes", () => {
    assert.equal(validateBrief(brief(3)).valid, true);
  });

  test("REJECTS three candidates chasing the same intent — they are near-substitutes", () => {
    const same = brief(3).map((c) => ({ ...c, intent: "relocation" }));
    const r = validateBrief(same);
    assert.equal(r.valid, false);
    assert.ok(r.failures.some((f) => f.includes("same intent")));
  });

  test("rejects duplicate titles", () => {
    const dupes = brief(3).map((c) => ({ ...c, title: "Moving to San Antonio: the same one" }));
    assert.ok(validateBrief(dupes).failures.some((f) => f.includes("share a title")));
  });

  test("rejects the wrong number of candidates", () => {
    assert.ok(validateBrief(brief(2), { wanted: 3 }).failures.some((f) => f.includes("wanted 3")));
  });

  test("an empty brief is invalid, not an empty pass", () => {
    assert.equal(validateBrief([]).valid, false);
    assert.equal(validateBrief(null).valid, false);
  });

  test("a single candidate cannot trip the same-intent rule", () => {
    assert.equal(validateBrief(brief(1), { wanted: 1 }).valid, true);
  });
});

describe("guards", () => {
  test("catches a monthly payment figure anywhere in the brief", () => {
    const c = brief(3);
    c[1].hook = "Your payment on that would be about $2,400 a month.";
    assert.equal(applyGuards(c).paymentFigure.found, true);
  });

  test("catches banned phrasing", () => {
    const c = brief(3);
    c[0].footage = "stunning homes nestled by the greenbelt";
    const labels = applyGuards(c).bannedTells.map((t) => t.label);
    assert.ok(labels.includes("stunning"));
  });

  test("clean candidates trip nothing", () => {
    const g = applyGuards(brief(3));
    assert.equal(g.paymentFigure.found, false);
    assert.deepEqual(g.bannedTells, []);
  });

  test("candidateText reaches every reader-visible field", () => {
    const texts = candidateText(candidate());
    assert.equal(texts.length, 6);
  });
});

describe("proposeFootage", () => {
  const videos = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, name: `clip${i}.mp4` }));

  test("prefers clips not spent on recent videos", () => {
    const used = new Set(["v0", "v1", "v2"]);
    const picks = proposeFootage(videos, used, { count: 3 });
    assert.deepEqual(picks.map((p) => p.driveFileId), ["v3", "v4", "v5"]);
    assert.ok(picks.every((p) => p.reused === false));
  });

  test("falls back to reused clips rather than proposing nothing, and says so", () => {
    const used = new Set(videos.map((v) => v.id));
    const picks = proposeFootage(videos, used, { count: 2 });
    assert.equal(picks.length, 2);
    assert.ok(picks.every((p) => p.reused === true), "a thin library should be visible, not hidden");
  });

  test("an empty library yields no proposals rather than throwing", () => {
    assert.deepEqual(proposeFootage([], new Set()), []);
    assert.deepEqual(proposeFootage(null, new Set()), []);
  });
});

// ─── generation ─────────────────────────────────────────────────────────────

function scriptedModel(responses) {
  const calls = [];
  let i = 0;
  const fn = async (system, prompt) => {
    calls.push({ system, prompt });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === "function" ? r() : r;
  };
  fn.calls = calls;
  return fn;
}

describe("generateBrief", () => {
  test("returns validated candidates", async () => {
    const model = scriptedModel([JSON.stringify({ candidates: brief(3) })]);
    const result = await generateBrief({ modelCall: model, wanted: 3 });
    assert.equal(result.candidates.length, 3);
    assert.equal(result.regenerated, false);
  });

  test("regenerates when every candidate chases the same intent", async () => {
    const same = brief(3).map((c) => ({ ...c, intent: "relocation" }));
    const model = scriptedModel([
      JSON.stringify({ candidates: same }),
      JSON.stringify({ candidates: brief(3) }),
    ]);
    const result = await generateBrief({ modelCall: model, wanted: 3 });
    assert.equal(result.regenerated, true);
    assert.ok(model.calls[1].prompt.includes("same intent"));
  });

  test("regenerates on a payment figure", async () => {
    const bad = brief(3);
    bad[0].hook = "That's about $2,400 a month for you.";
    const model = scriptedModel([
      JSON.stringify({ candidates: bad }),
      JSON.stringify({ candidates: brief(3) }),
    ]);
    const result = await generateBrief({ modelCall: model, wanted: 3 });
    assert.equal(result.regenerated, true);
    assert.ok(model.calls[1].prompt.includes("monthly payment figure"));
  });

  test("regenerates on banned phrasing", async () => {
    const bad = brief(3);
    bad[2].why = "Buyers want a stunning home in a charming area.";
    const model = scriptedModel([
      JSON.stringify({ candidates: bad }),
      JSON.stringify({ candidates: brief(3) }),
    ]);
    await generateBrief({ modelCall: model, wanted: 3 });
    assert.ok(model.calls[1].prompt.includes("do not swap in a synonym"));
  });

  test("passes already-made titles in as anti-examples", async () => {
    const model = scriptedModel([JSON.stringify({ candidates: brief(3) })]);
    await generateBrief({ modelCall: model, wanted: 3, recentTitles: ["Austin vs San Antonio: the honest comparison"] });
    assert.ok(model.calls[0].prompt.includes("ALREADY MADE"));
    assert.ok(model.calls[0].prompt.includes("Austin vs San Antonio"));
  });

  test("throws rather than returning an unvalidated brief", async () => {
    const model = scriptedModel([JSON.stringify({ candidates: [{ title: "nope" }] })]);
    await assert.rejects(() => generateBrief({ modelCall: model, wanted: 3, maxRetries: 1 }));
  });

  test("the intents list reaches the prompt", async () => {
    const model = scriptedModel([JSON.stringify({ candidates: brief(3) })]);
    await generateBrief({ modelCall: model, wanted: 3 });
    for (const intent of SEARCH_INTENTS) {
      assert.ok(model.calls[0].system.includes(intent.example), `missing example for ${intent.key}`);
    }
  });
});

describe("rendering", () => {
  const built = { candidates: brief(3).map((c) => ({ ...c, proposedClips: [{ driveFileId: "v1", fileName: "clip1.mp4", reused: false }] })) };

  test("the email numbers each option and tells Peter how to answer", () => {
    const text = renderBriefText(built, { requestId: "req-1" });
    assert.ok(text.includes("1. Moving to San Antonio: option 1"));
    assert.ok(text.includes("3. Moving to San Antonio: option 3"));
    assert.ok(text.includes("dashboard"));
    assert.ok(text.includes("req-1"));
  });

  test("the email shows the query, the hook, the chapters and the clips", () => {
    const text = renderBriefText(built);
    assert.ok(text.includes("Searches for:"));
    assert.ok(text.includes("OPENS WITH:"));
    assert.ok(text.includes("CHAPTERS:"));
    assert.ok(text.includes("clip1.mp4"));
  });

  test("it sets the expectation of what arrives after picking", () => {
    assert.ok(renderBriefText(built).includes("Nothing to memorise"));
  });

  test("the dashboard payload splits the outline into real chapters", () => {
    const payload = briefPayload(built, { requestId: "req-1" });
    assert.equal(payload.kind, "topic_pick");
    assert.equal(payload.candidates.length, 3);
    assert.ok(Array.isArray(payload.candidates[0].outline));
    assert.equal(payload.candidates[0].outline.length, 4);
    assert.equal(payload.candidates[0].index, 1);
  });
});

describe("resolveTopicSelection — an approval must say WHAT was approved", () => {
  const candidates = [
    { title: "Moving to San Antonio: what $300k gets you" },
    { title: "Austin vs San Antonio: the honest cost comparison" },
    { title: "New construction under $300k — what's the catch?" },
  ];

  test("a bare number in the notes picks that option", () => {
    const r = resolveTopicSelection({ decision: "approve", notes: "2" }, candidates);
    assert.equal(r.ok, true);
    assert.equal(r.index, 2);
    assert.equal(r.candidate.title, candidates[1].title);
  });

  test("a number followed by real notes still picks, and the notes survive", () => {
    const r = resolveTopicSelection({ decision: "approve", notes: "2 - but lead with the tax rate" }, candidates);
    assert.equal(r.ok, true);
    assert.equal(r.index, 2);
  });

  test("accepts the shapes a human actually types", () => {
    for (const notes of ["#3", "option 3", "3.", "3 please"]) {
      const r = resolveTopicSelection({ decision: "approve", notes }, candidates);
      assert.equal(r.ok, true, `failed on ${JSON.stringify(notes)}`);
      assert.equal(r.index, 3);
    }
  });

  test("a quoted title picks that candidate", () => {
    const r = resolveTopicSelection(
      { decision: "approve", notes: "let's do Austin vs San Antonio: the honest cost comparison" },
      candidates
    );
    assert.equal(r.ok, true);
    assert.equal(r.index, 2);
  });

  test("an explicit selection field wins when the dashboard grows one", () => {
    const r = resolveTopicSelection({ decision: "approve", selection: 3, notes: "" }, candidates);
    assert.equal(r.ok, true);
    assert.equal(r.index, 3);
    assert.equal(r.via, "selection field");
  });

  test("REFUSES rather than guessing when nothing says which", () => {
    const r = resolveTopicSelection({ decision: "approve", notes: "looks good!" }, candidates);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("which"));
    assert.equal(r.candidate, undefined, "must not fall back to the first candidate");
  });

  test("REFUSES on an empty note", () => {
    assert.equal(resolveTopicSelection({ decision: "approve" }, candidates).ok, false);
    assert.equal(resolveTopicSelection({ decision: "approve", notes: "" }, candidates).ok, false);
  });

  test("REFUSES when the notes name more than one candidate", () => {
    const r = resolveTopicSelection(
      { decision: "approve", notes: "Moving to San Antonio: what $300k gets you or maybe New construction under $300k — what's the catch?" },
      candidates
    );
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("cannot tell which"));
  });

  test("REFUSES an out-of-range number instead of clamping into a real video", () => {
    const r = resolveTopicSelection({ decision: "approve", notes: "7" }, candidates);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("7"));
  });

  test("a brief of one has nothing to be ambiguous about", () => {
    const r = resolveTopicSelection({ decision: "approve", notes: "go for it" }, [candidates[0]]);
    assert.equal(r.ok, true);
    assert.equal(r.index, 1);
  });

  test("a request that carried no candidates cannot resolve", () => {
    assert.equal(resolveTopicSelection({ decision: "approve", notes: "1" }, []).ok, false);
    assert.equal(resolveTopicSelection({ decision: "approve", notes: "1" }, null).ok, false);
  });
});

describe("priorTitles", () => {
  test("collects every title ever proposed, newest first, deduped", () => {
    const approvals = {
      requests: [
        { requestId: "a", payload: { candidates: [{ title: "One" }, { title: "Two" }] } },
        { requestId: "b", payload: { candidates: [{ title: "Two" }, { title: "Three" }] } },
      ],
    };
    assert.deepEqual(priorTitles(approvals), ["Three", "Two", "One"]);
  });

  test("tolerates records with no payload", () => {
    assert.deepEqual(priorTitles({ requests: [{ requestId: "a" }, null] }), []);
    assert.deepEqual(priorTitles(null), []);
  });
});

describe("generateBrief with rejection notes", () => {
  test("Peter's notes reach the writer and are marked as overriding", async () => {
    const model = scriptedModel([JSON.stringify({ candidates: brief(3) })]);
    await generateBrief({ modelCall: model, wanted: 3, notes: "less Austin, more new build" });
    assert.ok(model.calls[0].prompt.includes("less Austin, more new build"));
    assert.ok(model.calls[0].prompt.includes("overrides anything above"));
  });
});

describe("named places — the brief must give the writer specifics to work with", () => {
  // 2026-08-07: a picked topic produced a script scoring 6/10 on authenticity
  // because it never named a neighborhood — "inside 1604" vs "past 1604" for
  // eleven minutes. The critic's fix was to name Stone Oak, Alamo Ranch and
  // friends. The writer could not: the brief's prompt banned "community names"
  // outright, so the outline it was given had none. The critic was asking for
  // something the brief was forbidden to supply.
  const system = briefSystem();

  test("asks for real named places, not categories", () => {
    assert.match(system, /NAME REAL PLACES/);
    assert.match(system, /Stone Oak/, "the prompt shows the tier of specificity wanted");
  });

  test("no longer carries the blanket ban that caused the deadlock", () => {
    assert.doesNotMatch(
      system,
      /No builder names, no community names, no development names/,
      "the old blanket ban made the critic's demand unsatisfiable"
    );
  });

  test("still bans builder names — a builder is a company, not a place", () => {
    assert.match(system, /No builder names/);
  });

  test("lists every gated development by name, read live from the KB", () => {
    const gated = gatedDevelopmentNames();
    assert.ok(gated.length > 0, "the KB must yield something to gate");
    for (const name of gated) {
      assert.ok(system.includes(name), `prompt must name "${name}" as off-limits`);
    }
  });

  test("the prompt's gated list cannot drift from the guard that enforces it", () => {
    // Both sides read buildGatedTerms, so adding a community to the KB bans it
    // in the prompt without anyone maintaining a second copy.
    const gated = gatedDevelopmentNames();
    const stripped = applyGuards([candidate({ outline: gated.join("\n") })]);
    for (const name of gated) {
      assert.ok(
        !stripped.candidates[0].outline.includes(name),
        `the guard must strip "${name}" that the prompt forbids`
      );
    }
  });

  test("warns against inventing a place, which is worse than a general one", () => {
    assert.match(system, /Never invent a place/i);
  });
});

describe("applyGuards — precise about which names are protected", () => {
  const REAL_NEIGHBOURHOODS = [
    "Stone Oak", "Alamo Ranch", "Shavano Park", "Hollywood Park", "Cibolo Canyons", "Converse",
  ];

  test("lets established public neighborhoods through untouched", () => {
    const outline = REAL_NEIGHBOURHOODS.join("\n");
    const out = applyGuards([candidate({ outline })]);
    for (const name of REAL_NEIGHBOURHOODS) {
      assert.ok(out.candidates[0].outline.includes(name), `"${name}" must survive — it is a public place`);
    }
    assert.equal(out.leaksStripped.length, 0, "nothing here is gated");
  });

  test("still strips a gated development sitting among legitimate names", () => {
    const gated = gatedDevelopmentNames()[0];
    const out = applyGuards([candidate({ outline: `Stone Oak\n${gated}\nAlamo Ranch` })]);
    assert.ok(out.candidates[0].outline.includes("Stone Oak"), "the public name stays");
    assert.ok(out.candidates[0].outline.includes("Alamo Ranch"), "the public name stays");
    assert.ok(!out.candidates[0].outline.includes(gated), "the gated development goes");
    assert.ok(out.leaksStripped.length > 0, "and the strip is reported, never silent");
  });
});
