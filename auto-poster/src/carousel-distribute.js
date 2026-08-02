/**
 * carousel-distribute.js — publish a rendered carousel to the paths Phase 1 proved.
 *
 * Proven and built (see issue #11):
 *   Instagram satellites  native photo carousel, auto-published
 *   TikTok                photo carousel; Metricool infers photo mode from the
 *                         media types, so contentType is deliberately omitted
 *   Facebook              multi-image post
 *   LinkedIn              PDF document post via publishImagesAsPDF
 *
 * Deliberately NOT built:
 *   Instagram main        never auto-published — deliverToOwner, owner posts
 *                         natively, which is also the only route to real
 *                         trending audio
 *   YouTube               has no photo-carousel format. The scheduler accepts a
 *                         draft with images and reports PENDING, but that is
 *                         lazy validation, not support. Unproven, so not built.
 *   Trending audio        no field on the API surface carries it
 *
 * Brand discovery is local to this module rather than reusing getAllBrands(),
 * which cannot see LinkedIn: it probes `p.linkedin`, but the profile field is
 * actually `linkedinCompany`. Left alone there on purpose — createPost() filters
 * LinkedIn out of its allowed list anyway, so changing it would alter the
 * reported platform summary of the existing poster for no benefit.
 */

import { createHash } from "crypto";

const BASE = "https://app.metricool.com/api";

const authParams = (blogId) => `blogId=${blogId}&userId=${process.env.METRICOOL_USER_ID}`;
const authHeaders = () => ({
  "Content-Type": "application/json",
  "X-Mc-Auth": process.env.METRICOOL_API_TOKEN,
});

/** Chicago-local datetime string, the format Metricool's scheduler expects. */
export function chicagoDateTime(offsetMs = 90_000) {
  const target = new Date(Date.now() + offsetMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(target);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/**
 * Discover brands and which of the carousel-relevant networks each carries.
 * `isMain` marks the brand whose Instagram must never be auto-published.
 */
export async function getCarouselBrands() {
  const url = `${BASE}/admin/simpleProfiles?userId=${process.env.METRICOOL_USER_ID}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`getCarouselBrands failed (${res.status})`);

  const mainBlogId = Number(process.env.METRICOOL_BLOG_ID);
  const brands = [];
  for (const p of await res.json()) {
    if (p.deleted === true || p.isDemo === true) continue;
    const blogId = Number(p.id || p.blogId);
    if (!blogId) continue;
    const networks = [];
    if (p.instagram) networks.push("instagram");
    if (p.facebook) networks.push("facebook");
    if (p.tiktok) networks.push("tiktok");
    if (p.linkedinCompany) networks.push("linkedin");
    if (networks.length === 0) continue;
    brands.push({ blogId, label: String(p.label || blogId), networks, isMain: blogId === mainBlogId });
  }
  return brands;
}

/** Upload one PNG to a brand's media library. Mirrors the video flow in metricool.js. */
export async function uploadImageToBrand(blogId, buf) {
  const sha256b64 = createHash("sha256").update(buf).digest("base64");
  const size = buf.length;

  const txRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      resourceType: "planner",
      contentType: "image/png",
      fileExtension: "png",
      parts: [{ size, startByte: 0, endByte: size, hash: sha256b64 }],
    }),
  });
  if (!txRes.ok) throw new Error(`image transaction failed (${txRes.status})`);
  const tx = (await txRes.json()).data;
  if (!tx?.presignedUrl) throw new Error("no presigned URL for image upload");

  const put = await fetch(tx.presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(size),
      "x-amz-checksum-sha256": sha256b64,
    },
    body: new Uint8Array(buf),
  });
  if (!put.ok) throw new Error(`image S3 upload failed (${put.status})`);

  const doneRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ simple: { fileUrl: tx.fileUrl } }),
  });
  if (!doneRes.ok) throw new Error(`image upload completion failed (${doneRes.status})`);

  const done = (await doneRes.json()).data;
  const hosted = done?.convertedFileUrl || done?.fileUrl || tx.fileUrl;
  if (!hosted) throw new Error("no hosted URL after image upload");
  return hosted;
}

/** Upload a whole slide deck to one brand, in order. */
export async function uploadSlides(blogId, pngBuffers) {
  const urls = [];
  for (const buf of pngBuffers) urls.push(await uploadImageToBrand(blogId, buf));
  return urls;
}

async function schedulePost(blogId, body) {
  const res = await fetch(`${BASE}/v2/scheduler/posts?${authParams(blogId)}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: `API error ${res.status}: ${JSON.stringify(raw).slice(0, 200)}` };
  }
  return { ok: true, postId: raw?.data?.id || raw?.id || "unknown" };
}

