import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apps = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "privacy-backup",
  "transitous-runner",
  "transitous-tools",
];
const prefix = "example.invalid/openmapx";
const sha = "f".repeat(40);
const releaseId = `${sha}-1-1`;
const digests = Object.fromEntries(
  apps.map((app, i) => [app, `sha256:${String(i + 1).repeat(64)}`]),
);
const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/docker.yml"),
  "utf8",
);
// Execute every promotion run block in workflow order, with only Docker replaced.
const scripts = [
  ...workflow
    .slice(workflow.indexOf("  promote:\n"))
    .matchAll(/^ {8}run: \|\n((?:^ {10}.*\n|^\n)*)/gm),
].map((match) =>
  match[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n"),
);

function promote(
  failMatch = "",
  mismatch = false,
  reusedApps: string[] = [],
  planOverrides: Record<string, unknown> = {},
) {
  const temp = mkdtempSync(join(tmpdir(), "openmapx-promotion-"));
  try {
    const bin = join(temp, "bin");
    mkdirSync(bin);
    for (const app of apps) {
      const dir = join(temp, "digests", `docker-digest-${app}-1-1`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, digests[app].slice(7)), "");
    }
    mkdirSync(join(temp, "privacy-release-validation"));
    mkdirSync(join(temp, "release-plan"));
    writeFileSync(
      join(temp, "release-plan/release-plan.json"),
      JSON.stringify({
        version: 1,
        release: releaseId,
        sourceRevision: sha,
        privacyFingerprint: "a".repeat(64),
        images: apps.map((app) => ({
          app,
          rebuild: !reusedApps.includes(app),
          digest: reusedApps.includes(app) ? digests[app] : "",
        })),
        buildMetadata: {
          version: 1,
          images: Object.fromEntries(
            apps.map((app) => [
              app,
              {
                inputHash: "a".repeat(64),
                sourceRevision: reusedApps.includes(app) ? "b".repeat(40) : sha,
                builtAt: reusedApps.includes(app)
                  ? "2026-09-10T12:00:00.000Z"
                  : "2026-09-12T12:00:00.000Z",
              },
            ]),
          ),
        },
        ...planOverrides,
      }),
    );
    writeFileSync(
      join(temp, "privacy-release-validation/privacy-release-validation.json"),
      JSON.stringify({
        version: 1,
        sourceBuildFingerprint: "a".repeat(64),
        validatedAt: "2026-09-12T12:00:00.000Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      }),
    );
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (process.env.FAIL_MATCH && args.join(" ").includes(process.env.FAIL_MATCH)) process.exit(1);
if (args[2] === "inspect" && args.includes("--format")) {
  const ref = args.find(arg => arg.startsWith("example.invalid/"));
  const app = ref.split("/").pop().split(":")[0];
  console.log(process.env.MISMATCH === "true" ? "sha256:" + "0".repeat(64) : JSON.parse(process.env.DIGESTS)[app]);
}
`,
    );
    chmodSync(docker, 0o755);
    let status: number | null = 0;
    let stderr = "";
    for (const script of scripts) {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        cwd: temp,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          IMAGE_PREFIX: prefix,
          RELEASE_MANIFEST_IMAGE: `${prefix}/release-manifest`,
          RELEASE_SHA: sha,
          RELEASE_ID: releaseId,
          FAIL_MATCH: failMatch,
          MISMATCH: String(mismatch),
          DIGESTS: JSON.stringify(digests),
        },
      });
      status = result.status;
      stderr += result.stderr;
      if (status !== 0) break;
    }
    const calls = readFileSync(join(temp, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const manifestPath = join(temp, "release-manifest/release-manifest.json");
    const manifest = status === 0 ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
    return { calls, status, stderr, manifest };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const destinations = (args: string[]) =>
  args.flatMap((arg, index) => (arg === "--tag" ? [args[index + 1]] : []));
const destination = (args: string[]) =>
  args.includes("--tag") ? args[args.indexOf("--tag") + 1] : undefined;

describe("aggregate Docker promotion", () => {
  it("publishes a complete mixed release while retaining reused image provenance", () => {
    const { manifest, status, stderr } = promote("", false, ["api", "web"]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(manifest.images.api).toBe(`${prefix}/api@${digests.api}`);
    expect(manifest.buildMetadata.images.api.sourceRevision).toBe("b".repeat(40));
    expect(manifest.buildMetadata.images.api.builtAt).toBe("2026-09-10T12:00:00.000Z");
    expect(manifest.buildMetadata.images["ops-agent"].sourceRevision).toBe(sha);
    expect(Object.keys(manifest.images)).toEqual(apps);
  });
  it.each([
    { privacyFingerprint: "0".repeat(64) },
    { images: [{ app: "api", rebuild: false, digest: `sha256:${"0".repeat(64)}` }] },
  ])("refuses publication when evidence or reused digest disagrees with the plan", (override) => {
    const { status, calls } = promote("", false, ["api"], override);
    expect(status).toBe(1);
    expect(calls.flatMap(destinations).some((tag) => tag.endsWith(":latest"))).toBe(false);
    expect(calls.flatMap(destinations)).not.toContain(`${prefix}/release-manifest:${releaseId}`);
  });
  it("carries legacy docs metadata without contacting or tagging the docs image", () => {
    const legacyDocsImage = `${prefix}/docs@sha256:${"a".repeat(64)}`;
    const { manifest, calls, status } = promote("", false, [], { legacyDocsImage });
    expect(status).toBe(0);
    expect(manifest.images.docs).toBe(legacyDocsImage);
    expect(calls.flat().some((arg) => arg.includes(`${prefix}/docs`))).toBe(false);
    expect(manifest.buildMetadata.images.docs).toBeUndefined();
  });
  it("tags and verifies every approved digest, then advances the release pointer last", () => {
    const { calls, status, stderr } = promote();
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(calls.flatMap(destinations)).toEqual([
      ...apps.flatMap((app) => [`${prefix}/${app}:${sha}`, `${prefix}/${app}:${releaseId}`]),
      `${prefix}/release-manifest:${sha}`,
      `${prefix}/release-manifest:${releaseId}`,
      ...apps.map((app) => `${prefix}/${app}:latest`),
      `${prefix}/release-manifest:latest`,
    ]);
    for (const app of apps) {
      for (const tag of [sha, "latest"]) {
        const call = calls.find((args) => destination(args) === `${prefix}/${app}:${tag}`);
        expect(call?.at(-1)).toBe(`${prefix}/${app}@${digests[app]}`);
      }
      expect(
        calls.some(
          (args) =>
            args[2] === "inspect" &&
            args.includes(`${prefix}/${app}:latest`) &&
            args.includes("--format"),
        ),
      ).toBe(true);
    }
  });

  it.each([
    `--tag ${prefix}/ops-agent:${sha}`,
    `--tag ${prefix}/release-manifest:${sha}`,
    `--tag ${prefix}/ops-agent:latest`,
    `inspect ${prefix}/ops-agent:latest`,
  ])("does not switch the release pointer after failure at %s", (failMatch) => {
    const { calls, status } = promote(failMatch);
    expect(status).toBe(1);
    expect(calls.map(destination)).not.toContain(`${prefix}/release-manifest:latest`);
    if (!failMatch.endsWith(":latest")) {
      expect(calls.some((args) => destination(args)?.endsWith(":latest"))).toBe(false);
    }
  });

  it("rejects a latest tag that does not resolve to the approved digest", () => {
    const { calls, status, stderr } = promote("", true);
    expect(status).toBe(1);
    expect(stderr).toMatch(/digest/i);
    expect(calls.map(destination)).not.toContain(`${prefix}/release-manifest:latest`);
  });
});
