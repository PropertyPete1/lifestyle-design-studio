/**
 * manifest-flagship.js — tie a flagship Instagram post to the Drive file it came from.
 *
 * WHY THIS IS THE WHOLE PROBLEM. The decision file has read safe_to_act: false
 * for three runs with one reason: "No publish manifest exists mapping Instagram
 * post ids to source video files." #126 built a manifest, and it does not fix
 * this on its own, because of what the pipeline publishes and what the analyser
 * reads:
 *
 *   - The pipeline posts to three SATELLITE Instagram accounts and records
 *     their permalinks. It never posts to the flagship (@lifestyledesignrealty-
 *     texas): mainBrandSkipIG withholds it and Peter posts it by hand.
 *   - The analyser studies the FLAGSHIP and nothing else. Every post id on its
 *     POST list, and every example_post_ids entry, is a flagship id.
 *
 * So the manifest is a complete record of publications the analyser never looks
 * at, and says nothing about the account it does. This module builds the
 * missing half.
 *
 * ─── THE CHAIN, AND WHERE IT STOPS BEING DETERMINISTIC ──────────────────────
 *
 *   1. RECEIPT -> PUBLISH.  Exact, by id. A `manual_confirm` receipt (written
 *      by the dashboard when Peter confirms he posted) carries a driveFileId —
 *      and, measured on all 13 receipts since 2026-09-10, that id is NOT the
 *      source video. It is the DELIVERED COPY: the file the pipeline uploaded
 *      to Peter's Drive for him to post, whose link is on the publish's own
 *      posted-log entry as `deliveryDriveLink`. Joining receipt.driveFileId to
 *      that link is string equality on an id this pipeline wrote itself. A
 *      naive join on drive_file_id matches ZERO of 13 — it looks like an empty
 *      result rather than a wrong one, which is the kind of silence that
 *      survives a long time.
 *
 *   2. PUBLISH -> MANIFEST ROW.  Exact, by (drive_file_id, posted_at).
 *
 *   3. PUBLISH -> FLAGSHIP IG POST ID.  INFERENCE, and it is the only step that
 *      is. Nothing in the receipt, the posted-log or Metricool's scheduler
 *      records the id of a post made by hand in the Instagram app. It has to be
 *      recognised in the flagship's analytics by what it says and when it
 *      appeared. Every row therefore carries the method that produced it and a
 *      confidence, and a row that cannot be resolved says why instead of
 *      guessing — the analyser's own rule is that a null id is not actionable,
 *      and a WRONG id is worse than a null one: it credits a video with another
 *      video's numbers, which is exactly the error that made safe_to_act false.
 *
 * ─── WHY THE CAPTION ALONE IS NOT ENOUGH ────────────────────────────────────
 *
 * Because the captions repeat. Measured over the 45 receipts inside Metricool's
 * 30-day analytics window: matching on the caption's first line alone leaves 16
 * ambiguous (up to four flagship posts share an opening — "POV: you just walked
 * into your first brand new home…" appears four times) and produces one
 * outright COLLISION, two receipts claiming one post. That is the same
 * boilerplate problem the decision file flags, showing up inside the join.
 *
 * So time is required to break ties, and a post may be claimed ONCE: two
 * publishes resolving to one flagship post means at least one is wrong, and
 * both are refused rather than one being picked.
 */

/** How far apart the hand-post and its confirmation may be. */
export const MATCH_WINDOW_HOURS = 6;

/**
 * Parse a timestamp DETERMINISTICALLY, wherever the code runs.
 *
 * Metricool hands back two shapes: the analytics rows carry an explicit UTC
 * stamp ("2026-09-17T19:45:37Z"), and the reels endpoint carries a bare local
 * one ({ dateTime: "2026-09-14T18:27:04", timezone: "Europe/Madrid" }). A bare
 * string goes to Date.parse as LOCAL time, so the same data would resolve
 * differently on a CI runner (UTC) than on a laptop (CT) — a six-hour swing on
 * a six-hour window. Anything without an offset is read as UTC so the answer
 * does not depend on the machine. The residual skew against Metricool's own
 * zone is under two hours and the window absorbs it; the alternative, guessing
 * at their server's DST, would be less predictable, not more.
 */
