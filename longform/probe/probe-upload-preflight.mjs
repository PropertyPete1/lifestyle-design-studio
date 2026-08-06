#!/usr/bin/env node
/**
 * probe-upload-preflight.mjs — READ ONLY. Uploads nothing, creates nothing.
 *
 * One question, asked before any bytes move:
 *
 *   Can a file placed in Metricool's media library reach a connected social
 *   account without a separate, explicit post?
 *
 * The assumption is no. This checks it rather than assuming it, because the
 * cost of being wrong is a throwaway test file appearing on a real Instagram
 * or YouTube account.
 *
 * Method:
 *   1. enumerate the media-library endpoints and see what they expose
 *   2. count scheduler posts now, so the write test has a baseline to prove
 *      nothing new appeared
 *   3. look for ORPHAN media — library entries not referenced by any post.
 *      Orphans are the empirical proof that an upload is inert: if uploading
 *      implied posting, there could not be any.
 */

import { createHash } from "crypto";

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing METRICOOL_API_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID");
  process.exit(1);
}

function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>").split(BLOG_ID).join("<BLOG_ID>");
}

const authParams = (blogId = BLOG_ID) => `blogId=${blogId}&userId=${USER_ID}`;
const authHeaders = () => ({ "Content-Type": "application/json", "X-Mc-Auth": TOKEN });

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * The one mechanism that could defeat the structural argument.
 *
 * Metricool sells "autolists" / recycling / evergreen queues on some plans —
 * features that publish from a pool on a schedule without a per-post call. If
 * this brand had one configured AND it drew from the media library, an upload
 * really could reach an account with no explicit post. That is the assumption
 * worth attacking rather than restating.
 */
async function probeAutoPostingFeatures() {
  console.log("\n=== 0: IS ANY AUTO-PUBLISHING QUEUE CONFIGURED? ===");
  const candidates = [
    "/v2/scheduler/autolists", "/v2/autolists", "/v2/scheduler/recurrent",
    "/v2/scheduler/queues", "/v2/scheduler/recycle", "/v2/settings/autolists",
    "/v2/scheduler/evergreen", "/v2/scheduler/rss", "/v2/scheduler/best-times",
  ];
  let anyConfigured = false;
  for (const path of candidates) {
    const res = await api(`${path}?${authParams()}`);
    if (res.status === 404) { console.log(`  404  ${path}`); continue; }
    console.log(`  ${String(res.status).padStart(3)}  ${path}  <-- EXISTS`);
    if (res.ok) {
      const items = res.json?.data || res.json || [];
      const count = Array.isArray(items) ? items.length : (items && typeof items === "object" ? Object.keys(items).length : 0);
      console.log(`        ${count} entr(y|ies): ${redact(res.text).slice(0, 250)}`);
      if (Array.isArray(items) && items.length > 0) anyConfigured = true;
    }
  }
  console.log(anyConfigured
    ? "  >>> SOMETHING IS CONFIGURED — inspect the payloads above before uploading."
    : "  >>> No populated auto-publishing queue found on this brand.");
  return anyConfigured;
}

async function probeMediaEndpoints() {
  console.log("\n=== 1: WHAT DOES THE MEDIA LIBRARY EXPOSE? ===");
  const candidates = [
    "/v2/media",
    `/v2/media?limit=20`,
    "/v2/media/videos",
    "/v2/media/images",
    "/v2/media/list",
    "/v2/media/files",
    "/v2/media/library",
    "/v2/media/s3",
    "/v2/media/s3/upload-transactions",
  ];
  const found = [];
  for (const path of candidates) {
    const res = await api(`${path}?${authParams()}`);
    const exists = res.status !== 404;
    console.log(`  ${String(res.status).padStart(3)}  ${path}${exists ? "  <-- EXISTS" : ""}`);
    if (exists && res.ok) {
      console.log(`        ${redact(res.text).slice(0, 300)}`);
      found.push(path);
    }
  }
  return found;
}

