import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { commitConfigurationGeneration } from "../configuration-generation";
import { CURRENT_CONFIGURATION } from "../deployment";
import { readBuiltInServices } from "../release-authority-inventory";
import { releaseServiceFiles, renderedEmbeddedReleaseServiceFiles } from "../release-service-files";
import { serviceFilesImported } from "../service-file-import";
import type { LoadedService, ServiceManifest } from "../types";

// As the ops-agent's runtime bundle runs: its release's files embedded.
vi.mock("../embedded-service-files", () => import("../embedded-service-files.bundle"));
vi.mock("../embedded-built-in-services", () => import("../embedded-built-in-services.bundle"));

const REPOSITORY = fileURLToPath(new URL("../../../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Martin in a checkout whose martin.yaml the operator changed. */
function checkoutMartin(): LoadedService {
  const root = mkdtempSync(join(tmpdir(), "openmapx-local-service-files-"));
  roots.push(root);
  const directory = join(root, "services", "martin");
  cpSync(join(REPOSITORY, "services", "martin"), directory, { recursive: true });
  writeFileSync(join(directory, "config", "martin.yaml"), "listen_addresses: 0.0.0.0:3001\n");
  return {
    manifest: JSON.parse(readFileSync(join(directory, "service.json"), "utf8")) as ServiceManifest,
    directory,
    isBuiltIn: true,
    enabled: true,
  };
}

it("imports nothing under OPENMAPX_RELEASE=local, and mounts the checkout's edit; a release's render imports it", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-local-render-"));
  roots.push(root);
  cpSync(join(REPOSITORY, "services"), join(root, "services"), {
    recursive: true,
    filter: (source) =>
      !source.split(/[/\\]/).includes("node_modules") &&
      !["generated-routes.yml", "auth.yml"].includes(basename(source)),
  });
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  // The agent's built-ins: the bundle's manifests, mounting from the checkout.
  const services = readBuiltInServices(root).services;
  const edited = "listen_addresses: 0.0.0.0:3001\n";
  writeFileSync(join(root, "services", "martin", "config", "martin.yaml"), edited);
  const commit = () =>
    commitConfigurationGeneration({
      infraDir,
      services,
      input: {
        domain: "maps.example.test",
        selectedRoots: ["martin", "postgis"],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      legacyTraefikDynamicMounted: false,
    });
  const mountedMartin = () => {
    const compose = readFileSync(
      join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    );
    const block = compose.slice(compose.indexOf("\n  martin:\n"));
    const line = block.split("\n").find((entry) => entry.includes(":/etc/martin/martin.yaml"));
    const source = line?.trim().replace(/^- /, "").split(":")[0] ?? "";
    return readFileSync(join(infraDir, CURRENT_CONFIGURATION, source), "utf8");
  };

  vi.stubEnv("OPENMAPX_RELEASE", "local");
  const local = await commit();
  expect(mountedMartin()).toBe(edited);
  expect(serviceFilesImported(infraDir)).toBe(false);
  expect(existsSync(join(infraDir, "overrides"))).toBe(false);
  expect(local.serviceFileReport).toEqual([]);

  vi.unstubAllEnvs();
  const released = await commit();
  expect(released.serviceFileReport[0]).toEqual({
    level: "info",
    message: expect.stringContaining(
      "Imported 1 checkout service file that differs from every version a release shipped as overrides",
    ),
  });
  expect(mountedMartin()).toBe(edited);
  expect(
    readFileSync(
      join(infraDir, "overrides", "services", "martin", "config", "martin.yaml"),
      "utf8",
    ),
  ).toBe(edited);
});

it("renders the bundle's files, unless OPENMAPX_RELEASE=local makes the checkout's the release's", () => {
  const martin = checkoutMartin();
  const released = releaseServiceFiles([martin]);
  expect(released.origin).toBe("release");
  expect(released.files.get("martin/config/martin.yaml")?.bytes).toEqual(
    readFileSync(join(REPOSITORY, "services", "martin", "config", "martin.yaml")),
  );

  expect(renderedEmbeddedReleaseServiceFiles()?.origin).toBe("release");

  vi.stubEnv("OPENMAPX_RELEASE", "local");
  // What the agent's start-up report reads: none, the checkout's are the release's.
  expect(renderedEmbeddedReleaseServiceFiles()).toBeNull();
  const local = releaseServiceFiles([martin]);
  expect(local.origin).toBe("checkout");
  expect(local.files.get("martin/config/martin.yaml")?.bytes.toString()).toBe(
    "listen_addresses: 0.0.0.0:3001\n",
  );
});
