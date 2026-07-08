import { describe, it, expect } from "vitest";
import {
  parsePriceFromCaption,
  parseRateFromCaption,
  calculatePaymentBreakdown,
  stripDeliveryTags,
} from "./voiceoverScript";

describe("parsePriceFromCaption", () => {
  it("parses explicit dollar amounts", () => {
    expect(parsePriceFromCaption("Starting at $349,990")).toBe(349990);
    expect(parsePriceFromCaption("Homes from $500,000")).toBe(500000);
    expect(parsePriceFromCaption("$1,200,000 luxury estate")).toBe(1200000);
  });

  it("parses 'starting at' patterns", () => {
    expect(parsePriceFromCaption("starting at $394,990 new builds")).toBe(394990);
    expect(parsePriceFromCaption("Starting from $275,000")).toBe(275000);
  });

  it("parses written-out price ranges with hundreds", () => {
    expect(parsePriceFromCaption("pricing from the mid three forties")).toBeCloseTo(345000, -3);
    expect(parsePriceFromCaption("starting in the high three hundreds")).toBeCloseTo(380000, -3);
    expect(parsePriceFromCaption("homes in the low four hundreds")).toBeCloseTo(420000, -3);
  });

  it("returns null when no price is found", () => {
    expect(parsePriceFromCaption("Beautiful home with great views")).toBeNull();
    expect(parsePriceFromCaption("New construction coming soon")).toBeNull();
    expect(parsePriceFromCaption("")).toBeNull();
  });

  it("ignores prices below $100k (not home prices)", () => {
    expect(parsePriceFromCaption("Only $50 per month HOA")).toBeNull();
    expect(parsePriceFromCaption("$99,000 is too low")).toBeNull();
  });
});

describe("parseRateFromCaption", () => {
  it("parses percentage rates", () => {
    expect(parseRateFromCaption("5.99% fixed rate")).toBe(5.99);
    expect(parseRateFromCaption("at 4.99% interest")).toBe(4.99);
    expect(parseRateFromCaption("rates as low as 3.25%")).toBe(3.25);
  });

  it("returns null when no rate found", () => {
    expect(parseRateFromCaption("Great home in Austin")).toBeNull();
    expect(parseRateFromCaption("")).toBeNull();
  });

  it("ignores percentages outside mortgage range", () => {
    expect(parseRateFromCaption("50% off sale")).toBeNull();
    expect(parseRateFromCaption("1.5% is too low")).toBeNull();
  });
});

describe("calculatePaymentBreakdown", () => {
  it("calculates correct monthly payment for San Antonio home", () => {
    const result = calculatePaymentBreakdown(349990, 4.99, "san_antonio");

    expect(result.homePrice).toBe(349990);
    expect(result.downPaymentPct).toBe(3);
    expect(result.downPaymentAmount).toBe(Math.round(349990 * 0.03));
    expect(result.loanAmount).toBe(349990 - result.downPaymentAmount);
    expect(result.interestRate).toBe(4.99);
    // Monthly P&I for ~$339,490 at 4.99% over 30 years should be ~$1,820
    expect(result.monthlyPI).toBeGreaterThan(1700);
    expect(result.monthlyPI).toBeLessThan(1950);
    // Monthly tax at 2.1%: 349990 * 0.021 / 12 = ~$612
    expect(result.monthlyTax).toBeGreaterThan(580);
    expect(result.monthlyTax).toBeLessThan(650);
    // Monthly insurance: 1200/12 = $100
    expect(result.monthlyInsurance).toBe(100);
    // Total is rounded independently from the sum of rounded parts (off by at most 2)
    const sumOfParts = result.monthlyPI + result.monthlyTax + result.monthlyInsurance;
    expect(Math.abs(result.totalMonthly - sumOfParts)).toBeLessThanOrEqual(2);
  });

  it("calculates correct monthly payment for Austin home", () => {
    const result = calculatePaymentBreakdown(500000, 5.99, "austin");

    expect(result.propertyTaxRate).toBe(0.02);
    // Monthly tax at 2.0%: 500000 * 0.02 / 12 = ~$833
    expect(result.monthlyTax).toBeGreaterThan(800);
    expect(result.monthlyTax).toBeLessThan(870);
  });

  it("calculates correct monthly payment for Dallas home", () => {
    const result = calculatePaymentBreakdown(400000, 4.99, "dallas");

    expect(result.propertyTaxRate).toBe(0.023);
    // Monthly tax at 2.3%: 400000 * 0.023 / 12 = ~$767
    expect(result.monthlyTax).toBeGreaterThan(740);
    expect(result.monthlyTax).toBeLessThan(800);
  });

  it("uses 3% down payment always", () => {
    const result = calculatePaymentBreakdown(300000, 4.99, "austin");
    expect(result.downPaymentAmount).toBe(9000);
    expect(result.loanAmount).toBe(291000);
  });
});

describe("stripDeliveryTags", () => {
  it("removes bracket tags", () => {
    expect(stripDeliveryTags("[excited] Hello there [pause] welcome")).toBe("Hello there welcome");
  });

  it("handles clean text", () => {
    expect(stripDeliveryTags("This is a clean script")).toBe("This is a clean script");
  });
});
