import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../apps/web/next.config";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("required production build gate", () => {
  it.each([
    { alias: { retained: "/retained" } },
    { alias: [{ name: "retained", alias: "/retained" }] },
  ])("resolves integration contexts through the supported webpack fallback (%j)", ({ alias }) => {
    const configure = nextConfig.webpack;
    if (!configure) throw new Error("Missing supported webpack fallback");
    const config = { context: resolve(root, "apps/web"), resolve: { alias } };
    // Neither the next-intl wrapper nor this callback reads the compilation context.
    const rendered = configure(config, {} as Parameters<typeof configure>[1]);
    const integrations = resolve(root, "integrations");
    if (Array.isArray(alias)) {
      expect(rendered.resolve.alias).toEqual(
        expect.arrayContaining([
          { name: "retained", alias: "/retained" },
          { name: "@integrations", alias: integrations },
        ]),
      );
    } else
      expect(rendered.resolve.alias).toMatchObject({
        retained: "/retained",
        "@integrations": integrations,
      });
  });
  it("builds production outputs, checks packed packages, and aggregates the result", () => {
    const workflow = read(".github/workflows/ci.yml");
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(workflow).toMatch(/^ {2}build:\n/m);
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm check-packed-packages");
    expect(workflow).toMatch(/needs:\s*\[[^\]]*\bbuild\b[^\]]*\]/);
    expect(rootPackage.scripts["check-packed-packages"]).toBe(
      "node scripts/check-packed-packages.mjs",
    );
  });

  it("executes the bundled data-manager workers after the production build in the required build job", () => {
    const workflow = read(".github/workflows/ci.yml");
    const buildJob =
      workflow.match(/^ {2}build:\n[\s\S]*?(?=^ {2}\w[\w-]*:|$(?![\s\S]))/m)?.[0] ?? "";
    const smoke = [
      "OPENMAPX_RUN_BUILT_WORKER_TESTS=1 pnpm exec vitest run --project node",
      "services/data-manager/src/__tests__/live-writer-worker.test.ts",
      "services/data-manager/src/__tests__/offline-extractor-worker.test.ts",
    ].join(" ");
    const buildPosition = buildJob.indexOf("run: pnpm build");
    const smokePosition = buildJob.indexOf(`run: ${smoke}`);
    expect(buildPosition).toBeGreaterThan(-1);
    expect(smokePosition).toBeGreaterThan(buildPosition);
    // Neither step can be conditional or allowed to fail while the aggregate succeeds.
    expect(buildJob).not.toContain("continue-on-error:");
    expect(buildJob).toContain("needs.select.outputs['build'] == 'true'");
    expect(workflow).toMatch(/needs:\s*\[[^\]]*\bbuild\b[^\]]*\]/);
    expect(workflow).toContain("run: node scripts/ci-impact-plan.mjs verify");
  });
});
