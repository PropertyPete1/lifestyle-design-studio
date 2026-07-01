import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db + igHistorySync used by sourceCooldown.
const mockReposts: any[] = [];
let mockIgHistory: any[] = [];

vi.mock("./db", () => ({
  getAllReposts: async () => mockReposts,
}));

vi.mock("./igHistorySync", async () => {
  const actual = await vi.importActual<typeof import("./igHistorySync")>("./igHistorySync");
  return {
    ...actual,
    getRecentIgHistory: async () => mockIgHistory,
  };
});

import { checkSourceCooldown, COOLDOWN_DAYS } from "./sourceCooldown";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 1, 19, 0, 0); // Jul 1 2026 14:00 CDT

describe("checkSourceCooldown", () => {
  beforeEach(() => {
    mockReposts.length = 0;
    mockIgHistory = [];
  });

  it("blocks when the same postId was posted within cooldown (dashboard repost)", async () => {
    mockReposts.push({
      id: 1,
      postId: "111",
      captionUsed: "🧊 this is the type of new build",
      status: "posted",
      postedAt: new Date(NOW - 2 * DAY),
      confirmedAt: new Date(NOW - 2 * DAY),
      scheduledFor: NOW - 2 * DAY,
    });
    const res = await checkSourceCooldown({ postId: "111", caption: "different caption text here", now: NOW });
    expect(res.blocked).toBe(true);
    expect(res.matchedBy).toBe("postId");
    expect(res.daysSinceLast).toBe(2);
  });

  it("blocks when a caption fingerprint matches within cooldown even if postId differs", async () => {
    mockIgHistory = [
      {
        igPostId: "999",
        captionSnippet: "🧊 this is the type of new build that makes people say wait",
        postedAt: NOW - 5 * DAY,
      },
    ];
    const res = await checkSourceCooldown({
      postId: "222",
      caption: "🧊 this is the type of new build that makes people say wait",
      now: NOW,
    });
    expect(res.blocked).toBe(true);
    expect(res.matchedBy).toBe("caption");
  });

  it("does NOT block when the last post is older than the cooldown window", async () => {
    mockReposts.push({
      id: 1,
      postId: "111",
      captionUsed: "same caption",
      status: "posted",
      postedAt: new Date(NOW - (COOLDOWN_DAYS + 2) * DAY),
      scheduledFor: NOW - (COOLDOWN_DAYS + 2) * DAY,
    });
    const res = await checkSourceCooldown({ postId: "111", caption: "same caption", now: NOW });
    expect(res.blocked).toBe(false);
  });

  it("does NOT block a genuinely fresh video", async () => {
    mockIgHistory = [
      { igPostId: "aaa", captionSnippet: "golden hour really shines out here", postedAt: NOW - 1 * DAY },
    ];
    const res = await checkSourceCooldown({
      postId: "brand-new",
      caption: "fresh build energy without the crazy price tag",
      now: NOW,
    });
    expect(res.blocked).toBe(false);
  });

  it("excludes the current repost row from the scan (self-match)", async () => {
    mockReposts.push({
      id: 42,
      postId: "111",
      captionUsed: "self caption",
      status: "confirmed",
      confirmedAt: new Date(NOW - 1 * DAY),
      scheduledFor: NOW - 1 * DAY,
    });
    const res = await checkSourceCooldown({
      postId: "111",
      caption: "self caption",
      excludeRepostId: 42,
      now: NOW,
    });
    expect(res.blocked).toBe(false);
  });

  it("ignores failed reposts", async () => {
    mockReposts.push({
      id: 7,
      postId: "111",
      captionUsed: "failed caption",
      status: "failed",
      confirmedAt: new Date(NOW - 1 * DAY),
      scheduledFor: NOW - 1 * DAY,
    });
    const res = await checkSourceCooldown({ postId: "111", caption: "failed caption", now: NOW });
    expect(res.blocked).toBe(false);
  });
});