// ─── Per-network post bodies ────────────────────────────────────────────────

export function instagramCarouselBody(mediaUrls, caption, publishAt) {
  return {
    text: caption,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "instagram" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    instagramData: { type: "POST", autoPublish: true },
  };
}

export function tiktokCarouselBody(mediaUrls, caption, publishAt) {
  return {
    text: caption,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "tiktok" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    // contentType is omitted on purpose: the probe showed all four spellings are
    // dropped and Metricool sets photoCoverIndex itself once it sees images.
    tiktokData: { privacyOption: "PUBLIC_TO_EVERYONE", autoPublish: true, photoCoverIndex: 0 },
  };
}

export function facebookCarouselBody(mediaUrls, caption, publishAt) {
  return {
    text: caption,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "facebook" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    facebookData: { type: "POST" },
  };
}

export function linkedinDocumentBody(mediaUrls, caption, publishAt, documentTitle) {
  return {
    text: caption,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "linkedin" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    linkedinData: { publishImagesAsPDF: true, documentTitle },
  };
}

// ─── Fan-out ────────────────────────────────────────────────────────────────

/**
 * Publish a carousel across every proven path.
 *
 * @param {object} opts
 * @param {Buffer[]} opts.slides            rendered PNGs, in order
 * @param {string}   opts.caption           IG / TikTok / Facebook caption
 * @param {string}   opts.linkedinCaption   professional caption for LinkedIn
 * @param {string}   opts.documentTitle     LinkedIn document title
 * @param {boolean}  opts.dryRun
 * @returns {{ ok: boolean, results: Array }}
 */
export async function distributeCarousel({ slides, caption, linkedinCaption, documentTitle, dryRun = false }) {
  const brands = await getCarouselBrands();
  const publishAt = chicagoDateTime();
  const results = [];

  if (dryRun) {
    for (const b of brands) {
      const targets = [];
      if (b.networks.includes("instagram")) {
        targets.push(b.isMain ? "instagram (SKIPPED - deliverToOwner)" : "instagram carousel");
      }
      if (b.networks.includes("tiktok")) targets.push("tiktok carousel");
      if (b.networks.includes("facebook")) targets.push("facebook multi-image");
      if (b.networks.includes("linkedin")) targets.push("linkedin PDF document");
      console.log(`[Carousel] DRY RUN — ${b.label}: ${targets.join(", ") || "nothing"}`);
      results.push({ label: b.label, dryRun: true, targets });
    }
    return { ok: true, dryRun: true, results };
  }

  for (const brand of brands) {
    let mediaUrls;
    try {
      mediaUrls = await uploadSlides(brand.blogId, slides);
      console.log(`[Carousel] uploaded ${mediaUrls.length} slides to ${brand.label}`);
    } catch (err) {
      console.error(`[Carousel] ✗ ${brand.label}: slide upload failed — ${err.message}`);
      results.push({ label: brand.label, network: "upload", ok: false, error: err.message });
      continue;
    }

    const post = async (network, body) => {
      const r = await schedulePost(brand.blogId, body);
      if (r.ok) {
        console.log(`[Carousel] ✓ ${brand.label} ${network} (post ${r.postId})`);
      } else {
        console.error(`[Carousel] ✗ ${brand.label} ${network}: ${r.error}`);
      }
      results.push({ label: brand.label, network, ...r });
    };

    // Main Instagram is never auto-published. That is the whole point of the
    // manual-assist flow; the owner posts it natively with trending audio.
    if (brand.networks.includes("instagram") && !brand.isMain) {
      await post("instagram", instagramCarouselBody(mediaUrls, caption, publishAt));
    } else if (brand.isMain) {
      console.log(`[Carousel] ${brand.label}: skipping main Instagram — delivered to owner instead`);
      results.push({ label: brand.label, network: "instagram", ok: true, skipped: "deliverToOwner" });
    }

    if (brand.networks.includes("tiktok")) {
      await post("tiktok", tiktokCarouselBody(mediaUrls, caption, publishAt));
    }
    if (brand.networks.includes("facebook")) {
      await post("facebook", facebookCarouselBody(mediaUrls, caption, publishAt));
    }
    if (brand.networks.includes("linkedin")) {
      await post("linkedin", linkedinDocumentBody(mediaUrls, linkedinCaption, publishAt, documentTitle));
    }
  }

  const published = results.filter((r) => r.ok && !r.skipped);
  const failed = results.filter((r) => !r.ok);
  console.log(`[Carousel] distribution: ${published.length} published, ${failed.length} failed`);
  return { ok: published.length > 0, results };
}
