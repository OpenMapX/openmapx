import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { OpsOperation, OpsResourcePolicy } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { packageIntegration } from "@openmapx/integration-framework/installer";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationStore } from "./integration-store";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";
import { buildOpsAgentServer } from "./server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const signal = new AbortController().signal;
const uid = process.geteuid?.() ?? 0;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const apiToken = Buffer.alloc(32, 31).toString("base64url");
const allowAllResources: OpsResourcePolicy = {
  allowGlobal: () => true,
  allowService: () => true,
  allowBackup: () => true,
  allowPreparedRun: () => true,
  allowCandidate: () => true,
  allowRelease: () => true,
  allowRegion: () => true,
  allowDataType: () => true,
  allowIntegration: () => true,
  allowTrustedRevision: () => true,
};

function manifest(id: string, region = "eu"): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    domains: ["map-overlay"],
    quality: "community",
    platform: "1.0",
    configSchema: { type: "object", properties: { region: { enum: [region] } } },
  };
}

interface Fixture {
  root: string;
  store: IntegrationStore;
  /** Archives the fake download serves, by URL. */
  artifacts: Map<string, string>;
  downloads: string[];
}

function fixture(options: { downloadError?: Error } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-store-"));
  roots.push(root);
  mkdirSync(join(root, "infra", "docker", "state", "ops-agent"), {
    recursive: true,
    mode: 0o700,
  });
  const artifacts = new Map<string, string>();
  const downloads: string[] = [];
  const store = new IntegrationStore({
    rootDir: root,
    uid,
    builtInIds: () => new Set(["routing"]),
    download: async ({ url, destination }) => {
      downloads.push(url.href);
      if (options.downloadError) throw options.downloadError;
      const path = artifacts.get(url.href);
      if (!path) throw new Error("unreachable");
      copyFileSync(path, destination);
    },
  });
  return { root, store, artifacts, downloads };
}

/** An artifact as `openmapx-ext package` builds it, served at a URL. */
async function artifact(
  f: Fixture,
  id: string,
  options: { region?: string; strings?: Record<string, string> } = {},
) {
  const source = mkdtempSync(join(tmpdir(), "openmapx-integration-source-"));
  roots.push(source);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest(id, options.region)));
  if (options.strings) {
    mkdirSync(join(source, "strings"));
    for (const [locale, text] of Object.entries(options.strings)) {
      writeFileSync(join(source, "strings", `${locale}.json`), text);
    }
  }
  const outFile = join(source, "..", `${id}-${options.region ?? "eu"}-${Math.random()}.tar.gz`);
  roots.push(outFile);
  await packageIntegration({ rootDir: f.root, source, outFile });
  const url = `https://artifacts.example.test/${id}/${sha256(readFileSync(outFile)).slice(0, 8)}.tar.gz`;
  f.artifacts.set(url, outFile);
  // The pin as an operation carries it; the archive's path stays out of it.
  const pin = { kind: "artifact" as const, url, sha256: sha256(readFileSync(outFile)) };
  return Object.defineProperty(pin, "path", { value: outFile, enumerable: false }) as typeof pin & {
    path: string;
  };
}

