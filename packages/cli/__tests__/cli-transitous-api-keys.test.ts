import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  describeTransitousApiKeysMigration,
  ensureTransitousApiKeysFile,
  generateTransitousApiKeys,
  legacyTransitousApiKeysPath,
  transitousApiKeysPath,
} from "../src/lib/transitous-api-keys";

let tmp: string;

function writeTransitousCatalog(catalogDir: string): void {
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(join(catalogDir, "transitland-atlas", "feeds", "nested"), { recursive: true });

  writeFileSync(
    join(catalogDir, "feeds", "us-ca.json"),
    JSON.stringify({
      sources: [
        { name: "NeedsKey", "transitland-atlas-id": "atlas-auth-1" },
        { name: "NoAuthNeeded", "transitland-atlas-id": "atlas-open" },
        { name: "AlreadyInCatalog", "transitland-atlas-id": "atlas-auth-1", "api-key": "inline" },
        { name: "CustomUrl", "transitland-atlas-id": "atlas-auth-1", "url-override": "https://x" },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "feeds", "ca-qc.json"),
    JSON.stringify({
      sources: [{ name: "QuebecAgency", "transitland-atlas-id": "atlas-auth-2", skip: true }],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "transitland-atlas", "feeds", "nested", "agencies.dmfr.json"),
    JSON.stringify({
      feeds: [
        { id: "atlas-auth-1", authorization: { type: "api-key" } },
        { id: "atlas-auth-2", authorization: { type: "token" } },
        { id: "atlas-open" },
      ],
    }),
    "utf-8",
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-api-keys-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const keysPath = () => transitousApiKeysPath(join(tmp, "infra", "docker"));
const legacyPath = () => legacyTransitousApiKeysPath(tmp);
const mode = (path: string) => lstatSync(path).mode & 0o777;

/** An earlier release's keys file, as an operator kept it. */
function writeLegacy(contents: unknown, fileMode = 0o600): void {
  writeFileSync(legacyPath(), `${JSON.stringify(contents, null, 2)}\n`);
  chmodSync(legacyPath(), fileMode);
}

describe("generateTransitousApiKeys", () => {
  it("clones the Transitous catalog and preserves the keys carried over from the checkout", async () => {
    const outputPath = keysPath();
    writeLegacy({
      "us-ca/NeedsKey": "preserved-secret",
      "legacy/no-longer-needed": "stale-value",
    });
    const earlier = readFileSync(legacyPath(), "utf-8");

    const catalogDir = join(tmp, "infra", "docker", "data", ".transitous-catalog");
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args.includes("clone")) {
        const targetDir = args.at(-1);
        if (typeof targetDir === "string") {
          writeTransitousCatalog(targetDir);
        }
      }
    };

    const result = await generateTransitousApiKeys({ rootDir: tmp, runner });

    expect(result.requiredCount).toBe(2);
    expect(result.preservedCount).toBe(1);
    expect(result.droppedCount).toBe(1);
    expect(result.outputPath).toBe(outputPath);
    expect(result.keysFile?.created).toBe("copied");
    expect(JSON.parse(readFileSync(outputPath, "utf-8")) as Record<string, string>).toStrictEqual({
      "ca-qc/QuebecAgency": "",
      "us-ca/NeedsKey": "preserved-secret",
    });
    expect(mode(outputPath)).toBe(0o600);
    // Copied, not moved: the earlier release still finds its file.
    expect(readFileSync(legacyPath(), "utf-8")).toBe(earlier);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "-c",
          `safe.directory=${catalogDir}`,
          "clone",
          "--depth",
          "1",
          "--recurse-submodules",
          "--shallow-submodules",
          "--",
          DEFAULT_TRANSITOUS_REPO_URL,
          catalogDir,
        ],
        cwd: join(tmp, "infra", "docker", "data"),
      },
    ]);
  });

  it("uses an existing cached catalog and continues when git pull fails", async () => {
    const catalogDir = join(tmp, "infra", "docker", "data", ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    writeTransitousCatalog(catalogDir);

    const safe = `safe.directory=${catalogDir}`;
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args.includes("pull")) {
        throw new Error("network unavailable");
      }
    };

    const result = await generateTransitousApiKeys({ rootDir: tmp, runner });

    expect(result.requiredCount).toBe(2);
    expect(result.preservedCount).toBe(0);
    expect(result.droppedCount).toBe(0);
    expect(result.keysFile?.created).toBe("empty");
    expect(JSON.parse(readFileSync(keysPath(), "utf-8")) as Record<string, string>).toStrictEqual({
      "ca-qc/QuebecAgency": "",
      "us-ca/NeedsKey": "",
    });
    expect(existsSync(legacyPath())).toBe(false);
    expect(calls).toEqual([
      {
        command: "git",
        args: ["-c", safe, "-C", catalogDir, "reset", "--hard", "HEAD"],
        cwd: catalogDir,
      },
      {
        command: "git",
        args: ["-c", safe, "-C", catalogDir, "pull", "--ff-only"],
        cwd: join(tmp, "infra", "docker", "data"),
      },
      {
        command: "git",
        args: [
          "-c",
          safe,
          "-C",
          catalogDir,
          "submodule",
          "update",
          "--init",
          "--checkout",
          "--depth",
          "1",
        ],
        cwd: join(tmp, "infra", "docker", "data"),
      },
    ]);
  });

  it("replaces the keys file atomically inside its directory", async () => {
    const catalogDir = join(tmp, "infra", "docker", "data", ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    writeTransitousCatalog(catalogDir);
    ensureTransitousApiKeysFile(tmp);
    const before = lstatSync(keysPath()).ino;

    await generateTransitousApiKeys({ rootDir: tmp, runner: async () => {} });

    // A new file renamed into place, so the directory data-manager mounts
    // shows it; nothing else is left beside it.
    expect(lstatSync(keysPath()).ino).not.toBe(before);
    expect(readdirSync(join(keysPath(), ".."))).toEqual(["api-keys.json"]);
    expect(mode(keysPath())).toBe(0o600);
  });
});

