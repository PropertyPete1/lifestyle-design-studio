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
 * Returns a Map of driveFileId -> {
 *   ig_post_id, method, confidence, url, published_at, confirmed_at
 * } for the resolved, plus `unresolved` explaining each one that failed.
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

  const resolved = new Map();
  const unresolved = [];
  // ig_post_id -> the driveFileId that claimed it. A post belongs to one video.
  const claimedBy = new Map();

  for (const r of receiptsWithPublish(posts)) {
    const name = r.driveFileId || `receipt@${r.receipt.timestamp}`;
    if (!r.publish) {
      unresolved.push({ drive_file_id: null, receipt_at: r.receipt.timestamp, code: "no_publish_for_receipt", why: "receipt's delivered-copy id matches no publish in the log" });
      continue;
    }
    if (!r.captionKey) {
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: r.receipt.timestamp, code: "no_caption", why: "no caption text to match on" });
      continue;
    }

    const textHits = candidates.filter((c) => keysAgree(c.key, r.captionKey));
    let hit = null;
    let method = null;
    if (textHits.length === 1) {
      hit = textHits[0];
      method = "caption";
    } else if (textHits.length > 1) {
      const near = Number.isNaN(r.postedAtMs)
        ? []
        : textHits.filter((c) => !Number.isNaN(c.at) && Math.abs(c.at - r.postedAtMs) <= MATCH_WINDOW_HOURS * 3600000);
      if (near.length === 1) {
        hit = near[0];
        method = "caption+time";
      } else {
        unresolved.push({
          drive_file_id: r.driveFileId,
          receipt_at: r.receipt.timestamp,
          code: "ambiguous",
          why: `${textHits.length} flagship posts share this caption opening and ${near.length} are within ${MATCH_WINDOW_HOURS}h — ambiguous`,
        });
        continue;
      }
    } else {
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: r.receipt.timestamp, code: "no_caption_match", why: "no flagship post in the analytics window opens with this caption" });
      continue;
    }

    // ONE POST, ONE VIDEO. Two publishes claiming one flagship post means at
    // least one is wrong, and nothing here can tell which — so BOTH lose it.
    // Keeping the first would silently credit one video with another's numbers.
    const priorOwner = claimedBy.get(hit.id);
    if (priorOwner && priorOwner !== r.driveFileId) {
      resolved.delete(priorOwner);
      unresolved.push({ drive_file_id: priorOwner, code: "contested", why: `flagship post ${hit.id} was also matched by ${name} — both refused` });
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: r.receipt.timestamp, code: "contested", why: `flagship post ${hit.id} was also matched by ${priorOwner} — both refused` });
      claimedBy.set(hit.id, "__contested__");
      continue;
    }
    if (priorOwner === "__contested__") {
      unresolved.push({ drive_file_id: r.driveFileId, receipt_at: r.receipt.timestamp, code: "contested", why: `flagship post ${hit.id} is contested by more than one video` });
      continue;
    }

    claimedBy.set(hit.id, r.driveFileId);
    resolved.set(r.driveFileId, {
      ig_post_id: hit.id,
      url: hit.url,
      published_at: Number.isNaN(hit.at) ? null : new Date(hit.at).toISOString(),
      confirmed_at: r.receipt.mainIgPostedAt || r.receipt.timestamp || null,
      // "caption" means one post in the window opens with this caption and no
      // other does. "caption+time" means several did and exactly one was inside
      // the window — a tie broken by the clock, which is weaker.
      method,
      confidence: method === "caption" ? "high" : "medium",
    });
  }

  return { resolved, unresolved };
}

/**
 * Attach the resolved flagship block to each manifest row. PURE — returns new
 * rows, never mutates the manifest this pipeline writes at publish time.
 *
 * A row always carries a `flagship` key. Unresolved is `{ ig_post_id: null,
 * reason }`, because "we could not tie this one" and "we never looked" must not
 * read the same to whoever consumes this file.
 */
export function attachFlagship(publishes, { resolved, unresolved } = { resolved: new Map(), unresolved: [] }) {
  const reasons = new Map();
  for (const u of unresolved || []) if (u.drive_file_id && !reasons.has(u.drive_file_id)) reasons.set(u.drive_file_id, u.why);
  return (publishes || []).map((row) => {
    const hit = resolved?.get?.(row.drive_file_id);
    if (hit) return { ...row, flagship: hit };
    return {
      ...row,
      flagship: {
        ig_post_id: null,
        reason: reasons.get(row.drive_file_id) || "no flagship hand-post has been confirmed for this video yet",
      },
    };
  });
}
