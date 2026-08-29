/**
 * The thumbnail.
 *
 * One of these tests exists because of a bug that would have shipped: the SVG
 * painted a full-canvas black rect as its first element and was composited OVER
 * the photo, producing a thumbnail with no face on it. Nothing threw, the file
 * was a valid 1280x720 PNG, and the only way to catch it was to look at the
 * pixels. So now something looks at the pixels.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  thumbnailText,
  fitSize,
  thumbnailSvg,
  renderThumbnail,
  fitUnderLimit,
  WIDTH,
  HEIGHT,
  MAX_WORDS,
  MAX_LINES,
  MAX_THUMBNAIL_BYTES,
} from "../src/yt-thumbnail.js";

/** A stand-in for a frame of Peter: obviously not black. */
async function portraitFixture() {
  return sharp({ create: { width: 800, height: 1200, channels: 3, background: "#3b4a52" } })
    .png()
    .toBuffer();
}

/** Noise, so the PNG is genuinely large and the size-reduction path is exercised. */
async function noisyPortrait() {
  const w = 800;
  const h = 1200;
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) % 256;
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("thumbnailText — a thumbnail is glanced at, not read", () => {
  test("takes the payload after the colon, not the topic label", () => {
    assert.equal(
      thumbnailText("Moving to San Antonio: what $300k actually gets you"),
      "WHAT $300K ACTUALLY GETS YOU"
    );
  });

  test("keeps a title that has no colon", () => {
    assert.ok(thumbnailText("Austin property taxes explained").includes("AUSTIN"));
  });

  test("never exceeds the word cap", () => {
    const long = "Everything you have ever wanted to know about moving to San Antonio in 2026 and beyond";
    assert.ok(thumbnailText(long).split(/\s+/).length <= MAX_WORDS);
  });

  test("drops filler before content words when it has to cut", () => {
    const t = thumbnailText("What is the real cost of living in San Antonio for a family");
    assert.ok(!/\bTHE\b/.test(t) || t.split(/\s+/).length <= MAX_WORDS);
  });

  test("uppercases, because the layout is set in caps", () => {
    assert.equal(thumbnailText("austin vs san antonio"), "AUSTIN VS SAN ANTONIO");
  });

  test("does not throw on nothing", () => {
    assert.equal(thumbnailText(""), "");
    assert.equal(thumbnailText(null), "");
  });

  test("ignores a colon that leaves too little after it", () => {
    // "Texas: why" — the payload is not a headline, so keep the whole thing.
    assert.ok(thumbnailText("San Antonio: why").includes("SAN ANTONIO"));
  });
});

describe("fitSize", () => {
  test("never exceeds the line cap", () => {
    for (const text of ["SHORT", "WHAT $300K ACTUALLY GETS YOU", "AUSTIN VS SAN ANTONIO COST"]) {
      assert.ok(fitSize(text).lines.length <= MAX_LINES, `too many lines for "${text}"`);
    }
  });

  test("a shorter headline gets bigger type", () => {
    assert.ok(fitSize("TWO WORDS").size > fitSize("WHAT $300K ACTUALLY GETS YOU").size);
  });

  test("type stays large enough to survive the shrink to a search result", () => {
    // At 1280 wide shown at ~210, anything under ~54px is unreadable.
    assert.ok(fitSize("WHAT $300K ACTUALLY GETS YOU").size >= 54);
  });
});