async function schedulerBaseline() {
  console.log("\n=== 2: SCHEDULER BASELINE (so the write test can prove nothing posted) ===");
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19);
  const to = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 19);
  const res = await api(`/v2/scheduler/posts?${authParams()}&start=${from}&end=${to}`);
  if (!res.ok) {
    console.log(`  list failed (${res.status})`);
    return null;
  }
  const posts = res.json?.data || [];
  const future = posts.filter((p) => (p.publicationDate?.dateTime || "") > new Date().toISOString().slice(0, 19));
  console.log(`  ${posts.length} posts in the window, ${future.length} of them still scheduled`);
  console.log(`  baseline post ids: ${posts.length} total`);
  return { total: posts.length, ids: posts.map((p) => p.id), media: posts.flatMap((p) => p.media || []) };
}

/**
 * The decisive check.
 *
 * If every media file in the library were attached to a post, "upload" and
 * "post" would be the same act and uploading a test file would be unsafe. If
 * the library holds files no post references, an upload is demonstrably inert.
 */
async function probeOrphanMedia(baseline) {
  console.log("\n=== 3: IS THERE MEDIA THAT NO POST REFERENCES? ===");
  if (!baseline) {
    console.log("  no baseline — cannot answer");
    return;
  }
  const referenced = new Set(baseline.media.map((m) => String(m)));
  console.log(`  ${referenced.size} distinct media URLs are referenced by posts`);

  // Ask the library directly, if it will answer.
  for (const path of ["/v2/media", "/v2/media/list", "/v2/media/files"]) {
    const res = await api(`${path}?${authParams()}&limit=50`);
    if (!res.ok) continue;
    const items = res.json?.data?.items || res.json?.data || res.json?.items || [];
    if (!Array.isArray(items) || items.length === 0) continue;
    const urls = items.map((i) => i?.url || i?.fileUrl || i?.convertedFileUrl).filter(Boolean);
    const orphans = urls.filter((u) => !referenced.has(String(u)));
    console.log(`  ${path}: ${items.length} entries, ${orphans.length} referenced by NO post`);
    if (orphans.length > 0) {
      console.log(`  >>> ORPHAN MEDIA EXISTS — library entries are not posts.`);
      console.log(`      e.g. ${redact(orphans[0]).slice(0, 90)}`);
    }
    return { total: items.length, orphans: orphans.length };
  }
  console.log("  the library does not expose a listing endpoint — falling back to the structural argument below");
  return null;
}

function structuralArgument() {
  console.log("\n=== 4: THE STRUCTURAL ARGUMENT ===");
  console.log("  An upload transaction body is:");
  console.log("    { resourceType: 'planner', contentType, fileExtension, parts: [...] }");
  console.log("  It names NO social account. Nowhere in the upload flow is a network,");
  console.log("  a provider, or a blog's connected profile identified.");
  console.log("");
  console.log("  Publishing requires a SEPARATE call:");
  console.log("    POST /v2/scheduler/posts  { providers: [{ network: 'instagram' }], autoPublish: true, ... }");
  console.log("");
  console.log("  Metricool cannot publish a file it has not been told where to send.");
  console.log("  This is also how src/metricool.js already works in production: every");
  console.log("  post is an upload followed by an explicit, separate createPost().");
}

async function main() {
  console.log("PREFLIGHT — can a media-library upload reach a social account?");
  console.log("This script is READ ONLY. It uploads nothing and creates nothing.\n");
  await probeAutoPostingFeatures();
  await probeMediaEndpoints();
  const baseline = await schedulerBaseline();
  await probeOrphanMedia(baseline);
  structuralArgument();
  console.log("\nDone. No writes were made.");
}

main().catch((err) => {
  console.error(`\nPREFLIGHT ERROR: ${redact(err?.stack || String(err))}`);
  process.exitCode = 1;
});
