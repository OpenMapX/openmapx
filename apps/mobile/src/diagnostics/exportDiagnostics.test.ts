import type { DiagnosticRow } from "../storage/SessionRepository";
import { nth } from "../testing/nth";
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

    expect(document.exportId).toBe("abc123");
    const serialised = JSON.stringify(document);
    for (const forbidden of [
      "deviceId",
      "installId",
      "sessionId",
      "advertisingId",
      "udid",
      "openmapx-navigation.db",
      "/var/",
      "/data/",
      "file://",
    ])
      expect(serialised).not.toContain(forbidden);
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

    expect(document.events[0]?.fields).toEqual({ accepted: 1 });
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

    expect(document.events[0]?.fields).toEqual({ accepted: 1, droppedFieldCount: 2 });
  });
});

describe("exportDiagnostics", () => {
  it("writes a temporary file and shares it", async () => {
    const { ports: p, written, shared, deleted } = ports();

    const result = await exportDiagnostics(p);

    expect(result).toEqual({ ok: true, eventCount: 1 });
    const file = nth(written, 0);
    expect(file.name).toBe("openmapx-diagnostics-abc123.json");
    expect(shared).toEqual(["file:///cache/openmapx-diagnostics-abc123.json"]);

    expect(deleted).toEqual(shared);
    expect(file.contents).toContain("\n");
    expect(JSON.parse(file.contents)).toMatchObject({
      exportId: "abc123",
      events: [{ type: "location.batch", fields: { accepted: 3, rejected: 1 } }],
    });
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

    const [first, second] = [nth(written, 0), nth(written, 1)];
    expect(first.name).not.toBe(second.name);
    // Two exports from one device cannot be linked by their contents.
    expect(JSON.parse(first.contents).exportId).not.toBe(JSON.parse(second.contents).exportId);
  });
});