export function parseStamp(value) {
  if (value == null) return NaN;
  const raw = typeof value === "object" ? (value.dateTime ?? value.date ?? "") : String(value);
  if (!raw) return NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim());
  return Date.parse(hasZone ? raw : `${raw.trim()}Z`);
}

/** Shortest caption prefix that may be treated as identifying. */
const MIN_CAPTION_KEY = 20;

/** Fold captions the way Instagram and the model both vary them. */
function norm(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** The caption's first non-empty line, folded. What analytics exposes as `slug`. */
export function captionKey(caption) {
  const line = String(caption ?? "").split("\n").find((l) => l.trim());
  return norm(line || "");
}

/** Do two caption keys agree over the length they share? */
function keysAgree(a, b) {
  const n = Math.min(a.length, b.length, 60);
  return n >= MIN_CAPTION_KEY && a.slice(0, n) === b.slice(0, n);
}

/** Every `deliveryDriveLink` id -> the publish entry that produced it. */
export function deliveryIndex(posts) {
  const byDeliveredId = new Map();
  for (const p of posts || []) {
    const m = /\/file\/d\/([^/?#]+)/.exec(p?.deliveryDriveLink || "");
    if (m) byDeliveredId.set(m[1], p);
  }
  return byDeliveredId;
}

/**
 * The flagship hand-post receipts, each tied to the publish it confirms.
 *
 * `driveFileId` on a receipt is the delivered copy (see the header). The source
 * file id is taken from the publish entry, never from the receipt.
 */
export function receiptsWithPublish(posts) {
  const delivered = deliveryIndex(posts);
  const out = [];
  for (const r of posts || []) {
    if (r?.platform !== "instagram_main_native" && r?.source !== "manual_confirm") continue;
    const publish = r.driveFileId ? delivered.get(r.driveFileId) : null;
    out.push({
      receipt: r,
      publish: publish || null,
      // The source video, which is what the manifest and the analyser key on.
      driveFileId: publish?.driveFileId || null,
      postedAtMs: parseStamp(r.mainIgPostedAt || r.timestamp),
      captionKey: captionKey(publish?.caption || r.captionSnippet),
    });
  }
  return out;
}

/**
 * Resolve flagship IG post ids for every receipt. PURE.
 *
 * `igPosts` are the flagship account's own posts as analytics reports them:
 * { post_id | reelId, slug | caption, published | publishedAt }.
 *
 * TWO PASSES, and the second is the reason. Pass one asks each receipt which
 * post it matches; pass two settles the posts that more than one receipt
 * matched. A single streaming pass cannot do that, because the right answer to
 * a contest depends on a claim that may not have arrived yet.
 *
 * Returns a Map of driveFileId -> {
 *   ig_post_id, method, confidence, url, published_at, confirmed_at, contest?
 * } for the resolved, plus `unresolved` explaining each one that failed. Every
 * unresolved entry carries the `receipt_at` of the receipt that produced it, so
 * a caller with several receipts for one video can tell them apart.
 */
export function resolveFlagshipPosts({ posts = [], igPosts = [] } = {}) {
  const candidates = (igPosts || [])
    .map((p) => ({
      id: String(p.post_id ?? p.reelId ?? p.igPostId ?? ""),
      key: captionKey(p.slug ?? p.caption ?? p.content ?? ""),
      at: parseStamp(p.published ?? p.publishedAt ?? p.date),
      url: p.url ?? null,
    }))
    .filter((p) => p.id && p.key);

  const unresolved = [];
  const claims = [];

  // ── pass 1: what does each receipt match? ─────────────────────────────────
  for (const r of receiptsWithPublish(posts)) {
    const receiptAt = r.receipt.mainIgPostedAt || r.receipt.timestamp || null;
    if (!r.publish) {
      unresolved.push({ drive_file_id: null, receipt_at: receiptAt, code: "no_publish_for_receipt", why: "receipt's delivered-copy id matches no publish in the log" });
      continue;
    }
    if (!r.captionKey) {
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: receiptAt, code: "no_caption", why: "no caption text to match on" });
      continue;
    }

    const textHits = candidates.filter((c) => keysAgree(c.key, r.captionKey));
    if (textHits.length === 0) {
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: receiptAt, code: "no_caption_match", why: "no flagship post in the analytics window opens with this caption" });
      continue;
    }

    let hit = null;
    let method = null;
    if (textHits.length === 1) {
      hit = textHits[0];
      method = "caption";
    } else {
      const near = textHits.filter((c) => withinWindow(c.at, r.postedAtMs));
      if (near.length === 1) {
        hit = near[0];
        method = "caption+time";
      } else {
        unresolved.push({
          drive_file_id: r.driveFileId,
          receipt_at: receiptAt,
          code: "ambiguous",
          why: `${textHits.length} flagship posts share this caption opening and ${near.length} are within ${MATCH_WINDOW_HOURS}h — ambiguous`,
        });
        continue;
      }
    }

    claims.push({
      driveFileId: r.driveFileId,
      receiptAt,
      postedAtMs: r.postedAtMs,
      hit,
      method,
      // How far the hand-post confirmation sits from the post itself. This is
      // what settles a contest.
      gapMs: Number.isNaN(r.postedAtMs) || Number.isNaN(hit.at) ? NaN : Math.abs(hit.at - r.postedAtMs),
    });
  }

  // ── pass 2: one post belongs to one video ────────────────────────────────
  //
  // Two receipts matching one flagship post means at least one is wrong. The
  // ORIGINAL rule refused both, which is safe and, on real data, needlessly
  // lossy: on 2026-09-16 a video's flagship post went up TWO MINUTES after its
  // receipt, and it lost that post to a video published two days later whose
  // caption opened with the same words — the boilerplate template again.
  //
  // So a contest is settled by proximity, but ONLY when proximity actually
  // says something: exactly one claimant inside MATCH_WINDOW_HOURS of the post
  // wins it. Two claimants inside the window, or none, is a genuine tie and
  // every claimant is refused — a wrong id credits a video with another
  // video's numbers, and that is worse than a null.
  const byPost = new Map();
  for (const c of claims) {
    if (!byPost.has(c.hit.id)) byPost.set(c.hit.id, []);
    byPost.get(c.hit.id).push(c);
  }

  const resolved = new Map();
  for (const [postId, group] of byPost) {
    if (group.length === 1) {
      resolved.set(group[0].driveFileId, buildHit(group[0]));
      continue;
    }

    const inWindow = group.filter((c) => withinWindow(c.hit.at, c.postedAtMs));
    if (inWindow.length === 1) {
      const winner = inWindow[0];
      const losers = group.filter((c) => c !== winner);
      resolved.set(winner.driveFileId, buildHit(winner, {
        contest: {
          resolved_by: "proximity",
          hours_from_post: round1(winner.gapMs / 3600000),
          also_matched_by: losers.map((c) => ({
            drive_file_id: c.driveFileId,
            hours_from_post: Number.isNaN(c.gapMs) ? null : round1(c.gapMs / 3600000),
          })),
        },
      }));
      for (const c of losers) {
        unresolved.push({
          drive_file_id: c.driveFileId,
          receipt_at: c.receiptAt,
          code: "contested",
          why:
            `flagship post ${postId} was confirmed ${describeGap(winner.gapMs)} by ${winner.driveFileId} and ` +
            `${describeGap(c.gapMs)} by this one — the nearer confirmation keeps it`,
        });
      }
      continue;
    }

    // A real tie: nobody is close, or more than one is. Nothing here can tell
    // which, so none of them gets it.
    for (const c of group) {
      unresolved.push({
        drive_file_id: c.driveFileId,
        receipt_at: c.receiptAt,
        code: "contested",
        why:
          `flagship post ${postId} was matched by ${group.length} videos and ` +
          `${inWindow.length === 0 ? "none is" : `${inWindow.length} are`} within ${MATCH_WINDOW_HOURS}h of it — all refused`,
      });
    }
  }

  return { resolved, unresolved };
}

