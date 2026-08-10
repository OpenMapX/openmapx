import type { DiagnosticRow } from "../storage/SessionRepository";
import {
  buildDiagnosticExport,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  type ExportEnvironment,
  type ExportPorts,
  exportDiagnostics,
} from "./exportDiagnostics";

const NOW = 1_700_000_100_000;

const ENVIRONMENT: ExportEnvironment = {
  appVersion: "1.0.0",
  buildNumber: "42",
  shellProtocolMin: 1,
  shellProtocolMax: 1,
  platform: "ios",
  osVersion: "18.2",
  deviceModelBucket: "iPhone",
};

function row(overrides: Partial<DiagnosticRow> = {}): DiagnosticRow {
  return {
    id: 1,
    createdAtMs: NOW,
    type: "location.batch",
    fields: { accepted: 3, rejected: 1 },
    ...overrides,
  };
}

function ports(overrides: Partial<ExportPorts> = {}) {
  const written: Array<{ name: string; contents: string }> = [];
  const deleted: string[] = [];
  const shared: string[] = [];

  const base: ExportPorts = {
    read: async () => [row()],
    environment: () => ENVIRONMENT,
    now: () => NOW,
    randomId: () => "abc123",
    writeTempFile: async (name, contents) => {
      written.push({ name, contents });
      return `file:///cache/${name}`;
    },
    deleteTempFile: async (uri) => {
      deleted.push(uri);
    },
    share: async (uri) => {
      shared.push(uri);
    },
    isSharingAvailable: async () => true,
    ...overrides,
  };

  return { ports: base, written, deleted, shared };
}

describe("buildDiagnosticExport", () => {
  it("carries the versions a report needs to be interpretable", () => {
    const document = buildDiagnosticExport([row()], ENVIRONMENT, "abc123", NOW);

    expect(document.schemaVersion).toBe(DIAGNOSTIC_EXPORT_SCHEMA_VERSION);
    expect(document.environment).toEqual(ENVIRONMENT);
    expect(document.createdAtMs).toBe(NOW);
  });

  it("identifies the export and nothing else", () => {
    const document = buildDiagnosticExport([row()], ENVIRONMENT, "abc123", NOW);
    const serialised = JSON.stringify(document);

    expect(document.exportId).toBe("abc123");
    // No device, install or session identity travels with the file.
    for (const forbidden of ["deviceId", "installId", "sessionId", "advertisingId", "udid"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("drops a row whose type is no longer declared", () => {
    const document = buildDiagnosticExport(
      [row(), row({ id: 2, type: "route.exported", fields: { geometry: [[8.68, 50.11]] } })],
      ENVIRONMENT,
      "abc123",
      NOW,
    );

    expect(document.events).toHaveLength(1);
    expect(document.droppedRowCount).toBe(1);
    expect(JSON.stringify(document)).not.toContain("50.11");
  });

  it("filters a field that a previous version stored but no longer declares", () => {
    const document = buildDiagnosticExport(
      [row({ fields: { accepted: 1, coords: [8.68, 50.11], token: "tok_secret" } })],
      ENVIRONMENT,
      "abc123",
      NOW,
    );

    expect(document.events[0].fields).toEqual({ accepted: 1 });
    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain("50.11");
    expect(serialised).not.toContain("tok_secret");
  });

  it("keeps the record that fields were dropped", () => {
    const document = buildDiagnosticExport(
      [row({ fields: { accepted: 1, droppedFieldCount: 2 } })],
      ENVIRONMENT,
      "abc123",
      NOW,
    );

    expect(document.events[0].fields).toEqual({ accepted: 1, droppedFieldCount: 2 });
  });

  it("contains no database path or file location", () => {
    const serialised = JSON.stringify(buildDiagnosticExport([row()], ENVIRONMENT, "abc123", NOW));

    for (const forbidden of ["openmapx-navigation.db", "/var/", "/data/", "file://"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("exportDiagnostics", () => {
  it("writes a temporary file and shares it", async () => {
    const { ports: p, written, shared } = ports();

    const result = await exportDiagnostics(p);

    expect(result).toEqual({ ok: true, eventCount: 1 });
    expect(written[0].name).toBe("openmapx-diagnostics-abc123.json");
    expect(shared).toEqual(["file:///cache/openmapx-diagnostics-abc123.json"]);
  });

  it("deletes the temporary file after a successful share", async () => {
    const { ports: p, deleted } = ports();

    await exportDiagnostics(p);

    expect(deleted).toEqual(["file:///cache/openmapx-diagnostics-abc123.json"]);
  });

  it("deletes the temporary file after a cancelled or failed share", async () => {
    const { ports: p, deleted } = ports({
      share: async () => {
        throw new Error("user cancelled");
      },
    });

    const result = await exportDiagnostics(p);

    expect(result).toEqual({ ok: false, reason: "share-failed" });
    expect(deleted).toHaveLength(1);
  });

  it("does nothing when the platform cannot share", async () => {
    const { ports: p, written, shared } = ports({ isSharingAvailable: async () => false });

    const result = await exportDiagnostics(p);

    expect(result).toEqual({ ok: false, reason: "sharing-unavailable" });
    expect(written).toEqual([]);
    expect(shared).toEqual([]);
  });

  it("reports a failed write without sharing anything", async () => {
    const { ports: p, shared } = ports({
      writeTempFile: async () => {
        throw new Error("no space");
      },
    });

    const result = await exportDiagnostics(p);

    expect(result).toEqual({ ok: false, reason: "write-failed" });
    expect(shared).toEqual([]);
  });

  it("uses a different identifier for every export", async () => {
    let counter = 0;
    const { ports: p, written } = ports({
      randomId: () => {
        counter += 1;
        return `id${counter}`;
      },
    });

    await exportDiagnostics(p);
    await exportDiagnostics(p);

    expect(written[0].name).not.toBe(written[1].name);
    // Two exports from one device cannot be linked by their contents.
    expect(JSON.parse(written[0].contents).exportId).not.toBe(
      JSON.parse(written[1].contents).exportId,
    );
  });

  it("writes a file a person can actually read", async () => {
    const { ports: p, written } = ports();

    await exportDiagnostics(p);

    expect(written[0].contents).toContain("\n");
    expect(() => JSON.parse(written[0].contents)).not.toThrow();
  });

  it("shares only after the caller asked, never on its own", async () => {
    const { ports: p, shared } = ports();

    expect(shared).toEqual([]);
    await exportDiagnostics(p);
    expect(shared).toHaveLength(1);
  });
});
