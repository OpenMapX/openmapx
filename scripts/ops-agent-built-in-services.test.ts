import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRuntimeBundle,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
let outdir = "";

beforeAll(async () => {
  // A private output directory inside the repository, so the bundle's pinned
  // dependency paths resolve exactly as they do from apps/ops-agent/dist.
  mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
  outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "built-in-"));
  const bundle = await buildRuntimeBundle(ROOT, "ops-agent", {
    ...RUNTIME_BUNDLES["ops-agent"],
    outdir: relative(ROOT, outdir),
  });
  writeRuntimeBundle(bundle);
}, 120_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repositoryManifest(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "services", id, "service.json"), "utf8"));
}

/**
 * A host checkout the release must not trust: written under a umask of 002,
 * one manifest tampered with, one built-in the release adds still missing, and
 * one service directory the release does not have.
 */
function hostileCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-hostile-checkout-"));
  roots.push(root);
  cpSync(join(ROOT, "services"), join(root, "services"), {
    recursive: true,
    filter: (source) => !source.includes(`${join("services", ".community")}`),
  });
  rmSync(join(root, "services", "brouter"), { recursive: true });
  const valhalla = repositoryManifest("valhalla") as {
    version: string;
    container: Record<string, unknown>;
  };
  writeFileSync(
    join(root, "services", "valhalla", "service.json"),
    JSON.stringify({
      ...valhalla,
      version: "6.6.6-tampered",
      container: { ...valhalla.container, image: "attacker.invalid/valhalla", privileged: true },
    }),
  );
  mkdirSync(join(root, "services", "unlisted-engine"));
  writeFileSync(
    join(root, "services", "unlisted-engine", "service.json"),
    JSON.stringify({ ...repositoryManifest("redis"), id: "unlisted-engine" }),
  );
  mkdirSync(join(root, "infra", "docker"), { recursive: true });
  const groupWritable = (path: string) => {
    chmodSync(path, 0o775);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) groupWritable(child);
      else if (entry.isFile()) chmodSync(child, 0o664);
    }
  };
  groupWritable(root);
  return root;
}

async function cli(checkout: string, ...args: string[]) {
  return run(process.execPath, [join(outdir, "cli.mjs"), ...args], {
    cwd: checkout,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: checkout },
  }).catch((error: { stdout: string; stderr: string; code: number }) => error);
}

describe("the ops-agent's fixed CLI", () => {
  it("runs the release's built-in manifests, whatever the checkout holds", async () => {
    const checkout = hostileCheckout();
    const listed = await cli(checkout, "services", "list", "--quality", "built-in");
    expect(listed.stdout).toContain("brouter");
    expect(listed.stdout).not.toContain("unlisted-engine");
    expect(listed.stdout).not.toContain("6.6.6-tampered");

    const valhalla = JSON.parse((await cli(checkout, "services", "get", "valhalla")).stdout);
    expect(valhalla).toEqual(repositoryManifest("valhalla"));
    const missing = await cli(checkout, "services", "get", "unlisted-engine");
    expect(missing.stdout).toBe("");
  }, 60_000);

  it("reports the release's service files, whatever the checkout holds, and prints them for the host CLI", async () => {
    const checkout = hostileCheckout();
    const checked = await cli(checkout, "check", "--no-probe");
    const output = `${checked.stdout}\n${checked.stderr}`;
    // The checkout's manifests don't matter to the agent any more; its edits
    // to service files become overrides at the next render.
    expect(output).toContain("The next render imports, once");
    expect(output).not.toContain("missing brouter");

    const printed = await cli(checkout, "compose", "release-files");
    const index = JSON.parse(printed.stdout) as {
      manifests: Record<string, string>;
      files: Array<{ serviceId: string; path: string; executable: boolean }>;
    };
    // The release's manifests, brouter included, not the tampered valhalla.
    expect(index.manifests.valhalla).toBe(
      createHash("sha256")
        .update(readFileSync(join(ROOT, "services", "valhalla", "service.json")))
        .digest("hex"),
    );
    expect(index.files).toContainEqual(
      expect.objectContaining({ serviceId: "brouter", path: "scripts/run.sh" }),
    );
    expect(index.files).toContainEqual(
      expect.objectContaining({
        serviceId: "postgis",
        path: "scripts/sync-password.sh",
        executable: true,
      }),
    );
  }, 60_000);
});
