import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-api-keys-mount-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"));
  const catalog = join(tmp, "infra", "docker", "data", ".transitous-catalog");
  mkdirSync(join(catalog, ".git"), { recursive: true });
  mkdirSync(join(catalog, "feeds"), { recursive: true });
  mkdirSync(join(catalog, "transitland-atlas", "feeds"), { recursive: true });
  writeFileSync(
    join(catalog, "feeds", "de.json"),
    JSON.stringify({ sources: [{ name: "BVG", "transitland-atlas-id": "f-bvg" }] }),
  );
  writeFileSync(
    join(catalog, "transitland-atlas", "feeds", "de.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "f-bvg", authorization: { type: "header" } }] }),
  );
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
    // Why the directory: a file mount keeps the inode it was created with.
    const fileMounted = startReading(`${keys}:/config/transitous/api-keys.json:ro`);
    expect(readInside(container)).toBe("{}");
    expect(readInside(fileMounted)).toBe("{}");

    await generateTransitousApiKeys({ rootDir: tmp, runner: async () => {} });

    const replaced = readFileSync(keys, "utf-8").trim();
    expect(JSON.parse(replaced)).toEqual({ "de/BVG": "" });
    expect(readInside(container)).toBe(replaced);
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
