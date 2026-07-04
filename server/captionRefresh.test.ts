import { describe, expect, it } from "vitest";
import { splitHashtags } from "./captionRefresh";

describe("splitHashtags", () => {
  it("separates a trailing hashtag block from the body", () => {
    const cap =
      "Stunning new build in San Antonio\nStarting at $279,990\n\n#sanantonio #realestate #texashomes";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toContain("Starting at $279,990");
    expect(body).not.toContain("#");
    expect(cta).toBe("");
    expect(tags).toBe("#sanantonio #realestate #texashomes");
  });

  it("handles captions with no hashtags", () => {
    const cap = "Just a clean caption\nNo tags here";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toBe(cap);
    expect(cta).toBe("");
    expect(tags).toBe("");
  });

  it("handles multi-line hashtag blocks", () => {
    const cap = "Body line\n#one #two\n#three";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toBe("Body line");
    expect(cta).toBe("");
    expect(tags).toBe("#one #two\n#three");
  });

  it("handles empty input", () => {
    const { body, cta, tags } = splitHashtags("");
    expect(body).toBe("");
    expect(cta).toBe("");
    expect(tags).toBe("");
  });

  it("extracts CTA lines (Comment pattern) before hashtags", () => {
    const cap =
      "🏡 brand new homes starting in the $320s\n\nComment INFO for details\n\n#veteran #military #texas";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toContain("brand new homes");
    expect(body).not.toContain("Comment INFO");
    expect(cta).toBe("Comment INFO for details");
    expect(tags).toBe("#veteran #military #texas");
  });

  it("extracts CTA lines (FILL OUT THE LINK pattern)", () => {
    const cap =
      "🏡 Hill Country views\n\nFILL OUT THE LINK IN BIO FOR INFO\n\n#realestate #texas";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toContain("Hill Country views");
    expect(cta).toContain("FILL OUT THE LINK IN BIO");
    expect(tags).toBe("#realestate #texas");
  });

  it("extracts CTA lines (DM pattern)", () => {
    const cap =
      "🏡 Amazing homes\n\nDM us for more info\n\n#austin #realestate";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toContain("Amazing homes");
    expect(cta).toBe("DM us for more info");
    expect(tags).toBe("#austin #realestate");
  });

  it("preserves full caption structure with body + CTA + hashtags", () => {
    const cap =
      "🧊 proof you can still get a brand new home with real space\n" +
      "🪟 bright open layouts smart storage\n\n" +
      "Comment SA for San Antonio info\n\n" +
      "#veteran #military #texas #sanantonio #realestate";
    const { body, cta, tags } = splitHashtags(cap);
    expect(body).toContain("proof you can still get");
    expect(body).toContain("bright open layouts");
    expect(cta).toBe("Comment SA for San Antonio info");
    expect(tags).toBe("#veteran #military #texas #sanantonio #realestate");
  });
});
