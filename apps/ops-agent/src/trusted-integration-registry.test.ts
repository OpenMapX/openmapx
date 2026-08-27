import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTrustedIntegrationSchemas } from "./trusted-integration-registry";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-integrations-"));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, "integrations", "routing-demo"), { recursive: true, mode: 0o755 });
  writeFileSync(
    join(root, "integrations", "routing-demo", "manifest.json"),
    JSON.stringify({
      id: "routing-demo",
      configSchema: { properties: { region: { type: "string" } } },
    }),
    { mode: 0o644 },
  );
  mkdirSync(join(root, "custom_integrations", "overlay-demo"), {
    recursive: true,
    mode: 0o755,
  });
  writeFileSync(
    join(root, "custom_integrations", "overlay-demo", "manifest.json"),
    JSON.stringify({
      id: "overlay-demo",
      configSchema: { properties: { layers: { type: "array" } } },
    }),
    { mode: 0o644 },
  );
  return root;
}

describe("trusted integration registry", () => {
  it("loads built-in and installed declarative identities/schemas from agent-owned roots", () => {
    const root = fixture();
    expect(loadTrustedIntegrationSchemas(root)).toEqual(
      new Map([
        ["overlay-demo", { properties: { layers: { type: "array" } } }],
        ["routing-demo", { properties: { region: { type: "string" } } }],
      ]),
    );
  });

  it("rejects duplicate identities and symbolic manifest files", () => {
    const root = fixture();
    const duplicate = join(root, "custom_integrations", "duplicate");
    mkdirSync(duplicate, { mode: 0o755 });
    writeFileSync(join(duplicate, "manifest.json"), JSON.stringify({ id: "routing-demo" }), {
      mode: 0o644,
    });
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );

    rmSync(duplicate, { recursive: true });
    const manifest = join(root, "custom_integrations", "overlay-demo", "manifest.json");
    const real = join(root, "real-manifest.json");
    writeFileSync(real, JSON.stringify({ id: "overlay-demo" }), { mode: 0o644 });
    rmSync(manifest);
    symlinkSync(real, manifest);
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );
  });

  it("rejects an unsupported installed schema before it enters refreshed authority", () => {
    const root = fixture();
    writeFileSync(
      join(root, "custom_integrations", "overlay-demo", "manifest.json"),
      JSON.stringify({
        id: "overlay-demo",
        configSchema: { properties: { layers: { type: "array", contains: { type: "string" } } } },
      }),
      { mode: 0o644 },
    );

    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );
  });
});
