/**
 * merge-strategies.mjs — pure JSON merge functions used by merge-log-push.mjs.
 *
 * Extracted from merge-log-push.mjs so they can be unit-tested without touching git.
 * These functions must stay PURE (no fs, no git, no process.exit) — that is what
 * makes the concurrent-runner merge behaviour testable.
 */

// The ONE import this module has, and it is deliberately to a module that
// imports nothing itself. `capRequests` is shared with src/yt-approvals.js —
// which reads and writes the file and therefore has `fs` — and importing it
// from THERE would drag `fs` into this module through the back door and break
// the purity the header above depends on.
import { capRequests } from "./src/approvals-retention.js";

/** How much post history posted-log.json keeps. Matches state.js recordPost(). */
export const POSTED_LOG_RETENTION_DAYS = 365;

/**
 * posted-log.json: append local entries whose timestamp doesn't already exist remotely,
 * then drop anything older than the retention window.
 *
 * Dedup key is `timestamp`. Entries are matched on timestamp alone because a single
 * logical post is written exactly once by recordPost() with a ms-precision ISO stamp.
 *
 * THE TRIM HAS TO HAPPEN HERE, not only in recordPost(). recordPost() prunes the
 * local copy, but merge-log-push.mjs then does `git reset --hard origin/main` — which
 * restores the full committed history — and this function re-seeds from that remote
 * and only ever appends. So a prune applied locally is discarded on every run, and
 * posted-log was the one managed file whose merge had no cap: every sibling strategy
 * below ends in a .slice(). It grew without bound as a result.
 *
 * Entries whose timestamp is missing or unparseable are KEPT. A cap that cannot date
 * an entry must not delete it — that trades unbounded growth for silent data loss.
 */
export function mergePostedLog(local, remote, log = console.log) {
  const remotePosts = [...(remote?.posts || [])];
  const localPosts = local?.posts || [];

  const existingTimestamps = new Set(
    remotePosts.map((p) => p.timestamp).filter(Boolean)
  );

  let added = 0;
  for (const entry of localPosts) {
    if (entry.timestamp && !existingTimestamps.has(entry.timestamp)) {
      remotePosts.push(entry);
      existingTimestamps.add(entry.timestamp);
      added++;
    }
  }

  const cutoff = Date.now() - POSTED_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = remotePosts.filter((p) => {
    const t = Date.parse(p?.timestamp);
    return Number.isNaN(t) || t > cutoff;
  });
  const expired = remotePosts.length - kept.length;

  const merged = { ...remote, ...local, posts: kept };
  log(
    `[Merge] posted-log: ${added} new entries appended, ${expired} expired past ` +
      `${POSTED_LOG_RETENTION_DAYS}d (total: ${kept.length})`
  );
  return merged;
}

/** video-matches.json: object keyed by drive file id → local wins on conflict. */
export function mergeVideoMatches(local, remote, log = console.log) {
  const merged = { ...remote, ...local };
  log(`[Merge] video-matches: local=${Object.keys(local || {}).length}, remote=${Object.keys(remote || {}).length}, merged=${Object.keys(merged).length}`);
  return merged;
}

/** performance-weights.json: per key, take whichever side has the newer lastUpdated. */
export function mergePerformanceWeights(local, remote, log = console.log) {
  const merged = { ...(remote || {}) };
  for (const [key, localVal] of Object.entries(local || {})) {
    if (!merged[key]) {
      merged[key] = localVal;
    } else if (localVal && typeof localVal === "object" && localVal.lastUpdated) {
      const remoteUpdated = merged[key]?.lastUpdated || "";
      if (localVal.lastUpdated > remoteUpdated) merged[key] = localVal;
    } else {
      merged[key] = localVal;
    }
  }
  log(`[Merge] performance-weights: ${Object.keys(merged).length} keys`);
  return merged;
}

/** qc-blocklist.json: union — once blocked, always blocked. */
export function mergeBlocklist(local, remote, log = console.log) {
  const merged = {
    blockedDriveIds: { ...(remote?.blockedDriveIds || {}), ...(local?.blockedDriveIds || {}) },
  };
  log(`[Merge] qc-blocklist: ${Object.keys(merged.blockedDriveIds).length} blocked videos`);
  return merged;
}

/** linkedin-history.json: union by date, keep last 7. */
export function mergeLinkedinHistory(local, remote, log = console.log) {
  const allPosts = [...(remote?.posts || []), ...(local?.posts || [])];
  const byDate = new Map();
  for (const p of allPosts) byDate.set(p.date || p.body?.slice(0, 30), p);
  const merged = { posts: [...byDate.values()].slice(-7) };
  log(`[Merge] linkedin-history: ${merged.posts.length} entries`);
  return merged;
}

