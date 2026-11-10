// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are literal Docker Compose references under test
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose, renderServiceSnippet } from "../services/compose-renderer";
import { validateServiceManifest } from "../services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../services/types";

const validateCommunity = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });
const validateFirstParty = (raw: unknown) => validateServiceManifest(raw, { firstParty: true });

function manifest(container: Record<string, unknown> = {}, quality = "community") {
  return {
    id: "community-limits",
    name: "Community Limits",
    version: "1.0.0",
    quality,
    container: { image: "alpine", tag: "latest", expose: [8080], ...container },
  };
}

function service(
  overrides: Partial<ServiceManifest["container"]>,
  { builtIn }: { builtIn: boolean },
): LoadedService {
  return {
    manifest: {
      id: builtIn ? "first-party-limits" : "community-limits",
      name: "Limits",
      version: "1.0.0",
      quality: builtIn ? "built-in" : "community",
      container: { image: "alpine", tag: "latest", expose: [8080], ...overrides },
    },
    directory: "/tmp/limits",
    isBuiltIn: builtIn,
    enabled: true,
  };
}

describe("community container memory limit", () => {
  it("is required", () => {
    const result = validateCommunity(manifest());
    expect(result.valid).toBe(false);
    expect(result.errors?.join("\n")).toMatch(/community_memory_limit_required/);
  });

  it.each(["6m", "64m", "512m", "1g", "1.5g", "2G", "512MB", "6144k", "0.01g", "6.5m"])(
    "accepts %s",
    (memory) => {
      expect(validateCommunity(manifest({ memory })).valid).toBe(true);
    },
  );

  it.each([
    "",
    "0m",
    "0g",
    "5m",
    "5.9m",
    "1k",
    "6143k",
    "0.005g",
    "512",
    "512x",
    "-1g",
    "lots",
    "1e3m",
    "512m 1g",
    "512m; privileged",
    "m",
    "${MEMORY}",
    "${MEMORY:-512m}",
    "$MEMORY",
  ])("rejects %j", (memory) => {
    const result = validateCommunity(manifest({ memory }));
    expect(result.valid).toBe(false);
    expect(result.errors?.join("\n")).toMatch(/community_memory_limit_required/);
  });

  it("is not required of a first-party service", () => {
    expect(validateFirstParty(manifest({}, "built-in")).valid).toBe(true);
  });

  it("is checked again when a hand-built community service is rendered", () => {
    expect(() => renderServiceSnippet(service({}, { builtIn: false }), {})).toThrow(
      /community_memory_limit_required/,
    );
    expect(() =>
      renderServiceSnippet(service({ memory: "${POSTGRES_PASSWORD}" }, { builtIn: false }), {}),
    ).toThrow(/community_memory_limit_required/);
  });
});

describe("community container hardening", () => {
  it("limits processes, blocks privilege gain and keeps the memory limit", () => {
    const snippet = renderServiceSnippet(service({ memory: "256m" }, { builtIn: false }), {});
    expect(snippet.security_opt).toEqual(["no-new-privileges:true"]);
    expect(snippet).not.toHaveProperty("pids_limit");
    expect(snippet.deploy?.resources?.limits).toEqual({ memory: "256m", pids: 512 });
  });

  it("appears in the rendered Compose file", () => {
    const { composeYaml } = renderCompose([service({ memory: "256m" }, { builtIn: false })], {});
    const rendered = load(composeYaml) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(rendered.services["community-limits"]).toMatchObject({
      security_opt: ["no-new-privileges:true"],
      deploy: { resources: { limits: { memory: "256m", pids: 512 } } },
    });
  });

  it("leaves a first-party service as the manifest declares it", () => {
    const snippet = renderServiceSnippet(service({}, { builtIn: true }), {});
    expect(snippet).not.toHaveProperty("pids_limit");
    expect(snippet).not.toHaveProperty("security_opt");
    expect(snippet.deploy).toBeUndefined();

    const sized = renderServiceSnippet(service({ memory: "2g" }, { builtIn: true }), {});
    expect(sized.deploy?.resources?.limits).toEqual({ memory: "2g" });
    expect(sized).not.toHaveProperty("pids_limit");
    expect(sized).not.toHaveProperty("security_opt");
  });
});

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

// Compose rejects a service that sets pids_limit beside deploy.resources.limits,
// so the rendered file has to parse with the real tool. `config` only reads and
// validates the file: it starts, pulls and builds nothing.
describe.skipIf(!composeAvailable)(
  "community Compose output with the docker compose parser",
  () => {
    it("is a valid project beside a first-party service", () => {
      const { composeYaml } = renderCompose(
        [
          service({ memory: "256m" }, { builtIn: false }),
          service({ memory: "2g" }, { builtIn: true }),
          {
            ...service(
              { memory: "256m", gpu: { driver: "nvidia", count: "all", capabilities: ["gpu"] } },
              { builtIn: false },
            ),
            manifest: {
              ...service(
                { memory: "256m", gpu: { driver: "nvidia", count: "all", capabilities: ["gpu"] } },
                { builtIn: false },
              ).manifest,
              id: "community-gpu",
            },
          },
        ],
        {},
      );
      const directory = mkdtempSync(join(tmpdir(), "openmapx-compose-parse-"));
      try {
        const file = join(directory, "docker-compose.yml");
        writeFileSync(file, composeYaml);
        const output = execFileSync(
          "docker",
          [
            "compose",
            "--project-name",
            "openmapx-parse-check",
            "-f",
            file,
            "config",
            "--format",
            "json",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
        );
        const project = JSON.parse(output) as {
          services: Record<
            string,
            {
              security_opt?: string[];
              deploy?: { resources?: { limits?: Record<string, unknown> } };
            }
          >;
        };
        expect(project.services["community-limits"]?.security_opt).toEqual([
          "no-new-privileges:true",
        ]);
        expect(project.services["community-limits"]?.deploy?.resources?.limits).toMatchObject({
          memory: String(256 * 1024 * 1024),
          pids: 512,
        });
        expect(project.services["community-gpu"]?.deploy?.resources?.limits).toMatchObject({
          pids: 512,
        });
        expect(
          project.services["first-party-limits"]?.deploy?.resources?.limits,
        ).not.toHaveProperty("pids");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
