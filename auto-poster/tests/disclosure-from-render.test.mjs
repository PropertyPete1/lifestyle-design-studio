/**
 * The synthetic-content disclosure.
 *
 * It used to be decided from narrationMode — a PREDICTION made before anything
 * was recorded. In "peter" mode a single missed voiceover take falls back to the
 * clone, so the render would contain synthetic speech in a real person's voice
 * while the config still said it did not, and the disclosure would be dropped on
 * exactly the video that needed it. That is a policy exposure, not a cosmetic
 * one, so the render now decides.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { disclosureRequired } from "../src/yt-config.js";
import { syntheticNarrationUsed } from "../src/yt-assemble.js";
import { reviewChecklist } from "../src/yt-publish.js";

const recorded = (id) => ({ kind: "voiceover", takeId: id, narrationSource: `/rec/${id}.mp4` });
const cloned = (id) => ({ kind: "voiceover", takeId: id, generatedNarrationPath: `/tmp/${id}.mp3` });
const onCamera = (id) => ({ kind: "on_camera", takeId: id });

describe("syntheticNarrationUsed — an observation, not a prediction", () => {
  test("false when Peter recorded every voiceover take", () => {
    assert.equal(syntheticNarrationUsed({ segments: [onCamera("a"), recorded("b"), recorded("c")] }), false);
  });

  test("TRUE when even one take fell back to the clone", () => {
    // The case the old logic got wrong.
    assert.equal(syntheticNarrationUsed({ segments: [recorded("a"), recorded("b"), cloned("c")] }), true);
  });

  test("true when everything was generated", () => {
    assert.equal(syntheticNarrationUsed({ segments: [cloned("a"), cloned("b")] }), true);
  });

  test("tolerates an empty or malformed plan", () => {
    assert.equal(syntheticNarrationUsed({ segments: [] }), false);
    assert.equal(syntheticNarrationUsed(null), false);
    assert.equal(syntheticNarrationUsed({}), false);
  });
});

describe("disclosureRequired — evidence beats configuration", () => {
  test("THE HOLE THAT WAS OPEN: peter mode, one take missed, disclosure still required", () => {
    assert.equal(
      disclosureRequired({ narrationMode: "peter", syntheticNarration: true }),
      true,
      "a video containing clone speech must declare it, whatever the mode said"
    );
  });

  test("peter mode with everything recorded needs no disclosure", () => {
    assert.equal(disclosureRequired({ narrationMode: "peter", syntheticNarration: false }), false);
  });

  test("elevenlabs mode that happened to use no clone needs no disclosure", () => {
    // The other direction: observation overrides a mode that predicted synthetic.
    assert.equal(disclosureRequired({ narrationMode: "elevenlabs", syntheticNarration: false }), false);
  });

  test("elevenlabs mode that used the clone requires it", () => {
    assert.equal(disclosureRequired({ narrationMode: "elevenlabs", syntheticNarration: true }), true);
  });

  test("null means nobody looked — fall back to the mode, unchanged behaviour", () => {
    assert.equal(disclosureRequired({ narrationMode: "peter" }), false);
    assert.equal(disclosureRequired({ narrationMode: "elevenlabs" }), true);
    assert.equal(disclosureRequired({ narrationMode: "peter", syntheticNarration: null }), false);
  });

  test("other synthetic media still forces it, whatever the narration did", () => {
    assert.equal(
      disclosureRequired({ narrationMode: "peter", syntheticNarration: false, syntheticMedia: ["avatar"] }),
      true
    );
  });

  test("an unrecognised mode with no evidence stays on the safe side", () => {
    assert.equal(disclosureRequired({ narrationMode: "something-else" }), true);
  });
});

describe("reviewChecklist — the item follows the render", () => {
  const packaging = { title: "t", missingCta: [] };
  const has = (items) => items.some((i) => /Altered or synthetic content/.test(i));

  test("omits the disclosure when nothing synthetic was rendered", () => {
    assert.equal(has(reviewChecklist({ packaging, narrationMode: "peter", syntheticNarration: false })), false);
  });

  test("includes it when a take fell back to the clone, even in peter mode", () => {
    const items = reviewChecklist({ packaging, narrationMode: "peter", syntheticNarration: true });
    assert.equal(has(items), true);
  });

  test("the wording describes THIS render rather than asserting it always applies", () => {
    const [item] = reviewChecklist({ packaging, narrationMode: "peter", syntheticNarration: true })
      .filter((i) => /Altered or synthetic content/.test(i));
    assert.match(item, /THIS render/, "must not claim the clone is used on every video");
  });
});
