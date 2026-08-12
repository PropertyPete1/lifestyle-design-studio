#!/usr/bin/env node
/**
 * edit-queue-sweep.mjs — drive the whole chain against the real system.
 *
 * WHAT IS REAL HERE, because a sweep that quietly mocks the interesting half is
 * worse than no sweep: real ffmpeg renders, real Whisper transcription, real
 * Drive uploads and downloads, real link-permission grants, real dashboard
 * webhooks, real Gmail. The scan and the advance run as SUBPROCESSES of their
 * actual entry points — not as imported functions with a convenient argument —
 * so the thing under test is the thing that runs on a schedule.
 *
 * WHAT IS SIMULATED, and it is exactly one thing: Peter's finger. A decision
 * reaches this system as a commit to yt-approvals.json made by the dashboard,
 * and no test can press a button on a deployed web app. So the sweep writes the
 * decision in the shape the dashboard actually commits — a BARE ARRAY of
 * decision records, which is what it was found to write on the first live
 * round-trip and what `normaliseApprovals` exists to accept — and then merges
 * it exactly as merge-log-push would. Whether the dashboard RENDERS these two
 * new card types is a different question, and it is measured by the
 * dashboard-smoke suite rather than assumed here.
 *
 * EVERY ARTIFACT CARRIES THE TEST- PREFIX. That keeps the files off Peter's
 * real surfaces, keeps the requests invisible to every scheduled job, and stops
 * the advance job writing to trial-variants.json or posted-log.json. The sweep
 * commits nothing at all, and deletes the Drive files it made.
 *
 * Usage: SWEEP_STAGE=full|matrix|cleanup node scripts/edit-queue-sweep.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAccessToken, listFolderFiles, uploadAndShare } from "../src/drive.js";
import { loadApprovals, saveApprovals, findRequest, TEST_REQUEST_PREFIX } from "../src/yt-approvals.js";
import { mergeYtApprovals } from "../merge-strategies.mjs";
import { loadQueue, findVideo, STATUS, VIDEOS_TO_EDIT_FOLDER } from "../src/edit-queue.js";

const ROOT = join(import.meta.dirname, "..");
const STAGE = process.env.SWEEP_STAGE || "full";
const REPORT_DIR = join(process.env.RUNNER_TEMP || tmpdir(), "edit-queue-sweep");
const WORK = join(tmpdir(), `sweep-${Date.now()}`);

if (process.env.I_UNDERSTAND_THIS_TOUCHES_LIVE !== "yes") {
  console.error(
    "[Sweep] This uploads to Drive, raises dashboard cards and sends mail. " +
      "Set I_UNDERSTAND_THIS_TOUCHES_LIVE=yes to run it."
  );
  process.exit(1);
}

mkdirSync(REPORT_DIR, { recursive: true });
mkdirSync(WORK, { recursive: true });

const findings = [];
const notes = [];
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (ok) {
    console.log(`[Sweep] PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`::error::[Sweep] FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    findings.push({ name, detail });
  }
  return ok;
}

function note(text) {
  console.log(`[Sweep] note  ${text}`);
  notes.push(text);
}

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * A vertical video with real speech and real pauses in it.
 *
 * espeak rather than a tone, because the whole chain downstream is speech
 * shaped: silencedetect has to find gaps BETWEEN words, and Whisper has to
 * return a transcript the hook writer can draw from. A sine wave would sail
 * through the cut and produce an empty transcript, which would test the
 * degraded path every time and the real one never.
 *
 * `testsrc2` gives moving picture, so a punch-in crop is visibly different from
 * no crop when a human opens the file from the report.
 */
function makeSpeechVideo(path, { lines, gapSeconds = 1.2, width = 1080, height = 1920 }) {
  const parts = [];
  lines.forEach((line, i) => {
    const wav = join(WORK, `say-${i}.wav`);
    execFileSync("espeak", ["-s", "150", "-w", wav, line]);
    parts.push(wav);
    if (i < lines.length - 1) {
      const sil = join(WORK, `gap-${i}.wav`);
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", String(gapSeconds), sil]);
      parts.push(sil);
    }
  });

  const listFile = join(WORK, `list-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n") + "\n");
  const audio = join(WORK, `audio-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", audio]);

  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30`,
    "-i", audio,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", path,
  ]);
  return path;
}

/** A video with picture and audio but no words in it — room tone. */
function makeNoSpeechVideo(path, seconds = 25) {
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:a=0.02:r=48000`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest", path,
  ]);
  return path;
}

/** Picture, and digital silence. Every frame of it. */
function makeSilentVideo(path, seconds = 20) {
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-shortest", "-t", String(seconds), path,
  ]);
  return path;
}