/** Is `at` within the match window of `ref`? Unknown stamps are never "within". */
function withinWindow(at, ref) {
  if (Number.isNaN(at) || Number.isNaN(ref) || at == null || ref == null) return false;
  return Math.abs(at - ref) <= MATCH_WINDOW_HOURS * 3600000;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** "2 minutes after it", "46.0 hours from it", "at an unknown distance". */
function describeGap(gapMs) {
  if (!Number.isFinite(gapMs)) return "at an unknown distance from it";
  const minutes = gapMs / 60000;
  if (minutes < 90) return `${Math.round(minutes)} minute(s) from it`;
  return `${round1(gapMs / 3600000)} hours from it`;
}

function buildHit(claim, extra = {}) {
  return {
    ig_post_id: claim.hit.id,
    url: claim.hit.url,
    published_at: Number.isNaN(claim.hit.at) ? null : new Date(claim.hit.at).toISOString(),
    confirmed_at: claim.receiptAt,
    // "caption" means one post in the window opens with this caption and no
    // other does. "caption+time" means several did and exactly one was inside
    // the window — a tie broken by the clock, which is weaker.
    method: claim.method,
    // A post that had to be won from another claimant is weaker evidence than
    // one nobody else matched, whatever method found it.
    confidence: extra.contest ? "medium" : claim.method === "caption" ? "high" : "medium",
    ...extra,
  };
}

/**
 * Attach the resolved flagship block to each manifest row. PURE — returns new
 * rows, never mutates the manifest this pipeline writes at publish time.
 *
 * A row always carries a `flagship` key. Unresolved is `{ ig_post_id: null,
 * reason }`, because "we could not tie this one" and "we never looked" must not
 * read the same to whoever consumes this file.
 *
 * THE REASON MUST BELONG TO THIS PUBLISH. One Drive file can be published more
 * than once — the 30-day no-repeat rule permits a re-run, and several do — so a
 * video can have several receipts and several different failures. Taking the
 * first reason found put a JULY receipt's "ambiguous" against a SEPTEMBER
 * publish on the live data. The reason chosen is the one whose receipt is
 * nearest the row's own posted_at.
 */
export function attachFlagship(publishes, { resolved, unresolved } = { resolved: new Map(), unresolved: [] }) {
  const byFile = new Map();
  for (const u of unresolved || []) {
    if (!u.drive_file_id) continue;
    if (!byFile.has(u.drive_file_id)) byFile.set(u.drive_file_id, []);
    byFile.get(u.drive_file_id).push(u);
  }
  return (publishes || []).map((row) => {
    const hit = resolved?.get?.(row.drive_file_id);
    if (hit) return { ...row, flagship: hit };
    return {
      ...row,
      flagship: {
        ig_post_id: null,
        reason: reasonForRow(byFile.get(row.drive_file_id), row.posted_at),
      },
    };
  });
}

/**
 * The reason that belongs to THIS publish: the one whose receipt sits nearest
 * the row's own posted_at. Entries with no receipt stamp sort last — they are
 * still better than nothing, but anything dated beats them.
 */
function reasonForRow(entries, postedAt) {
  if (!entries || entries.length === 0) return "no flagship hand-post has been confirmed for this video yet";
  if (entries.length === 1) return entries[0].why;
  const rowAt = parseStamp(postedAt);
  let best = entries[0];
  let bestGap = Infinity;
  for (const e of entries) {
    const at = parseStamp(e.receipt_at);
    const gap = Number.isNaN(at) || Number.isNaN(rowAt) ? Infinity : Math.abs(at - rowAt);
    if (gap < bestGap) {
      bestGap = gap;
      best = e;
    }
  }
  return best.why;
}
