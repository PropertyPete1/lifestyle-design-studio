#!/usr/bin/env node
/**
 * probe-youtube-path.mjs — Phase 0, question 2. PUBLISHES NOTHING.
 *
 * Settles which pipe carries a 10-15 minute long-form video to YouTube with the
 * metadata the format actually needs:
 *
 *   title, description, tags, chapters (they live in the description),
 *   a custom 1280x720 thumbnail, notForKids, and the altered-or-synthetic
 *   content disclosure that a HeyGen avatar of Peter's likeness legally requires.
 *
 * Two candidate pipes:
 *   A. Metricool /v2/scheduler/posts with youtubeData  (already wired, already paid for)
 *   B. YouTube Data API v3 videos.insert               (needs a new OAuth scope)
 *
 * METHOD for pipe A. Metricool's help centre lists what the WEB planner exposes.
 * Docs describe the UI, not the API, and they go stale — so we settle it by
 * observation instead of by reading:
 *   A1. enumerate which brands actually have YouTube connected,
 *   A2. dump a real existing YouTube post object — if the API models a field at
 *       all, it surfaces on read,
 *   A3. round-trip every plausible spelling of every field we need through a
 *       draft. Write it, read it back, keep what survives. A field the API
 *       silently drops on write is a field that silently drops at publish time.
 *
 * METHOD for pipe B. No upload happens here — Phase 0 proves capability, it does
 * not publish. We check the granted scopes on whatever token exists and report
 * whether videos.insert would be reachable, plus the audit restriction that
 * governs what privacyStatus an unaudited project is allowed to set.
 *
 * SAFETY:
 *   - every probe post is draft:true + autoPublish:false,
 *   - every created draft is deleted in a finally block and the deletion is
 *     verified with a follow-up GET,
 *   - no token is ever printed; redact() scrubs them from all output.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const DEFAULT_BLOG = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !DEFAULT_BLOG) {
  console.error("Missing METRICOOL_API_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID");
  process.exit(1);
}

/** Scrub secrets out of anything we print. */
function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  let out = str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>");
  for (const v of [process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REFRESH_TOKEN, process.env.YT_REFRESH_TOKEN]) {
    if (v) out = out.split(v).join("<REDACTED>");
  }
  return out;
}

function authParams(blogId = DEFAULT_BLOG) {
  return `blogId=${blogId}&userId=${USER_ID}`;
}

