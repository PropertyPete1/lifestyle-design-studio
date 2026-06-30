import { describe, it, expect } from "vitest";
import { chicagoLocalDateTime } from "./scheduledPublish";

describe("chicagoLocalDateTime", () => {
  it("returns a wall-clock string in America/Chicago, not UTC", () => {
    // 2026-06-30T20:58:00Z is 15:58 CDT (UTC-5 in summer).
    const epoch = Date.parse("2026-06-30T20:58:00Z");
    const local = chicagoLocalDateTime(epoch);
    expect(local).toBe("2026-06-30T15:58:00");
  });

  it("produces a valid YYYY-MM-DDTHH:MM:SS pattern", () => {
    const local = chicagoLocalDateTime(Date.now() + 90_000);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("differs from the naive UTC ISO slice by the CDT offset", () => {
    const epoch = Date.parse("2026-07-01T02:00:00Z"); // 21:00 CDT on Jun 30
    const local = chicagoLocalDateTime(epoch);
    const naiveUtc = new Date(epoch).toISOString().slice(0, 19);
    expect(local).toBe("2026-06-30T21:00:00");
    expect(naiveUtc).toBe("2026-07-01T02:00:00");
    expect(local).not.toBe(naiveUtc);
  });
});
