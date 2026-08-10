/**
 * yt-footage-source.js — where long-form footage may come from, and where it may not.
 *
 * THE REELS LIBRARY IS NOT AVAILABLE TO THIS PIPELINE.
 *
 * Revision 2 filled long-form B-roll from the same Drive folders the reels bot
 * uses, because they were the footage that existed. Those clips carry burned-in
 * listing copy — "San Antonio starting at $X / 4.99%" — which is wrong inside an
 * education video twice over: it turns a teaching sentence into an ad, and the
 * rate ages into a false claim the moment the market moves. A frame of it is
 * worse than no picture at all, because no picture fails loudly and a stale rate
 * ships.
 *
 * So the connection is severed at the source rather than filtered downstream. A
 * filter is a thing that can be bypassed by a new call site; a module that has
 * no access to the IDs cannot reach them however it is called. `assertNoReelsReach`
 * is the belt to that braces, and the test in yt-longform-footage.test.mjs
 * asserts the whole long-form path against the real reels IDs.
 *
 * WHAT REPLACES IT: an EMPTY folder, deliberately.
 *
 * `YT_LONGFORM_BROLL_FOLDER` starts with nothing in it, and that is the correct
 * steady state, not a setup step somebody forgot. Footage appears in long-form
 * only when Peter puts something there. Until then every segment is carried by a
 * generated graphic, kinetic typography, or licensed stock — which is the point
 * of the three-layer system, and which is why an empty pool must be an ordinary
 * quiet path through this file rather than a warning.
 */

import { CITY_FOLDER_IDS, getAccessToken } from "./drive.js";

/**
 * The Drive folder long-form footage comes from. Empty by default.
 *
 * Unset is not an error. It means "no owned footage", which is the state the
 * three-layer visual system is designed around.
 */
export const LONGFORM_BROLL_FOLDER = process.env.YT_LONGFORM_BROLL_FOLDER || null;

/** Every folder id the reels pipeline owns. Long-form may not read any of them. */
export function reelsFolderIds() {
  return Object.values(CITY_FOLDER_IDS);
}

/**
 * Refuse to proceed if a reels folder has been reached for.
 *
 * Throws rather than returning a verdict. Every other failure in the visual
 * system falls back to something, because a missing graphic costs a graphic. This
 * one does not fall back: the failure mode is a stale mortgage rate on screen in
 * a video that will sit on the channel for years, and a build that dies is
 * strictly cheaper than that. It is also the only way the assertion is worth
 * anything — a check that logs and continues is a check that ships the frame.
 */
export function assertNoReelsReach(folderId, context = "long-form footage") {
  if (!folderId) return;
  const reels = reelsFolderIds();
  if (reels.includes(folderId)) {
    const city = Object.keys(CITY_FOLDER_IDS).find((k) => CITY_FOLDER_IDS[k] === folderId);
    throw new Error(
      `${context} tried to read the reels ${city} folder (${folderId}). ` +
        `Long-form may not use reels footage — those clips carry burned-in price and rate copy. ` +
        `Put long-form footage in YT_LONGFORM_BROLL_FOLDER instead.`
    );
  }
}

/**
 * List the long-form footage library.
 *
 * Returns [] for: no folder configured, an empty folder, or a Drive call that
 * failed. All three mean the same thing to the caller — "no owned footage, use
 * the other layers" — and distinguishing them in the return type would invite a
 * caller to treat one of them as fatal. They are distinguished in the LOG,
 * because "Drive is broken" and "the folder is empty on purpose" are very
 * different things to a human reading a build.
 */
export async function listLongformFootage({ folderId = LONGFORM_BROLL_FOLDER, fetchImpl = fetch, tokenFn = getAccessToken } = {}) {
  if (!folderId) {
    console.log("[Longform] no YT_LONGFORM_BROLL_FOLDER set — no owned footage, visuals come from graphics, typography and stock");
    return [];
  }

  assertNoReelsReach(folderId, "listLongformFootage");

  let token;
  try {
    token = await tokenFn();
  } catch (err) {
    console.warn(`[Longform] could not authenticate to Drive: ${err.message} — continuing with no owned footage`);
    return [];
  }

  const videos = [];
  let pageToken;
  try {
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size,videoMediaMetadata)",
        pageSize: "100",
        orderBy: "name",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Drive API ${res.status}`);

      const data = await res.json();
      if (data.files) videos.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.warn(`[Longform] could not list the long-form footage folder: ${err.message} — continuing with no owned footage`);
    return [];
  }

  if (videos.length === 0) {
    console.log("[Longform] the long-form footage folder is empty — visuals come from graphics, typography and stock");
    return [];
  }

  console.log(`[Longform] ${videos.length} owned clip(s) available`);
  return videos.map((v) => ({
    id: v.id,
    name: v.name,
    durationSeconds: Number(v.videoMediaMetadata?.durationMillis || 0) / 1000 || 0,
    contentHash: null,
    localPath: null,
    source: "owned",
  }));
}
