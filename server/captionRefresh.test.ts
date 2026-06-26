import { describe, expect, it } from "vitest";
import { splitHashtags } from "./captionRefresh";

describe("splitHashtags", () => {
  it("separates a trailing hashtag block from the body", () => {
    const cap =
      "Stunning new build in San Antonio\nStarting at $279,990\nComment INFO\n\n#sanantonio #realestate #texashomes";
    const { body, tags } = splitHashtags(cap);
    expect(body).toContain("Comment INFO");
    expect(body).not.toContain("#");
    expect(tags).toBe("#sanantonio #realestate #texashomes");
  });

  it("handles captions with no hashtags", () => {
    const cap = "Just a clean caption\nNo tags here";
    const { body, tags } = splitHashtags(cap);
    expect(body).toBe(cap);
    expect(tags).toBe("");
  });

  it("handles multi-line hashtag blocks", () => {
    const cap = "Body line\n#one #two\n#three";
    const { body, tags } = splitHashtags(cap);
    expect(body).toBe("Body line");
    expect(tags).toBe("#one #two\n#three");
  });

  it("handles empty input", () => {
    const { body, tags } = splitHashtags("");
    expect(body).toBe("");
    expect(tags).toBe("");
  });
});
