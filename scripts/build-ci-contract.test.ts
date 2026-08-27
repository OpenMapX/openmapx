import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("required production build gate", () => {
  it("builds production outputs, checks packed packages, and aggregates the result", () => {
    const workflow = read(".github/workflows/ci.yml");
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(workflow).toMatch(/^ {2}build:\n/m);
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm check-packed-packages");
    expect(workflow).toMatch(/needs: \[[^\]]*build[^\]]*\]/);
    expect(rootPackage.scripts["check-packed-packages"]).toBe(
      "node scripts/check-packed-packages.mjs",
    );
  });

  it("does not make a production build depend on downloading a Google font", () => {
    const layout = read("apps/web/src/app/layout.tsx");
    const webPackage = JSON.parse(read("apps/web/package.json")) as {
      dependencies: Record<string, string>;
    };

    expect(layout).not.toContain('from "next/font/google"');
    expect(layout).toContain('import "@fontsource-variable/plus-jakarta-sans"');
    expect(webPackage.dependencies["@fontsource-variable/plus-jakarta-sans"]).toBeDefined();
  });

  it("keeps the supported webpack fallback aware of integration contexts", () => {
    const nextConfig = read("apps/web/next.config.ts");

    expect(nextConfig).toContain("webpack(config)");
    expect(nextConfig).toContain('"@integrations": integrations');
  });

  it("does not publish the retired in-process community runtime SDK", () => {
    expect(existsSync(resolve(root, "packages/extension-sdk/package.json"))).toBe(false);
    expect(read("scripts/check-packed-packages.mjs")).not.toContain("extension-sdk");
  });
});