/** A raw ustar archive, for entries a packager never writes. */
function tarGz(entries: Array<{ name: string; data?: string; type?: "0" | "2"; link?: string }>) {
  const blocks = entries.flatMap((entry) => {
    const payload = Buffer.from(entry.data ?? "", "utf8");
    const header = Buffer.alloc(512);
    const octal = (offset: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    header.write(entry.name, 0, 100, "utf8");
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, payload.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    return [header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function record(f: Fixture, id: string) {
  return services.readIntegrationRecords(join(f.root, "infra", "docker"), uid).records.get(id);
}

const loads = (f: Fixture) => [...services.loadTrustedIntegrationSchemas(f.root).keys()];
const installed = (f: Fixture, id: string, path = "manifest.json") =>
  readFileSync(
    join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations", id, path),
    "utf8",
  );

describe("integration store", () => {
  it("installs an artifact, records every file and loads it by those digests", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar", { strings: { en: '{"title":"Radar"}' } });
    const published = await f.store.publish(
      {
        kind: "integration.publish",
        integrationId: "weather-radar",
        source: { kind: "artifact", url: source.url, sha256: source.sha256 },
        extensionId: "radar-bundle",
      },
      signal,
    );
    expect(published.integrationId).toBe("weather-radar");
    expect(JSON.parse(installed(f, "weather-radar")).id).toBe("weather-radar");
    const recorded = record(f, "weather-radar");
    expect(recorded?.status).toBe("ok");
    expect(recorded?.extensionId).toBe("radar-bundle");
    expect(recorded?.files.map((file) => file.path)).toEqual([
      "manifest.json",
      "openmapx-artifact.json",
      "strings/en.json",
    ]);
    expect(recorded?.pending?.phase).toBe("published");
    expect(loads(f)).toEqual(["weather-radar"]);

    await f.store.settle({
      kind: "integration.settle",
      integrationId: "weather-radar",
      transactionId: published.transactionId,
      outcome: "commit",
    });
    expect(record(f, "weather-radar")?.pending).toBeNull();
    const listed = await f.store.list();
    expect(listed.integrations).toMatchObject([
      { integrationId: "weather-radar", status: "ok", pending: null },
    ]);
    expect(listed.unrecorded).toEqual([]);
  });

  it.each([
    "https://sentinel-user:sentinel-password@example.test/integration.tgz",
    "https://example.test/integration.tgz?token=sentinel-query",
    "https://example.test/integration.tgz#sentinel-fragment",
  ])("refuses an unsafe artifact locator before download or durable work: %s", async (url) => {
    const f = fixture();
    await expect(
      f.store.publish(
        {
          kind: "integration.publish",
          integrationId: "weather-radar",
          source: { kind: "artifact", url, sha256: "a".repeat(64) },
        },
        signal,
      ),
    ).rejects.toThrow();
    expect(f.downloads).toEqual([]);
    expect(record(f, "weather-radar")).toBeUndefined();
  });

  it("canonicalizes a safe artifact locator before download and persistence", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    const noncanonical = source.url.replace(
      "https://artifacts.example.test/",
      "https://ARTIFACTS.example.test:443/",
    );

    await f.store.publish(
      {
        kind: "integration.publish",
        integrationId: "weather-radar",
        source: { kind: "artifact", url: noncanonical, sha256: source.sha256 },
      },
      signal,
    );

    expect(f.downloads).toEqual([source.url]);
    expect(record(f, "weather-radar")?.pending?.next.source).toEqual({
      kind: "artifact",
      url: source.url,
      sha256: source.sha256,
    });
  });

  it("does not expose provider redirect locators in inspection problems", async () => {
    const secretRedirect = "https://redirect.example.test/archive.tgz?token=sentinel-secret";
    const f = fixture({
      downloadError: new Error(`Too many redirects while fetching ${secretRedirect}`),
    });

    const result = await f.store.inspect(
      {
        kind: "integration.inspect",
        source: {
          kind: "artifact",
          url: "https://artifacts.example.test/archive.tgz",
          sha256: "a".repeat(64),
        },
      },
      signal,
    );

    expect(result).toMatchObject({
      valid: false,
      problems: ["The archive could not be downloaded"],
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");
  });

  it("keeps provider redirect locators out of the ops journal and status response", async () => {
    const secretRedirect = "https://redirect.example.test/archive.tgz?token=sentinel-secret";
    const f = fixture({
      downloadError: new Error(`Too many redirects while fetching ${secretRedirect}`),
    });
    let persistedJobs: readonly PersistedOpsJob[] = [];
    const journal: OpsJobJournal = {
      records: () => [],
      replace: async (records) => {
        persistedJobs = structuredClone(records);
      },
    };
    const now = new Date("2026-10-25T20:00:00.000Z");
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": Buffer.alloc(32, 32).toString("base64url") },
      resourcePolicy: allowAllResources,
      journal,
      now: () => now,
      randomBytes: () => Buffer.alloc(18, 33),
      dispatch: async (operation: OpsOperation, _runtime, context) => {
        if (operation.kind !== "integration.inspect") throw new Error("unexpected operation");
        return f.store.inspect(operation, context.signal);
      },
    });

    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        version: 1,
        requestId: "ops1_redirectDiagnostic",
        operationKey: "opk1_redirectDiagnostic",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 20_000).toISOString(),
        operation: {
          kind: "integration.inspect",
          source: {
            kind: "artifact",
            url: "https://artifacts.example.test/archive.tgz",
            sha256: "a".repeat(64),
          },
        },
      },
    });
    expect(admitted.statusCode).toBe(202);
    const operationId = admitted.json().result.operationId as string;

    let status = await app.inject({
      method: "GET",
      url: `/v1/operations/${operationId}`,
      headers: { authorization: `Bearer ${apiToken}` },
    });
    for (
      let attempt = 0;
      attempt < 50 && status.json().result.state !== "succeeded";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      status = await app.inject({
        method: "GET",
        url: `/v1/operations/${operationId}`,
        headers: { authorization: `Bearer ${apiToken}` },
      });
    }

    expect(status.statusCode).toBe(200);
    expect(status.json().result).toMatchObject({
      state: "succeeded",
      result: { valid: false, problems: ["The archive could not be downloaded"] },
    });
    expect(JSON.stringify(status.json())).not.toContain("sentinel-secret");
    expect(JSON.stringify(persistedJobs)).not.toContain("sentinel-secret");
    await app.close();
  });

  it("keeps the previous copy until settled and restores it on rollback", async () => {
    const f = fixture();
    const first = await artifact(f, "weather-radar", { region: "eu" });
    const second = await artifact(f, "weather-radar", { region: "us" });
    const publish = (source: typeof first) =>
      f.store.publish(
        {
          kind: "integration.publish",
          integrationId: "weather-radar",
          source: { kind: "artifact", url: source.url, sha256: source.sha256 },
          extensionId: "radar-bundle",
        },
        signal,
      );
    const installedFirst = await publish(first);
    await f.store.settle({
      kind: "integration.settle",
      integrationId: "weather-radar",
      transactionId: installedFirst.transactionId,
      outcome: "commit",
    });
    const update = await publish(second);
    expect(JSON.parse(installed(f, "weather-radar")).configSchema.properties.region.enum).toEqual([
      "us",
    ]);
    // A change pending settlement refuses another one.
    await expect(publish(first)).rejects.toThrow();

    await f.store.settle({
      kind: "integration.settle",
      integrationId: "weather-radar",
      transactionId: update.transactionId,
      outcome: "rollback",
    });
    expect(JSON.parse(installed(f, "weather-radar")).configSchema.properties.region.enum).toEqual([
      "eu",
    ]);
    expect(record(f, "weather-radar")).toMatchObject({
      status: "ok",
      pending: null,
      source: { url: first.url },
    });
    expect(loads(f)).toEqual(["weather-radar"]);
    expect(
      readdirSync(join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations")),
    ).toEqual(["weather-radar"]);
  });

  it("removes a fresh install on rollback, leaving no record", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    const published = await f.store.publish(
      { kind: "integration.publish", integrationId: "weather-radar", source },
      signal,
    );
    await f.store.settle({
      kind: "integration.settle",
      integrationId: "weather-radar",
      transactionId: published.transactionId,
      outcome: "rollback",
    });
    expect(
      existsSync(
        join(
          f.root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "weather-radar",
        ),
      ),
    ).toBe(false);
    expect(record(f, "weather-radar")).toBeUndefined();
  });

  it("refuses archives that do not match their pin, their id or the declarative rules", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    const publish = (overrides: Record<string, unknown>) =>
      f.store.publish(
        {
          kind: "integration.publish",
          integrationId: "weather-radar",
          source: { kind: "artifact", url: source.url, sha256: source.sha256 },
          ...overrides,
        } as Parameters<IntegrationStore["publish"]>[0],
        signal,
      );
    await expect(
      publish({ source: { kind: "artifact", url: source.url, sha256: "0".repeat(64) } }),
    ).rejects.toThrow("expected SHA-256");
    await expect(publish({ integrationId: "other-id" })).rejects.toThrow(
      'installs integration "weather-radar", not "other-id"',
    );
    const linked = join(f.root, "..", `linked-${Math.random()}.tar.gz`);
    roots.push(linked);
    writeFileSync(
      linked,
      tarGz([
        { name: "real.json", data: JSON.stringify(manifest("weather-radar")) },
        { name: "manifest.json", type: "2", link: "real.json" },
      ]),
    );
    f.artifacts.set("https://artifacts.example.test/linked.tar.gz", linked);
    await expect(
      publish({
        source: {
          kind: "artifact",
          url: "https://artifacts.example.test/linked.tar.gz",
          sha256: sha256(readFileSync(linked)),
        },
      }),
    ).rejects.toThrow("not a symbolic link");
    const builtIn = await artifact(f, "routing");
    await expect(
      publish({
        integrationId: "routing",
        source: { kind: "artifact", url: builtIn.url, sha256: builtIn.sha256 },
      }),
    ).rejects.toThrow("reserved");
    expect(
      readdirSync(join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations")),
    ).toEqual([]);
  });

  it("lets only an integration's owner change it, and never adopts an unrecorded copy", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    const publish = (extensionId?: string) =>
      f.store.publish(
        {
          kind: "integration.publish",
          integrationId: "weather-radar",
          source,
          ...(extensionId ? { extensionId } : {}),
        } as Parameters<IntegrationStore["publish"]>[0],
        signal,
      );
    const settle = (transactionId: string) =>
      f.store.settle({
        kind: "integration.settle",
        integrationId: "weather-radar",
        transactionId,
        outcome: "commit",
      });
    await settle((await publish("radar-bundle")).transactionId);
    await expect(publish("another-bundle")).rejects.toThrow("another owner");
    await expect(publish()).rejects.toThrow("another owner");
    await expect(
      f.store.remove({
        kind: "integration.remove",
        integrationId: "weather-radar",
        extensionId: "another-bundle",
      }),
    ).rejects.toThrow("another owner");
    await f.store.remove({
      kind: "integration.remove",
      integrationId: "weather-radar",
      extensionId: "radar-bundle",
    });
    expect(
      existsSync(
        join(
          f.root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "weather-radar",
        ),
      ),
    ).toBe(false);

    // A copy placed by hand: an extension may not take it over; the operator may replace it.
    mkdirSync(
      join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations", "weather-radar"),
    );
    writeFileSync(
      join(
        f.root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "weather-radar",
        "manifest.json",
      ),
      JSON.stringify(manifest("weather-radar")),
    );
    await expect(publish("radar-bundle")).rejects.toThrow("another owner");
    await settle((await publish()).transactionId);
    expect(record(f, "weather-radar")?.extensionId).toBeNull();
    expect(loads(f)).toEqual(["weather-radar"]);
  });

  it("installs an archive the operator uploaded to the agent's state directory", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    const uploads = services.integrationUploadsDirectory(join(f.root, "infra", "docker"));
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    copyFileSync(source.path, join(uploads, `${source.sha256}.tar.gz`));
    await f.store.publish(
      {
        kind: "integration.publish",
        integrationId: "weather-radar",
        source: { kind: "upload", sha256: source.sha256 },
      },
      signal,
    );
    expect(f.downloads).toEqual([]);
    expect(record(f, "weather-radar")?.source).toEqual({ kind: "upload", sha256: source.sha256 });
    await expect(
      f.store.inspect(
        { kind: "integration.inspect", source: { kind: "upload", sha256: "f".repeat(64) } },
        signal,
      ),
    ).resolves.toMatchObject({ valid: false, problems: [expect.stringContaining("No uploaded")] });
  });

  it("reports a changed manifest and unrecorded directories", async () => {
    const f = fixture();
    const source = await artifact(f, "weather-radar");
    await f.store.publish(
      { kind: "integration.publish", integrationId: "weather-radar", source },
      signal,
    );
    writeFileSync(
      join(
        f.root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "weather-radar",
        "manifest.json",
      ),
      JSON.stringify(manifest("weather-radar", "us")),
    );
    mkdirSync(
      join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations", "hand-placed"),
    );
    const listed = await f.store.list();
    expect(listed.integrations).toMatchObject([
      { integrationId: "weather-radar", status: "needs_reinstall" },
    ]);
    expect(listed.unrecorded).toEqual(["hand-placed"]);
    expect(loads(f)).toEqual([]);
  });

  it("undoes a transaction interrupted before its files were in place", async () => {
    const f = fixture();
    const first = await artifact(f, "weather-radar", { region: "eu" });
    const second = await artifact(f, "weather-radar", { region: "us" });
    const published = await f.store.publish(
      { kind: "integration.publish", integrationId: "weather-radar", source: first },
      signal,
    );
    await f.store.settle({
      kind: "integration.settle",
      integrationId: "weather-radar",
      transactionId: published.transactionId,
      outcome: "commit",
    });
    // Interrupted after the new copy was moved in, before the record said so.
    const update = await f.store.publish(
      { kind: "integration.publish", integrationId: "weather-radar", source: second },
      signal,
    );
    const path = services.integrationRecordPath(join(f.root, "infra", "docker"), "weather-radar");
    const current = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...current,
        ...current.pending.previous,
        pending: { ...current.pending, phase: "prepared" },
      }),
      { mode: 0o600 },
    );
    mkdirSync(
      join(
        f.root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        `.agent-stage-${"a".repeat(24)}`,
      ),
    );
    mkdirSync(
      join(
        f.root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        `.agent-backup-gone-itx1_${"b".repeat(24)}`,
      ),
    );
    expect(loads(f)).toEqual(["weather-radar"]);

    await f.store.recover();
    expect(JSON.parse(installed(f, "weather-radar")).configSchema.properties.region.enum).toEqual([
      "eu",
    ]);
    expect(record(f, "weather-radar")).toMatchObject({ pending: null, source: { url: first.url } });
    expect(
      readdirSync(join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations")),
    ).toEqual(["weather-radar"]);
    expect(update.transactionId).toMatch(/^itx1_/);
  });

  describe("adopting an integration an earlier release installed", () => {
    async function legacyInstall(f: Fixture, region = "eu") {
      const source = await artifact(f, "weather-radar", { region });
      // What the earlier installer left: the archive's files, modes as the umask made them.
      const work = join(f.root, "..", `legacy-${Math.random()}`);
      roots.push(work);
      const { extractIntegrationArchive } = await import(
        "@openmapx/integration-framework/installer"
      );
      mkdirSync(work);
      const tree = extractIntegrationArchive(source.path, join(work, "x"), join(work, "y"));
      mkdirSync(join(f.root, "infra", "docker", "state", "ops-agent", "custom-integrations"), {
        recursive: true,
      });
      renameSync(
        tree,
        join(
          f.root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "weather-radar",
        ),
      );
      return source;
    }
    const adopt = (f: Fixture, source?: { url: string; sha256: string }) =>
      f.store.adopt(
        {
          kind: "integration.adopt",
          integrationId: "weather-radar",
          extensionId: "radar-bundle",
          ...(source
            ? { source: { kind: "artifact", url: source.url, sha256: source.sha256 } }
            : {}),
        } as Parameters<IntegrationStore["adopt"]>[0],
        signal,
      );

    it("records it only when its files match the archive fetched again", async () => {
      const f = fixture();
      const source = await legacyInstall(f);
      expect(loads(f)).toEqual([]);
      await expect(adopt(f, source)).resolves.toEqual({
        integrationId: "weather-radar",
        status: "recorded",
        reason: null,
      });
      expect(f.downloads).toEqual([source.url]);
      expect(loads(f)).toEqual(["weather-radar"]);
      // Adopting again changes nothing and fetches nothing.
      await adopt(f, source);
      expect(f.downloads).toHaveLength(1);
    });

    it("marks changed files, a missing source or a missing directory as needing a reinstall", async () => {
      const f = fixture();
      const source = await legacyInstall(f);
      writeFileSync(
        join(
          f.root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "weather-radar",
          "manifest.json",
        ),
        JSON.stringify(manifest("weather-radar", "us")),
      );
      await expect(adopt(f, source)).resolves.toMatchObject({ status: "needs_reinstall" });
      expect(record(f, "weather-radar")).toMatchObject({
        status: "needs_reinstall",
        reason: "Its files differ from the archive it was installed from.",
      });
      expect(loads(f)).toEqual([]);

      const g = fixture();
      await legacyInstall(g);
      await expect(adopt(g)).resolves.toMatchObject({
        status: "needs_reinstall",
        reason: "Nothing records the archive it was installed from.",
      });

      const h = fixture();
      await expect(adopt(h, source)).resolves.toMatchObject({
        status: "needs_reinstall",
        reason: "It is not installed.",
      });
    });

    it("retries later when the archive cannot be fetched", async () => {
      const f = fixture();
      const source = await legacyInstall(f);
      f.artifacts.delete(source.url);
      await expect(adopt(f, source)).resolves.toMatchObject({ status: "needs_reinstall" });
      expect(record(f, "weather-radar")).toBeUndefined();
      f.artifacts.set(source.url, source.path);
      await expect(adopt(f, source)).resolves.toMatchObject({ status: "recorded" });
    });

    it("lets the owner reinstall it once marked", async () => {
      const f = fixture();
      const source = await legacyInstall(f);
      writeFileSync(
        join(
          f.root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "weather-radar",
          "extra.json",
        ),
        "{}",
      );
      await adopt(f, source);
      const published = await f.store.publish(
        {
          kind: "integration.publish",
          integrationId: "weather-radar",
          source,
          extensionId: "radar-bundle",
        },
        signal,
      );
      await f.store.settle({
        kind: "integration.settle",
        integrationId: "weather-radar",
        transactionId: published.transactionId,
        outcome: "commit",
      });
      expect(
        existsSync(
          join(
            f.root,
            "infra",
            "docker",
            "state",
            "ops-agent",
            "custom-integrations",
            "weather-radar",
            "extra.json",
          ),
        ),
      ).toBe(false);
      expect(loads(f)).toEqual(["weather-radar"]);
    });
  });
});
