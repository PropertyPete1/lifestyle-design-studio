import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  queryTerms, openerCarriesQuery, generateSeoOpener, curiosityChapters,
  buildDescription, CHAPTER_TITLE_MAX,
} from "../src/yt-packaging.js";

const TOPIC = { query: "moving to san antonio", title: "Moving to San Antonio: what $400K buys", market: "san_antonio" };

describe("D5 — the search-facing opener", () => {
  test("queryTerms drops stopwords and keeps the searchable core", () => {
    assert.deepEqual(queryTerms("moving to san antonio"), ["moving", "san", "antonio"]);
    assert.deepEqual(queryTerms("best neighborhoods for veterans"), ["neighborhoods", "veterans"]);
  });

  test("an opener that carries the query passes; one that dropped it fails", () => {
    assert.equal(openerCarriesQuery("Moving to San Antonio and wondering what $400K buys?", "moving to san antonio"), true);
    assert.equal(openerCarriesQuery("A city guide for smart buyers everywhere.", "moving to san antonio"), false);
  });

  test("a good opener is accepted", async () => {
    const model = async () => JSON.stringify({
      line1: "Moving to San Antonio and trying to work out what $400K actually buys?",
      line2: "Real neighborhoods, the tax bill line by line, and where the money goes furthest.",
    });
    const opener = await generateSeoOpener(TOPIC, model);
    assert.ok(opener);
    assert.equal(opener.split("\n").length, 2);
  });

  test("an opener that loses the query FALLS BACK rather than shipping", async () => {
    const model = async () => JSON.stringify({ line1: "A beautiful city awaits you.", line2: "Watch to learn more." });
    assert.equal(await generateSeoOpener(TOPIC, model), null);
  });

  test("an opener with a DM promise falls back", async () => {
    const model = async () => JSON.stringify({
      line1: "Moving to San Antonio and unsure what $400K buys here?",
      line2: "Comment MATH and I'll send it over.",
    });
    assert.equal(await generateSeoOpener(TOPIC, model), null);
  });

  test("model failure degrades to null, never throws", async () => {
    assert.equal(await generateSeoOpener(TOPIC, async () => "not json"), null);
    assert.equal(await generateSeoOpener(TOPIC, async () => { throw new Error("down"); }), null);
  });

  test("the description leads with the opener when present, hook when not", () => {
    const opener = "Moving to San Antonio and pricing it out?\nEvery line of the real cost, mapped.";
    const withOpener = buildDescription({ hook: "The hook line.", promise: "The promise.", seoOpener: opener });
    assert.ok(withOpener.text.startsWith("Moving to San Antonio and pricing it out?"));
    assert.ok(withOpener.text.includes("The hook line."), "the hook still appears below");
    const without = buildDescription({ hook: "The hook line.", promise: "The promise." });
    assert.ok(without.text.startsWith("The hook line."));
  });
});

describe("D6 — curiosity-shaped chapters", () => {
  const CHAPTERS = [
    { title: "Where the north side starts", seconds: 0, timestamp: "00:00" },
    { title: "Property taxes", seconds: 245, timestamp: "04:05" },
    { title: "School districts", seconds: 512, timestamp: "08:32" },
  ];

  test("a clean rewrite is applied and timestamps are untouched", async () => {
    const model = async () => JSON.stringify({ titles: ["The line where prices change", "The tax nobody warns you about", "One street, two school districts"] });
    const r = await curiosityChapters(CHAPTERS, model);
    assert.equal(r.rewritten, true);
    assert.equal(r.chapters[1].title, "The tax nobody warns you about");
    assert.equal(r.chapters[1].seconds, 245, "seconds must never move");
    assert.equal(r.chapters[1].timestamp, "04:05", "timestamps must never move");
  });

  test("a count mismatch falls back to the originals wholesale", async () => {
    const model = async () => JSON.stringify({ titles: ["Only one title"] });
    const r = await curiosityChapters(CHAPTERS, model);
    assert.equal(r.rewritten, false);
    assert.equal(r.chapters[0].title, "Where the north side starts");
  });

  test("an over-length or duplicate title falls back", async () => {
    const long = "x".repeat(CHAPTER_TITLE_MAX + 1);
    assert.equal((await curiosityChapters(CHAPTERS, async () => JSON.stringify({ titles: [long, "b", "c"] }))).rewritten, false);
    assert.equal((await curiosityChapters(CHAPTERS, async () => JSON.stringify({ titles: ["Same", "same", "c"] }))).rewritten, false);
  });

  test("model failure keeps the originals, never throws", async () => {
    const r = await curiosityChapters(CHAPTERS, async () => { throw new Error("down"); });
    assert.equal(r.rewritten, false);
    assert.equal(r.chapters.length, 3);
  });

  test("empty chapters pass through untouched", async () => {
    const r = await curiosityChapters([], async () => { throw new Error("must not be called"); });
    assert.deepEqual(r.chapters, []);
  });
});
