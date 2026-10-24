import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tightenCustomIntegrations } from "../custom-integrations-modes";
import { loadTrustedIntegrationSchemas } from "../trusted-integration-schemas";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => lstatSync(path).mode & 0o7777;

/** A checkout with one integration as an earlier installer left it under umask 002. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-custom-modes-"));
  roots.push(root);
  const custom = join(root, "custom_integrations");
  const integration = join(custom, "loose");
  mkdirSync(join(integration, "strings"), { recursive: true });
  writeFileSync(
    join(integration, "manifest.json"),
    JSON.stringify({
      id: "loose",
      configSchema: { type: "object", properties: { region: { enum: ["eu"] } } },
    }),
  );
  writeFileSync(join(integration, "strings", "en.json"), "{}");
  for (const directory of [custom, integration, join(integration, "strings")]) {
    chmodSync(directory, 0o775);
  }
  chmodSync(join(integration, "manifest.json"), 0o664);
  chmodSync(join(integration, "strings", "en.json"), 0o666);
  return { root, custom, integration };
}

describe("tightenCustomIntegrations", () => {
  it("removes group and other write so an earlier install loads", () => {
    const { root, custom, integration } = checkout();
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow("Trusted integration registry");

    tightenCustomIntegrations(root);

    expect(mode(custom)).toBe(0o755);
    expect(mode(integration)).toBe(0o755);
    expect(mode(join(integration, "strings"))).toBe(0o755);
    expect(mode(join(integration, "manifest.json"))).toBe(0o644);
    expect(mode(join(integration, "strings", "en.json"))).toBe(0o644);
    expect([...loadTrustedIntegrationSchemas(root).keys()]).toEqual(["loose"]);
  });

  it("never follows or changes a symbolic link", () => {
    const { root, integration } = checkout();
    const outsideFile = join(root, "outside.json");
    const outsideDirectory = join(root, "outside");
    writeFileSync(outsideFile, "{}");
    chmodSync(outsideFile, 0o666);
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "inner.json"), "{}");
    chmodSync(outsideDirectory, 0o777);
    chmodSync(join(outsideDirectory, "inner.json"), 0o666);
    symlinkSync(outsideFile, join(integration, "linked.json"));
    symlinkSync(outsideDirectory, join(integration, "linked-directory"));

    tightenCustomIntegrations(root);

    expect(mode(outsideFile)).toBe(0o666);
    expect(mode(outsideDirectory)).toBe(0o777);
    expect(mode(join(outsideDirectory, "inner.json"))).toBe(0o666);
    expect(lstatSync(join(integration, "linked.json")).isSymbolicLink()).toBe(true);
    expect(mode(join(integration, "manifest.json"))).toBe(0o644);
  });

  it("leaves entries another account owns, and anything but files and directories", () => {
    const { root, custom, integration } = checkout();
    const fifo = join(integration, "pipe");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o666);

    // Everything here belongs to this account, so as another account's
    // checkout nothing is changed.
    tightenCustomIntegrations(root, (process.geteuid?.() ?? 0) + 1);
    expect(mode(custom)).toBe(0o775);
    expect(mode(join(integration, "manifest.json"))).toBe(0o664);

    tightenCustomIntegrations(root);
    expect(mode(fifo)).toBe(0o666);
    expect(mode(join(integration, "manifest.json"))).toBe(0o644);
  });

  it("keeps the other bits and removes only write", () => {
    const { root, integration } = checkout();
    const tool = join(integration, "tool.sh");
    writeFileSync(tool, "");
    chmodSync(tool, 0o777);
    chmodSync(join(integration, "manifest.json"), 0o620);

    tightenCustomIntegrations(root);

    expect(mode(tool)).toBe(0o755);
    expect(mode(join(integration, "manifest.json"))).toBe(0o600);
  });

  it("does nothing without custom_integrations", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-custom-modes-"));
    roots.push(root);
    expect(() => tightenCustomIntegrations(root)).not.toThrow();
  });
});
