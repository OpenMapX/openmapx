import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins } from "@openmapx/core/catalog-pins";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureTransitousApiKeysFile,
  generateTransitousApiKeys,
} from "../src/lib/transitous-api-keys";

// Docker bind mounts, as data-manager's generation mounts the keys. The image
// only needs `sh` and `cat`; CI passes one it has already pulled.
const runMountTests = process.env.OPENMAPX_RUN_SECRET_MOUNT_TESTS === "1";
const pinnedImage = process.env.OPENMAPX_SECRET_MOUNT_TEST_IMAGE;
const image = pinnedImage || "alpine:3";

let tmp: string;
const containers: string[] = [];

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf-8" }).trim();
}

function startReading(mount: string): string {
  const id = docker(
    "run",
    "--detach",
    "--rm",
    // An image CI pulled already; the test spends no registry budget.
    ...(pinnedImage ? ["--pull", "never"] : []),
    "--network",
    "none",
    "--user",
    `${process.getuid?.()}:${process.getgid?.()}`,
    "--volume",
    mount,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "sleep 300",
  );
  containers.push(id);
  return id;
}

const readInside = (id: string) => docker("exec", id, "cat", "/config/transitous/api-keys.json");

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-api-keys-mount-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n", { mode: 0o600 });
  mkdirSync(join(tmp, "services"), { mode: 0o700 });
  const catalog = join(tmp, "infra", "docker", "data", ".transitous-catalog");
  mkdirSync(join(catalog, ".git"), { recursive: true, mode: 0o700 });
  mkdirSync(join(catalog, "feeds"), { recursive: true, mode: 0o700 });
  mkdirSync(join(catalog, "transitland-atlas", "feeds"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(catalog, "feeds", "de.json"),
    JSON.stringify({ sources: [{ name: "BVG", "transitland-atlas-id": "f-bvg" }] }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(catalog, "transitland-atlas", "feeds", "de.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "f-bvg", authorization: { type: "header" } }] }),
    { mode: 0o600 },
  );
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenMapX mount fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "OpenMapX mount fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  const atlas = join(catalog, "transitland-atlas");
  git(atlas, ["init"]);
  git(atlas, ["add", "feeds"]);
  git(atlas, ["commit", "-m", "Pinned mount atlas"]);
  const atlasSha = git(atlas, ["rev-parse", "HEAD"]);
  git(catalog, ["init"]);
  writeFileSync(
    join(catalog, ".gitmodules"),
    `[submodule "transitland-atlas"]\npath = transitland-atlas\nurl = ${atlas}\n`,
    { mode: 0o600 },
  );
  git(catalog, ["add", "feeds", ".gitmodules"]);
  git(catalog, ["update-index", "--add", "--cacheinfo", `160000,${atlasSha},transitland-atlas`]);
  git(catalog, ["commit", "-m", "Pinned mount catalog"]);
  const infraDir = join(tmp, "infra/docker");
  writeFileSync(
    join(infraDir, "transitous.lock.json"),
    JSON.stringify({
      ref: `main@${git(catalog, ["rev-parse", "HEAD"])}`,
      submodules: { "transitland-atlas": atlasSha },
      lockedAt: "2026-10-31T00:00:00.000Z",
      lockedBy: "mount-fixture",
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(infraDir, "gbfs-catalog.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: "a".repeat(40),
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"a".repeat(40)}/systems.csv`,
      sha256: "b".repeat(64),
      lockedAt: "2026-10-31T00:00:00.000Z",
      lockedBy: "mount-fixture",
    }),
    { mode: 0o600 },
  );
  await provisionControlInstallation(infraDir);
  const installation = openControlInstallation({
    infraDir,
    role: "host-cli",
    serviceIds: ["motis"],
  });
  try {
    const pins = await initializeManagedCatalogPins({ rootDir: tmp, installation });
    expect(pins?.transitous.submodules["transitland-atlas"]).toBe(atlasSha);
  } finally {
    closeControlInstallation(installation);
  }
});

afterEach(() => {
  for (const id of containers.splice(0)) docker("rm", "--force", id);
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(runMountTests)("the Transitous API keys mount", () => {
  it("shows a running container the keys generate-api-keys replaced, without recreating it", async () => {
    const keys = ensureTransitousApiKeysFile(tmp).path;
    const directory = join(keys, "..");
    const container = startReading(`${directory}:/config/transitous:ro`);
    const startedAt = docker("inspect", "--format", "{{.State.StartedAt}}", container);
    // Why the directory: a file mount keeps the inode it was created with.
    const fileMounted = startReading(`${keys}:/config/transitous/api-keys.json:ro`);
    expect(readInside(container)).toBe("{}");
    expect(readInside(fileMounted)).toBe("{}");

    await generateTransitousApiKeys({ rootDir: tmp });

    const replaced = readFileSync(keys, "utf-8").trim();
    expect(JSON.parse(replaced)).toEqual({ "de/BVG": "" });
    expect(readInside(container)).toBe(replaced);
    expect(docker("inspect", "--format", "{{.State.StartedAt}}", container)).toBe(startedAt);
    // Linux shows the replaced file's old bytes; Docker Desktop loses the file.
    let throughFileMount: string;
    try {
      throughFileMount = readInside(fileMounted);
    } catch {
      throughFileMount = "(unreadable)";
    }
    expect(throughFileMount).not.toBe(replaced);
  });
});
