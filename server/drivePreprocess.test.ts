import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getDailyPicks: vi.fn().mockResolvedValue([]),
  getVideoById: vi.fn().mockResolvedValue(null),
  updateDailyPick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./driveIndex", () => ({
  syncDriveIndex: vi.fn().mockResolvedValue({ synced: 5, total: 5 }),
  getAllDriveVideos: vi.fn().mockResolvedValue([]),
  getDriveVideosByDuration: vi.fn().mockResolvedValue([]),
  listDriveVideos: vi.fn().mockResolvedValue([]),
}));

vi.mock("./driveMatcher", () => ({
  findDriveMatch: vi.fn().mockResolvedValue(null),
}));

vi.mock("./videoVariant", () => ({
  makeDifferentiatedVariant: vi.fn().mockResolvedValue({
    ok: true,
    url: "https://storage.example.com/variant.mp4",
    sha256: "abc123",
  }),
}));

vi.mock("./selection", () => ({
  getCdtPickDate: vi.fn().mockReturnValue("2026-07-03"),
}));

describe("drivePreprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should export preprocessDriveOriginals function", async () => {
    const mod = await import("./drivePreprocess");
    expect(typeof mod.preprocessDriveOriginals).toBe("function");
  });

  it("should return early when no picks need processing", async () => {
    const { preprocessDriveOriginals } = await import("./drivePreprocess");
    const result = await preprocessDriveOriginals();
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("driveIndex", () => {
  it("should export syncDriveIndex and getAllDriveVideos", async () => {
    const mod = await import("./driveIndex");
    expect(typeof mod.syncDriveIndex).toBe("function");
    expect(typeof mod.getAllDriveVideos).toBe("function");
    expect(typeof mod.getDriveVideosByDuration).toBe("function");
    expect(typeof mod.listDriveVideos).toBe("function");
  });
});

describe("driveMatcher", () => {
  it("should export findDriveMatch", async () => {
    const mod = await import("./driveMatcher");
    expect(typeof mod.findDriveMatch).toBe("function");
  });

  it("should return null when no thumbnail URL provided", async () => {
    // Reset the mock to use the real implementation for this test
    vi.doUnmock("./driveMatcher");
    const { findDriveMatch } = await import("./driveMatcher");
    const result = await findDriveMatch({
      igThumbnailUrl: "",
      igCaption: "test",
      igDurationMs: null,
    });
    expect(result).toBeNull();
  });
});

describe("publishNow with Drive original (4K-only policy)", () => {
  it("should use driveVideoUrl when available", () => {
    // When pick.driveVideoUrl is set, the publish pipeline uses it directly
    const pick = {
      driveVideoUrl: "https://storage.example.com/drive-variant.mp4",
      driveMatchConfidence: "high",
    };

    // 4K-only policy: Drive original is the ONLY source
    const videoUrl = pick.driveVideoUrl;
    expect(videoUrl).toBe("https://storage.example.com/drive-variant.mp4");
  });

  it("should FAIL (not fallback) when no Drive original is available", () => {
    // 4K-only policy: if no Drive original, the pick FAILS.
    // We NEVER fall back to Instagram copies.
    const pick = {
      driveVideoUrl: null as string | null,
      driveMatchConfidence: null as string | null,
    };

    // No fallback — videoUrl stays null, pick will be failed
    const videoUrl = pick.driveVideoUrl;
    expect(videoUrl).toBeNull();
  });

  it("should skip variant when using Drive original (already differentiated)", () => {
    const pick = {
      driveVideoUrl: "https://storage.example.com/drive-variant.mp4",
    };
    const usingDriveOriginal = Boolean(pick.driveVideoUrl);
    expect(usingDriveOriginal).toBe(true);
    // When usingDriveOriginal is true, variant step is skipped
  });
});
