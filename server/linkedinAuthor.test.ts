import { describe, it, expect, vi, beforeEach } from "vitest";

// LLM + db are external; control their outputs per test.
const invokeLLMMock = vi.fn();
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: unknown[]) => invokeLLMMock(...args),
}));
const getRecentLinkedinPostsMock = vi.fn();
vi.mock("./db", () => ({
  getRecentLinkedinPosts: () => getRecentLinkedinPostsMock(),
}));

import { sanitizePost, wordCount, topicForDate, generateLinkedinPost } from "./linkedinAuthor";
import { LINKEDIN_TOPICS } from "../shared/const";

function llmReturns(text: string) {
  invokeLLMMock.mockResolvedValue({ choices: [{ message: { content: text } }] });
}

beforeEach(() => {
  invokeLLMMock.mockReset();
  getRecentLinkedinPostsMock.mockReset();
  getRecentLinkedinPostsMock.mockResolvedValue([]);
});

describe("sanitizePost", () => {
  it("removes em-dashes and en-dashes", () => {
    const out = sanitizePost("Leaders lead — managers manage – always.");
    expect(out).not.toMatch(/[—–]/);
  });
  it("strips hashtags", () => {
    const out = sanitizePost("Join us today #realestate #recruiting");
    expect(out).not.toContain("#");
  });
  it("removes a preamble line and wrapping quotes", () => {
    const out = sanitizePost('Here is your post:\n"Agents deserve better."');
    expect(out).toBe("Agents deserve better.");
  });
  it("collapses excess blank lines", () => {
    const out = sanitizePost("Line one\n\n\n\nLine two");
    expect(out).toBe("Line one\n\nLine two");
  });
});

describe("topicForDate", () => {
  it("is deterministic for the same date", () => {
    expect(topicForDate("2026-07-02").key).toBe(topicForDate("2026-07-02").key);
  });
  it("rotates across all six topics over six consecutive days", () => {
    const keys = new Set<string>();
    const base = Date.UTC(2026, 6, 2);
    for (let i = 0; i < 6; i++) {
      const d = new Date(base + i * 86400000).toISOString().slice(0, 10);
      keys.add(topicForDate(d).key);
    }
    expect(keys.size).toBe(LINKEDIN_TOPICS.length);
  });
});

describe("generateLinkedinPost", () => {
  it("returns sanitized body under 150 words with a topic key", async () => {
    llmReturns('Here is your post:\n"Most agents have never been led. #recruiting"');
    const { topic, body } = await generateLinkedinPost("2026-07-02");
    expect(body).not.toMatch(/[—–]/);
    expect(body).not.toContain("#");
    expect(wordCount(body)).toBeLessThanOrEqual(150);
    expect(topic).toBeTruthy();
  });

  it("retries once when the first draft is empty", async () => {
    invokeLLMMock
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "A solid recruiting hook." } }] });
    const { body } = await generateLinkedinPost("2026-07-03");
    expect(body).toBe("A solid recruiting hook.");
    expect(invokeLLMMock).toHaveBeenCalledTimes(2);
  });

  it("hard-trims an over-length draft to <= 150 words", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ") + ".";
    llmReturns(long);
    const { body } = await generateLinkedinPost("2026-07-04");
    expect(wordCount(body)).toBeLessThanOrEqual(150);
  });

  it("throws when the model returns nothing on both attempts", async () => {
    invokeLLMMock.mockResolvedValue({ choices: [{ message: { content: "" } }] });
    await expect(generateLinkedinPost("2026-07-05")).rejects.toThrow();
  });
});
