import { describe, it, expect } from "vitest";
import { classifyByKeywords } from "./geoClassify";

describe("geoClassify keyword rules", () => {
  it("classifies Schertz / Cibolo / Alamo Ranch / New Braunfels as San Antonio", () => {
    expect(classifyByKeywords("New build in Schertz", "Schertz | Texas")).toBe("san_antonio");
    expect(classifyByKeywords("Cibolo homes", null)).toBe("san_antonio");
    expect(classifyByKeywords(null, "Alamo Ranch")).toBe("san_antonio");
    expect(classifyByKeywords("Beautiful New Braunfels listing", null)).toBe("san_antonio");
    expect(classifyByKeywords("San Antonio luxury", null)).toBe("san_antonio");
  });

  it("classifies Austin and north as Austin", () => {
    expect(classifyByKeywords("North Austin", "North | Austin")).toBe("austin");
    expect(classifyByKeywords("Round Rock new homes", null)).toBe("austin");
    expect(classifyByKeywords(null, "Georgetown")).toBe("austin");
    expect(classifyByKeywords("Leander community tour", null)).toBe("austin");
    expect(classifyByKeywords(null, "San Marcos | Texas")).toBe("austin");
    expect(classifyByKeywords(null, "Temple | Texas")).toBe("austin");
  });

  it("classifies Dallas / Fort Worth / DFW as Dallas", () => {
    expect(classifyByKeywords("Fort Worth new build", "Fort Worth")).toBe("dallas");
    expect(classifyByKeywords("Dallas luxury home", null)).toBe("dallas");
    expect(classifyByKeywords(null, "Frisco")).toBe("dallas");
    expect(classifyByKeywords("DFW metroplex listing", null)).toBe("dallas");
    expect(classifyByKeywords("McKinney move-in ready", null)).toBe("dallas");
  });

  it("returns null when ambiguous (no place or conflicting places)", () => {
    expect(classifyByKeywords("Beautiful new home", "Starting at $455,000")).toBeNull();
    // conflicting: both Austin and Dallas mentioned
    expect(classifyByKeywords("From Austin to Dallas", null)).toBeNull();
  });
});
