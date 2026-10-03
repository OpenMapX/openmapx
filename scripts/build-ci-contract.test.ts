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

  it("executes the emitted traffic worker after the production build in the required build job", () => {
    const workflow = read(".github/workflows/ci.yml");
    const buildJob =
      workflow.match(/^ {2}build:\n[\s\S]*?(?=^ {2}\w[\w-]*:|$(?![\s\S]))/m)?.[0] ?? "";
    const smoke =
      "OPENMAPX_RUN_BUILT_WORKER_TESTS=1 pnpm exec vitest run --project node services/data-manager/src/__tests__/live-writer-worker.test.ts";
    const buildPosition = buildJob.indexOf("run: pnpm build");
    const smokePosition = buildJob.indexOf(`run: ${smoke}`);
    expect(buildPosition).toBeGreaterThan(-1);
    expect(smokePosition).toBeGreaterThan(buildPosition);
    // Neither step can be conditional or allowed to fail while the aggregate succeeds.
    expect(buildJob).not.toMatch(/continue-on-error:|^\s+if:/m);
    expect(workflow).toMatch(/needs: \[[^\]]*build[^\]]*\]/);
    expect(workflow).toContain("needs.build.result != 'success'");
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
