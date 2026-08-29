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

/**
 * Clips longer than this are not takes — a 10-30s take never runs 10 minutes.
 *
 * Only fires when Drive filled in videoMediaMetadata, which it does not do for
 * a clip it has mistyped (see MEDIA_EXTENSIONS). Those get transcribed and then
 * fail to match, which is the slow path to the same answer, not a wrong one.
 */
const MAX_CLIP_SECONDS = 600;

/**
 * Extensions that mean "this is a take".
 *
 * The name decides, not Drive's mimeType. The dashboard has already uploaded a
 * valid mp4 typed as text/plain, and a mimeType filter drops that file without
 * a word — which reads downstream as "Peter has not recorded that take yet",
 * the one wrong answer this module exists to avoid. The extension is what Peter
 * controls and what survives a bad upload.
 */
const MEDIA_EXTENSIONS = new Set([
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "mpg", "mpeg", "3gp", "3g2", "wmv", "flv",
  "m4a", "mp3", "wav", "aac", "flac", "ogg", "oga", "opus", "caf", "aiff", "aif", "wma",
]);

/** The lowercased extension, or "" when the name carries none. */
function extensionOf(name) {
  const dot = (name || "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Drive's own answer, when we are willing to believe it. */
function isMediaType(mimeType) {
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

/**
 * Is this Drive file one of Peter's takes?
 *
 * Extension first, so a mistyped upload still counts. Drive's mimeType is the
 * fallback for the opposite case — a phone upload that arrived with the type
 * intact and no extension on the name.
 *
 * Google's own doc types are always out: alt=media cannot fetch bytes for them,
 * so admitting one buys a download failure later instead of a skip now.
 */
/**
 * Our own outputs are not Peter's recordings.
 *
 * The pipeline writes the cut teaser and the chosen thumbnail into the
 * request's Drive folder tree. When the teaser landed in the SAME folder the
 * takes live in, the next ingest transcribed it, heard the hook's words in
 * it, and — "the last recording of a take wins" — matched it as the newest
 * hook take: probe 32300759856's thumbnail frames came from the teaser,
 * letterboxed, with its burned captions in shot. A rebuild would have cut the
 * next teaser from the previous teaser the same way. Outputs now live in a
 * subfolder, and this predicate is the belt to that braces: anything carrying
 * an output prefix is skipped even when something puts it in the wrong place
 * — video 1's folder already has one.
 */
export function isPipelineOutput(name) {
  return /^(teaser|thumbnail)-/i.test(String(name || ""));
}

export function looksLikeRecording(file) {
  const mimeType = file?.mimeType || "";
  if (mimeType.startsWith("application/vnd.google-apps")) return false;
  if (MEDIA_EXTENSIONS.has(extensionOf(file?.name))) return true;
  return isMediaType(mimeType);
}

/**
 * The name says take, Drive says otherwise.
 *
 * We take the file anyway — that is the point of reading the name. But the
 * disagreement means whatever uploaded it set the type wrong, and absorbing
 * that quietly is how a broken uploader stays broken: the pipeline stops
 * noticing, so nobody fixes it, and the next symptom is one that tolerance
 * cannot paper over. Tolerant about the file, loud about the cause.
 */
export function isMistypedUpload(file) {
  if (!MEDIA_EXTENSIONS.has(extensionOf(file?.name))) return false;
  return !isMediaType(file?.mimeType || "");
}

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

/**
 * Every recording Peter has put in the folder, newest last.
 *
 * Drive is asked for everything in the folder and the filtering happens here,
 * because the query language can only filter on the mimeType we do not trust.
 */
export async function listRecordings(folderId, accessToken = null) {
  const token = accessToken || (await getAccessToken());
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,videoMediaMetadata)",
      pageSize: "200",
      orderBy: "createdTime",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, token);
    const data = await res.json();
    for (const file of data.files || []) {
      if (!looksLikeRecording(file)) {
        console.log(`[Ingest] ignoring ${file.name} (${file.mimeType}) — not a recording`);
        continue;
      }
      if (isMistypedUpload(file)) {
        console.log(
          `::warning::[Ingest] ${file.name} arrived typed as ${file.mimeType || "nothing"} — ` +
          `taking it on the name, but whatever uploaded it is setting the type wrong`
        );
      }
      files.push(file);
    }
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
export function transcribeFile(path, { model = process.env.YT_WHISPER_MODEL || "base", words = false } = {}) {
  try {
    const out = execFileSync("python3", [TRANSCRIBE_SCRIPT, path, model, ...(words ? ["--words"] : [])], {
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
 * With `keepFiles`, the downloaded clips survive the call and each clip carries
 * a `localPath` — the assembler needs the bytes, and downloading every clip
 * twice (once to transcribe, once to cut) is the alternative.
 *
 * The last two both carry the full match result, so the caller can report gaps
 * without re-deriving them.
 */
export async function ingestRecordings({ requestId, takes, accessToken = null, workDir = null, keepFiles = false } = {}) {
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
      if (isPipelineOutput(file.name)) {
        console.log(`[Ingest] skipping ${file.name} — that is the pipeline's own output, not a recording`);
        continue;
      }
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
      // The assembler needs these files. Deleting them here would mean
      // downloading every clip twice — once to transcribe, once to cut.
      if (!keepFiles) rmSync(localPath, { force: true });
      if (!transcript) {
        if (keepFiles) rmSync(localPath, { force: true });
        continue;
      }
      clips.push({
        id: file.id,
        name: file.name,
        transcript: transcript.transcript,
        recordedAt: file.createdTime || file.modifiedTime || null,
        durationSeconds: transcript.duration,
        localPath: keepFiles ? localPath : null,
      });
    }
  } finally {
    if (!workDir && !keepFiles && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  const result = matchTakesToClips(takes, clips);
  console.log(
    `[Ingest] ${result.matches.length}/${(takes || []).length} takes matched, ` +
    `${result.missingTakes.length} missing, ${result.strayClips.length} unused clip(s)`
  );

  // Orientation report — the structural answer to "did the landscape recorder
  // change land?". The kit says landscape; video 1 arrived 100% portrait
  // anyway, so the build now MEASURES rather than trusts. Portrait is not an
  // error — the blur-fill treatment absorbs it — but it must never be silent.
  try {
    let portrait = 0, landscape = 0, audioOnly = 0;
    for (const clip of clips) {
      if (!clip.localPath || !existsSync(clip.localPath)) continue;
      const out = execFileSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", clip.localPath],
        { encoding: "utf-8", timeout: 60_000 }
      ).trim();
      if (!out) { audioOnly++; continue; }
      const [w, h] = out.split(",").map(Number);
      if (h > w) portrait++; else landscape++;
    }
    console.log(`[Ingest] orientation: ${landscape} landscape, ${portrait} portrait, ${audioOnly} audio-only`);
    if (portrait > 0) {
      console.log(`::warning::${portrait} take(s) arrived PORTRAIT — the blur-fill treatment applies. If the recorder was updated to shoot landscape, it is not doing so yet.`);
    }
  } catch (err) {
    console.log(`[Ingest] orientation probe skipped (${err.message})`);
  }

  return {
    state: result.complete ? "matched" : "incomplete",
    requestId,
    folderId,
    clips,
    result,
  };
}
