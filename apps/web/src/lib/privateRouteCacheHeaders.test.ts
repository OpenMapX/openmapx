import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

type HeaderRule = {
  source: string;
  has?: Array<{ type: string; key?: string; value?: string }>;
  headers: Array<{ key: string; value: string }>;
};

function effectiveRootCacheControl(url: string, rules: HeaderRule[]): string | undefined {
  const parsed = new URL(url);
  const matchingRules = rules.filter(
    (rule) =>
      rule.source === "/" &&
      (rule.has ?? []).every((condition) => {
        if (condition.type !== "query" || !condition.key) return false;
        const actual = parsed.searchParams.get(condition.key);
        return actual !== null && (condition.value === undefined || actual === condition.value);
      }),
  );

  return matchingRules
    .flatMap((rule) => rule.headers)
    .findLast((header) => header.key === "Cache-Control")?.value;
}

describe("private route response cache headers", () => {
  it("sets private, no-store on every user-specific or token-handling route family", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];

    for (const source of [
      "/admin/:path*",
      "/settings/:path*",
      "/mobile-auth",
      "/auth/:path*",
      "/delete-account",
    ]) {
      const rule = rules.find((candidate) => candidate.source === source);
      expect({
        source,
        cacheControl: rule?.headers.find((header) => header.key === "Cache-Control")?.value,
      }).toEqual({ source, cacheControl: "private, no-store" });
    }
  });

  it("does not apply private no-store to the global static-asset header rule", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const globalRule = rules.find((candidate) => candidate.source === "/:path*");

    expect(globalRule?.headers.some((header) => header.key === "Cache-Control")).toBe(false);
  });

  it.each([
    "https://maps.example/?token=one-time-reset-token",
    "https://maps.example/?error=INVALID_TOKEN",
  ])("sets private, no-store on the real root reset callback: %s", async (url) => {
    const rules = ((await nextConfig.headers?.()) ?? []) as HeaderRule[];

    expect(effectiveRootCacheControl(url, rules)).toBe("private, no-store");
  });

  it("does not broaden private no-store to an ordinary root request", async () => {
    const rules = ((await nextConfig.headers?.()) ?? []) as HeaderRule[];

    expect(effectiveRootCacheControl("https://maps.example/", rules)).toBeUndefined();
    expect(
      effectiveRootCacheControl("https://maps.example/?error=ANOTHER_ERROR", rules),
    ).toBeUndefined();
  });
});
