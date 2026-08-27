import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_TTL_MS,
  mintTransitousCapability,
  type TransitousRunnerScript,
  transitousRunnerArgv,
  transitousRunnerScriptSchema,
} from "@openmapx/core/transitous-runner";
import { afterEach, describe, expect, it } from "vitest";
import { createTransitousRunner, TransitousRunnerError } from "./runner";
import { buildTransitousRunnerServer } from "./server";

const roots: string[] = [];
const KEY = Buffer.alloc(32, 3);
const NOW = 1_760_000_000_000;
const capability = (run: TransitousRunnerScript = { script: "garbage-collect" }) =>
  mintTransitousCapability(KEY, { now: NOW, run });

function fixture(): { catalogDir: string; stagingDir: string } {
  const base = mkdtempSync(join(tmpdir(), "openmapx-transitous-runner-"));
  roots.push(base);
  const catalogDir = join(base, "catalog");
  const stagingDir = join(base, "staging");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(join(catalogDir, "src"), { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(catalogDir, "feeds", "de.json"), "{}");
  return { catalogDir, stagingDir };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** A spawn stub that records the call and exits cleanly. */
function recordingSpawn(calls: Array<{ file: string; args: string[]; options: never }>) {
  return ((file: string, args: string[], options: never) => {
    calls.push({ file, args, options });
    const child = {
      pid: 4242,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      kill: () => undefined,
      on(event: string, listener: (value?: unknown) => void) {
        if (event === "close") setTimeout(() => listener(0), 0);
        return child;
      },
    };
    return child;
  }) as never;
}

describe("private Transitous runner", () => {
  it("executes only the fixed argv derived from a typed script", () => {
    expect(transitousRunnerArgv({ script: "garbage-collect" })).toEqual([
      "./src/garbage-collect.py",
      "--non-interactive",
    ]);
    expect(
      transitousRunnerArgv({
        script: "generate-motis-config",
        importOnly: true,
        feedProxy: false,
        countries: ["de", "fr"],
      }),
    ).toEqual([
      "./src/generate-motis-config.py",
      "--import-only",
      "--skip-missing-files",
      "de",
      "fr",
    ]);
  });

  it("runs in the catalog with a scrubbed environment and its own process group", async () => {
    const { catalogDir, stagingDir } = fixture();
    const calls: Array<{ file: string; args: string[]; options: never }> = [];
    process.env.OPENMAPX_FIXTURE_SECRET = "fixture-platform-secret";
    process.env.TRANSITOUS_FEED_PROXY_KEY_FILE = "/secrets/transitous-feed-proxy.age";

    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl: recordingSpawn(calls),
    });
    await runner.run({ version: 1, capability: capability(), run: { script: "garbage-collect" } });

    const [call] = calls as unknown as Array<{
      file: string;
      args: string[];
      options: { cwd: string; detached: boolean; env: Record<string, string> };
    }>;
    expect(call?.file).toBe("python3");
    expect(call?.options.cwd).toBe(catalogDir);
    // Killable as a group: upstream scripts spawn their own children.
    expect(call?.options.detached).toBe(true);
    // Only the declared allowlist reaches upstream code; the feed-decryption
    // key path is on it, everything else in this process's environment is not.
    expect(Object.keys(call?.options.env ?? {}).sort()).toEqual([
      "HOME",
      "PATH",
      "TMPDIR",
      "TRANSITOUS_FEED_PROXY_KEY_FILE",
    ]);
    expect(JSON.stringify(call?.options.env)).not.toContain("fixture-platform-secret");
    // Writable scratch is the staging directory, never the catalog.
    expect(call?.options.env.TMPDIR).toBe(stagingDir);

    delete process.env.OPENMAPX_FIXTURE_SECRET;
    delete process.env.TRANSITOUS_FEED_PROXY_KEY_FILE;
  });

  it("consumes a capability exactly once", async () => {
    const { catalogDir, stagingDir } = fixture();
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl: recordingSpawn([]),
    });
    const request = {
      version: 1 as const,
      capability: capability(),
      run: { script: "garbage-collect" as const },
    };
    await expect(runner.run(request)).resolves.toMatchObject({ ok: true });
    // A leaked token cannot be replayed.
    await expect(runner.run(request)).rejects.toBeInstanceOf(TransitousRunnerError);
  });

  it("rejects an unknown capability without running anything", async () => {
    const { catalogDir, stagingDir } = fixture();
    const calls: Array<{ file: string; args: string[]; options: never }> = [];
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl: recordingSpawn(calls),
    });
    await expect(
      runner.run({
        version: 1,
        capability: `trc1_${"b".repeat(40)}`,
        run: { script: "garbage-collect" },
      }),
    ).rejects.toThrow(/capability/i);
    expect(calls).toEqual([]);
  });

  it("refuses a feed path that escapes the catalog through a symlink", async () => {
    const { catalogDir, stagingDir } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "openmapx-runner-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.json"), "fixture-outside-secret");
    symlinkSync(join(outside, "secret.json"), join(catalogDir, "feeds", "escape.json"));

    const calls: Array<{ file: string; args: string[]; options: never }> = [];
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl: recordingSpawn(calls),
    });
    await expect(
      runner.run({
        version: 1,
        capability: capability({ script: "fetch", feedPath: "feeds/escape.json" }),
        run: { script: "fetch", feedPath: "feeds/escape.json" },
      }),
    ).rejects.toThrow(/escapes the catalog/i);
    expect(calls).toEqual([]);
  });

  it("confines operator metadata to its own staging directory", async () => {
    const { catalogDir, stagingDir } = fixture();
    // The catalog reaches operator metadata through its `downloads` symlink,
    // exactly as the deployed layout does.
    const downloads = mkdtempSync(join(tmpdir(), "openmapx-runner-downloads-"));
    roots.push(downloads);
    mkdirSync(join(downloads, "operator-metadata"), { recursive: true });
    writeFileSync(join(downloads, "operator-metadata", "de.json"), "{}");
    writeFileSync(join(downloads, "elsewhere.json"), "{}");
    symlinkSync(downloads, join(catalogDir, "downloads"), "dir");

    const calls: Array<{ file: string; args: string[]; options: never }> = [];
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl: recordingSpawn(calls),
    });

    await runner.run({
      version: 1,
      capability: capability({ script: "fetch-operator", metadataName: "de.json" }),
      run: { script: "fetch-operator", metadataName: "de.json" },
    });
    expect((calls[0] as unknown as { args: string[] }).args).toEqual([
      "./src/fetch.py",
      "downloads/operator-metadata/de.json",
    ]);

    // A name is not a path: traversal out of the staging directory is rejected
    // by the schema before the runner ever sees it.
    expect(
      transitousRunnerScriptSchema.safeParse({
        script: "fetch-operator",
        metadataName: "../elsewhere.json",
      }).success,
    ).toBe(false);
  });

  it("terminates the whole process group when the deadline passes", async () => {
    const { catalogDir, stagingDir } = fixture();
    const killed: number[] = [];
    const originalKill = process.kill;
    (process as { kill: unknown }).kill = ((pid: number) => {
      killed.push(pid);
    }) as typeof process.kill;

    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      timeoutMs: 10,
      spawnImpl: ((_file: string, _args: string[]) => {
        const child = {
          pid: 4242,
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          kill: () => undefined,
          on(event: string, listener: (value?: unknown) => void) {
            // Never closes on its own: only the deadline ends this run.
            if (event === "close") setTimeout(() => listener(137), 60);
            return child;
          },
        };
        return child;
      }) as never,
    });

    const result = await runner.run({
      version: 1,
      capability: capability(),
      run: { script: "garbage-collect" },
    });
    (process as { kill: unknown }).kill = originalKill;

    // Negative pid signals the process group, not just the direct child.
    expect(killed).toContain(-4242);
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("rejects an untyped command through the HTTP surface", async () => {
    const { catalogDir, stagingDir } = fixture();
    const app = buildTransitousRunnerServer({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
    });
    await app.ready();

    const token = capability();
    for (const run of [
      { script: "fetch", feedPath: "../../etc/passwd" },
      { command: "sh", args: ["-c", "id"] },
      { script: "garbage-collect", cwd: "/" },
      { script: "not-a-script" },
      { script: "fetch", feedPath: "feeds/de.json; rm -rf /" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/run",
        payload: { version: 1, capability: token, run },
      });
      expect(response.statusCode, JSON.stringify(run)).toBe(400);
      // The rejection never echoes the request, which may carry a token.
      expect(response.body).not.toContain(token);
    }
    await app.close();
  });

  it("refuses a capability that has outlived its window", async () => {
    const { catalogDir, stagingDir } = fixture();
    const calls: Array<{ file: string; args: string[]; options: never }> = [];
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW + CAPABILITY_TTL_MS + 1_000,
      spawnImpl: recordingSpawn(calls),
    });
    await expect(
      runner.run({ version: 1, capability: capability(), run: { script: "garbage-collect" } }),
    ).rejects.toBeInstanceOf(TransitousRunnerError);
    expect(calls).toEqual([]);
  });

  it("bounds captured output and reports truncation", async () => {
    const { catalogDir, stagingDir } = fixture();
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      maxOutputBytes: 32,
      spawnImpl: ((_file: string, _args: string[]) => {
        const handlers: Array<(chunk: Buffer) => void> = [];
        const child = {
          pid: 4242,
          stdout: {
            on: (_event: string, listener: (chunk: Buffer) => void) => {
              handlers.push(listener);
            },
          },
          stderr: { on: () => undefined },
          kill: () => undefined,
          on(event: string, listener: (value?: unknown) => void) {
            if (event === "close") {
              setTimeout(() => {
                for (const handler of handlers) handler(Buffer.from("x".repeat(500)));
                listener(0);
              }, 0);
            }
            return child;
          },
        };
        return child;
      }) as never,
    });

    const result = await runner.run({
      version: 1,
      capability: capability(),
      run: { script: "garbage-collect" },
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(32);
  });

  it("bounds multibyte and invalid output by encoded bytes", async () => {
    const { catalogDir, stagingDir } = fixture();
    const runner = createTransitousRunner({
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => NOW,
      maxOutputBytes: 5,
      spawnImpl: ((_file: string, _args: string[]) => {
        const handlers: Array<(chunk: Buffer) => void> = [];
        const child = {
          pid: 4242,
          stdout: {
            on: (_event: string, listener: (chunk: Buffer) => void) => handlers.push(listener),
          },
          stderr: { on: () => undefined },
          kill: () => undefined,
          on(event: string, listener: (value?: unknown) => void) {
            if (event === "close") {
              setTimeout(() => {
                for (const handler of handlers)
                  handler(Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff]));
                listener(0);
              }, 0);
            }
            return child;
          },
        };
        return child;
      }) as never,
    });

    const result = await runner.run({
      version: 1,
      capability: capability(),
      run: { script: "garbage-collect" },
    });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(5);
    expect(result.output).toBe("😀");
    expect(result.truncated).toBe(true);
  });
});