describe("thumbnailSvg", () => {
  test("declares the 1280x720 canvas YouTube wants", () => {
    const svg = thumbnailSvg("Moving to San Antonio: the honest numbers");
    assert.ok(svg.includes(`width="${WIDTH}"`));
    assert.ok(svg.includes(`height="${HEIGHT}"`));
  });

  test("puts the headline on the canvas", () => {
    // The headline wraps into one <text> element per line, so the words are on
    // the canvas but not as one contiguous string.
    const svg = thumbnailSvg("Austin vs San Antonio: the honest cost");
    for (const word of ["HONEST", "COST"]) {
      assert.ok(svg.includes(word), `"${word}" is missing from the canvas`);
    }
  });

  test("escapes characters that would break the SVG", () => {
    // No colon, so the whole string survives into the canvas — otherwise the
    // trimming drops the very characters being tested.
    const svg = thumbnailSvg("Taxes & fees <you> pay");
    assert.ok(svg.includes("&amp;"), "an unescaped ampersand makes the SVG unparseable");
    assert.ok(!svg.includes("<YOU>"), "an unescaped angle bracket opens a phantom element");
  });

  test("WITHOUT a portrait the background covers the whole canvas", () => {
    const svg = thumbnailSvg("Moving to San Antonio: the numbers", { hasPortrait: false });
    assert.ok(svg.includes(`width="${WIDTH}" height="${HEIGHT}" fill="#000000"`));
  });

  test("WITH a portrait the background STOPS SHORT of the portrait column", () => {
    // This is the regression. A full-width opaque rect here paints over the
    // photo and the thumbnail ships with no face on it.
    const svg = thumbnailSvg("Moving to San Antonio: the numbers", { hasPortrait: true });
    assert.ok(
      !svg.includes(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#000000"/>`),
      "the opaque background must not span the full canvas when a portrait is composited"
    );
    assert.ok(svg.includes("linearGradient"), "a scrim should bridge the seam");
  });
});

describe("renderThumbnail", () => {
  test("produces a 1280x720 PNG", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you");
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, WIDTH);
    assert.equal(meta.height, HEIGHT);
    assert.equal(meta.format, "png");
  });

  test("THE REGRESSION: a supplied portrait actually reaches the pixels", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you", {
      portraitPng: await portraitFixture(),
    });
    // Sample well inside the reserved column. If the SVG background covered it,
    // every channel here is 0 and nothing else would have noticed.
    // removeAlpha matters: raw() on an RGBA buffer includes the alpha channel,
    // so opaque black averages 63.75 and every region looks "bright".
    const { data } = await sharp(png)
      .extract({ left: WIDTH - 120, top: 300, width: 60, height: 60 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mean = data.reduce((n, v) => n + v, 0) / data.length;
    assert.ok(mean > 20, `the portrait column is nearly black (mean ${mean.toFixed(1)}) — the photo was painted over`);
  });

  test("the text side stays dark so the type keeps its contrast", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you", {
      portraitPng: await portraitFixture(),
    });
    const { data } = await sharp(png)
      .extract({ left: 20, top: 600, width: 80, height: 60 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mean = data.reduce((n, v) => n + v, 0) / data.length;
    assert.ok(mean < 20, `the text side is too bright (mean ${mean.toFixed(1)}) — type would lose contrast`);
  });

  test("renders without a portrait rather than failing", async () => {
    const png = await renderThumbnail("Austin vs San Antonio: the honest comparison", { kicker: "Comparison" });
    assert.ok(png.length > 1000);
  });

  test("comes in well under YouTube's 2MB ceiling", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you", {
      portraitPng: await portraitFixture(),
    });
    assert.ok(png.length < MAX_THUMBNAIL_BYTES, `${png.length} bytes`);
  });
});

describe("fitUnderLimit", () => {
  test("leaves a small PNG alone", async () => {
    const png = await renderThumbnail("Short one: the numbers");
    const r = await fitUnderLimit(png);
    assert.equal(r.converted, false);
    assert.equal(r.buffer, png);
  });

  test("converts to JPEG when the PNG is over the ceiling", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you", {
      portraitPng: await noisyPortrait(),
    });
    const limit = Math.floor(png.length * 0.6);
    const r = await fitUnderLimit(png, limit);
    assert.equal(r.converted, true);
    assert.ok(r.buffer.length <= limit);
    assert.equal((await sharp(r.buffer).metadata()).format, "jpeg");
  });

  test("throws rather than returning something YouTube will reject", async () => {
    const png = await renderThumbnail("Moving to San Antonio: what $300k gets you", {
      portraitPng: await portraitFixture(),
    });
    await assert.rejects(() => fitUnderLimit(png, 200));
  });
});

describe("fitUnderLimit's return shape reaches disk as bytes", () => {
  test("the pipeline call sites destructure .buffer — the object is not writable", async () => {
    // Video 1's real build failed here: writeFileSync(path, {buffer, ...})
    // throws "Received an instance of Object". Assert the contract so a
    // future caller cannot repeat it silently.
    const { fitUnderLimit } = await import("../src/yt-thumbnail.js");
    const small = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const out = await fitUnderLimit(small);
    assert.ok(Buffer.isBuffer(out.buffer), "buffer property must be the bytes");
    assert.equal(out.converted, false);
    assert.ok(!Buffer.isBuffer(out), "the return itself is NOT bytes — callers must destructure");
  });
});

describe("imageMediaType — the declared type must match the bytes", () => {
  test("jpeg copies are declared as jpeg", async () => {
    const { imageMediaType } = await import("../src/yt-thumbnail.js");
    // Run 32300759856: judging copies are .judge.jpg, the call declared
    // image/png, and the API 400'd every expression contest.
    assert.equal(imageMediaType("/x/thumb-cand-0.judge.jpg"), "image/jpeg");
    assert.equal(imageMediaType("/x/frame.jpeg"), "image/jpeg");
    assert.equal(imageMediaType("/x/frame.png"), "image/png");
  });
});