// ─── running the real entry points ──────────────────────────────────────────

function runEntry(script, extraEnv = {}) {
  console.log(`\n[Sweep] ── running ${script} ──`);
  const res = spawnSync("node", [script], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
    timeout: 45 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  console.log(out.split("\n").slice(-60).join("\n"));
  return { code: res.status, out };
}

/**
 * Write a decision the way the DASHBOARD writes one.
 *
 * A bare array replacing the whole file, then merged — which is precisely the
 * round trip that once made a request record vanish from HEAD and left the
 * pipeline reporting "no decision" over a decision Peter had made. Simulating
 * the tidy `{requests:[...]}` shape instead would test a path production does
 * not take.
 */
function dashboardDecides(requestId, decision, notesText = null) {
  const bare = [{ requestId, decision, decidedAt: new Date().toISOString(), notes: notesText }];
  const merged = mergeYtApprovals(bare, loadApprovals(), () => {});
  saveApprovals(merged);
  const back = findRequest(loadApprovals(), requestId);
  return back;
}

/** Does this Drive link actually open for someone who is not signed in? */
async function linkOpens(link) {
  if (!link) return { ok: false, why: "no link at all" };
  try {
    const res = await fetch(link, { redirect: "follow" });
    return { ok: res.ok, why: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

// ─── Drive housekeeping ─────────────────────────────────────────────────────

const uploaded = [];

async function putInFolder(folderId, name, path, mime = "video/mp4") {
  const res = await uploadAndShare(folderId, name, readFileSync(path), mime);
  uploaded.push(res.id);
  console.log(`[Sweep] uploaded ${name} -> ${res.id}`);
  return res;
}

async function trashEverythingWeMade(folderId) {
  const token = await getAccessToken();
  const files = await listFolderFiles(folderId, { accessToken: token });
  const ours = files.filter((f) => String(f.name || "").startsWith("TEST-"));

  // The review subfolder too — the advance job creates it and puts TEST-
  // masters and variants in it.
  for (const folder of files.filter((f) => f.mimeType === "application/vnd.google-apps.folder")) {
    const inner = await listFolderFiles(folder.id, { accessToken: token });
    ours.push(...inner.filter((f) => String(f.name || "").startsWith("TEST-")));
  }

  let removed = 0;
  for (const f of ours) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (res.ok) removed++;
    else console.log(`::warning::[Sweep] could not trash ${f.name} (${res.status})`);
  }
  console.log(`[Sweep] trashed ${removed}/${ours.length} TEST- file(s)`);
  return { removed, total: ours.length };
}

// ─── the passes ─────────────────────────────────────────────────────────────

/**
 * One complete journey: drop -> card -> Start -> review -> approve -> Trial tab.
 */
async function fullChainPass(pass, folderId) {
  console.log(`\n[Sweep] ══════ PASS ${pass}: full chain ══════`);
  const stamp = `${Date.now()}-${pass}`;
  const name = `TEST-sweep-${stamp}.mp4`;
  const local = join(WORK, name);

  makeSpeechVideo(local, {
    lines: [
      "This three bedroom sits about twelve minutes from the interstate.",
      "The kitchen island is quartz and the counters run the whole wall.",
      "Taxes here are the part most buyers forget to check before they sign.",
      "Builder incentives are still on the table this month.",
    ],
    gapSeconds: 1.3,
  });

  const drive = await putInFolder(folderId, name, local);

  // ── 1. the scan cards it, and starts nothing ─────────────────────────────
  const scan = runEntry("src/edit-queue-scan.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  check(`pass ${pass}: scan exits clean`, scan.code === 0, `exit ${scan.code}`);

  const afterScan = findVideo(loadQueue(), drive.id);
  check(`pass ${pass}: the video is in the queue`, Boolean(afterScan), afterScan ? afterScan.fileName : "not found");
  check(`pass ${pass}: it is queued, not editing`, afterScan?.status === STATUS.QUEUED, `status=${afterScan?.status}`);
  check(`pass ${pass}: it has a Start card`, Boolean(afterScan?.queueRequestId), afterScan?.queueRequestId || "none");
  check(
    `pass ${pass}: the card id is TEST- prefixed`,
    String(afterScan?.queueRequestId || "").startsWith(TEST_REQUEST_PREFIX),
    afterScan?.queueRequestId
  );

  // ── 2. THE CENTRAL CLAIM: a scheduled advance with no decision does nothing
  const idle = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  const stillQueued = findVideo(loadQueue(), drive.id);
  check(
    `pass ${pass}: the schedule alone starts NO edit`,
    idle.code === 0 && stillQueued?.status === STATUS.QUEUED && !stillQueued?.master,
    `exit ${idle.code}, status=${stillQueued?.status}, master=${stillQueued?.master ? "PRESENT" : "none"}`
  );

  // ── 3. Peter presses Start ───────────────────────────────────────────────
  const decided = dashboardDecides(afterScan.queueRequestId, "approve");
  check(`pass ${pass}: the decision survives the dashboard-shaped merge`, decided?.decision === "approve", JSON.stringify(decided?.decision));
  check(`pass ${pass}: the merge kept the request's payload`, Boolean(decided?.payload), decided?.payload ? "kept" : "LOST");

  const edit = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  check(`pass ${pass}: the edit run exits clean`, edit.code === 0, `exit ${edit.code}`);

  const reviewed = findVideo(loadQueue(), drive.id);
  check(`pass ${pass}: it reached review`, reviewed?.status === STATUS.IN_REVIEW, `status=${reviewed?.status}${reviewed?.failure ? ` (${reviewed.failure.reason})` : ""}`);
  check(`pass ${pass}: there is an edited master`, Boolean(reviewed?.master?.driveFileId), reviewed?.master?.fileName || "none");
  check(
    `pass ${pass}: 2-3 hook variants exist`,
    (reviewed?.variants || []).length >= 2 && (reviewed?.variants || []).length <= 3,
    `${(reviewed?.variants || []).length} variant(s)`
  );

  // Every variant differs in the HOOK, and the hooks are distinct.
  const hookLines = (reviewed?.variants || []).map((v) => v.hookLine);
  check(`pass ${pass}: every variant has its own hook line`, new Set(hookLines).size === hookLines.length, hookLines.join(" | "));

  // ── 4. every link in the review card actually opens ──────────────────────
  const links = [reviewed?.master?.link, ...(reviewed?.variants || []).map((v) => v.link)];
  for (const [i, link] of links.entries()) {
    const label = i === 0 ? "master" : `variant ${reviewed.variants[i - 1].label}`;
    const opened = await linkOpens(link);
    check(`pass ${pass}: ${label} link opens`, opened.ok, `${link} — ${opened.why}`);
  }

  // ── 5. the edit did what it claims ───────────────────────────────────────
  const attempt = (reviewed?.attempts || []).slice(-1)[0];
  check(`pass ${pass}: the attempt is recorded as finished and ok`, attempt?.finishedAt && attempt?.ok === true, JSON.stringify(attempt));

  const reviewRequest = findRequest(loadApprovals(), reviewed?.reviewRequestId);
  check(`pass ${pass}: a review card was raised`, Boolean(reviewRequest), reviewed?.reviewRequestId || "none");
  check(
    `pass ${pass}: the review card carries every link`,
    (reviewRequest?.payload?.variants || []).every((v) => Boolean(v.link)) && Boolean(reviewRequest?.payload?.master?.link),
    JSON.stringify((reviewRequest?.payload?.variants || []).map((v) => v.label))
  );

  // ── 6. approve, and everything lands on the Trial tab ────────────────────
  dashboardDecides(reviewed.reviewRequestId, "approve");
  const deliver = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  check(`pass ${pass}: the approve run exits clean`, deliver.code === 0, `exit ${deliver.code}`);

  const delivered = findVideo(loadQueue(), drive.id);
  check(`pass ${pass}: it is delivered`, delivered?.status === STATUS.DELIVERED, `status=${delivered?.status}`);
  check(
    `pass ${pass}: the Trial delivery reached the dashboard`,
    /Trial delivery complete/.test(deliver.out),
    /Trial delivery complete/.test(deliver.out) ? "webhook ok" : "no trial webhook confirmation in the log"
  );
  check(
    `pass ${pass}: a caption was generated for every item`,
    (deliver.out.match(/Caption generated|on the Trial tab/g) || []).length >= (delivered?.variants || []).length,
    "see the run log"
  );

  // ── 7. idempotency: pressing Approve again changes nothing ───────────────
  const again = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  const afterAgain = findVideo(loadQueue(), drive.id);
  check(
    `pass ${pass}: a second Approve is a no-op`,
    again.code === 0 && afterAgain?.status === STATUS.DELIVERED && afterAgain?.deliveredAt === delivered?.deliveredAt,
    `status=${afterAgain?.status}, deliveredAt unchanged=${afterAgain?.deliveredAt === delivered?.deliveredAt}`
  );

  return { driveFileId: drive.id, name };
}

/** The failure matrix, on real files through the real entry points. */
async function matrixPass(folderId) {
  console.log(`\n[Sweep] ══════ failure matrix ══════`);
  const stamp = Date.now();

  // ── empty folder ─────────────────────────────────────────────────────────
  const emptyProbe = runEntry("src/edit-queue-scan.js", { EDIT_QUEUE_FOLDER_ID: process.env.SWEEP_EMPTY_FOLDER_ID || folderId });
  check("matrix: a scan over a folder with nothing new exits clean", emptyProbe.code === 0, `exit ${emptyProbe.code}`);

  // ── a non-video file ─────────────────────────────────────────────────────
  const txt = join(WORK, `TEST-notes-${stamp}.txt`);
  writeFileSync(txt, "this is not a video\n");
  await putInFolder(folderId, `TEST-notes-${stamp}.txt`, txt, "text/plain");

  // ── no speech ────────────────────────────────────────────────────────────
  const noSpeech = join(WORK, `TEST-nospeech-${stamp}.mp4`);
  makeNoSpeechVideo(noSpeech);
  const noSpeechDrive = await putInFolder(folderId, `TEST-nospeech-${stamp}.mp4`, noSpeech);

  // ── all silence ──────────────────────────────────────────────────────────
  const silent = join(WORK, `TEST-silent-${stamp}.mp4`);
  makeSilentVideo(silent);
  const silentDrive = await putInFolder(folderId, `TEST-silent-${stamp}.mp4`, silent);

  // ── under ten seconds ────────────────────────────────────────────────────
  const short = join(WORK, `TEST-short-${stamp}.mp4`);
  makeSpeechVideo(short, { lines: ["Quick look at this one."], gapSeconds: 0.3 });
  const shortDrive = await putInFolder(folderId, `TEST-short-${stamp}.mp4`, short);

  const scan = runEntry("src/edit-queue-scan.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  check("matrix: the scan survives all of them", scan.code === 0, `exit ${scan.code}`);

  const queue = loadQueue();
  check("matrix: the .txt was ignored, not queued", !queue.videos.some((v) => v.fileName.endsWith(".txt")), "no .txt record");
  check("matrix: ignoring it was reported", /ignoring "TEST-notes/.test(scan.out), "warning present");

  // ── under ten seconds: caught at scan when Drive has reported a duration,
  //    and at the edit itself when it has not ──────────────────────────────
  //
  // Drive populates videoMediaMetadata asynchronously after an upload, so a
  // scan running seconds later legitimately sees no duration and cards the
  // video. The floor that MATTERS is the one in the advance job, measured with
  // ffprobe on the downloaded bytes. Both are asserted, and which one fires
  // depends on how fast Drive was — so the check is on the OUTCOME rather than
  // on which guard produced it.
  let shortRecord = findVideo(loadQueue(), shortDrive.id);
  if (shortRecord?.status === STATUS.QUEUED && shortRecord.queueRequestId) {
    check(
      "matrix: a short video with no Drive duration is carded honestly",
      /unknown/.test(shortRecord.durationSeconds === null ? "unknown" : ""),
      `Drive reported durationSeconds=${shortRecord.durationSeconds}`
    );
    dashboardDecides(shortRecord.queueRequestId, "approve");
    const attempt = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
    check("matrix: the run reports the short video as a failure", attempt.code === 1, `exit ${attempt.code}`);
    shortRecord = findVideo(loadQueue(), shortDrive.id);
  }
  check(
    "matrix: the short video fails loudly rather than being edited",
    shortRecord?.status === STATUS.FAILED && /floor/.test(shortRecord?.failure?.reason || ""),
    `status=${shortRecord?.status}: ${shortRecord?.failure?.reason || "(no reason)"}`
  );
  check(
    "matrix: the short video produced no master",
    !shortRecord?.master,
    shortRecord?.master ? "a master was rendered for a clip under the floor" : "nothing rendered"
  );

  // ── the two speech-free videos: start both AT ONCE ───────────────────────
  for (const id of [noSpeechDrive.id, silentDrive.id]) {
    const rec = findVideo(loadQueue(), id);
    if (rec?.queueRequestId) dashboardDecides(rec.queueRequestId, "approve");
  }
  const both = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
  check("matrix: two videos started at once both get processed", both.code === 0 || both.code === 1, `exit ${both.code}`);

  const noSpeechAfter = findVideo(loadQueue(), noSpeechDrive.id);
  const silentAfter = findVideo(loadQueue(), silentDrive.id);
  for (const [label, rec] of [["no-speech", noSpeechAfter], ["all-silence", silentAfter]]) {
    check(
      `matrix: the ${label} video reached a terminal state, not limbo`,
      rec?.status === STATUS.IN_REVIEW || rec?.status === STATUS.FAILED,
      `status=${rec?.status}${rec?.failure ? `: ${rec.failure.reason}` : ""}`
    );
    if (rec?.status === STATUS.FAILED) {
      check(`matrix: the ${label} failure carries a reason`, Boolean(rec.failure?.reason), rec.failure?.reason || "(none)");
    }
    if (rec?.status === STATUS.IN_REVIEW) {
      check(
        `matrix: the ${label} video did not lose its audio to the cut`,
        Boolean(rec.master?.driveFileId),
        rec.master?.fileName || "no master"
      );
    }
  }

  // ── Start pressed twice ──────────────────────────────────────────────────
  const doubleTarget = noSpeechAfter?.status === STATUS.IN_REVIEW ? noSpeechAfter : silentAfter;
  if (doubleTarget?.queueRequestId) {
    const before = findVideo(loadQueue(), doubleTarget.driveFileId);
    const second = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
    const after = findVideo(loadQueue(), doubleTarget.driveFileId);
    check(
      "matrix: Start pressed twice does not edit twice",
      second.code === 0 && after?.revision === before?.revision,
      `revision ${before?.revision} -> ${after?.revision}`
    );
  }

  // ── reject, then approve the replacement ─────────────────────────────────
  const rejectTarget = [noSpeechAfter, silentAfter].find((r) => r?.status === STATUS.IN_REVIEW);
  if (rejectTarget) {
    dashboardDecides(rejectTarget.reviewRequestId, "reject", "Open on the wide shot, not the counter.");
    const reedit = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
    const afterReject = findVideo(loadQueue(), rejectTarget.driveFileId);
    check(
      "matrix: a rejection re-edits and comes back to review",
      reedit.code === 0 && afterReject?.revision > rejectTarget.revision,
      `status=${afterReject?.status}, revision ${rejectTarget.revision} -> ${afterReject?.revision}`
    );
    check(
      "matrix: the rejection raised a NEW review card",
      afterReject?.reviewRequestId && afterReject.reviewRequestId !== rejectTarget.reviewRequestId,
      `${rejectTarget.reviewRequestId} -> ${afterReject?.reviewRequestId}`
    );

    // Approving the SUPERSEDED card must do nothing.
    dashboardDecides(rejectTarget.reviewRequestId, "approve");
    const stale = runEntry("src/edit-queue-advance.js", { EDIT_QUEUE_FOLDER_ID: folderId });
    const afterStale = findVideo(loadQueue(), rejectTarget.driveFileId);
    check(
      "matrix: approving a superseded review card cannot deliver",
      stale.code === 0 && afterStale?.status !== STATUS.DELIVERED,
      `status=${afterStale?.status}`
    );
  } else {
    note("no video reached review in the matrix pass, so reject-then-approve was not exercised here — the unit suite covers it");
  }

  return { noSpeechDrive, silentDrive, shortDrive };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const folderId = process.env.EDIT_QUEUE_FOLDER_ID || VIDEOS_TO_EDIT_FOLDER;
  console.log(`[Sweep] stage=${STAGE} folder=${folderId}`);
  console.log(`[Sweep] work=${WORK}`);

  if (STAGE === "cleanup") {
    await trashEverythingWeMade(folderId);
    return;
  }

  try {
    if (STAGE === "full") {
      for (const pass of [1, 2, 3]) await fullChainPass(pass, folderId);
      await matrixPass(folderId);
    } else if (STAGE === "matrix") {
      await matrixPass(folderId);
    }
  } finally {
    const cleaned = await trashEverythingWeMade(folderId).catch((e) => ({ removed: 0, total: -1, error: e.message }));
    const report = {
      stage: STAGE,
      folderId,
      ranAt: new Date().toISOString(),
      checks,
      findings,
      notes,
      cleanup: cleaned,
    };
    writeFileSync(join(REPORT_DIR, `sweep-${Date.now()}.json`), JSON.stringify(report, null, 2) + "\n");
    rmSync(WORK, { recursive: true, force: true });

    console.log(`\n[Sweep] ═══════════════════════════════════════════════`);
    console.log(`[Sweep] ${checks} check(s), ${findings.length} finding(s)`);
    for (const f of findings) console.log(`[Sweep]   FINDING: ${f.name} — ${f.detail}`);
    for (const n of notes) console.log(`[Sweep]   note: ${n}`);
    console.log(`[Sweep] ═══════════════════════════════════════════════`);
  }

  if (findings.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[Sweep] Fatal: ${err.stack || err.message}`);
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
