import { describe, test, expect } from "bun:test";
import { friendlyTier, formatDuration } from "../../src/cli/formatters.ts";

describe("friendlyTier", () => {
  test("maps PRO tier", () => {
    expect(friendlyTier("SUBSCRIPTION_TIER_PRO")).toBe("Pro");
  });

  test("maps PRO_PLUS tier", () => {
    expect(friendlyTier("SUBSCRIPTION_TIER_PRO_PLUS")).toBe("Pro+");
  });

  test("strips prefix for unknown tiers", () => {
    expect(friendlyTier("SUBSCRIPTION_TIER_ENTERPRISE")).toBe("ENTERPRISE");
  });

  test("returns empty for undefined", () => {
    expect(friendlyTier(undefined)).toBe("");
  });

  test("returns empty for empty string", () => {
    expect(friendlyTier("")).toBe("");
  });
});

describe("formatDuration", () => {
  test("seconds only", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(59)).toBe("59s");
  });

  test("minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m 0s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3599)).toBe("59m 59s");
  });

  test("hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(7200)).toBe("2h 0m");
  });

  test("handles fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("59s");
    expect(formatDuration(90.5)).toBe("1m 30s");
  });
});
