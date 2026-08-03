#!/usr/bin/env node
/**
 * diagnose-tiktok.mjs — how do TikTok posts actually resolve on this account?
 *
 * The JPEG carousel test reached AWAITING_CONFIRMATION rather than PUBLISHED.
 * The question that decides the fix: is that photo-specific, or does every
 * TikTok post from this account go through it? The property reels have been
 * publishing to TikTok for months, so they are the control.
 *
 * READ ONLY.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;
const redact = (s) => String(s ?? "").split(TOKEN).join("<TOKEN>").split(USER_ID).join("<USER>").split(String(BLOG_ID)).join("<BLOG>");

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "Content-Type": "application/json", "X-Mc-Auth": TOKEN } });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

const fmt = (d) => d.toISOString().slice(0, 19);

async function main() {
  const from = fmt(new Date(Date.now() - 120 * 86400_000));
  const to = fmt(new Date(Date.now() + 7 * 86400_000));
  const res = await api(`/v2/scheduler/posts?blogId=${BLOG_ID}&userId=${USER_ID}&start=${from}&end=${to}`);
  const posts = res.json?.data || [];
  console.log(`Scanned ${posts.length} posts on the main brand over 120 days\n`);

  const tiktok = [];
  for (const p of posts) {
    for (const pr of p.providers || []) {
      if (pr.network !== "tiktok") continue;
      tiktok.push({
        id: p.id,
        date: p.publicationDate?.dateTime,
        status: pr.status,
        detail: pr.detailedStatus,
        mediaCount: (p.media || []).length,
        isPhoto: (p.media || []).some((m) => /\.(png|jpe?g|webp)(\?|$)/i.test(m)),
        isVideo: (p.media || []).some((m) => /\.(mp4|mov)(\?|$)/i.test(m)),
      });
    }
  }

  tiktok.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  console.log(`Found ${tiktok.length} TikTok posts:\n`);
  console.log("date                 kind    media  status                  detail");
  for (const t of tiktok) {
    const kind = t.isVideo ? "VIDEO" : t.isPhoto ? "PHOTO" : "?";
    console.log(
      `${String(t.date).padEnd(20)} ${kind.padEnd(7)} ${String(t.mediaCount).padStart(3)}    ` +
      `${String(t.status).padEnd(23)} ${redact(String(t.detail || "")).slice(0, 70)}`
    );
  }

  const tally = {};
  for (const t of tiktok) {
    const kind = t.isVideo ? "VIDEO" : "PHOTO";
    tally[kind] = tally[kind] || {};
    tally[kind][t.status] = (tally[kind][t.status] || 0) + 1;
  }
  console.log(`\n=== status by media kind ===`);
  console.log(JSON.stringify(tally, null, 2));
}

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(1); });
