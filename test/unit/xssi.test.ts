import { describe, test, expect } from "bun:test";
import { parseXssiJson } from "../../src/colab/xssi.ts";

describe("parseXssiJson", () => {
  test("strips XSSI prefix and parses JSON", () => {
    const body = ")]}'\n{\"token\":\"abc123\",\"variant\":\"GPU\"}";
    const result = parseXssiJson<{ token: string; variant: string }>(body);
    expect(result).toEqual({ token: "abc123", variant: "GPU" });
  });

  test("parses JSON without XSSI prefix", () => {
    const body = '{"status":"ok"}';
    const result = parseXssiJson<{ status: string }>(body);
    expect(result).toEqual({ status: "ok" });
  });

  test("handles complex nested response", () => {
    const inner = {
      accelerator: "T4",
      endpoint: "ep-123",
      outcome: 4,
      runtimeProxyInfo: {
        token: "proxy-tok",
        tokenExpiresInSeconds: 3600,
        url: "https://proxy.example.com",
      },
    };
    const body = ")]}'\n" + JSON.stringify(inner);
    const result = parseXssiJson(body);
    expect(result).toEqual(inner);
  });

  test("handles empty object", () => {
    expect(parseXssiJson(")]}'\n{}")).toEqual({});
  });

  test("handles array response", () => {
    expect(parseXssiJson(")]}'\n[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("throws on invalid JSON after prefix", () => {
    expect(() => parseXssiJson(")]}'\n{invalid}")).toThrow();
  });

  test("throws on invalid JSON without prefix", () => {
    expect(() => parseXssiJson("{invalid}")).toThrow();
  });

  test("partial prefix is NOT stripped", () => {
    // Only the first 3 chars match — not a real prefix
    const body = ")]}{\"a\":1}";
    expect(() => parseXssiJson(body)).toThrow();
  });
});
