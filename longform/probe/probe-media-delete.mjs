#!/usr/bin/env node
/**
 * probe-media-delete.mjs — remove the multipart test file, and prove it is gone.
 *
 * The round-trip probe uploaded a throwaway slate, verified it byte-for-byte,
 * and then could not delete it: no endpoint it tried accepted the request and
 * the URL kept serving. That is the TikTok lesson landing exactly where it was
 * predicted — a cleanup step that reports success it has not earned.
 *
 * This hunts for the real delete endpoint. It takes the target URL as an
 * argument so it can never delete anything it was not pointed at, and it always
 * finishes by re-fetching: if the bytes are still being served, this exits
 * non-zero and says so, whatever any endpoint returned.
 *
 * Run:
 *   node probe-media-delete.mjs "https://static.metricool.com/video/.../file.mp4"
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;
const TARGET = process.argv[2] || process.env.MEDIA_URL;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing METRICOOL_API_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID");
  process.exit(1);
}
if (!TARGET || !/^https:\/\/static\.metricool\.com\//.test(TARGET)) {
  console.error("Pass the static.metricool.com URL to delete as the first argument.");
  console.error("Refusing to run without an explicit target.");
  process.exit(1);
}

function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>").split(BLOG_ID).join("<BLOG_ID>");
}

const authParams = () => `blogId=${BLOG_ID}&userId=${USER_ID}`;
const authHeaders = () => ({ "Content-Type": "application/json", "X-Mc-Auth": TOKEN });

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/** static.metricool.com/video/<user>/<yyyymm>/<name> -> planner/<user>/<yyyymm>/<name> */
function s3KeyFromUrl(url) {
  const m = url.match(/static\.metricool\.com\/(?:video|image)\/(.+)$/);
  return m ? `planner/${m[1]}` : null;
}

async function stillServing() {
  const res = await fetch(TARGET, { method: "GET", headers: { Range: "bytes=0-1023" } }).catch(() => null);
  return { ok: Boolean(res && res.ok), status: res ? res.status : "network error" };
}

async function main() {
  console.log(`TARGET: ${redact(TARGET)}`);
  const key = s3KeyFromUrl(TARGET);
  console.log(`derived S3 key: ${redact(String(key))}`);

  const before = await stillServing();
  console.log(`serving before: ${before.ok} (${before.status})`);
  if (!before.ok) {
    console.log("Already gone. Nothing to do.");
    return;
  }

  console.log("\n=== HUNTING A DELETE ENDPOINT ===");
  const attempts = [
    ["DELETE", `/v2/media?${authParams()}&url=${encodeURIComponent(TARGET)}`, null],
    ["DELETE", `/v2/media?${authParams()}&key=${encodeURIComponent(key || "")}`, null],
    ["DELETE", `/v2/media/s3?${authParams()}&key=${encodeURIComponent(key || "")}`, null],
    ["DELETE", `/v2/media/s3/upload-transactions?${authParams()}&key=${encodeURIComponent(key || "")}`, null],
    ["DELETE", `/v2/media/files?${authParams()}&url=${encodeURIComponent(TARGET)}`, null],
    ["POST", `/v2/media/delete?${authParams()}`, { url: TARGET, key }],
    ["POST", `/v2/media/s3/delete?${authParams()}`, { key }],
    ["DELETE", `/v2/media/planner?${authParams()}&key=${encodeURIComponent(key || "")}`, null],
    ["DELETE", `/v2/media/s3/objects?${authParams()}&key=${encodeURIComponent(key || "")}`, null],
  ];

  for (const [method, path, body] of attempts) {
    const res = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const label = `${method} ${path.split("?")[0]}`;
    console.log(`  ${String(res.status).padStart(3)}  ${label}`);
    if (res.status !== 404 && res.status !== 405 && !res.ok) {
      console.log(`        ${redact(res.text).slice(0, 200)}`);
    }
    if (res.ok) {
      console.log(`        ACCEPTED: ${redact(res.text).slice(0, 200)}`);
      // Do not trust it. Check.
      const after = await stillServing();
      console.log(`        re-fetch says serving: ${after.ok} (${after.status})`);
      if (!after.ok) {
        console.log(`\n>>> DELETED AND VERIFIED via ${label}`);
        return;
      }
      console.log("        endpoint returned OK but the bytes are still there — continuing");
    }
  }

  const after = await stillServing();
  console.log(`\n=== RESULT ===`);
  console.log(`still serving: ${after.ok} (${after.status})`);
  if (after.ok) {
    console.log("");
    console.log("NO API DELETE PATH EXISTS for planner media on this account.");
    console.log("The file has to be removed by hand: Metricool > Planner > Media library.");
    console.log(`  ${TARGET}`);
    console.log("");
    console.log("This matters beyond the test file: the long-form uploader will put a");
    console.log("~320MB video into this library every week, and if nothing can delete");
    console.log("them the library grows without bound. Worth raising with Metricool.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nDELETE PROBE ERROR: ${redact(err?.stack || String(err))}`);
  process.exitCode = 1;
});
