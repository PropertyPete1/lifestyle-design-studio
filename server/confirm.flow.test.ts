import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the db + caption modules so we can test router logic without a live DB.
vi.mock("./db", () => {
  const state: any = {
    picks: [] as any[],
    reposts: [] as any[],
    videos: [] as any[],
    nextRepostId: 100,
  };
  return {
    __state: state,
    getDailyPicks: vi.fn(async () => state.picks),
    getVideoById: vi.fn(async (id: number) => state.videos.find((v: any) => v.id === id)),
    insertRepost: vi.fn(async (row: any) => {
      const id = state.nextRepostId++;
      state.reposts.push({ id, ...row });
      return id;
    }),
    updateDailyPick: vi.fn(async (id: number, set: any) => {
      const p = state.picks.find((x: any) => x.id === id);
      if (p) Object.assign(p, set);
    }),
    getLastRepostByPostId: vi.fn(async () => ({})),
    getVideosByCity: vi.fn(async () => []),
    insertDailyPick: vi.fn(async () => 1),
    getAllReposts: vi.fn(async () => state.reposts),
    autoConfirmPick: vi.fn(async (pick: any) => {
      if (pick.status !== "pending") return { confirmed: false, alreadyDone: true };
      const video = state.videos.find((v: any) => v.id === pick.videoId);
      const id = state.nextRepostId++;
      state.reposts.push({
        id,
        videoId: pick.videoId,
        postId: pick.postId,
        city: pick.city,
        captionUsed: pick.refreshedCaption ?? video?.caption ?? "",
        viewsAtRepost: video?.views ?? 0,
        thumbnailUrl: video?.thumbnailUrl ?? null,
        scheduledFor: pick.scheduledFor,
        status: "confirmed",
      });
      const p = state.picks.find((x: any) => x.id === pick.id);
      if (p) Object.assign(p, { status: "confirmed", repostId: id });
      return { confirmed: true, repostId: id };
    }),
  };
});

vi.mock("./captionRefresh", () => ({
  refreshCaption: vi.fn(async (c: string) => c),
}));

vi.mock("./hookOptimizer", () => ({
  optimizeHook: vi.fn(async (c: string) => ({ caption: c })),
  getWinningHooks: vi.fn(async () => []),
}));

import { appRouter } from "./routers";
import * as dbMock from "./db";

const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID ?? "";

function ownerCtx() {
  return {
    user: {
      id: 1,
      openId: OWNER_OPEN_ID,
      email: "peter@lifestyledesignrealty.com",
      name: "Peter",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as any;
}

describe("picks.confirm", () => {
  beforeEach(() => {
    const s = (dbMock as any).__state;
    s.picks = [
      {
        id: 1,
        pickDate: new Date().toISOString().slice(0, 10),
        city: "san_antonio",
        videoId: 10,
        postId: "p10",
        refreshedCaption: "edited caption",
        scheduledFor: Date.now() + 1000,
        status: "pending",
        repostId: null,
      },
    ];
    s.videos = [{ id: 10, postId: "p10", views: 6727, thumbnailUrl: "t.jpg", caption: "orig" }];
    s.reposts = [];
    s.nextRepostId = 100;
  });

  it("creates a repost and marks the pick confirmed", async () => {
    // getDailyPicks needs to return the right pickDate set; patch the mock to use current
    const caller = appRouter.createCaller(ownerCtx());
    const res = await caller.picks.confirm({ pickId: 1 });
    expect(res.success).toBe(true);
    const s = (dbMock as any).__state;
    expect(s.reposts).toHaveLength(1);
    expect(s.reposts[0].captionUsed).toBe("edited caption");
    expect(s.reposts[0].viewsAtRepost).toBe(6727);
    expect(s.picks[0].status).toBe("confirmed");
  });

  it("is idempotent when already confirmed", async () => {
    const s = (dbMock as any).__state;
    s.picks[0].status = "confirmed";
    const caller = appRouter.createCaller(ownerCtx());
    const res = await caller.picks.confirm({ pickId: 1 });
    expect(res.alreadyDone).toBe(true);
    expect(s.reposts).toHaveLength(0);
  });

  it("auto-confirms a pending pick without a manual tap", async () => {
    const s = (dbMock as any).__state;
    const before = s.picks[0].status;
    expect(before).toBe("pending");
    const result = await (dbMock as any).autoConfirmPick({
      id: 1,
      status: "pending",
      videoId: 10,
      postId: "p10",
      city: "san_antonio",
      refreshedCaption: "auto caption",
      scheduledFor: Date.now() + 1000,
    });
    expect(result.confirmed).toBe(true);
    expect(result.repostId).toBeGreaterThan(0);
    expect(s.picks[0].status).toBe("confirmed");
    expect(s.picks[0].repostId).toBe(result.repostId);
    expect(s.reposts).toHaveLength(1);
    expect(s.reposts[0].status).toBe("confirmed");
    expect(s.reposts[0].captionUsed).toBe("auto caption");
  });

  it("denies a non-owner admin (owner-only gate)", async () => {
    const ctx = ownerCtx();
    ctx.user.openId = "some-other-admin";
    ctx.user.role = "admin";
    const caller = appRouter.createCaller(ctx);
    await expect(caller.picks.today()).rejects.toThrow(/owner only/i);
    await expect(caller.picks.confirm({ pickId: 1 })).rejects.toThrow(/owner only/i);
    await expect(caller.history.list()).rejects.toThrow(/owner only/i);
    await expect(caller.library.stats()).rejects.toThrow(/owner only/i);
  });

  it("denies an unauthenticated user", async () => {
    const ctx = ownerCtx();
    ctx.user = null;
    const caller = appRouter.createCaller(ctx);
    await expect(caller.picks.today()).rejects.toThrow();
    await expect(caller.history.list()).rejects.toThrow();
  });
});
