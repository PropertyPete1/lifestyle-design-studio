import { describe, expect, it } from "vitest";
import {
  cdtTimeToUtcMs,
  defaultScheduleMs,
  isDallasDay,
  scheduleHourFor,
} from "./selection";

describe("Dallas market scheduling", () => {
  it("uses 2PM SA, 3PM Austin, 4PM Dallas (CDT)", () => {
    expect(scheduleHourFor("san_antonio")).toBe(14);
    expect(scheduleHourFor("austin")).toBe(15);
    expect(scheduleHourFor("dallas")).toBe(16);
  });

  it("schedules Dallas at 4PM CDT = 21:00 UTC", () => {
    const ms = defaultScheduleMs("2026-07-02", "dallas");
    expect(ms).toBe(cdtTimeToUtcMs("2026-07-02", 16));
    expect(new Date(ms).getUTCHours()).toBe(21);
  });

  it("isDallasDay alternates every other calendar day", () => {
    // Consecutive days must differ (strict every-other-day rhythm)
    const days = [
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ];
    const flags = days.map(isDallasDay);
    for (let i = 1; i < flags.length; i++) {
      expect(flags[i]).not.toBe(flags[i - 1]);
    }
  });

  it("isDallasDay is deterministic for the same date", () => {
    expect(isDallasDay("2026-07-02")).toBe(isDallasDay("2026-07-02"));
  });
});