function authHeaders() {
  return { "Content-Type": "application/json", "X-Mc-Auth": TOKEN };
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const created = [];

async function createDraft(blogId, body, label) {
  const res = await api(`/v2/scheduler/posts?${authParams(blogId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const id = res.json?.data?.id || res.json?.id;
  if (id) created.push({ id, blogId, label });
  return { ...res, id };
}

async function deleteDraft({ id, blogId, label }) {
  const res = await api(`/v2/scheduler/posts/${id}?${authParams(blogId)}`, { method: "DELETE" });
  const check = await api(`/v2/scheduler/posts/${id}?${authParams(blogId)}`);
  const gone = check.status === 404 || check.status === 400 || !check.json?.data;
  console.log(`  [cleanup] ${label} id=${id}: delete=${res.status} verified_gone=${gone}`);
  return gone;
}

function futureDateTime(daysAhead = 14) {
  const d = new Date(Date.now() + daysAhead * 86400_000);
  return d.toISOString().slice(0, 19);
}

/** Every key in an object, flattened, so a field cannot hide in a nested branch. */
function allKeys(o, prefix = "", acc = new Set()) {
  if (!o || typeof o !== "object") return acc;
  for (const [k, v] of Object.entries(o)) {
    acc.add(prefix + k);
    if (v && typeof v === "object" && !Array.isArray(v)) allKeys(v, `${prefix}${k}.`, acc);
  }
  return acc;
}

// ─── A1: which brands have YouTube connected ────────────────────────────────

async function probeYoutubeBrands() {
  console.log("\n=== A1: BRANDS WITH YOUTUBE CONNECTED ===");
  const res = await api(`/admin/simpleProfiles?userId=${USER_ID}`);
  if (!res.ok) {
    console.log(`  FAILED (${res.status}): ${redact(res.text).slice(0, 200)}`);
    return [];
  }
  const brands = [];
  for (const p of res.json || []) {
    if (p.deleted === true || p.isDemo === true) continue;
    const nets = [];
    for (const n of ["instagram", "facebook", "tiktok", "youtube", "linkedin"]) {
      if (typeof p[n] === "string" && p[n]) nets.push(n);
    }
    const brand = { blogId: Number(p.id || p.blogId), label: String(p.label || p.id), networks: nets };
    if (nets.includes("youtube")) brands.push(brand);
    console.log(`  blogId=${brand.blogId}  label="${brand.label}"  networks=[${nets.join(", ")}]${nets.includes("youtube") ? "  <-- YOUTUBE" : ""}`);
  }
  console.log(`  ${brands.length} brand(s) can receive a YouTube post`);
  return brands;
}

// ─── A2: what does a real YouTube post object look like on read ─────────────

async function probeExistingYoutubeShape() {
  console.log("\n=== A2: SHAPE OF A REAL YOUTUBE POST OBJECT ===");
  const from = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 19);
  const to = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 19);
  const res = await api(`/v2/scheduler/posts?${authParams()}&start=${from}&end=${to}`);
  if (!res.ok) {
    console.log(`  list failed (${res.status}): ${redact(res.text).slice(0, 200)}`);
    return null;
  }
  const posts = res.json?.data || [];
  console.log(`  ${posts.length} posts in window`);

  const yt = posts.find(p => p.youtubeData) ||
             posts.find(p => (p.providers || []).some(x => String(x.network).toLowerCase() === "youtube"));
  if (!yt) {
    console.log("  no YouTube post found in window — cannot read a live shape");
    return null;
  }

  const keys = [...allKeys(yt)];
  const ytKeys = Object.keys(yt.youtubeData || {});
  console.log(`  post has ${keys.length} keys total`);
  console.log(`  youtubeData keys: ${ytKeys.join(", ") || "(youtubeData absent)"}`);
  console.log(`  youtubeData value: ${redact(JSON.stringify(yt.youtubeData || {})).slice(0, 500)}`);

  const interesting = keys.filter(k => /thumb|kid|child|audience|synthetic|ai|disclos|alter|tag|categor|privacy|type/i.test(k));
  console.log(`  metadata-shaped keys anywhere on the object: ${interesting.join(", ") || "NONE"}`);
  return { keys, ytKeys };
}

// ─── A3: round-trip every field long-form needs ─────────────────────────────

/**
 * Candidate spellings for each capability we need. Metricool's API is
 * undocumented on these, so we write every plausible name at once and let the
 * read-back tell us which ones are real.
 */
const CANDIDATES = {
  longFormType: ["type"],
  title: ["title"],
  description: ["description", "text"],
  tags: ["tags", "keywords"],
  thumbnail: ["thumbnail", "thumbnailUrl", "customThumbnail", "thumbnailImage", "cover", "coverUrl"],
  madeForKids: ["madeForKids", "notForKids", "selfDeclaredMadeForKids", "audience", "forKids", "kidsContent"],
  aiDisclosure: [
    "containsSyntheticMedia", "syntheticMedia", "alteredContent", "aiDisclosure",
    "aiGenerated", "disclosureAiContent", "alteredOrSyntheticContent", "isAiGenerated",
  ],
  category: ["category", "categoryId"],
  privacy: ["privacy", "privacyStatus"],
};

async function probeLongFormRoundTrip(brand, mediaUrl) {
  console.log("\n=== A3: ROUND-TRIP LONG-FORM FIELDS THROUGH A DRAFT ===");
  console.log(`  brand: ${brand.label} (blogId=${brand.blogId})`);
  console.log(`  media: ${mediaUrl ? redact(mediaUrl).slice(0, 80) : "(none available)"}`);

  const youtubeData = {
    // The central question: does anything other than "short" get accepted?
    type: "video",
    title: "Phase 0 probe - draft, never published",
    description: "Probe description.\n\n00:00 Intro\n01:30 Section one\n\nChapters live here.",
    tags: ["probe", "moving to san antonio", "austin vs san antonio"],
    privacy: "private",
    category: "22",
    categoryId: "22",
  };
  // Every candidate spelling for the fields the docs do not cover.
  for (const name of CANDIDATES.thumbnail) youtubeData[name] = "https://example.invalid/probe-thumb-1280x720.jpg";
  for (const name of CANDIDATES.madeForKids) youtubeData[name] = name === "audience" ? "NOT_MADE_FOR_KIDS" : false;
  for (const name of CANDIDATES.aiDisclosure) youtubeData[name] = true;

  const body = {
    text: "Phase 0 capability probe - draft, never published.",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "youtube" }],
    media: mediaUrl ? [mediaUrl] : [],
    draft: true,
    autoPublish: false,
    shortener: false,
    youtubeData,
  };

  const res = await createDraft(brand.blogId, body, "youtube-longform-roundtrip");
  console.log(`  create: ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${redact(res.text).slice(0, 600)}`);
    return { accepted: false, status: res.status, error: redact(res.text).slice(0, 600) };
  }

  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams(brand.blogId)}`);
  const data = back.json?.data || {};
  const echoed = data.youtubeData || {};
  console.log(`  read-back youtubeData: ${redact(JSON.stringify(echoed)).slice(0, 800)}`);

  const survived = {};
  for (const [capability, names] of Object.entries(CANDIDATES)) {
    const kept = names.filter(n => echoed[n] !== undefined && echoed[n] !== null);
    survived[capability] = kept;
    const verdict = kept.length
      ? `SURVIVED as ${kept.map(n => `${n}=${JSON.stringify(echoed[n])}`).join(", ")}`
      : "DROPPED";
    console.log(`  ${capability.padEnd(14)} ${verdict}`);
  }

  // The type field decides whether this is even a long-form pipe.
  const typeBack = echoed.type;
  console.log(`\n  >>> youtubeData.type written "video", read back ${JSON.stringify(typeBack)}`);
  if (String(typeBack).toLowerCase() === "short") {
    console.log("  >>> Metricool coerced long-form to SHORT — pipe A cannot carry a 10-15 min video.");
  }

  return { accepted: true, echoed, survived, typeBack };
}

/** Also try the short form, as a control: proves the round-trip method itself works. */
async function probeShortControl(brand, mediaUrl) {
  console.log("\n=== A3-control: same round-trip with type:\"short\" ===");
  const res = await createDraft(brand.blogId, {
    text: "Phase 0 control probe - draft, never published.",
    publicationDate: { dateTime: futureDateTime(15), timezone: "America/Chicago" },
    providers: [{ network: "youtube" }],
    media: mediaUrl ? [mediaUrl] : [],
    draft: true,
    autoPublish: false,
    youtubeData: { type: "short", privacy: "private", title: "control probe" },
  }, "youtube-short-control");
  console.log(`  create: ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${redact(res.text).slice(0, 400)}`);
    return { accepted: false, status: res.status };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams(brand.blogId)}`);
  console.log(`  read-back youtubeData: ${redact(JSON.stringify(back.json?.data?.youtubeData || {})).slice(0, 300)}`);
  return { accepted: true };
}

/** Reuse a media URL Metricool already hosts — never upload anything new. */
async function findExistingMediaUrl() {
  const from = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 19);
  const to = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 19);
  const res = await api(`/v2/scheduler/posts?${authParams()}&start=${from}&end=${to}`);
  for (const p of res.json?.data || []) {
    const m = (p.media || [])[0];
    if (typeof m === "string" && m.startsWith("http")) return m;
  }
  return null;
}

// ─── B: YouTube Data API v3 reachability ────────────────────────────────────

async function probeYoutubeDataApi() {
  console.log("\n=== B: YOUTUBE DATA API v3 — SCOPE CHECK (no upload) ===");
  const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
  const FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";

  const candidates = [
    ["YT_REFRESH_TOKEN", process.env.YT_REFRESH_TOKEN],
    ["GOOGLE_REFRESH_TOKEN", process.env.GOOGLE_REFRESH_TOKEN],
  ];

  for (const [name, refresh] of candidates) {
    if (!refresh) {
      console.log(`  ${name}: not set — skipped`);
      continue;
    }
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.log(`  ${name}: present but GOOGLE_CLIENT_ID/SECRET missing — cannot exchange`);
      continue;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      console.log(`  ${name}: token exchange failed (${res.status}) ${redact(await res.text()).slice(0, 200)}`);
      continue;
    }
    const { access_token } = await res.json();
    const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${access_token}`)
      .then(r => r.json()).catch(() => ({}));
    const scopes = String(info.scope || "").split(" ").filter(Boolean);
    console.log(`  ${name}: granted scopes:`);
    for (const s of scopes) console.log(`      ${s}`);
    console.log(`  ${name}: youtube.upload  -> ${scopes.includes(UPLOAD_SCOPE) ? "YES" : "NO"}`);
    console.log(`  ${name}: youtube.force-ssl -> ${scopes.includes(FORCE_SSL) ? "YES" : "NO"}`);

    if (scopes.includes(UPLOAD_SCOPE) || scopes.includes(FORCE_SSL)) {
      // Read-only: confirm the token resolves a channel we can upload to.
      const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,status&mine=true", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const chJson = await ch.json().catch(() => ({}));
      const item = (chJson.items || [])[0];
      console.log(`  ${name}: channel -> ${item ? `${item.snippet?.title} (${item.id})` : `none (${ch.status})`}`);
    }
  }
  console.log("\n  Reference (developers.google.com/youtube/v3/docs/videos/insert):");
  console.log("    videos.insert writable status fields include selfDeclaredMadeForKids");
  console.log("    and containsSyntheticMedia — the AI disclosure IS settable via the API.");
  console.log("    Unaudited API projects created after 2020-07-28 are restricted to");
  console.log("    private videos until Google audits the project.");
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("PHASE 0 PROBE — long-form YouTube upload path");
  console.log("This script creates DRAFTS ONLY and deletes them. It publishes nothing.\n");

  const brands = await probeYoutubeBrands();
  await probeExistingYoutubeShape();

  if (brands.length === 0) {
    console.log("\nNo YouTube-connected brand — cannot round-trip pipe A.");
  } else {
    const mediaUrl = await findExistingMediaUrl();
    const brand = brands.find(b => b.blogId === Number(DEFAULT_BLOG)) || brands[0];
    await probeShortControl(brand, mediaUrl);
    await probeLongFormRoundTrip(brand, mediaUrl);
  }

  await probeYoutubeDataApi();
}

main()
  .catch(err => {
    console.error(`\nPROBE ERROR: ${redact(err?.stack || String(err))}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log("\n=== CLEANUP ===");
    let allGone = true;
    for (const d of created) {
      try {
        const gone = await deleteDraft(d);
        if (!gone) allGone = false;
      } catch (err) {
        allGone = false;
        console.log(`  [cleanup] ${d.label} id=${d.id} FAILED: ${redact(err.message)}`);
      }
    }
    console.log(allGone ? "  all probe drafts removed" : "  WARNING: some drafts survived — delete them by hand");
    if (!allGone) process.exitCode = 1;
  });
