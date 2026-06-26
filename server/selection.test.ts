import { describe, expect, it } from "vitest";
import {
  cdtTimeToUtcMs,
  defaultScheduleMs,
  getCdtPickDate,
  selectForCity,
  NO_REPEAT_DAYS,
  DAY_MS,
} from "./selection";
import type { Video } from "../drizzle/schema";

function vid(id: number, postId: string, views: number): Video {
  return {
    id,
    postId,
    city: "san_antonio",
    views,
    caption: `caption ${id}`,
    permalink: null,
    thumbnailUrl: null,
    onscreenText: null,
    originalTimestamp: null,
    mediaType: "VIDEO",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Video;
}

describe("selectForCity", () => {
  const now = Date.UTC(2026, 5, 26, 12, 0, 0);

  it("picks highest views when nothing reposted", () => {
    const lib = [vid(1, "a", 5000), vid(2, "b", 9000), vid(3, "c", 1000)];
    const r = selectForCity(lib, {}, new Set(), now);
    expect(r?.video.postId).toBe("b");
    expect(r?.mode).toBe("fresh");
  });

  it("skips a video reposted within 30 days", () => {
    const lib = [vid(1, "a", 9000), vid(2, "b", 8000)];
    const last = { a: now - 5 * DAY_MS }; // a within cooldown
    const r = selectForCity(lib, last, new Set(), now);
    expect(r?.video.postId).toBe("b");
    expect(r?.mode).toBe("fresh");
  });

  it("re-allows a video after 30 days", () => {
    const lib = [vid(1, "a", 9000), vid(2, "b", 8000)];
    const last = { a: now - (NO_REPEAT_DAYS + 1) * DAY_MS };
    const r = selectForCity(lib, last, new Set(), now);
    expect(r?.video.postId).toBe("a");
  });

  it("excludes a postId already chosen today", () => {
    const lib = [vid(1, "a", 9000), vid(2, "b", 8000)];
    const r = selectForCity(lib, {}, new Set(["a"]), now);
    expect(r?.video.postId).toBe("b");
  });

  it("falls back to least-recently reposted when all within cooldown", () => {
    const lib = [vid(1, "a", 9000), vid(2, "b", 8000)];
    const last = { a: now - 2 * DAY_MS, b: now - 10 * DAY_MS };
    const r = selectForCity(lib, last, new Set(), now);
    expect(r?.mode).toBe("fallback");
    expect(r?.video.postId).toBe("b"); // older repost first
  });

  it("returns null for empty library", () => {
    expect(selectForCity([], {}, new Set(), now)).toBeNull();
  });
});

describe("scheduling (CDT)", () => {
  it("maps 2PM CDT to 19:00 UTC", () => {
    const ms = cdtTimeToUtcMs("2026-06-26", 14);
    expect(new Date(ms).toISOString()).toBe("2026-06-26T19:00:00.000Z");
  });

  it("schedules SA at 2PM and Austin at 3PM (one hour apart)", () => {
    const sa = defaultScheduleMs("2026-06-26", "san_antonio");
    const austin = defaultScheduleMs("2026-06-26", "austin");
    expect(austin - sa).toBe(60 * 60 * 1000);
  });

  it("derives a YYYY-MM-DD pick date", () => {
    expect(getCdtPickDate(new Date("2026-06-26T18:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });
});
