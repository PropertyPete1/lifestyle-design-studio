/**
 * yt-watch-report.test.mjs — the watcher must catch a planted mismatch, pass a
 * known-good scene, and never be able to hurt a build.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWatchReport, sceneTimeline } from "../src/yt-watch-report.js";
import { renderReviewText } from "../src/yt-publish.js";

const have = (bin) => {
  const res = spawnSync(bin, ["-version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
};
const HAVE_FFMPEG = have("ffmpeg");
const ff = (args) => execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

describe("sceneTimeline", () => {
  test("absolute times accumulate across mixed segments, words follow the window", () => {
    const plan = {
      segments: [
        { kind: "on_camera", takeId: "oc", seconds: 10, text: "hello there" },
        {
          kind: "voiceover", takeId: "vo", seconds: 8,
          text: "one two three four five six seven eight",
          broll: [
            { kind: "stock", seconds: 4, query: "front yard" },
            { kind: "beat", seconds: 4 },
          ],
        },
      ],
    };
    const scenes = sceneTimeline(plan);
    assert.equal(scenes.length, 3);
    assert.deepEqual([scenes[0].at, scenes[1].at, scenes[2].at], [0, 10, 14]);
    assert.equal(scenes[1].kind, "stock");
    assert.equal(scenes[1].words, "one two three four", "the words are the window's own, not the whole take");
    assert.equal(scenes[2].words, "five six seven eight");
  });
});

describe("the watcher's verdicts", () => {
  test("flags the planted mismatch, passes the known-good scene, ranks worst first", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "watch-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const video = join(dir, "video.mp4");
    ff(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", video]);

    const plan = {
      segments: [{
        kind: "voiceover", takeId: "t1", seconds: 16,
        text: "a family relaxing in their front yard together happily " +
              "the military base front gate during the morning commute",
        broll: [
          { kind: "stock", seconds: 8, query: "family front yard" },
          { kind: "stock", seconds: 8, query: "baseball field" },
        ],
      }],
    };

    // The judge is scripted by the words in the prompt — this tests the
    // REPORT machinery (pairing, ranking, formatting), not the model.
    const client = {
      messages: {
        create: async ({ messages }) => {
          const text = messages[0].content.find((c) => c.type === "text").text;
          const wrong = /military base/.test(text);
          return { content: [{ type: "text", text: JSON.stringify(
            wrong ? { verdict: "wrong", see: "aerial baseball diamond" } : { verdict: "good", see: "family on a lawn" }
          ) }] };
        },
      },
    };

    const report = await buildWatchReport({
      plan, videoPath: video,
      ffmpeg: (args) => ff(args),
      client, workDir: dir,
    });

    assert.equal(report.judged, 2);
    assert.equal(report.matchRate, 50);
    assert.equal(report.flagged.length, 1, "exactly the planted mismatch is flagged");
    assert.equal(report.flagged[0].verdict, "wrong");
    assert.match(report.flagged[0].see, /baseball/);
    assert.match(report.text, /0:08.*WRONG.*baseball/s, "the card line carries timestamp, verdict, and what is seen");
    assert.doesNotMatch(report.text, /0:00.*WRONG/s, "the known-good scene is not flagged");
    assert.match(report.text, /Match rate: 1\/2/);
  });

  test("a dead judge, a missing video, or a broken plan can never throw", async () => {
    const throwingClient = { messages: { create: async () => { throw new Error("model down"); } } };
    const plan = { segments: [{ kind: "voiceover", takeId: "t", seconds: 4, text: "w x y z", broll: [{ kind: "stock", seconds: 4 }] }] };

    const dead = await buildWatchReport({ plan, videoPath: "/nope.mp4", ffmpeg: () => { throw new Error("no ffmpeg"); }, client: throwingClient, workDir: tmpdir() });
    assert.equal(dead.judged, 0);
    assert.match(dead.text, /no stock scenes were judged/);

    const broken = await buildWatchReport({ plan: null, videoPath: null, ffmpeg: null, client: null, workDir: null });
    assert.match(broken.text, /WATCH REPORT|no stock scenes/i, "even a null world produces a report string");
  });

  test("no client means a labelled skip, not silence", async () => {
    const plan = { segments: [{ kind: "voiceover", takeId: "t", seconds: 4, text: "w x y z", broll: [{ kind: "stock", seconds: 4 }] }] };
    const r = await buildWatchReport({ plan, videoPath: null, ffmpeg: null, client: null, workDir: tmpdir() });
    assert.match(r.text, /no vision client/);
  });

  test("the review card carries the report above the checklist", () => {
    const text = renderReviewText({
      packaging: { title: "T", description: "", pinnedComment: "pc", tags: [] },
      youtubeUrl: "https://x", driveLink: null,
      checklist: ["do a thing"], stats: {},
      watchReport: "WATCH REPORT (advisory)\nMatch rate: 9/10.",
    });
    const body = String(text);
    assert.ok(body.indexOf("WATCH REPORT") !== -1, "report present");
    assert.ok(body.indexOf("WATCH REPORT") < body.indexOf("BEFORE IT GOES PUBLIC"), "report sits above the checklist");
    // And without one, the card is unchanged.
    const plain = renderReviewText({ packaging: { title: "T", description: "", pinnedComment: "pc", tags: [] }, youtubeUrl: "https://x", driveLink: null, checklist: ["x"], stats: {} });
    assert.doesNotMatch(String(plain), /WATCH REPORT/);
  });
});
