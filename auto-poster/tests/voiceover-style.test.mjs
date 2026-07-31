/**
 * Voiceover pacing + persona rotation.
 *
 * These pin the three things that would silently degrade every post if they
 * drifted: the tempo clamp (too fast = unintelligible), the silence-trim
 * parameters (too aggressive = words run together), and persona rotation
 * (broken = every video sounds identical, which is the whole point of the work).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTempo,
  TEMPO_DEFAULT,
  TEMPO_MIN,
  TEMPO_MAX,
  buildAudioFilterChain,
  SILENCE_KEEP_SEC,
  SILENCE_THRESHOLD_DB,
  targetWordsForDuration,
  BASE_WORDS_PER_SEC,
  resolveVoiceSettings,
  PERSONAS,
  PERSONA_IDS,
  pickPersona,
  getLastPersonaForCity,
  getRecentTranscripts,
  buildAvoidBlock,
} from "../src/voiceover-style.js";

describe("resolveTempo — clamp 1.0 to 1.30", () => {
  test("defaults when unset", () => {
    assert.equal(resolveTempo(undefined), TEMPO_DEFAULT);
  });

  test("passes through an in-range value", () => {
    assert.equal(resolveTempo("1.22"), 1.22);
  });

  test("clamps ABOVE max — never unintelligible", () => {
    assert.equal(resolveTempo("2.5"), TEMPO_MAX);
    assert.equal(resolveTempo("1.31"), TEMPO_MAX);
  });

  test("clamps BELOW min — never slower than the original read", () => {
    assert.equal(resolveTempo("0.5"), TEMPO_MIN);
    assert.equal(resolveTempo("-3"), TEMPO_MIN);
  });

  test("accepts the exact boundaries", () => {
    assert.equal(resolveTempo("1.0"), 1.0);
    assert.equal(resolveTempo("1.30"), 1.3);
  });

  describe("malformed input falls back to default rather than throwing", () => {
    for (const bad of ["", "fast", "NaN", null, undefined, "1.2x", {}]) {
      test(JSON.stringify(bad), () => {
        assert.equal(resolveTempo(bad), TEMPO_DEFAULT);
      });
    }
  });

  test("default sits inside the clamp range", () => {
    assert.ok(TEMPO_DEFAULT >= TEMPO_MIN && TEMPO_DEFAULT <= TEMPO_MAX);
  });
});

describe("buildAudioFilterChain — silence trim then speedup", () => {
  const chain = buildAudioFilterChain(1.18);

  test("trims silence before changing tempo", () => {
    assert.ok(chain.indexOf("silenceremove") < chain.indexOf("atempo"), "order matters: trim, then speed up");
  });

  test("removes silence throughout, not just leading", () => {
    assert.match(chain, /stop_periods=-1/);
  });

  test("keeps ~250ms so word spacing survives", () => {
    assert.equal(SILENCE_KEEP_SEC, 0.25);
    assert.match(chain, /stop_duration=0\.25/);
  });

  test("uses the documented silence threshold", () => {
    assert.equal(SILENCE_THRESHOLD_DB, -38);
    assert.match(chain, /stop_threshold=-38dB/);
  });

  test("applies the tempo it was given", () => {
    assert.match(buildAudioFilterChain(1.25), /atempo=1\.25/);
  });

  test("tempo stays within atempo's single-pass range (0.5–2.0)", () => {
    assert.ok(TEMPO_MAX <= 2.0, "above 2.0 atempo would need chaining");
    assert.ok(TEMPO_MIN >= 0.5);
  });
});

describe("targetWordsForDuration — budget tracks the speedup", () => {
  test("scales with tempo so the script fills the clip", () => {
    const base = targetWordsForDuration(30, 1.0);
    const fast = targetWordsForDuration(30, 1.18);
    assert.ok(fast > base, "a sped-up read must be given more words");
    assert.equal(base, Math.floor(30 * BASE_WORDS_PER_SEC));
    assert.equal(fast, Math.floor(30 * BASE_WORDS_PER_SEC * 1.18));
  });

  test("longer clips get proportionally more words", () => {
    assert.ok(targetWordsForDuration(60, 1.18) > targetWordsForDuration(30, 1.18));
  });
});

describe("resolveVoiceSettings — energetic delivery, env-overridable", () => {
  test("defaults: low stability, raised style", () => {
    const s = resolveVoiceSettings({});
    assert.equal(s.stability, 0.35);
    assert.equal(s.style, 0.6);
    assert.equal(s.use_speaker_boost, true);
  });

  test("env overrides win", () => {
    const s = resolveVoiceSettings({ ELEVENLABS_STABILITY: "0.2", ELEVENLABS_STYLE: "0.8" });
    assert.equal(s.stability, 0.2);
    assert.equal(s.style, 0.8);
  });

  test("out-of-range values clamp to 0..1", () => {
    const s = resolveVoiceSettings({ ELEVENLABS_STABILITY: "5", ELEVENLABS_STYLE: "-2" });
    assert.equal(s.stability, 1);
    assert.equal(s.style, 0);
  });

  test("garbage env falls back to defaults", () => {
    const s = resolveVoiceSettings({ ELEVENLABS_STABILITY: "loud" });
    assert.equal(s.stability, 0.35);
  });
});

describe("personas", () => {
  test("there are exactly 6, with unique ids", () => {
    assert.equal(PERSONAS.length, 6);
    assert.equal(new Set(PERSONA_IDS).size, 6);
  });

  test("every persona has a label and a non-trivial instruction", () => {
    for (const p of PERSONAS) {
      assert.ok(p.label && p.label.length > 3, `${p.id} needs a label`);
      assert.ok(p.instruction && p.instruction.length > 40, `${p.id} needs a real instruction`);
    }
  });

  test("the storyteller persona carries the no-fabricated-facts guardrail", () => {
    // This is the persona allowed to invent a scenario, so it is the one that
    // must explicitly ban inventing facts about the actual property.
    const story = PERSONAS.find((p) => p.id === "storyteller");
    assert.match(story.instruction, /NEVER invent a fact about this specific property/i);
    assert.match(story.instruction, /No named people/i);
  });

  test("the insider persona bans inventing incentives or deadlines", () => {
    const insider = PERSONAS.find((p) => p.id === "insider_secret");
    assert.match(insider.instruction, /Do NOT invent a specific incentive, discount, deadline/i);
  });
});

describe("persona rotation — never the same city twice in a row", () => {
  const mkLog = (posts) => ({ posts });

  test("with no history, any persona is valid", () => {
    const p = pickPersona(mkLog([]), "san_antonio", () => 0);
    assert.ok(PERSONA_IDS.includes(p.id));
  });

  test("never returns the city's previous persona, for ANY random draw", () => {
    const log = mkLog([{ city: "san_antonio", voiceover_persona: "storyteller" }]);
    // Sweep the whole random space — no draw may reproduce the last persona.
    for (let i = 0; i < 100; i++) {
      const p = pickPersona(log, "san_antonio", () => i / 100);
      assert.notEqual(p.id, "storyteller", `draw ${i / 100} repeated the previous persona`);
    }
  });

  test("another city is unaffected by this city's history", () => {
    const log = mkLog([{ city: "san_antonio", voiceover_persona: "storyteller" }]);
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(pickPersona(log, "austin", () => i / 100).id);
    assert.ok(seen.has("storyteller"), "austin should still be able to draw storyteller");
  });

  test("uses the MOST RECENT persona for the city, not the oldest", () => {
    const log = mkLog([
      { city: "austin", voiceover_persona: "checklist_sprint" },
      { city: "austin", voiceover_persona: "deadpan_comedian" },
    ]);
    assert.equal(getLastPersonaForCity(log, "austin"), "deadpan_comedian");
    for (let i = 0; i < 50; i++) {
      assert.notEqual(pickPersona(log, "austin", () => i / 50).id, "deadpan_comedian");
    }
  });

  test("entries without a persona are ignored", () => {
    const log = mkLog([{ city: "dallas", voiceover: true }]);
    assert.equal(getLastPersonaForCity(log, "dallas"), null);
  });

  test("rotation can reach every persona over time", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(pickPersona(mkLog([]), "dallas", () => i / 200).id);
    assert.equal(seen.size, 6, "all six personas must be reachable");
  });
});

describe("getRecentTranscripts — 'do not resemble these'", () => {
  test("returns newest first, capped at the limit", () => {
    const log = { posts: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ voiceover: true, voiceover_transcript: `script ${n}` })) };
    const got = getRecentTranscripts(log, 5);
    assert.equal(got.length, 5);
    assert.equal(got[0], "script 7");
  });

  test("EXCLUDES the owner's own narration (voiceover: false)", () => {
    // Those transcripts are Whisper capturing Peter's hand-recorded read — the
    // tone we want to emulate. Listing them as "do not resemble" would push the
    // model away from the target voice.
    const log = {
      posts: [
        { voiceover: false, voiceover_transcript: "Quick payment math price is..." },
        { voiceover: true, voiceover_transcript: "generated one" },
      ],
    };
    const got = getRecentTranscripts(log, 5);
    assert.deepEqual(got, ["generated one"]);
  });

  test("skips empty and missing transcripts", () => {
    const log = {
      posts: [
        { voiceover: true, voiceover_transcript: "   " },
        { voiceover: true },
        { voiceover: true, voiceover_transcript: "real" },
      ],
    };
    assert.deepEqual(getRecentTranscripts(log, 5), ["real"]);
  });

  test("empty history yields an empty avoid block (no dangling prompt section)", () => {
    assert.equal(buildAvoidBlock([]), "");
    assert.equal(buildAvoidBlock(undefined), "");
  });

  test("avoid block lists the transcripts", () => {
    const block = buildAvoidBlock(["alpha", "beta"]);
    assert.match(block, /DO NOT RESEMBLE/i);
    assert.match(block, /alpha/);
    assert.match(block, /beta/);
  });
});
