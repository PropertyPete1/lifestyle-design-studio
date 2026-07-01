import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks: LLM + db are external; we control their outputs per test. ---
const invokeLLMMock = vi.fn();
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: unknown[]) => invokeLLMMock(...args),
}));

const getLatestMetricsPerPostMock = vi.fn();
vi.mock("./db", () => ({
  getLatestMetricsPerPost: () => getLatestMetricsPerPostMock(),
}));

import {
  optimizeHook,
  findCtaLine,
  hashtagSet,
  getWinningHooks,
  likelyWeakFirstFrame,
} from "./hookOptimizer";

function llmReturns(text: string) {
  invokeLLMMock.mockResolvedValue({
    choices: [{ message: { content: text } }],
  });
}

beforeEach(() => {
  invokeLLMMock.mockReset();
  getLatestMetricsPerPostMock.mockReset();
  getLatestMetricsPerPostMock.mockResolvedValue([]); // no history by default
});

describe("findCtaLine", () => {
  it("finds a plain Comment CTA", () => {
    const cta = findCtaLine("Beautiful home\nComment HOME for details\nMore text");
    expect(cta?.line).toBe("Comment HOME for details");
  });
  it("finds a Comment CTA behind a leading emoji", () => {
    const cta = findCtaLine("Great light\n\uD83D\uDC47 Comment SA to learn more");
    expect(cta?.index).toBe(1);
  });
  it("returns null when there is no Comment CTA", () => {
    expect(findCtaLine("Just a description\nWith no cta")).toBeNull();
  });
});

describe("hashtagSet", () => {
  it("extracts a lowercased set of hashtags", () => {
    const s = hashtagSet("hi #RealEstate #Austin #realestate");
    expect(s.has("#realestate")).toBe(true);
    expect(s.has("#austin")).toBe(true);
    expect(s.size).toBe(2);
  });
});

describe("likelyWeakFirstFrame", () => {
  it("flags a logo/brand opener", () => {
    expect(likelyWeakFirstFrame("Lifestyle Design Realty presents\nA home")).toBe(true);
  });
  it("flags a static exterior opener", () => {
    expect(likelyWeakFirstFrame("Exterior of this stunning build\n...")).toBe(true);
  });
  it("does not flag a strong hook", () => {
    expect(likelyWeakFirstFrame("Wait, that's the price?\n...")).toBe(false);
  });
});

describe("getWinningHooks", () => {
  it("ranks by views discounted by skip rate and returns opening lines", async () => {
    getLatestMetricsPerPostMock.mockResolvedValue([
      { network: "instagram", brandLabel: "A", views: 5000, skipRate: 60, captionSnippet: "Wait, that's the price? Huge value" },
      { network: "instagram", brandLabel: "A", views: 5000, skipRate: 90, captionSnippet: "Boring intro line here" },
      { network: "instagram", brandLabel: "A", views: 100, skipRate: 50, captionSnippet: "Small reach line" },
    ]);
    const hooks = await getWinningHooks(undefined, 2);
    expect(hooks[0].hook).toContain("Wait, that's the price");
    expect(hooks.length).toBe(2);
  });
  it("returns [] when there is no data", async () => {
    getLatestMetricsPerPostMock.mockResolvedValue([]);
    expect(await getWinningHooks()).toEqual([]);
  });
});

describe("optimizeHook safety guards", () => {
  const CTA = "Comment HOME for the full tour";
  const original = [
    "Boring opener line about a house.",
    "This 4 bed 3 bath sits in Austin at $625,000 with great light and a big backyard that the family will love for years.",
    CTA,
    "",
    "#RealEstate #Austin #LifestyleDesignRealty",
  ].join("\n");

  it("applies a stronger hook while preserving CTA + hashtags + length", async () => {
    // LLM returns body (no hashtags) with a new opener, CTA intact, body kept long.
    llmReturns(
      [
        "Wait \u2014 that light, that backyard, at THIS price?",
        "This 4 bed 3 bath sits in Austin at $625,000 with great light and a big backyard that the family will love for years.",
        CTA,
      ].join("\n")
    );
    const res = await optimizeHook(original);
    expect(res.changed).toBe(true);
    expect(res.caption).toContain(CTA); // CTA preserved verbatim
    expect(res.caption).toContain("#RealEstate");
    expect(res.caption).toContain("#Austin");
    expect(res.caption).toContain("#LifestyleDesignRealty");
    expect(res.caption).toContain("$625,000"); // facts preserved
  });

  it("fails safe (returns original) if the CTA is dropped", async () => {
    llmReturns(
      [
        "New strong hook line here for the win.",
        "This 4 bed 3 bath sits in Austin at $625,000 with great light and a big backyard that the family will love for years.",
      ].join("\n")
    );
    const res = await optimizeHook(original);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("cta-dropped");
    expect(res.caption).toBe(original);
  });

  it("fails safe if the model adds hashtags into the body", async () => {
    llmReturns(
      [
        "Strong hook #spam",
        "This 4 bed 3 bath sits in Austin at $625,000 with great light and a big backyard that the family will love for years.",
        CTA,
      ].join("\n")
    );
    const res = await optimizeHook(original);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("added-hashtags");
    expect(res.caption).toBe(original);
  });

  it("fails safe if the CTA becomes the very first line", async () => {
    llmReturns(
      [
        CTA,
        "This 4 bed 3 bath sits in Austin at $625,000 with great light and a big backyard that the family will love for years.",
      ].join("\n")
    );
    const res = await optimizeHook(original);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("cta-is-opener");
  });

  it("fails safe if the caption is gutted (too short)", async () => {
    llmReturns(["Short.", CTA].join("\n"));
    const res = await optimizeHook(original);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("too-short");
    expect(res.caption).toBe(original);
  });

  it("fails safe on LLM error", async () => {
    invokeLLMMock.mockRejectedValue(new Error("boom"));
    const res = await optimizeHook(original);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("llm-error");
    expect(res.caption).toBe(original);
  });

  it("returns original for an empty body", async () => {
    const res = await optimizeHook("   ");
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("empty-body");
  });
});
