import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectToolchainPinViolations } from "./check-toolchain-pins";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

/** Real file contents with exactly one targeted change; fails if the change is a no-op. */
function withChange(relativePath: string, change: (contents: string) => string): string {
  const original = read(relativePath);
  const changed = change(original);
  expect(changed, `${relativePath} override must differ from the real file`).not.toBe(original);
  return changed;
}

function withJsonChange<T>(relativePath: string, change: (json: T) => void): string {
  return withChange(relativePath, (contents) => {
    const json = JSON.parse(contents) as T;
    change(json);
    return `${JSON.stringify(json, null, 2)}\n`;
  });
}

function violationsFor(relativePath: string, contents: string): string[] {
  return collectToolchainPinViolations({ [relativePath]: contents });
}

describe("collectToolchainPinViolations", () => {
  it("rejects a .nvmrc that does not pin an exact Node release", () => {
    expect(violationsFor(".nvmrc", "20\n")).toContainEqual(
      expect.stringContaining('.nvmrc: "20" must pin an exact Node release'),
    );
  });

  it("rejects a Node base image that differs from .nvmrc", () => {
    const rel = "apps/web/Dockerfile";
    const nodeVersion = read(".nvmrc").trim();
    const violations = violationsFor(
      rel,
      withChange(rel, (contents) =>
        contents.replace(`FROM node:${nodeVersion}-`, "FROM node:1.0.0-"),
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(rel);
    expect(violations[0]).toContain("does not match .nvmrc");
  });

  it("rejects a mobile release pnpm version that differs from the root package manager", () => {
    const rel = "apps/mobile/release/toolchains.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ pnpm?: string }>(rel, (json) => {
        json.pnpm = "0.0.0";
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`${rel}: pnpm "0.0.0"`);
  });

  it("rejects a React Native Jest preset that differs from react-native", () => {
    const rel = "apps/mobile/package.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ devDependencies: Record<string, string> }>(rel, (json) => {
        json.devDependencies["@react-native/jest-preset"] = "0.0.0";
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`${rel}: @react-native/jest-preset "0.0.0"`);
  });

  it("rejects a MOTIS container tag that differs from MOTIS_VERSION", () => {
    const rel = "services/motis/service.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ container: { tag?: string } }>(rel, (json) => {
        json.container.tag = "0.0.0";
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(rel);
    expect(violations[0]).toContain("MOTIS_VERSION");
  });

  it("rejects a third-party service image without a manifest digest", () => {
    const rel = "services/brouter/service.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ container: { image: string; digest?: string } }>(rel, (json) => {
        expect(json.container.image.startsWith("ghcr.io/openmapx/")).toBe(false);
        delete json.container.digest;
      }),
    );
    expect(violations).toEqual([
      `${rel}: third-party image is missing a valid immutable sha256 digest`,
    ]);
  });

  it("rejects a build image without a manifest digest", () => {
    const rel = "services/pelias/service.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ buildImages: { schema: { digest?: string } } }>(rel, (json) => {
        json.buildImages.schema.digest = "latest";
      }),
    );
    expect(violations).toEqual([
      `${rel}: build image "schema" is missing a valid immutable sha256 digest`,
    ]);
  });

  it("rejects a GBFS catalog lock that differs from the pinned commit", () => {
    const rel = "infra/docker/gbfs-catalog.lock.json";
    const violations = violationsFor(
      rel,
      withJsonChange<{ commit?: string }>(rel, (json) => {
        json.commit = "0".repeat(40);
      }),
    );
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) expect(violation).toContain(rel);
  });

  it("rejects a Python lock with an unhashed package", () => {
    const rel = "apps/transitous-runner/requirements.txt";
    const violations = violationsFor(
      rel,
      withChange(rel, (contents) => contents.replaceAll("--hash=sha256:", "--hash=")),
    );
    expect(violations).toEqual([`${rel}: every locked package needs a hash`]);
  });
});
