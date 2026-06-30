import { describe, it, expect } from "vitest";
import { getConnectedNetworks } from "./metricool";

describe("Metricool API", () => {
  it("should return connected networks for the brand", async () => {
    const networks = await getConnectedNetworks();
    // Should have at least Instagram connected
    expect(Array.isArray(networks)).toBe(true);
    expect(networks.length).toBeGreaterThan(0);
    const instagram = networks.find(n => n.network === "INSTAGRAM");
    expect(instagram).toBeDefined();
    expect(instagram?.id).toBeTruthy();
  }, 15000);

  it("should include LinkedIn now that it is connected", async () => {
    const networks = await getConnectedNetworks();
    const linkedin = networks.find(n => n.network === "LINKEDIN");
    expect(linkedin).toBeDefined();
    expect(linkedin?.id).toBeTruthy();
  }, 15000);
});

describe("Metricool media upload flow", () => {
  // A small, fetchable sample MP4.
  const SAMPLE_MP4 =
    "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

  it("uploadVideoToMetricool returns a Metricool-hosted CDN url for an external video", async () => {
    // Skip cleanly if the sample host is unreachable from the test runner.
    const probe = await fetch(SAMPLE_MP4, { method: "GET", headers: { Range: "bytes=0-1" } }).catch(() => null);
    if (!probe || !(probe.ok || probe.status === 206)) {
      console.warn("sample mp4 host unreachable; skipping upload-flow live test");
      return;
    }
    const { uploadVideoToMetricool } = await import("./metricool");
    const hosted = await uploadVideoToMetricool(SAMPLE_MP4);
    expect(typeof hosted).toBe("string");
    // Must be hosted on Metricool's own CDN (not the original external URL).
    expect(hosted).toMatch(/^https:\/\/(static\.metricool\.com|metricool-temp\.s3)/);
    expect(hosted).not.toBe(SAMPLE_MP4);

    // The hosted URL must actually serve video bytes.
    const head = await fetch(hosted, { method: "GET", headers: { Range: "bytes=0-1" } });
    expect(head.ok || head.status === 206).toBe(true);
  }, 60000);
});
