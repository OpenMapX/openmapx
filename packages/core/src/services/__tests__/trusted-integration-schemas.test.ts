import {
  chmodSync,
  existsSync,
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuiltInManifestSource } from "../built-in-service-source";
import {
  embeddedBuiltInIntegrationManifests,
  embeddedBuiltInServiceManifests,
} from "../embedded-built-in-services";
import { embeddedBuiltInIntegrationManifests as bundledIntegrationManifests } from "../embedded-built-in-services.bundle";
import { integrationRecordsDirectory, sha256Hex } from "../integration-records";
import {
  loadTrustedIntegrationAuthority,
  loadTrustedIntegrationSchemas,
} from "../trusted-integration-schemas";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeManifest(path: string, id: string, schema: Record<string, unknown>, mode = 0o644) {
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ id, configSchema: schema }), {
    mode,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-schemas-"));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, "integrations", "routing-demo"), { recursive: true, mode: 0o755 });
  writeManifest(join(root, "integrations", "routing-demo"), "routing-demo", {
    properties: { region: { type: "string" } },
  });
  mkdirSync(join(root, "integrations", "_template"), { recursive: true });
  writeManifest(join(root, "integrations", "_template"), "__ID__", {});
  mkdirSync(
    join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "overlay-demo"),
    { recursive: true, mode: 0o755 },
  );
  chmodSync(join(root, "infra", "docker", "state", "ops-agent", "custom-integrations"), 0o755);
  writeManifest(
    join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "overlay-demo"),
    "overlay-demo",
    {
      properties: { layers: { type: "array" } },
    },
  );
  return root;
}

/**
 * What the operations agent records when it installs `id`: the SHA-256 of the
 * manifest on disk now, in its state directory.
 */
function record(root: string, id: string, overrides: Record<string, unknown> = {}) {
  const directory = integrationRecordsDirectory(join(root, "infra", "docker"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "infra", "docker", "state", "ops-agent"), 0o700);
  chmodSync(directory, 0o700);
  const path = join(
    root,
    "infra",
    "docker",
    "state",
    "ops-agent",
    "custom-integrations",
    id,
    "manifest.json",
  );
  const manifest = existsSync(path) ? readFileSync(path) : Buffer.from("");
  writeFileSync(
    join(directory, `${id}.json`),
    JSON.stringify({
      version: 1,
      integrationId: id,
      extensionId: "demo-extension",
      status: "ok",
      reason: null,
      source: {
        kind: "artifact",
        url: `https://example.test/${id}.tar.gz`,
        sha256: "a".repeat(64),
      },
      files: [{ path: "manifest.json", sha256: sha256Hex(manifest) }],
      pending: null,
      ...overrides,
    }),
    { mode: 0o600 },
  );
}

/** A release's embedded integration manifests, laid out like the bundle's copies. */
function releaseSource(manifests: Record<string, Record<string, unknown>>): BuiltInManifestSource {
  const release = mkdtempSync(join(tmpdir(), "openmapx-release-integrations-"));
  roots.push(release);
  for (const [id, schema] of Object.entries(manifests)) {
    mkdirSync(join(release, id));
    writeManifest(join(release, id), id, schema);
  }
  return {
    ids: Object.keys(manifests).sort(),
    manifestPath: (id) => join(release, id, "manifest.json"),
    embedded: true,
  };
}

