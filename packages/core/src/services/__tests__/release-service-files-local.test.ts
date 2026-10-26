import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { releaseServiceFiles } from "../release-service-files";
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

it("renders the bundle's files, unless OPENMAPX_RELEASE=local makes the checkout's the release's", () => {
  const martin = checkoutMartin();
  const released = releaseServiceFiles([martin]);
  expect(released.origin).toBe("release");
  expect(released.files.get("martin/config/martin.yaml")?.bytes).toEqual(
    readFileSync(join(REPOSITORY, "services", "martin", "config", "martin.yaml")),
  );

  vi.stubEnv("OPENMAPX_RELEASE", "local");
  const local = releaseServiceFiles([martin]);
  expect(local.origin).toBe("checkout");
  expect(local.files.get("martin/config/martin.yaml")?.bytes.toString()).toBe(
    "listen_addresses: 0.0.0.0:3001\n",
  );
});
