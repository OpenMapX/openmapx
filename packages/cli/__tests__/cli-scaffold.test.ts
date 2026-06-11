import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldIntegration } from "../src/commands/integrations";

let tmp: string;

function createTemplateDir(integrationsDir: string): void {
  const templateDir = join(integrationsDir, "_template");
  mkdirSync(join(templateDir, "strings"), { recursive: true });

  writeFileSync(
    join(templateDir, "manifest.json"),
    JSON.stringify({
      id: "__ID__",
      version: "1.0.0",
      domains: ["__DOMAIN__"],
      quality: "community",
      dataSources: [],
    }),
    "utf-8",
  );

  writeFileSync(
    join(templateDir, "index.ts"),
    "// Integration: __ID__\nexport function setup() { /* __ID__ in __DOMAIN__ */ }\n",
    "utf-8",
  );

  writeFileSync(
    join(templateDir, "package.json.template"),
    JSON.stringify({ name: "@openmapx/integration-__ID__", private: true }),
    "utf-8",
  );

  writeFileSync(
    join(templateDir, "strings", "en.json"),
    JSON.stringify({ name: "__ID__", description: "A description" }),
    "utf-8",
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-scaffold-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("scaffoldIntegration", () => {
  it("creates the integration directory with substituted tokens", () => {
    createTemplateDir(tmp);

    const destDir = scaffoldIntegration({
      id: "my-feature",
      domain: "knowledge",
      integrationsDir: tmp,
    });

    expect(existsSync(destDir)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(destDir, "manifest.json"), "utf-8")) as {
      id: string;
      domains: string[];
    };
    expect(manifest.id).toBe("my-feature");
    expect(manifest.domains).toEqual(["knowledge"]);

    const indexContent = readFileSync(join(destDir, "index.ts"), "utf-8");
    expect(indexContent).toContain("my-feature");
    expect(indexContent).not.toContain("__ID__");
    expect(indexContent).not.toContain("__DOMAIN__");

    const stringsContent = JSON.parse(
      readFileSync(join(destDir, "strings", "en.json"), "utf-8"),
    ) as { name: string };
    expect(stringsContent.name).toBe("my-feature");
  });

  it("renames package.json.template to package.json", () => {
    createTemplateDir(tmp);

    const destDir = scaffoldIntegration({
      id: "my-feature",
      domain: "weather",
      integrationsDir: tmp,
    });

    expect(existsSync(join(destDir, "package.json"))).toBe(true);
    expect(existsSync(join(destDir, "package.json.template"))).toBe(false);

    const pkg = JSON.parse(readFileSync(join(destDir, "package.json"), "utf-8")) as {
      name: string;
    };
    expect(pkg.name).toBe("@openmapx/integration-my-feature");
  });

  it("rejects a duplicate id when the directory already exists", () => {
    createTemplateDir(tmp);
    mkdirSync(join(tmp, "existing-feature"), { recursive: true });

    expect(() => scaffoldIntegration({ id: "existing-feature", integrationsDir: tmp })).toThrow(
      /already exists/,
    );
  });

  it("rejects an invalid id (uppercase letters)", () => {
    createTemplateDir(tmp);

    expect(() => scaffoldIntegration({ id: "MyFeature", integrationsDir: tmp })).toThrow(
      /Invalid integration id/,
    );
  });

  it("rejects an id starting with a digit", () => {
    createTemplateDir(tmp);

    expect(() => scaffoldIntegration({ id: "1bad-id", integrationsDir: tmp })).toThrow(
      /Invalid integration id/,
    );
  });
});