/** trial-variants.json: union by generatedAt, newest first, keep 100. */
export function mergeTrialVariants(local, remote, log = console.log) {
  const all = [...(remote?.variants || []), ...(local?.variants || [])];
  const seen = new Set();
  const deduped = [];
  for (const v of all) {
    const key = v.generatedAt || `${v.date}-${v.window}-${v.sourceVideoId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }
  deduped.sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
  const merged = { variants: deduped.slice(0, 100) };
  log(`[Merge] trial-variants: ${merged.variants.length} entries`);
  return merged;
}

/**
 * carousel-log.json: union by timestamp, oldest first, keep the last 120.
 *
 * Append-only like posted-log, but with a second dedup key. The carousel job
 * has its own concurrency group, so two runners writing the same day's entry
 * should not happen — if it does, `date` catches the duplicate that `timestamp`
 * would miss, since two runs of the same day produce different ms stamps but
 * the same date. Losing that check would put two entries for one day into the
 * writer's anti-example window and waste it.
 */
export function mergeCarouselLog(local, remote, log = console.log) {
  const all = [...(remote?.posts || []), ...(local?.posts || [])];
  const seenTimestamps = new Set();
  const seenDates = new Set();
  const merged = [];
  for (const p of all) {
    if (!p || typeof p !== "object") continue;
    const ts = p.timestamp;
    if (ts && seenTimestamps.has(ts)) continue;
    if (p.date && seenDates.has(p.date)) continue;
    if (ts) seenTimestamps.add(ts);
    if (p.date) seenDates.add(p.date);
    merged.push(p);
  }
  merged.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const kept = merged.slice(-120);
  log(`[Merge] carousel-log: ${kept.length} entries`);
  return { ...remote, ...local, posts: kept };
}

/**
 * skip-list.json: union by driveFileId — a skip is never un-done by a
 * concurrent runner that happened to check out an older copy.
 */
export function mergeSkipList(local, remote, log = console.log) {
  const all = [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])];
  const byId = new Map();
  for (const e of all) {
    if (e && typeof e === "object" && typeof e.driveFileId === "string" && e.driveFileId) {
      // Keep the earliest skip for an id — first skip wins, later ones add nothing.
      if (!byId.has(e.driveFileId)) byId.set(e.driveFileId, e);
    }
  }
  const merged = [...byId.values()];
  log(`[Merge] skip-list: ${merged.length} skipped videos`);
  return merged;
}

/**
 * yt-approvals.json: union by requestId, merged field-group by field-group.
 *
 * This is the only managed file with TWO independent writers. The poster
 * appends the request and, later, the acted marker; the dashboard appends
 * Peter's decision and commits it separately. Neither sees the other's commit
 * before making its own, so both sides routinely push a version of the same
 * record that is missing the other side's fields.
 *
 * A plain "local wins" or "first wins" union loses one of them every time, so
 * each record is merged in three independent groups:
 *
 *   identity  kind, requestedAt, payload, videoId
 *   decision  decision, selection, notes, decidedAt  <- only the dashboard writes these
 *   acted     actedAt, actedAction, actedResult <- only the poster writes these
 *
 * Within a group, a side that HAS the group beats a side that does not, and if
 * both have it the earlier timestamp wins. That makes the merge deterministic
 * regardless of which runner gets there first, and gives the approval channel
 * the two properties it depends on:
 *
 *   - a recorded decision can never be erased or flipped by a poster push,
 *   - an acted marker can never be erased by a dashboard push, which is what
 *     stops a re-merge from resurrecting an already-published request and
 *     publishing it a second time.
 */
export function mergeYtApprovals(local, remote, log = console.log) {
  // Either side can be a BARE ARRAY of decision records — that is what the
  // deployed dashboard commits. Without this, a dashboard write makes
  // `remote.requests` undefined, the merge keeps only the poster's half, and
  // Peter's decision is silently discarded. Verified on the first live
  // round-trip.
  const asRequests = (side) => (Array.isArray(side) ? side : side?.requests || []);
  const all = [...asRequests(remote), ...asRequests(local)];
  const byId = new Map();

  for (const entry of all) {
    if (!entry || typeof entry !== "object") continue;
    const id = entry.requestId;
    if (typeof id !== "string" || !id) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? mergeApprovalRecord(existing, entry) : { ...entry });
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(a.requestedAt || "").localeCompare(String(b.requestedAt || ""))
  );
  const kept = capRequests(merged);
  const decided = kept.filter((r) => typeof r.decision === "string" && r.decision).length;
  const acted = kept.filter((r) => r.actedAt).length;
  log(`[Merge] yt-approvals: ${kept.length} requests (${decided} decided, ${acted} acted)`);
  // Always write back the poster's shape. Spreading a bare array here would
  // produce an object with numeric keys.
  const base = Array.isArray(remote) ? {} : remote || {};
  const overlay = Array.isArray(local) ? {} : local || {};
  return { ...base, ...overlay, requests: kept };
}

// The cap used to be a local `MAX_APPROVALS = 400` with a comment asking the
// next reader to keep it in step with src/yt-approvals.js. It is now IMPORTED
// from there (see the top of this file), which is the only version of "in step"
// that cannot come apart — and it had to, because the cap stopped being one
// number when the reels edit queue started writing to the same file.

/**
 * Which side owns a field group: a present value beats an absent one, and when
 * both are present the earlier timestamp wins so the result does not depend on
 * which runner happened to push first.
 */
function groupWinner(aVal, bVal, aStamp, bStamp) {
  const aHas = aVal !== undefined && aVal !== null;
  const bHas = bVal !== undefined && bVal !== null;
  if (aHas && !bHas) return "a";
  if (bHas && !aHas) return "b";
  if (!aHas && !bHas) return "neither";
  const a = String(aStamp || "");
  const b = String(bStamp || "");
  if (a && b) return a <= b ? "a" : "b";
  return a ? "a" : "b";
}

function mergeApprovalRecord(x, y) {
  const out = { requestId: x.requestId };

  // identity — whichever side carries it; earlier requestedAt breaks the tie.
  const idFrom = groupWinner(x.kind, y.kind, x.requestedAt, y.requestedAt) === "b" ? y : x;
  out.kind = idFrom.kind ?? x.kind ?? y.kind;
  out.requestedAt = idFrom.requestedAt ?? x.requestedAt ?? y.requestedAt;
  out.payload = idFrom.payload !== undefined ? idFrom.payload : (x.payload ?? y.payload ?? null);
  const videoId = idFrom.videoId ?? x.videoId ?? y.videoId;
  if (videoId !== undefined) out.videoId = videoId;

  // A DELIBERATE OUTLINE REWRITE MUST NOT LOSE TO THE COPY IT REWROTE.
  //
  // The identity group above breaks ties on requestedAt — but a rewrite and its
  // original are the SAME record with the same stamp, so the tie resolves to
  // whichever side the merge happened to see first, and that is the remote. A
  // reoutline would push, merge, and silently come back unchanged.
  //
  // `payload.reoutlinedAt` marks a payload that was rewritten on purpose. A side
  // carrying one beats a side that does not, and the later rewrite wins over an
  // earlier one. Nothing else about the record moves: the decision, selection,
  // notes and acted marker all keep their own groups below.
  const xRewrite = x.payload?.reoutlinedAt;
  const yRewrite = y.payload?.reoutlinedAt;
  if (xRewrite || yRewrite) {
    const winner = !yRewrite ? x : !xRewrite ? y : String(xRewrite) >= String(yRewrite) ? x : y;
    out.payload = winner.payload;
  }

  // decision — the dashboard's half. Never dropped, never flipped.
  //
  // `selection` travels with the decision and is NOT optional: it is the field
  // that says WHICH of the three topics Peter picked. An earlier version of
  // this merge copied decision/notes/decidedAt and silently dropped it, so a
  // recovered record resolved to "approved, but nothing says which one" and the
  // pipeline stalled on a decision that was actually complete. Found on the
  // first live round-trip.
  const dec = groupWinner(x.decision, y.decision, x.decidedAt, y.decidedAt);
  if (dec !== "neither") {
    const d = dec === "a" ? x : y;
    out.decision = d.decision;
    out.notes = d.notes ?? null;
    out.decidedAt = d.decidedAt ?? null;
    if (d.selection !== undefined && d.selection !== null) out.selection = d.selection;
  }

  // acted — the poster's latch. Never dropped, or an approved video publishes twice.
  const act = groupWinner(x.actedAt, y.actedAt, x.actedAt, y.actedAt);
  if (act !== "neither") {
    const a = act === "a" ? x : y;
    out.actedAt = a.actedAt;
    out.actedAction = a.actedAction ?? null;
    out.actedResult = a.actedResult ?? null;
  }

  // presenter — the assignment group. LATER assignedAt wins, because a
  // reassignment is deliberately newer news (the same argument as the
  // reoutline marker above: a deliberate change must not lose to the copy it
  // changed). This group exists because this function rebuilds records from an
  // explicit field list — without it, the first two-sided merge after an
  // assignment would silently drop the stamp and the kit would quietly revert
  // to the owner, which is the never-default rule failing by erosion.
  const xp = x.presenter;
  const yp = y.presenter;
  if (xp || yp) {
    const winner = !yp ? xp : !xp ? yp : String(xp.assignedAt || "") >= String(yp.assignedAt || "") ? xp : yp;
    out.presenter = winner;
  }
  // The supersession trail unions on (id, assignedAt) so neither side's
  // history is lost — same rule as the edit queue's attempts.
  const historyKey = (h) => `${h?.id ?? "?"}|${h?.assignedAt ?? "?"}`;
  const history = new Map();
  for (const h of [...(x.presenterHistory || []), ...(y.presenterHistory || [])]) {
    if (h && !history.has(historyKey(h))) history.set(historyKey(h), h);
  }
  if (history.size > 0) {
    out.presenterHistory = [...history.values()].sort((a, b) =>
      String(a.assignedAt || "").localeCompare(String(b.assignedAt || ""))
    );
  }

  // A reassignment ADAPTS the acted script (updateActedScript in
  // yt-approvals.js) without touching the acted latch, so both sides carry the
  // same actedAt and the group tie above resolves to whichever side the merge
  // saw first — the remote, whose actedResult is the STALE script. The build
  // matches recordings against actedResult.script, so losing the adaptation
  // would match the new presenter's takes against the old presenter's words.
  // Same fix as reoutlinedAt: the side whose actedResult carries the later
  // scriptAdaptedAt wins the actedResult alone; the latch fields stand.
  const xAdapt = x.actedResult?.scriptAdaptedAt;
  const yAdapt = y.actedResult?.scriptAdaptedAt;
  if ((xAdapt || yAdapt) && out.actedAt) {
    const winner = !yAdapt ? x : !xAdapt ? y : String(xAdapt) >= String(yAdapt) ? x : y;
    out.actedResult = winner.actedResult;
  }

  // nudge — the stall reminder's stamp (yt-stall-nudge.js). Its own group
  // because this function rebuilds records from an explicit field list: a
  // field with no group here is a field the next concurrent commit silently
  // deletes, and a deleted stamp re-arms the nudge into a mail on every run.
  //
  // LATEST wins, unlike every group above — deliberately. The other groups
  // protect a decision from being rewritten, so the earlier write is the
  // truth. A nudge stamp records "when was Peter last reminded", and two
  // runners racing means he was reminded at the later time.
  const nudgedAt = [x.stallNudgedAt, y.stallNudgedAt]
    .filter((v) => typeof v === "string" && v)
    .sort()
    .pop();
  if (nudgedAt) out.stallNudgedAt = nudgedAt;

  return out;
}

/**
 * youtube-log.json: union by videoId, merged field-group by field-group.
 *
 * Same two-writer problem as yt-approvals, and the same shape of answer. The
 * poster writes the render and the upload; the dashboard writes Peter's review.
 * Neither sees the other's commit first.
 *
 *   render    requestId, title, market, createdAt, brollHashes, scores
 *   upload    uploadedAt, youtubeUrl, metricoolPostId, privacy
 *   review    reviewedAt, approved, reviewNotes
 *   shorts    shortsCutAt, shorts
 *
 * Two properties this has to guarantee:
 *
 *   - an `uploadedAt` is never erased, or the next scheduled run sees an
 *     un-uploaded video and pushes another 320MB copy to YouTube.
 *   - `approved: true` is never downgraded to false. A merge that loses an
 *     approval is recoverable; one that INVENTS an approval is not, so the
 *     merge is asymmetric on purpose: true wins over false, and false never
 *     overwrites true.
 */
export function mergeYouTubeLog(local, remote, log = console.log) {
  const all = [...(remote?.videos || []), ...(local?.videos || [])];
  const byId = new Map();
  for (const v of all) {
    if (!v || typeof v !== "object") continue;
    const id = v.videoId;
    if (typeof id !== "string" || !id) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? mergeVideoRecord(existing, v) : { ...v });
  }
  const merged = [...byId.values()].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
  const kept = merged.slice(-MAX_VIDEOS);
  const uploaded = kept.filter((v) => v.uploadedAt).length;
  const approved = kept.filter((v) => v.approved === true).length;
  log(`[Merge] youtube-log: ${kept.length} videos (${uploaded} uploaded, ${approved} approved)`);
  return { ...remote, ...local, videos: kept };
}

/** Keep in step with MAX_ENTRIES in src/yt-log.js. */
const MAX_VIDEOS = 200;

function mergeVideoRecord(x, y) {
  const out = { videoId: x.videoId };

  // render — whichever side has it; earlier createdAt breaks the tie.
  const renderFrom = groupWinner(x.createdAt, y.createdAt, x.createdAt, y.createdAt) === "b" ? y : x;
  for (const f of ["requestId", "title", "market", "intent", "createdAt", "runtimeSeconds", "bytes", "resolution", "brollHashes", "scriptScores", "packagingScores"]) {
    const v = renderFrom[f] ?? x[f] ?? y[f];
    if (v !== undefined) out[f] = v;
  }

  // A HIGHER REVISION IS A NEWER GENERATION, NOT A STALE COPY.
  //
  // This distinction did not exist, and its absence made rework unable to ever
  // rebuild. `recordRework` reopens the build gate by CLEARING `uploadedAt`,
  // and the rules below are written so that an upload is never erased — a
  // sound rule against a stale concurrent writer, and exactly wrong against a
  // deliberate one. The merge kept `revision: 8` from the local side and
  // `uploadedAt` from the remote, producing a record that says both "queued for
  // rework" and "already uploaded". The build gate reads the second half and
  // exits with "review already recorded — nothing further", forever.
  //
  // Verified on revision 8 of video 1: two dispatches, each finishing in three
  // minutes without building anything.
  //
  // The fix is to say what the invariant actually meant. "Never erase an
  // upload" protects against a copy that has not heard about the upload yet —
  // one at the SAME revision or older. A side carrying a higher revision has
  // heard, and has superseded it. So every field scoped to one generation of
  // the video — the upload, the review, the approval, the distribution — comes
  // wholesale from the newer generation, nulls included.
  const xRev = Number(x.revision) || 0;
  const yRev = Number(y.revision) || 0;
  const newer = xRev > yRev ? x : yRev > xRev ? y : null;

  // upload — never dropped by a SAME-generation copy, or the next run
  // re-uploads 320MB.
  if (newer) {
    out.uploadedAt = newer.uploadedAt ?? null;
    out.privacy = newer.privacy ?? null;
    out.youtubeUrl = newer.youtubeUrl ?? null;
    out.metricoolPostId = newer.metricoolPostId ?? null;
    out.blogId = newer.blogId ?? null;
  } else {
    const up = groupWinner(x.uploadedAt, y.uploadedAt, x.uploadedAt, y.uploadedAt);
    if (up !== "neither") {
      const u = up === "a" ? x : y;
      out.uploadedAt = u.uploadedAt;
      out.privacy = u.privacy ?? null;
      out.youtubeUrl = u.youtubeUrl ?? null;
      out.metricoolPostId = u.metricoolPostId ?? null;
      out.blogId = u.blogId ?? null;
    }
  }

  // review — asymmetric within a generation. An approval is never downgraded by
  // a stale copy; it IS cleared by a rework, because the approval belonged to
  // the revision that was just superseded and carrying it forward would mark an
  // unbuilt video as approved.
  if (newer) {
    out.reviewedAt = newer.reviewedAt ?? null;
    out.reviewNotes = newer.reviewNotes ?? null;
    out.approved = newer.approved === true;
  } else {
    const rev = groupWinner(x.reviewedAt, y.reviewedAt, x.reviewedAt, y.reviewedAt);
    if (rev !== "neither") {
      const r = rev === "a" ? x : y;
      out.reviewedAt = r.reviewedAt;
      out.reviewNotes = r.reviewNotes ?? null;
    }
    out.approved = x.approved === true || y.approved === true;
  }

  // shorts — cut once per generation.
  if (newer) {
    out.shortsCutAt = newer.shortsCutAt ?? null;
    out.shorts = newer.shorts ?? [];
  } else {
    const sh = groupWinner(x.shortsCutAt, y.shortsCutAt, x.shortsCutAt, y.shortsCutAt);
    if (sh !== "neither") {
      const s = sh === "a" ? x : y;
      out.shortsCutAt = s.shortsCutAt;
      out.shorts = s.shorts ?? [];
    }
  }

  // revision history — the iteration loop's memory. Max revision wins;
  // reworks union on (revision, rejectedAt) so neither side's history is lost.
  const revNo = Math.max(x.revision || 0, y.revision || 0);
  if (revNo > 0) out.revision = revNo;
  const reworkKey = (r) => `${r?.revision ?? "?"}|${r?.rejectedAt ?? "?"}`;
  const reworks = new Map();
  for (const r of [...(x.reworks || []), ...(y.reworks || [])]) {
    if (r && !reworks.has(reworkKey(r))) reworks.set(reworkKey(r), r);
  }
  if (reworks.size > 0) out.reworks = [...reworks.values()].sort((a, b) => (a.revision || 0) - (b.revision || 0));

  // distribution — belongs to the generation that was distributed. A rework
  // nulls it deliberately: the steps that ran, ran against an upload that no
  // longer exists, and carrying them forward would mark the new one as already
  // distributed.
  if (newer) {
    out.distribution = newer.distribution ?? null;
  } else if (x.distribution || y.distribution) {
    // Within one generation: per-step done-wins, like approved. A completed
    // thumbnails.set that a stale copy erases would re-run against YouTube.
    out.distribution = { ...(y.distribution || {}), ...(x.distribution || {}) };
    for (const step of new Set([...Object.keys(x.distribution || {}), ...Object.keys(y.distribution || {})])) {
      const xa = x.distribution?.[step];
      const ya = y.distribution?.[step];
      out.distribution[step] = xa?.done ? xa : ya?.done ? ya : (xa ?? ya);
    }
  }

  // EVERYTHING ELSE SURVIVES BY DEFAULT. The groups above exist to apply
  // POLICY (asymmetric approval, upload never dropped) — they were never
  // meant to be an allowlist, but that is what they became: this function
  // rebuilt records from named fields only, and every field added after it
  // was written (revision, reworks, distribution, youtubeVideoId,
  // thumbnailText) was silently dropped at every two-sided merge. Video 1's
  // revision history vanished exactly that way.
  //
  // AND A NULL IS NOT A VALUE. The first passthrough preferred x on a
  // definedness tie — but x here is the REMOTE side (mergeYouTubeLog spreads
  // remote's videos first), and a field initialized as `null` at entry
  // creation is defined on BOTH sides forever after. So the first field ever
  // UPDATED from its initial null — video 1's youtubeVideoId, resolved to a
  // real watch id by the sweep in run 32202427105 — was thrown away at the
  // very next MergePush: remote's stale null "won the tie" over local's
  // freshly learned value. The rule is now: a real value beats null, and on
  // a value-vs-value tie the LOCAL side (y) wins, matching every other
  // strategy in this file. Null still carries through when it is all either
  // side has, so initialized-but-unlearned fields keep their shape.
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (key in out) continue;
    const xv = x[key];
    const yv = y[key];
    let v;
    if (yv !== undefined && yv !== null) v = yv;
    else if (xv !== undefined && xv !== null) v = xv;
    else v = yv !== undefined ? yv : xv;
    if (v !== undefined) out[key] = v;
  }

  return out;
}

/**
 * edit-queue.json: union by driveFileId, merged field-group by field-group.
 *
 * ONE WRITER, TWO RUNNERS. Unlike yt-approvals.json the dashboard never touches
 * this file — but the scan job and the advance job both do, and both start from
 * `git reset --hard origin/main`, so a scan that discovers a new video while an
 * advance is halfway through a render is the ordinary case rather than the
 * exotic one. Whichever pushes second must not erase what the first recorded.
 *
 * THE STATUS IS NOT MONOTONIC, which rules out the obvious merge. A rejection
 * moves in_review -> editing, so "the further-along status wins" would make a
 * re-edit impossible to record: the stale copy's `in_review` would beat the
 * new `editing` forever and the rework would vanish, which is precisely the
 * failure mergeVideoRecord's revision handling exists to fix on the long-form
 * side. So status is resolved by `statusAt` — the later transition is the true
 * one — with one asymmetry:
 *
 *   DELIVERED IS NEVER DOWNGRADED. Approving moves master and variants onto the
 *   Trial tab, and that is not undone by a concurrent runner that had not heard
 *   about it. A merge that loses a delivery would re-deliver on the next run and
 *   put a second copy of three variants on the tab.
 *
 * The card ids, the outputs and the attempt history all union rather than
 * choosing, because losing any of them loses the thread between a card Peter is
 * looking at and the video it belongs to.
 */
export function mergeEditQueue(local, remote, log = console.log) {
  const all = [...(remote?.videos || []), ...(local?.videos || [])];
  const byId = new Map();
  for (const v of all) {
    if (!v || typeof v !== "object") continue;
    const id = v.driveFileId;
    if (typeof id !== "string" || !id) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? mergeQueueRecord(existing, v) : { ...v });
  }
  const merged = [...byId.values()].sort((a, b) =>
    String(a.discoveredAt || "").localeCompare(String(b.discoveredAt || ""))
  );
  const kept = merged.slice(-MAX_QUEUE_VIDEOS);
  const counts = kept.reduce((acc, v) => ({ ...acc, [v.status]: (acc[v.status] || 0) + 1 }), {});
  log(
    `[Merge] edit-queue: ${kept.length} videos (` +
      Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(" ") + ")"
  );
  return { ...remote, ...local, videos: kept };
}

/** Keep in step with MAX_ENTRIES in src/edit-queue.js. */
const MAX_QUEUE_VIDEOS = 500;

function mergeQueueRecord(x, y) {
  const out = { driveFileId: x.driveFileId };

  // identity — written once at discovery and never changed. Earlier wins, so a
  // re-discovery cannot restamp a video as newly found.
  const first = String(x.discoveredAt || "") <= String(y.discoveredAt || "") ? x : y;
  for (const f of ["fileName", "durationSeconds", "sizeBytes", "discoveredAt", "test"]) {
    const v = first[f] ?? x[f] ?? y[f];
    if (v !== undefined) out[f] = v;
  }

  // status — the later transition is the real one, EXCEPT that delivered stands.
  const delivered = [x, y].find((r) => r.status === "delivered");
  const later = String(x.statusAt || "") >= String(y.statusAt || "") ? x : y;
  const winner = delivered || later;
  out.status = winner.status;
  out.statusAt = winner.statusAt ?? null;
  out.failure = winner.status === "failed" ? (winner.failure ?? null) : null;
  const deliveredAt = x.deliveredAt || y.deliveredAt;
  if (deliveredAt) out.deliveredAt = deliveredAt;

  // the cards — a requestId is never dropped. Losing one orphans a card Peter
  // can still see and press, and its decision would then match no video.
  out.queueRequestId = x.queueRequestId || y.queueRequestId || null;
  out.reviewRequestId = winner.reviewRequestId || x.reviewRequestId || y.reviewRequestId || null;

  // the outputs — belong to the newest generation, like the long-form upload.
  out.revision = Math.max(Number(x.revision) || 0, Number(y.revision) || 0);
  const newest = (Number(x.revision) || 0) >= (Number(y.revision) || 0) ? x : y;
  out.master = newest.master ?? x.master ?? y.master ?? null;
  out.variants = newest.variants ?? x.variants ?? y.variants ?? [];

  // attempts — union on (revision, startedAt), oldest first. This is the record
  // of what was tried and why it failed, and it is the only thing that survives
  // a wedged video for a human to read.
  const key = (a) => `${a?.revision ?? "?"}|${a?.startedAt ?? "?"}`;
  const attempts = new Map();
  for (const a of [...(x.attempts || []), ...(y.attempts || [])]) {
    if (!a) continue;
    const k = key(a);
    // A finished attempt beats an open one for the same key — the side that
    // wrote the outcome is the side that has it.
    if (!attempts.has(k) || (a.finishedAt && !attempts.get(k).finishedAt)) attempts.set(k, a);
  }
  out.attempts = [...attempts.values()].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));

  // Everything else carries through, defined-over-undefined, local winning ties.
  // The long-form video merge learned this the hard way: its named-field rebuild
  // became an accidental allowlist and silently dropped every field added after
  // it was written. This one starts with the lesson applied.
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (k in out) continue;
    const v = x[k] !== undefined ? x[k] : y[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * presenters.json: the presenter registry (src/presenters.js).
 *
 * Writers are the dispatch jobs (add/assign/rotate) and the Monday brief
 * (consuming the standing assignment); any two can race through merge-log-push.
 * Per presenter, merged in field groups like the approval records:
 *
 *   identity  name, email, role, test, addedAt, cta  — EARLIEST addedAt wins;
 *             who somebody is does not change because a stale runner pushed.
 *   code      accessCode, codeIssuedAt               — LATEST codeIssuedAt wins;
 *             a rotation is deliberately newer news and a stale copy must not
 *             resurrect a code the rotation just killed.
 *
 * retiredCodes union (a retired code is retired forever — that is what makes
 * "never reused" hold across runners), and the standing next-assignment is
 * resolved by assignedAt with consumption sticky at equal stamps: a consumed
 * copy of the SAME assignment beats an unconsumed one (or the assignment
 * would re-fire on a later brief), while a genuinely newer assignment beats
 * an old consumption (or "next" could never be set twice).
 */
export function mergePresenters(local, remote, log = console.log) {
  const byId = new Map();
  for (const p of [...(remote?.presenters || []), ...(local?.presenters || [])]) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) continue;
    const existing = byId.get(p.id);
    byId.set(p.id, existing ? mergePresenterRecord(existing, p) : { ...p });
  }

  // One presenter per email survives the merge too: two ids for one address
  // can only come from a racing double-add, and resolving it here rather than
  // warning forever keeps the invariant true everywhere else. Earliest added
  // wins — that is the copy whose code may already be in someone's inbox —
  // and the loser's code is retired so it can never be minted again.
  const retired = [...(remote?.retiredCodes || []), ...(local?.retiredCodes || [])];
  const byEmail = new Map();
  const kept = [];
  for (const p of [...byId.values()].sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")))) {
    const key = String(p.email || "").toLowerCase();
    const winner = byEmail.get(key);
    if (winner) {
      log(`[Merge] presenters: DUPLICATE EMAIL ${p.email} — keeping "${winner.id}" (added first), retiring "${p.id}"`);
      if (p.accessCode) retired.push({ code: p.accessCode, presenterId: p.id, retiredAt: new Date().toISOString() });
      continue;
    }
    byEmail.set(key, p);
    kept.push(p);
  }

  const retiredUnion = new Map();
  for (const r of retired) {
    if (r && typeof r.code === "string") retiredUnion.set(`${r.code}|${r.presenterId ?? "?"}`, r);
  }

  const la = local?.nextAssignment;
  const ra = remote?.nextAssignment;
  let nextAssignment = null;
  if (la || ra) {
    if (!la) nextAssignment = ra;
    else if (!ra) nextAssignment = la;
    else if (String(la.assignedAt || "") === String(ra.assignedAt || "")) nextAssignment = la.consumedAt ? la : ra;
    else nextAssignment = String(la.assignedAt || "") > String(ra.assignedAt || "") ? la : ra;
  }

  log(`[Merge] presenters: ${kept.length} presenters, ${retiredUnion.size} retired codes` +
    (nextAssignment ? `, next -> ${nextAssignment.presenterId}${nextAssignment.consumedAt ? " (consumed)" : ""}` : ""));
  return {
    ...(remote || {}),
    ...(local || {}),
    presenters: kept,
    retiredCodes: [...retiredUnion.values()],
    nextAssignment,
  };
}

function mergePresenterRecord(x, y) {
  const out = { id: x.id };
  // identity — earliest addedAt wins.
  const first = String(x.addedAt || "") <= String(y.addedAt || "") ? x : y;
  for (const f of ["name", "email", "role", "test", "addedAt", "cta"]) {
    const v = first[f] ?? x[f] ?? y[f];
    if (v !== undefined) out[f] = v;
  }
  // code — latest codeIssuedAt wins (a rotation sticks).
  const codeFrom = String(x.codeIssuedAt || "") >= String(y.codeIssuedAt || "") ? x : y;
  out.accessCode = codeFrom.accessCode ?? x.accessCode ?? y.accessCode;
  out.codeIssuedAt = codeFrom.codeIssuedAt ?? x.codeIssuedAt ?? y.codeIssuedAt;
  // Everything else: defined-over-undefined, local (y) winning ties — the
  // lesson the youtube-log merge learned about accidental allowlists.
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (k in out) continue;
    const v = y[k] !== undefined ? y[k] : x[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Dispatch table used by merge-log-push.mjs. */
export const MERGE_STRATEGIES = {
  "posted-log.json": (l, r, log) => mergePostedLog(l, r || { posts: [] }, log),
  "video-matches.json": mergeVideoMatches,
  "performance-weights.json": mergePerformanceWeights,
  // The LDT brand's learning-loop brief (analytics.js weightsPathForBrand).
  // Same shape, same newer-lastUpdated rule; unregistered it would be
  // discarded by merge-log-push's reset --hard.
  "performance-weights.ldt.json": mergePerformanceWeights,
  "qc-blocklist.json": mergeBlocklist,
  "linkedin-history.json": (l, r, log) => mergeLinkedinHistory(l, r || { posts: [] }, log),
  "trial-variants.json": (l, r, log) => mergeTrialVariants(l, r || { variants: [] }, log),
  "skip-list.json": (l, r, log) => mergeSkipList(l, r || [], log),
  "carousel-log.json": (l, r, log) => mergeCarouselLog(l, r || { posts: [] }, log),
  "yt-approvals.json": (l, r, log) => mergeYtApprovals(l, r || { requests: [] }, log),
  "youtube-log.json": (l, r, log) => mergeYouTubeLog(l, r || { videos: [] }, log),
  "edit-queue.json": (l, r, log) => mergeEditQueue(l, r || { videos: [] }, log),
  "presenters.json": (l, r, log) => mergePresenters(l, r || { presenters: [], retiredCodes: [], nextAssignment: null }, log),
};

export const MERGE_FILES = Object.keys(MERGE_STRATEGIES);
