#!/usr/bin/env node
/**
 * diagnose-tiktok.mjs — why did 2026-08-03's TikTok carousel never appear?
 *
 * The run recorded ok:true because the scheduler accepted the post. Acceptance
 * is not publication. This asks Metricool what actually happened to it, and
 * dumps the stored object so the TikTok body can be compared against the
 * Instagram one from the same run, which did publish.
 *
 * READ ONLY. Creates nothing, deletes nothing.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

const redact = (s) => String(s ?? "")
  .split(TOKEN).join("<TOKEN>")
  .split(USER_ID).join("<USER>")
  .split(String(BLOG_ID)).join("<BLOG>");

async function getPost(id, blogId = BLOG_ID) {
  const res = await fetch(`${BASE}/v2/scheduler/posts/${id}?blogId=${blogId}&userId=${USER_ID}`, {
    headers: { "Content-Type": "application/json", "X-Mc-Auth": TOKEN },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function summarise(label, data) {
  if (!data) return console.log(`\n--- ${label}: NO DATA ---`);
  console.log(`\n--- ${label} ---`);
  console.log(`  providers:`);
  for (const p of data.providers || []) {
    console.log(`    network=${p.network} status=${p.status} detailedStatus=${JSON.stringify(p.detailedStatus)}`);
    for (const k of Object.keys(p)) {
      if (!["network", "status", "detailedStatus"].includes(k)) {
        console.log(`      ${k}: ${redact(JSON.stringify(p[k])).slice(0, 300)}`);
      }
    }
  }
  console.log(`  media count: ${(data.media || []).length}`);
  console.log(`  tiktokData:    ${redact(JSON.stringify(data.tiktokData))}`);
  console.log(`  instagramData: ${redact(JSON.stringify(data.instagramData))}`);
  console.log(`  publicationDate: ${redact(JSON.stringify(data.publicationDate))}`);
  for (const k of ["status", "detailedStatus", "errors", "validationErrors", "autoPublish", "draft", "hasNotes"]) {
    if (data[k] !== undefined) console.log(`  ${k}: ${redact(JSON.stringify(data[k])).slice(0, 400)}`);
  }
}

async function main() {
  // From the 2026-08-03 run log.
  const TIKTOK_POST = 357434895;   // never appeared
  const LINKEDIN_POST = 357434900; // same brand, same run, published fine

  console.log("=== TIKTOK POST (did not appear) ===");
  const tt = await getPost(TIKTOK_POST);
  console.log(`HTTP ${tt.status}`);
  summarise(`tiktok ${TIKTOK_POST}`, tt.json?.data);

  console.log("\n\n=== CONTROL: LINKEDIN POST, SAME BRAND AND RUN (published) ===");
  const li = await getPost(LINKEDIN_POST);
  console.log(`HTTP ${li.status}`);
  summarise(`linkedin ${LINKEDIN_POST}`, li.json?.data);

  console.log("\n\n=== FULL RAW TIKTOK OBJECT ===");
  console.log(redact(JSON.stringify(tt.json?.data, null, 2)));
}

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(1); });
