/**
 * The recording kit.
 *
 * The failure this guards against is subtle: a kit that is technically correct
 * but that Peter cannot work from. Takes ordered for the timeline instead of
 * for the camera setup, takes too long to read off a phone, or a kit that
 * silently asks him to record voiceover he was never meant to record.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildKit, renderKitText, kitPayload, estimateSeconds, recordingsFolderPath, takesToRecord } from "../src/yt-recording-kit.js";
import { ON_CAMERA, VOICEOVER } from "../src/yt-script.js";

function takeText(words) {
  const pool = "here is the honest version of what that actually costs you every single month".split(" ");
  return Array.from({ length: words }, (_, i) => pool[i % pool.length]).join(" ");
}

const SCRIPT = {
  title: "Moving to San Antonio: what it actually costs",
  hook: "hook line",
  promise: "promise line",
  sections: [
    {
      title: "The payment gap",
      boundaryPull: "pull",
      takes: [
        { id: "s1t1", mode: ON_CAMERA, text: takeText(40), direction: "energy up, this is the hook" },
        { id: "s1t2", mode: VOICEOVER, text: takeText(50), direction: "plays over drone footage" },
      ],
    },
    {
      title: "Neighbourhoods",
      boundaryPull: "pull",
      takes: [
        { id: "s2t1", mode: VOICEOVER, text: takeText(60), direction: "over the walkthrough" },
        { id: "s2t2", mode: ON_CAMERA, text: takeText(30), direction: "walking shot if you can" },
      ],
    },
  ],
  softCta: { mode: ON_CAMERA, text: takeText(25), direction: "relaxed" },
  close: { mode: ON_CAMERA, text: takeText(45), direction: "look right at the lens" },
};

describe("buildKit", () => {
  test("defaults to on-camera takes only — ElevenLabs handles the rest", () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1", narrationMode: "elevenlabs" });
    assert.equal(kit.stats.onCameraCount, 4);
    assert.equal(kit.stats.voiceoverCount, 0);
    assert.ok(kit.takes.every((t) => t.mode === ON_CAMERA));
  });

  test('in "peter" mode the voiceover takes become his too', () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1", narrationMode: "peter" });
    assert.equal(kit.stats.onCameraCount, 4);
    assert.equal(kit.stats.voiceoverCount, 2);
    assert.equal(kit.stats.takeCount, 6);
  });

  test("groups by camera setup, not by timeline order", () => {
    // s2t2 is on camera and comes after two voiceover takes in the script.
    // The kit must still shoot it in the on-camera block: one setup, one light.
    const kit = buildKit(SCRIPT, { requestId: "req-1", narrationMode: "peter" });
    const modes = kit.takes.map((t) => t.mode);
    const firstVoiceover = modes.indexOf(VOICEOVER);
    assert.ok(modes.slice(0, firstVoiceover).every((m) => m === ON_CAMERA));
    assert.ok(modes.slice(firstVoiceover).every((m) => m === VOICEOVER));
  });

  test("numbers takes continuously across the blocks", () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1", narrationMode: "peter" });
    assert.deepEqual(kit.takes.map((t) => t.number), [1, 2, 3, 4, 5, 6]);
  });

  test("keeps the takeId, which is what the ingest matches on", () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1" });
    assert.ok(kit.takes.every((t) => typeof t.takeId === "string" && t.takeId));
    assert.ok(kit.takes.some((t) => t.takeId === "close"));
  });

  test("every take carries its direction through", () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1" });
    assert.ok(kit.takes.every((t) => t.direction));
    assert.ok(kit.takes.some((t) => t.direction.includes("walking shot")));
  });

  test("folder is scoped per request so two videos cannot mix", () => {
    assert.equal(buildKit(SCRIPT, { requestId: "req-abc" }).folderPath, recordingsFolderPath("req-abc"));
    assert.notEqual(recordingsFolderPath("a"), recordingsFolderPath("b"));
  });

  test("estimates a session length rather than just reading time", () => {
    const kit = buildKit(SCRIPT, { requestId: "req-1" });
    assert.ok(kit.stats.estimatedSessionMinutes >= 1);
    assert.ok(
      kit.stats.estimatedSessionMinutes * 60 > kit.stats.estimatedRecordingSeconds,
      "a session takes longer than the sum of the takes — resets, retakes, walking"
    );
  });

  test("accepts a generateScript result as well as a bare script", () => {
    const kit = buildKit({ script: SCRIPT, scores: {} }, { requestId: "req-1" });
    assert.equal(kit.title, SCRIPT.title);
  });

  test("refuses to build without a requestId — the folder would be ambiguous", () => {
    assert.throws(() => buildKit(SCRIPT, {}));
  });

  test("refuses a script with no title", () => {
    assert.throws(() => buildKit({ sections: [] }, { requestId: "r" }));
  });
});

describe("estimateSeconds", () => {
  test("a 40-word take lands inside the 10-30s window", () => {
    const s = estimateSeconds(takeText(40));
    assert.ok(s >= 10 && s <= 30, `estimated ${s}s`);
  });

  test("empty text is zero, not NaN", () => {
    assert.equal(estimateSeconds(""), 0);
    assert.equal(estimateSeconds(null), 0);
  });
});

describe("renderKitText — read on a phone, in a driveway", () => {
  const kit = buildKit(SCRIPT, { requestId: "req-xyz", narrationMode: "peter" });
  const text = renderKitText(kit);

  test("leads with what it is and what it will cost him", () => {
    assert.ok(text.startsWith("RECORDING KIT"));
    assert.ok(text.includes("minutes of your time"));
  });

  test("says he can shoot in any order and re-record freely", () => {
    assert.ok(text.includes("any order"));
    assert.ok(text.includes("last version of a take is the one that gets used"));
  });

  test("every take appears with its number, id, direction and words", () => {
    for (const take of kit.takes) {
      assert.ok(text.includes(`TAKE ${take.number} (${take.takeId})`), `missing take ${take.number}`);
      assert.ok(text.includes(take.direction), `missing direction for ${take.takeId}`);
    }
  });

  test("separates the on-camera block from the voiceover block", () => {
    assert.ok(text.includes("ON CAMERA —"));
    assert.ok(text.includes("VOICEOVER —"));
    assert.ok(text.indexOf("ON CAMERA —") < text.indexOf("VOICEOVER —"));
  });

  test("ends with the upload destination", () => {
    assert.ok(text.trimEnd().includes(kit.folderPath));
  });

  test("tells him what happens if something is missing", () => {
    assert.ok(text.includes("reported back to you rather than guessed"));
  });
});

describe("kitPayload", () => {
  test("carries everything the dashboard needs to render a checklist", () => {
    const payload = kitPayload(buildKit(SCRIPT, { requestId: "req-1" }));
    assert.equal(payload.requestId, "req-1");
    assert.ok(payload.takes.length > 0);
    assert.ok(payload.instructions.includes("Read one take"));
    assert.ok(payload.folderPath);
    assert.ok(payload.stats.takeCount > 0);
  });
});

describe("takesToRecord — the kit and the ingest must agree", () => {
  test("default mode asks for the on-camera takes only", () => {
    const takes = takesToRecord(SCRIPT, "elevenlabs");
    assert.ok(takes.every((t) => t.mode === ON_CAMERA));
    assert.equal(takes.length, 4);
  });

  test('"peter" mode asks for the voiceover takes too', () => {
    assert.equal(takesToRecord(SCRIPT, "peter").length, 6);
  });

  test("THE BUG THE DRY RUN CAUGHT: this is exactly what the kit lists", () => {
    // When these two disagreed, the ingest expected the voiceover takes, found
    // them missing on every run, and the build never proceeded past "incomplete".
    for (const mode of ["elevenlabs", "peter"]) {
      const kitIds = buildKit(SCRIPT, { requestId: "r", narrationMode: mode }).takes.map((t) => t.takeId).sort();
      const ingestIds = takesToRecord(SCRIPT, mode).map((t) => t.id).sort();
      assert.deepEqual(ingestIds, kitIds, `kit and ingest disagree in "${mode}" mode`);
    }
  });
});
