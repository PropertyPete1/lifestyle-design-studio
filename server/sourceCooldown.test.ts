import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db + igHistorySync modules the guard depends on.
vi.mock("./db", () => ({
  getAllReposts: vi.fn(),
}));
vi.mock("./igHistorySync", async () => {
  const actual = await vi.importActual<typeof import("./igHistorySync")>(
    "./igHistorySync"
  );
  return {
    // keep the real caption fingerprint so matching behaves realistically
    captionFingerprint: actual.captionFingerprint,
    getRecentIgHistory: vi.fn(),
  };
});

import { checkSourceCooldown, COOLDOWN_DAYS } from "./sourceCooldown";
import * as db from "./db";
import { getRecentIgHistory } from "./igHistorySync";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.mocked(db.getAllReposts).mockReset();
  vi.mocked(getRecentIgHistory).mockReset();
  vi.mocked(db.getAllReposts).mockResolvedValue([] as any);
  vi.mocked(getRecentIgHistory).mockResolvedValue([] as any);
});

describe("checkSourceCooldown", () => {
  it("passes when nothing was posted recently", async () => {
    const r = await checkSourceCooldown({ postId: "abc", caption: "hello world", now: NOW });
    expect(r.blocked).toBe(false);
  });

  it("blocks when the same postId was posted within the window (via reposts)", async () => {
    vi.mocked(db.getAllReposts).mockResolvedValue([
      {
        id: 1,
        postId: "abc",
        captionUsed: "some other caption",
        status: "posted",
        postedAt: new Date(NOW - 3 * DAY),
        confirmedAt: new Date(NOW - 3 * DAY),
        scheduledFor: NOW - 3 * DAY,
      },
    ] as any);
    const r = await checkSourceCooldown({ postId: "abc", caption: "totally different", now: NOW });
    expect(r.blocked).toBe(true);
    expect(r.matchedBy).toBe("postId");
    expect(r.daysSinceLast).toBe(3);
  });

  it("blocks when the same caption fingerprint was posted within the window", async () => {
    const caption = "Brand new North Austin home starting at 455000 all closing costs paid";
    vi.mocked(db.getAllReposts).mockResolvedValue([
      {
        id: 2,
        postId: "different-id",
        captionUsed: caption,
        status: "posted",
        postedAt: new Date(NOW - 5 * DAY),
        confirmedAt: new Date(NOW - 5 * DAY),
        scheduledFor: NOW - 5 * DAY,
      },
    ] as any);
    const r = await checkSourceCooldown({ postId: "brand-new-id", caption, now: NOW });
    expect(r.blocked).toBe(true);
    expect(r.matchedBy).toBe("caption");
  });

  it("does NOT block when the only match is older than the cooldown window", async () => {
    vi.mocked(db.getAllReposts).mockResolvedValue([
      {
        id: 3,
        postId: "abc",
        captionUsed: "x",
        status: "posted",
        postedAt: new Date(NOW - (COOLDOWN_DAYS + 2) * DAY),
        confirmedAt: new Date(NOW - (COOLDOWN_DAYS + 2) * DAY),
        scheduledFor: NOW - (COOLDOWN_DAYS + 2) * DAY,
      },
    ] as any);
    const r = await checkSourceCooldown({ postId: "abc", caption: "y", now: NOW });
    expect(r.blocked).toBe(false);
  });

  it("excludes the repost we're currently publishing", async () => {
    vi.mocked(db.getAllReposts).mockResolvedValue([
      {
        id: 42,
        postId: "abc",
        captionUsed: "x",
        status: "confirmed",
        postedAt: null,
        confirmedAt: new Date(NOW - 1 * DAY),
        scheduledFor: NOW - 1 * DAY,
      },
    ] as any);
    const r = await checkSourceCooldown({
      postId: "abc",
      caption: "x",
      excludeRepostId: 42,
      now: NOW,
    });
    expect(r.blocked).toBe(false);
  });

  it("ignores failed reposts", async () => {
    vi.mocked(db.getAllReposts).mockResolvedValue([
      {
        id: 7,
        postId: "abc",
        captionUsed: "x",
        status: "failed",
        postedAt: null,
        confirmedAt: new Date(NOW - 1 * DAY),
        scheduledFor: NOW - 1 * DAY,
      },
    ] as any);
    const r = await checkSourceCooldown({ postId: "abc", caption: "x", now: NOW });
    expect(r.blocked).toBe(false);
  });

  it("blocks when the same postId is present in live IG history", async () => {
    vi.mocked(getRecentIgHistory).mockResolvedValue([
      { igPostId: "abc", captionSnippet: "whatever", postedAt: NOW - 2 * DAY },
    ] as any);
    const r = await checkSourceCooldown({ postId: "abc", caption: "unrelated", now: NOW });
    expect(r.blocked).toBe(true);
    expect(r.matchedBy).toBe("postId");
  });
});
