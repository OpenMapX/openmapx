import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("production supply-chain policy", () => {
  it("keeps digest pins current through reviewable Renovate PRs", () => {
    const renovate = JSON.parse(read("renovate.json")) as {
      enabledManagers?: string[];
      customManagers?: Array<{
        datasourceTemplate?: string;
        managerFilePatterns?: string[];
        matchStrings?: string[];
      }>;
    };
    const manager = renovate.customManagers?.[0];

    expect(renovate.enabledManagers).toContain("custom.regex");
    expect(manager?.datasourceTemplate).toBe("docker");
    expect(manager?.managerFilePatterns).toContain("/^services\\/[^/]+\\/service\\.json$/");
    expect(manager?.matchStrings?.[0]).toContain("?<currentDigest>");

    const matcher = new RegExp(manager?.matchStrings?.[0] ?? "(?!x)x");
    const managedServices = readdirSync(join(root, "services"), { withFileTypes: true }).filter(
      (entry) => {
        const path = join(root, "services", entry.name, "service.json");
        return (
          entry.isDirectory() &&
          (() => {
            try {
              return matcher.test(readFileSync(path, "utf8"));
            } catch {
              return false;
            }
          })()
        );
      },
    );
    expect(managedServices).toHaveLength(24);
  });

  it("pins every third-party service image to an immutable manifest digest", () => {
    const serviceRoot = join(root, "services");
    const violations: string[] = [];

    for (const entry of readdirSync(serviceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(serviceRoot, entry.name, "service.json");
      let manifest: { container?: { image?: string; digest?: string } };
      try {
        manifest = JSON.parse(readFileSync(path, "utf8")) as typeof manifest;
      } catch {
        continue;
      }
      const container = manifest.container;
      if (!container?.image || container.image.startsWith("ghcr.io/openmapx/")) continue;
      if (!/^sha256:[a-f0-9]{64}$/.test(container.digest ?? "")) {
        violations.push(entry.name);
      }
    }

    expect(violations).toEqual([]);

    const generatedImages = read("infra/docker/docker-compose.generated.yml")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("image: "));
    expect(generatedImages).not.toHaveLength(0);
    expect(
      generatedImages.filter(
        (line) => !line.includes("ghcr.io/openmapx/") && !/@sha256:[a-f0-9]{64}$/.test(line),
      ),
    ).toEqual([]);
  });

  it("stages the patch directory in every image that installs from the lockfile", () => {
    // `patchedDependencies` makes the lockfile reference each patch by file
    // hash, so a `pnpm install --frozen-lockfile` that cannot read the patch
    // fails outright. Every image that installs must therefore copy the
    // patches its own workspace root declares.
    for (const [workspaceRoot, dockerfiles] of [
      [
        ".",
        [
          "apps/api/Dockerfile",
          "apps/ops-agent/Dockerfile",
          "apps/transitous-runner/Dockerfile",
          "apps/web/Dockerfile",
          "services/data-manager/Dockerfile",
        ],
      ],
      ["docs", ["docs/Dockerfile"]],
    ] as const) {
      const workspace = read(
        `${workspaceRoot === "." ? "" : `${workspaceRoot}/`}pnpm-workspace.yaml`,
      );
      if (!workspace.includes("patchedDependencies:")) continue;
      for (const dockerfile of dockerfiles) {
        const contents = read(dockerfile);
        const installs = contents.match(/pnpm install --frozen-lockfile/g)?.length ?? 0;
        expect(installs, dockerfile).toBeGreaterThan(0);
        expect(contents.match(/COPY patches\/ patches\//g)?.length ?? 0, dockerfile).toBe(installs);
      }
    }
  });

  it("requires hashes for downloaded executable and Python artifacts", () => {
    const dataManagerDockerfile = read("services/data-manager/Dockerfile");
    const transitousDockerfile = read("services/motis/tools/transitous/Dockerfile");
    const transitousRunnerDockerfile = read("apps/transitous-runner/Dockerfile");
    const requirements = read("services/motis/tools/transitous/requirements.txt");

    expect(dataManagerDockerfile.match(/sha256sum -c -/g)).toHaveLength(3);
    expect(dataManagerDockerfile).toMatch(/pip3 install[^\n]*--require-hashes/);
    expect(transitousDockerfile).not.toContain('MOTIS_SHA256_AMD64=""');
    expect(transitousDockerfile).not.toContain('MOTIS_SHA256_ARM64=""');
    expect(transitousDockerfile).toContain("sha256sum -c -");
    expect(transitousDockerfile).toMatch(/pip3 install[^\n]*--require-hashes/);
    // The private runner executes the same upstream Python, so it installs it
    // from the same hash-locked requirements rather than a second lock.
    expect(transitousRunnerDockerfile).toMatch(/pip3 install[^\n]*--require-hashes/);
    expect(transitousRunnerDockerfile).toContain(
      "COPY services/motis/tools/transitous/requirements.txt",
    );
    expect(requirements).toContain("--hash=sha256:");
  });
});