describe("trusted integration schemas", () => {
  it("embeds every built-in integration manifest in the ops-agent bundle", () => {
    expect(embeddedBuiltInIntegrationManifests()).toBeNull();
    expect(embeddedBuiltInServiceManifests()).toBeNull();
    const bundled = bundledIntegrationManifests();
    const directories = readdirSync(join(REPOSITORY_ROOT, "integrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9]/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(bundled?.ids).toEqual(directories);
    for (const id of bundled?.ids ?? []) {
      expect(bundled?.manifestPath(id)).toBe(
        join(REPOSITORY_ROOT, "integrations", id, "manifest.json"),
      );
    }
    const schemas = loadTrustedIntegrationSchemas(REPOSITORY_ROOT, {
      ...(bundled ? { builtIns: bundled } : {}),
    });
    expect([...schemas.keys()]).toEqual(expect.arrayContaining(directories));
  });

  it("loads built-in and recorded installed schemas", () => {
    const root = fixture();
    record(root, "overlay-demo");
    expect(loadTrustedIntegrationAuthority(root)).toEqual({
      schemas: new Map([
        ["overlay-demo", { properties: { layers: { type: "array" } } }],
        ["routing-demo", { properties: { region: { type: "string" } } }],
      ]),
      problems: [],
    });
  });

  it("accepts built-in integrations a umask of 002 left group-writable", () => {
    const root = fixture();
    chmodSync(root, 0o775);
    chmodSync(join(root, "integrations"), 0o775);
    chmodSync(join(root, "integrations", "routing-demo"), 0o775);
    chmodSync(join(root, "integrations", "routing-demo", "manifest.json"), 0o664);
    expect(loadTrustedIntegrationSchemas(root).has("routing-demo")).toBe(true);
  });

  it("takes built-in schemas from the release, not from a tampered checkout", () => {
    const root = fixture();
    writeManifest(join(root, "integrations", "routing-demo"), "routing-demo", {
      properties: { region: { type: "string" }, tampered: { type: "string" } },
    });
    const schemas = loadTrustedIntegrationSchemas(root, {
      builtIns: releaseSource({ "routing-demo": { properties: { region: { type: "string" } } } }),
    });
    expect(schemas.get("routing-demo")).toEqual({ properties: { region: { type: "string" } } });
  });

  it("trusts an installed integration by its recorded bytes, whatever its modes", () => {
    const root = fixture();
    record(root, "overlay-demo");
    chmodSync(join(root, "infra", "docker", "state", "ops-agent", "custom-integrations"), 0o777);
    chmodSync(
      join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "overlay-demo"),
      0o775,
    );
    chmodSync(
      join(
        root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "overlay-demo",
        "manifest.json",
      ),
      0o666,
    );
    const authority = loadTrustedIntegrationAuthority(root);
    expect(authority.schemas.has("overlay-demo")).toBe(true);
    expect(authority.problems).toEqual([]);
  });

  it("leaves out and reports what the agent did not record, or what changed", () => {
    const root = fixture();
    const install = (id: string, schema: Record<string, unknown>) => {
      mkdirSync(join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", id));
      writeManifest(
        join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", id),
        id,
        schema,
      );
    };
    install("unrecorded", {});
    install("changed", {});
    record(root, "changed");
    writeManifest(
      join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "changed"),
      "changed",
      {
        properties: { tampered: { type: "string" } },
      },
    );
    install("linked", {});
    record(root, "linked");
    const real = join(root, "real-manifest.json");
    writeFileSync(
      real,
      readFileSync(
        join(
          root,
          "infra",
          "docker",
          "state",
          "ops-agent",
          "custom-integrations",
          "linked",
          "manifest.json",
        ),
      ),
    );
    rmSync(
      join(
        root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "linked",
        "manifest.json",
      ),
    );
    symlinkSync(
      real,
      join(
        root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "linked",
        "manifest.json",
      ),
    );
    install("unsupported", { properties: { layers: { type: "array", contains: {} } } });
    record(root, "unsupported");
    install("routing-demo-copy", {});
    record(root, "overlay-demo");
    record(root, "reinstall", {
      status: "needs_reinstall",
      reason: "Its files differ from the archive it was installed from.",
      source: null,
      files: [],
    });

    const authority = loadTrustedIntegrationAuthority(root);
    expect([...authority.schemas.keys()]).toEqual(["overlay-demo", "routing-demo"]);
    expect(
      authority.problems.map(({ integrationId, problem }) => [
        integrationId,
        problem.split(".")[0],
      ]),
    ).toEqual([
      ["changed", "Its manifest"],
      ["linked", "Its manifest"],
      ["reinstall", "Its files differ from the archive it was installed from"],
      ["routing-demo-copy", "It was not installed through the operations agent"],
      ["unrecorded", "It was not installed through the operations agent"],
      ["unsupported", "Its manifest"],
    ]);
    expect(
      authority.problems.find((entry) => entry.integrationId === "changed")?.problem,
    ).toContain("no longer matches");
  });

  it("refuses a built-in id and an unreadable record without failing the others", () => {
    const root = fixture();
    record(root, "overlay-demo");
    mkdirSync(
      join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "routing-demo"),
    );
    writeManifest(
      join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "routing-demo"),
      "routing-demo",
      {},
    );
    record(root, "routing-demo");
    const directory = integrationRecordsDirectory(join(root, "infra", "docker"));
    writeFileSync(join(directory, "broken.json"), "{", { mode: 0o600 });
    const authority = loadTrustedIntegrationAuthority(root);
    expect(authority.schemas.get("routing-demo")).toEqual({
      properties: { region: { type: "string" } },
    });
    expect(authority.schemas.has("overlay-demo")).toBe(true);
    expect(authority.problems.map((entry) => entry.integrationId)).toEqual([
      "broken",
      "routing-demo",
    ]);
  });

  it("accepts the files a transaction is installing while it is being prepared", () => {
    const root = fixture();
    const before = readFileSync(
      join(
        root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "overlay-demo",
        "manifest.json",
      ),
    );
    writeManifest(
      join(root, "infra", "docker", "state", "ops-agent", "custom-integrations", "overlay-demo"),
      "overlay-demo",
      {
        properties: { layers: { type: "array" }, opacity: { type: "number" } },
      },
    );
    const after = readFileSync(
      join(
        root,
        "infra",
        "docker",
        "state",
        "ops-agent",
        "custom-integrations",
        "overlay-demo",
        "manifest.json",
      ),
    );
    const installed = (bytes: Buffer) => ({
      extensionId: "demo-extension",
      status: "ok",
      reason: null,
      source: { kind: "upload", sha256: "b".repeat(64) },
      files: [{ path: "manifest.json", sha256: sha256Hex(bytes) }],
    });
    record(root, "overlay-demo", {
      ...installed(before),
      pending: {
        transactionId: `itx1_${"c".repeat(24)}`,
        phase: "prepared",
        replaced: true,
        previous: installed(before),
        next: installed(after),
      },
    });
    expect(loadTrustedIntegrationSchemas(root).get("overlay-demo")).toEqual({
      properties: { layers: { type: "array" }, opacity: { type: "number" } },
    });
  });

  it("reads records only from a directory that is the agent's alone", () => {
    const root = fixture();
    record(root, "overlay-demo");
    expect(() => loadTrustedIntegrationSchemas(root, { uid: 4_242_424 })).toThrow(
      "Trusted integration registry rejected",
    );
    chmodSync(integrationRecordsDirectory(join(root, "infra", "docker")), 0o750);
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );
  });

  it("loads no installed schemas when custom_integrations does not exist", () => {
    const root = fixture();
    rmSync(join(root, "infra", "docker", "state", "ops-agent", "custom-integrations"), {
      recursive: true,
    });
    expect([...loadTrustedIntegrationSchemas(root).keys()]).toEqual(["routing-demo"]);
  });
});
