/**
 * Voiceover fit guard (integration audit, issue #7 / HIGH-1).
 *
 * The merge uses `amix=duration=first` + `-shortest`, so audio past the clip
 * length is discarded with no error — and the CTA is the last line of every
 * script. Two independent causes can overrun:
 *
 *   1. the audio post-process failing (best-effort: on ffmpeg error the read
 *      stays at 1.0x while the word budget assumed 1.18x), and
 *   2. the model overshooting its word target, which is only a prompt
 *      instruction and is enforced nowhere.
 *
 * Measuring finished audio against the clip catches both, which is why the fit
 * check is the authoritative gate rather than the word budget.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_LEAD_IN_SEC,
  availableAudioSeconds,
  fitsInClip,
  requiredTempoToFit,
  targetWordsForDuration,
  TEMPO_DEFAULT,
  TEMPO_MAX,
  BASE_WORDS_PER_SEC,
} from "../src/voiceover-style.js";

describe("AUDIO_LEAD_IN_SEC must match the merge filter", () => {
  test("is 0.5s, matching adelay=500|500 in mergeAudioWithVideo", () => {
    // If the adelay in voiceover.js changes, this must change with it or the
    // fit maths silently drifts and the CTA starts getting cut again.
    assert.equal(AUDIO_LEAD_IN_SEC, 0.5);
  });
});

describe("availableAudioSeconds", () => {
  test("subtracts the lead-in from the clip", () => {
    assert.equal(availableAudioSeconds(19.2), 18.7);
  });

  test("never returns negative for absurdly short clips", () => {
    assert.equal(availableAudioSeconds(0.2), 0);
  });
});

describe("fitsInClip", () => {
  test("audio shorter than the window fits", () => {
    assert.equal(fitsInClip(15, 19.2), true);
  });

  test("audio exactly filling the window fits", () => {
    assert.equal(fitsInClip(18.7, 19.2), true);
  });

  test("audio one tick over does NOT fit", () => {
    assert.equal(fitsInClip(18.8, 19.2), false);
  });

  test("the lead-in is what makes a clip-length read overrun", () => {
    // Audio equal to the raw clip length still loses 0.5s to the delay.
    assert.equal(fitsInClip(19.2, 19.2), false);
  });

  test("unknown durations are treated as fitting (never block on missing data)", () => {
    assert.equal(fitsInClip(NaN, 19.2), true);
    assert.equal(fitsInClip(15, NaN), true);
  });
});

describe("requiredTempoToFit", () => {
  test("computes the exact multiplier needed", () => {
    // 22s of audio into 18.7s of space -> 22/18.7
    assert.ok(Math.abs(requiredTempoToFit(22, 19.2) - 22 / 18.7) < 1e-9);
  });

  test("returns >1 when the read overruns", () => {
    assert.ok(requiredTempoToFit(22, 19.2) > 1);
  });

  test("returns <1 when there is slack", () => {
    assert.ok(requiredTempoToFit(10, 19.2) < 1);
  });

  test("is UNCLAMPED so callers can detect an impossible ask", () => {
    // A read needing 1.9x cannot be fixed within TEMPO_MAX; the caller must be
    // able to see that rather than silently clamping and truncating anyway.
    const needed = requiredTempoToFit(35, 19.2);
    assert.ok(needed > TEMPO_MAX, `expected >${TEMPO_MAX}, got ${needed}`);
  });

  test("degrades to the default on nonsense input", () => {
    assert.equal(requiredTempoToFit(0, 19.2), TEMPO_DEFAULT);
    assert.equal(requiredTempoToFit(NaN, 19.2), TEMPO_DEFAULT);
    assert.equal(requiredTempoToFit(10, 0.1), TEMPO_DEFAULT);
  });
});

describe("the regression this guard exists for", () => {
  // Reproduces the audit finding across the real library duration profile.
  const RATE = 2.6; // words/sec, measured on a representative script
  const CLIPS = [14.1, 16.4, 19.2, 23.6, 28.1]; // p10/p25/median/p75/p90

  test("at 1.18x the budgeted script fits every clip", () => {
    for (const D of CLIPS) {
      const words = targetWordsForDuration(D, TEMPO_DEFAULT);
      const spoken = words / RATE / TEMPO_DEFAULT;
      assert.ok(fitsInClip(spoken, D), `${D}s clip should fit at ${TEMPO_DEFAULT}x`);
    }
  });

  test("WITHOUT the speedup the same script overruns every clip", () => {
    // This is the bug: the budget assumed a best-effort step always succeeds.
    for (const D of CLIPS) {
      const words = targetWordsForDuration(D, TEMPO_DEFAULT);
      const spoken = words / RATE; // post-process failed -> no atempo
      assert.equal(fitsInClip(spoken, D), false, `${D}s clip should overrun at 1.0x`);
    }
  });

  test("and the required tempo to rescue it is within TEMPO_MAX", () => {
    // So the re-pace path can actually save these — it is not a lost cause.
    for (const D of CLIPS) {
      const words = targetWordsForDuration(D, TEMPO_DEFAULT);
      const spoken = words / RATE;
      const needed = requiredTempoToFit(spoken, D);
      assert.ok(needed <= TEMPO_MAX, `${D}s clip needs ${needed.toFixed(2)}x, over max`);
    }
  });

  test("a model overshoot of 40% is caught too (independent trigger)", () => {
    const D = 19.2;
    const words = Math.round(targetWordsForDuration(D, TEMPO_DEFAULT) * 1.4);
    const spoken = words / RATE / TEMPO_DEFAULT; // speedup applied, still too long
    assert.equal(fitsInClip(spoken, D), false, "overshoot must be detected even at full tempo");
  });

  test("word budget still scales with tempo (unchanged behaviour)", () => {
    assert.equal(targetWordsForDuration(30, 1.0), Math.floor(30 * BASE_WORDS_PER_SEC));
  });
});

describe("required tempo must be derived from the ORIGINAL audio", () => {
  // Regression: the first version of this fix computed the retry tempo from the
  // ALREADY-PACED duration while re-pacing from the original file. That
  // understates the multiplier, so the retry still overran — and the log said
  // the incoherent "needs 1.09x but max is 1.3x".
  const CLIP = 19.2;          // available = 18.7s
  const ORIGINAL = 24.0;      // raw TTS
  const PACED = ORIGINAL / TEMPO_DEFAULT; // ~20.3s after the standard 1.18x

  test("deriving from the paced duration understates what is needed", () => {
    const fromPaced = requiredTempoToFit(PACED, CLIP);
    // Applying that to the ORIGINAL still overruns — the bug.
    assert.equal(fitsInClip(ORIGINAL / fromPaced, CLIP), false);
  });

  test("deriving from the original duration actually fits", () => {
    const fromOriginal = requiredTempoToFit(ORIGINAL, CLIP);
    assert.ok(fitsInClip(ORIGINAL / fromOriginal, CLIP));
  });

  test("and that multiplier is reported honestly against the max", () => {
    // 24 / 18.7 = 1.283 -> achievable, so this case must be RESCUED, not reported
    // as untruncatable.
    const needed = requiredTempoToFit(ORIGINAL, CLIP);
    assert.ok(needed > TEMPO_DEFAULT, "should need more than the default");
    assert.ok(needed <= TEMPO_MAX, "should still be achievable");
  });
});
