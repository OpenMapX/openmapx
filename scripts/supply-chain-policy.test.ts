import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("production supply-chain policy", () => {
  it("primes pnpm before the offline build stages of every Node image", () => {
    for (const dockerfile of [
      "apps/api/Dockerfile",
      "apps/ops-agent/Dockerfile",
      "apps/transitous-runner/Dockerfile",
      "apps/web/Dockerfile",
      "docs/Dockerfile",
      "services/data-manager/Dockerfile",
    ]) {
      expect(
        read(dockerfile),
        `${dockerfile} must prime pnpm before offline build stages`,
      ).toContain("pnpm --version");
    }
  });

  it("keeps the Dependabot note that the React Native Jest preset follows the runtime", () => {
    expect(read(".github/dependabot.yml")).toMatch(
      /- dependency-name: "@react-native\/jest-preset"\n\s+# Kept aligned with react-native/,
    );
  });

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
    expect(managedServices.map((entry) => entry.name).sort()).toEqual(
      readdirSync(join(root, "services"), { withFileTypes: true })
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          try {
            const manifest = JSON.parse(read(`services/${entry.name}/service.json`));
            return (
              manifest.container?.digest &&
              !manifest.container.image.startsWith("ghcr.io/openmapx/")
            );
          } catch {
            return false;
          }
        })
        .map((entry) => entry.name)
        .sort(),
    );
    expect(managedServices.map((entry) => entry.name)).toContain("brouter");

    const globalMatcher = new RegExp(manager?.matchStrings?.[0] ?? "(?!x)x", "g");
    for (const slug of ["tileserver", "pelias"]) {
      const text = read(`services/${slug}/service.json`);
      const manifest = JSON.parse(text) as { buildImages?: Record<string, { image: string }> };
      const matched = new Set([...text.matchAll(globalMatcher)].map((m) => m.groups?.depName));
      for (const buildImage of Object.values(manifest.buildImages ?? {})) {
        expect(matched).toContain(buildImage.image);
      }
    }
  });

  it("stages patches exactly when an image's workspace lockfile requires them", () => {
    // `patchedDependencies` makes the lockfile reference each patch by file
    // hash, so a `pnpm install --frozen-lockfile` that cannot read the patch
    // fails outright. Conversely, Docker rejects a COPY when that workspace's
    // patch directory no longer exists. Keep each install stage in exact sync
    // with the patches its own workspace root declares.
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
      const hasPatchedDependencies = workspace.includes("patchedDependencies:");
      for (const dockerfile of dockerfiles) {
        const contents = read(dockerfile);
        const installs = contents.match(/pnpm install --frozen-lockfile/g)?.length ?? 0;
        expect(installs, dockerfile).toBeGreaterThan(0);
        expect(contents.match(/COPY patches\/ patches\//g)?.length ?? 0, dockerfile).toBe(
          hasPatchedDependencies ? installs : 0,
        );
      }
    }
  });

  it("requires hashes for downloaded executable and Python artifacts", () => {
    const dataManagerDockerfile = read("services/data-manager/Dockerfile");
    const transitousDockerfile = read("services/motis/tools/transitous/Dockerfile");
    const transitousRunnerDockerfile = read("apps/transitous-runner/Dockerfile");
    const requirements = read("services/motis/tools/transitous/requirements.txt");

    // DuckDB is the image's one downloaded executable.
    expect(dataManagerDockerfile.match(/sha256sum -c -/g)).toHaveLength(1);
    for (const architecture of ["AMD64", "ARM64"]) {
      expect(dataManagerDockerfile).toMatch(
        new RegExp(`^ARG DUCKDB_SHA256_${architecture}=[a-f0-9]{64}$`, "m"),
      );
    }
    expect(dataManagerDockerfile).not.toMatch(/download\.docker\.com|docker\/compose\/releases/);
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