describe("ensureTransitousApiKeysFile", () => {
  it("creates a private directory holding only an empty keys file", () => {
    const result = ensureTransitousApiKeysFile(tmp);

    expect(result).toEqual({ path: keysPath(), created: "empty" });
    expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
    expect(mode(keysPath())).toBe(0o600);
    expect(mode(join(keysPath(), ".."))).toBe(0o700);
    expect(readdirSync(join(keysPath(), ".."))).toEqual(["api-keys.json"]);
    expect(describeTransitousApiKeysMigration(result, tmp)).toBeNull();
  });

  it("copies the earlier release's file once, leaving it in place", () => {
    writeLegacy({ "us-ca/NeedsKey": "secret" });
    const earlier = readFileSync(legacyPath(), "utf-8");

    const first = ensureTransitousApiKeysFile(tmp);
    expect(first.created).toBe("copied");
    expect(readFileSync(keysPath(), "utf-8")).toBe(earlier);
    expect(readFileSync(legacyPath(), "utf-8")).toBe(earlier);
    expect(mode(legacyPath())).toBe(0o600);
    expect(describeTransitousApiKeysMigration(first, tmp)).toEqual({
      level: "info",
      message:
        "Copied the Transitous API keys from services/motis/tools/transitous/api-keys.json to infra/docker/secrets/transitous-api-keys/api-keys.json; the earlier file stays for rolling back and is no longer read.",
    });

    // Later edits in the checkout are no longer read.
    writeLegacy({ "us-ca/NeedsKey": "changed" });
    expect(ensureTransitousApiKeysFile(tmp)).toEqual({ path: keysPath(), created: null });
    expect(readFileSync(keysPath(), "utf-8")).toBe(earlier);
  });

  it.each([
    ["group or others can write it", () => writeLegacy({ a: "b" }, 0o664)],
    ["it is not a JSON object of key strings", () => writeFileSync(legacyPath(), "{ not json")],
    ["it is not a JSON object of key strings", () => writeLegacy({ a: 1 })],
    [
      "it has 2 links",
      () => {
        writeLegacy({ a: "b" });
        linkSync(legacyPath(), join(tmp, "elsewhere.json"));
      },
    ],
    [
      "it is a symbolic link",
      () => {
        writeFileSync(join(tmp, "target.json"), "{}");
        symlinkSync(join(tmp, "target.json"), legacyPath());
      },
    ],
  ])("leaves an earlier file in place when %s, and starts empty", (reason, arrange) => {
    arrange();
    const earlier = lstatSync(legacyPath());

    const result = ensureTransitousApiKeysFile(tmp);

    expect(result).toEqual({
      path: keysPath(),
      created: "empty",
      leftInPlace: { path: legacyPath(), reason },
    });
    expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
    expect(lstatSync(legacyPath()).mtimeMs).toBe(earlier.mtimeMs);
    expect(lstatSync(legacyPath()).mode).toBe(earlier.mode);
    expect(describeTransitousApiKeysMigration(result, tmp)).toEqual({
      level: "warn",
      message: `Left the earlier Transitous API keys file services/motis/tools/transitous/api-keys.json in place and started an empty infra/docker/secrets/transitous-api-keys/api-keys.json: ${reason}. If it is yours, check it and copy its keys into the new file, or run pnpm openmapx data generate-api-keys and enter them again.`,
    });
  });

  it("keeps an existing keys file owner-only", () => {
    ensureTransitousApiKeysFile(tmp);
    chmodSync(keysPath(), 0o664);

    expect(ensureTransitousApiKeysFile(tmp).created).toBeNull();
    expect(mode(keysPath())).toBe(0o600);
  });

  it("refuses an existing keys file it can't use", () => {
    ensureTransitousApiKeysFile(tmp);
    writeFileSync(keysPath(), "[]");

    expect(() => ensureTransitousApiKeysFile(tmp)).toThrow(
      `Transitous API keys at ${keysPath()} can't be used: it is not a JSON object of key strings`,
    );
  });
});
