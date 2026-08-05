/**
 * yt-ingest.js — pull Peter's recordings out of Drive and work out what he shot.
 *
 * The Friday build job's first question is "did he record yet?", and it has to
 * be able to answer "not yet" cleanly. An empty folder, a missing folder, and a
 * folder with three of eight takes in it are all NORMAL states that mean "come
 * back next run", not errors.
 *
 * Everything decision-shaped lives in yt-take-match.js, which is pure and
 * tested offline. This module is the glue that gets bytes and transcripts to
 * it, and it deliberately holds no matching logic of its own.
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { getAccessToken } from "./drive.js";
import { matchTakesToClips } from "./yt-take-match.js";
import { RECORDINGS_ROOT } from "./yt-config.js";

const TRANSCRIBE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "transcribe-take.py");

/** Clips longer than this are not takes — a 10-30s take never runs 10 minutes. */
const MAX_CLIP_SECONDS = 600;

async function driveFetch(url, accessToken, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
    throw new Error(`Drive ${res.status}: ${err}`);
  }
  return res;
}

/** Find one folder by name under a parent. Returns null when absent. */
async function findFolder(accessToken, name, parentId = "root") {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `'${parentId}' in parents`,
  ].join(" and ");
  const params = new URLSearchParams({ q, fields: "files(id,name)", spaces: "drive" });
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken);
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(accessToken, name, parentId = "root") {
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const folder = await res.json();
  return folder.id;
}

/**
 * The folder for one request, created if missing.
 *
 * Called when the kit goes out, so Peter has somewhere to upload before he has
 * recorded anything. Creating it later, on first read, would mean the kit email
 * points at a folder that does not exist yet.
 */
export async function ensureRecordingsFolder(requestId, accessToken = null) {
  const token = accessToken || (await getAccessToken());
  let rootId = await findFolder(token, RECORDINGS_ROOT);
  if (!rootId) {
    rootId = await createFolder(token, RECORDINGS_ROOT);
    console.log(`[Ingest] created "${RECORDINGS_ROOT}" folder`);
  }
  let requestFolderId = await findFolder(token, requestId, rootId);
  if (!requestFolderId) {
    requestFolderId = await createFolder(token, requestId, rootId);
    console.log(`[Ingest] created "${RECORDINGS_ROOT}/${requestId}" folder`);
  }
  return requestFolderId;
}

/** The folder for one request, WITHOUT creating anything. Null when absent. */
export async function findRecordingsFolder(requestId, accessToken = null) {
  const token = accessToken || (await getAccessToken());
  const rootId = await findFolder(token, RECORDINGS_ROOT);
  if (!rootId) return null;
  return findFolder(token, requestId, rootId);
}

/** Every video/audio file Peter has put in the folder, newest last. */
export async function listRecordings(folderId, accessToken = null) {
  const token = accessToken || (await getAccessToken());
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')`,
      fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,videoMediaMetadata)",
      pageSize: "200",
      orderBy: "createdTime",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, token);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadTo(fileId, destPath, accessToken) {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    accessToken
  );
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * Transcribe one file. Returns null when Whisper cannot make sense of it.
 *
 * A null here is not fatal — the clip simply becomes a stray, gets reported,
 * and Peter can look at it. Throwing would take down a build over one corrupt
 * upload.
 */
export function transcribeFile(path, { model = process.env.YT_WHISPER_MODEL || "base" } = {}) {
  try {
    const out = execFileSync("python3", [TRANSCRIBE_SCRIPT, path, model], {
      encoding: "utf-8",
      timeout: 15 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out.trim().split("\n").pop());
    if (!parsed.ok) {
      console.warn(`[Ingest] transcription failed for ${path}: ${parsed.error}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[Ingest] transcription error for ${path}: ${String(err.message).slice(0, 200)}`);
    return null;
  }
}

/**
 * The whole ingest: find the folder, transcribe what is in it, match it to the
 * script's takes.
 *
 * Returns a `state` the caller can branch on without interpreting anything:
 *
 *   "no-folder"  the kit has not gone out, or Peter deleted the folder
 *   "empty"      folder exists, nothing uploaded — the normal "not yet" case
 *   "matched"    everything the script needs is present
 *   "incomplete" some takes are recorded, some are not
 *
 * The last two both carry the full match result, so the caller can report gaps
 * without re-deriving them.
 */
export async function ingestRecordings({ requestId, takes, accessToken = null, workDir = null } = {}) {
  if (!requestId) throw new Error("ingestRecordings requires a requestId");
  const token = accessToken || (await getAccessToken());

  const folderId = await findRecordingsFolder(requestId, token);
  if (!folderId) {
    console.log(`[Ingest] no folder for ${requestId} yet`);
    return { state: "no-folder", requestId, clips: [], result: null };
  }

  const files = await listRecordings(folderId, token);
  if (files.length === 0) {
    console.log(`[Ingest] folder for ${requestId} is empty — nothing recorded yet`);
    return { state: "empty", requestId, folderId, clips: [], result: null };
  }

  console.log(`[Ingest] ${files.length} clip(s) in ${RECORDINGS_ROOT}/${requestId}`);

  const dir = workDir || join(tmpdir(), `yt-ingest-${requestId}`);
  mkdirSync(dir, { recursive: true });

  const clips = [];
  try {
    for (const file of files) {
      const durationSec = Number(file.videoMediaMetadata?.durationMillis || 0) / 1000;
      if (durationSec > MAX_CLIP_SECONDS) {
        console.warn(`[Ingest] skipping ${file.name} — ${Math.round(durationSec)}s is far longer than a take`);
        continue;
      }
      const localPath = join(dir, `${file.id}-${file.name.replace(/[^\w.-]/g, "_")}`);
      try {
        const bytes = await downloadTo(file.id, localPath, token);
        console.log(`[Ingest] ${file.name} (${(bytes / 1024 / 1024).toFixed(1)} MB) — transcribing...`);
      } catch (err) {
        console.warn(`[Ingest] could not download ${file.name}: ${err.message}`);
        continue;
      }
      const transcript = transcribeFile(localPath);
      rmSync(localPath, { force: true });
      if (!transcript) continue;
      clips.push({
        id: file.id,
        name: file.name,
        transcript: transcript.transcript,
        recordedAt: file.createdTime || file.modifiedTime || null,
        durationSeconds: transcript.duration,
      });
    }
  } finally {
    if (!workDir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  const result = matchTakesToClips(takes, clips);
  console.log(
    `[Ingest] ${result.matches.length}/${(takes || []).length} takes matched, ` +
    `${result.missingTakes.length} missing, ${result.strayClips.length} unused clip(s)`
  );

  return {
    state: result.complete ? "matched" : "incomplete",
    requestId,
    folderId,
    clips,
    result,
  };
}
