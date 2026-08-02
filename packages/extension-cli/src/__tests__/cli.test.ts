import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldIntegration, scaffoldService } from "../commands/scaffold.js";
import { runValidate } from "../commands/validate.js";

const CLI = resolve(__dirname, "../../dist/cli.js");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-ext-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("scaffold integration", () => {
  it("creates an integration directory with __ID__ substituted", () => {
    const destDir = scaffoldIntegration({ id: "demo", domain: "map-overlay", outDir: tmp });

    expect(existsSync(destDir)).toBe(true);
    expect(existsSync(join(destDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(destDir, "index.ts"))).toBe(true);
    expect(existsSync(join(destDir, "package.json"))).toBe(true);
    expect(existsSync(join(destDir, "package.json.template"))).toBe(false);
    expect(existsSync(join(destDir, "strings", "en.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(destDir, "manifest.json"), "utf-8")) as {
      id: string;
      domains: string[];
    };
    expect(manifest.id).toBe("demo");
    expect(manifest.domains).toContain("map-overlay");

    const pkg = JSON.parse(readFileSync(join(destDir, "package.json"), "utf-8")) as {
      name: string;
    };
    expect(pkg.name).toBe("@openmapx/integration-demo");

    const indexContent = readFileSync(join(destDir, "index.ts"), "utf-8");
    expect(indexContent).toContain("demo");
    expect(indexContent).not.toContain("__ID__");
    expect(indexContent).not.toContain("__DOMAIN__");
  });

  it("rejects an invalid id", () => {
    expect(() => scaffoldIntegration({ id: "MyDemo", outDir: tmp })).toThrow(
      /Invalid integration id/,
    );
  });

  it("rejects a duplicate id when the directory already exists", () => {
    scaffoldIntegration({ id: "demo", domain: "knowledge", outDir: tmp });
    expect(() => scaffoldIntegration({ id: "demo", domain: "weather", outDir: tmp })).toThrow(
      /already exists/,
    );
  });
});

describe("scaffold service", () => {
  it("creates a service.json with __ID__ substituted", () => {
    const destPath = scaffoldService({ id: "my-service", outDir: tmp });

    expect(existsSync(destPath)).toBe(true);

    const service = JSON.parse(readFileSync(destPath, "utf-8")) as {
      id: string;
      quality: string;
      ownsSchema: string;
    };
    expect(service.id).toBe("my-service");
    expect(service.quality).toBe("community");
    expect(service.ownsSchema).toBe("my_service");
  });

  it("produces a service.json that passes the OpenMapX service-manifest validator", () => {
    const destPath = scaffoldService({ id: "valid-svc", outDir: tmp });
    const parsed: unknown = JSON.parse(readFileSync(destPath, "utf-8"));
    const result = services.validateServiceManifest(parsed, { firstParty: false });
    expect(result.valid, `manifest validation failed: ${result.errors.join("; ")}`).toBe(true);
  });
});

describe("validate", () => {
  it("passes on a freshly scaffolded integration", async () => {
    scaffoldIntegration({ id: "demo-validate", domain: "knowledge", outDir: tmp });
    const destDir = join(tmp, "demo-validate");
    await expect(runValidate(destDir)).resolves.toBeUndefined();
  });
});

describe("CLI binary (integration + validate + package)", () => {
  it.skipIf(!existsSync(CLI))("scaffold integration via CLI", () => {
    const output = execFileSync(
      "node",
      [CLI, "scaffold", "integration", "cli-demo", "--domain", "weather", "--out", tmp],
      {
        encoding: "utf-8",
      },
    );
    expect(output).toContain("cli-demo");
    expect(existsSync(join(tmp, "cli-demo", "manifest.json"))).toBe(true);
  });

  it.skipIf(!existsSync(CLI))("validate passes on a scaffolded integration", () => {
    execFileSync(
      "node",
      [CLI, "scaffold", "integration", "valid-demo", "--domain", "knowledge", "--out", tmp],
      {
        encoding: "utf-8",
      },
    );
    const output = execFileSync("node", [CLI, "validate", join(tmp, "valid-demo")], {
      encoding: "utf-8",
    });
    expect(output).toContain("valid");
  });

  it.skipIf(!existsSync(CLI))(
    "package produces a .tar.gz artifact with dist/backend/index.mjs",
    () => {
      execFileSync(
        "node",
        [CLI, "scaffold", "integration", "pack-demo", "--domain", "knowledge", "--out", tmp],
        {
          encoding: "utf-8",
        },
      );
      const outFile = join(tmp, "pack-demo.tar.gz");
      execFileSync("node", [CLI, "package", join(tmp, "pack-demo"), "--out", outFile], {
        encoding: "utf-8",
        cwd: tmp,
      });
      expect(existsSync(outFile)).toBe(true);

      const tarContents = execFileSync("tar", ["-tzf", outFile], { encoding: "utf-8" });
      expect(tarContents).toContain("dist/backend/index.mjs");
    },
  );
});
