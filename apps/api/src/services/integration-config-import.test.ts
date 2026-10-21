import {
  configurationProjectionFingerprint,
  type OpsResultFor,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { describe, expect, it } from "vitest";
import {
  exportIntegrationConfigs,
  type IntegrationImportPorts,
  prepareIntegrationImport,
  runIntegrationImport,
} from "./integration-config-import";

const schema = {
  properties: {
    enabled: { type: "boolean" },
    label: { type: "string" },
    secret: { type: "string", "x-openmapx-secret": true },
    fixed: { type: "string", readOnly: true },
    nested: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
  },
};
const manifests = new Map([
  ["alpha", schema],
  ["beta", schema],
]);
const input = (config: Record<string, unknown> = { label: "new" }) => ({
  integrations: [{ integrationId: "alpha", config }],
});

describe("integration import preparation", () => {
  it.each([
    null,
    {},
    { integrations: [] },
    { integrations: [{ integrationId: "alpha", config: null }] },
    { integrations: [{ integrationId: "unknown", config: {} }] },
    { integrations: [...input().integrations, ...input().integrations] },
    input({ enabled: "false" }),
    input({ fixed: "x" }),
    input({ unknown: true }),
    input({ label: "***" }),
    input({ nested: { count: 0 } }),
  ])("rejects the entire invalid file before persistence: %j", (body) => {
    expect(() => prepareIntegrationImport(body, manifests)).toThrow("Invalid integration import");
  });
  it("bounds diagnostics and never echoes unknown keys, values or schema choice contents", () => {
    const schemas = new Map([
      ["alpha", { properties: { choice: { type: "string", enum: ["internal-schema-marker"] } } }],
    ]);
    try {
      prepareIntegrationImport(
        {
          integrations: [
            {
              integrationId: "alpha",
              config: { choice: "supplied-secret", "unknown-secret-name": "another-secret" },
            },
            ...Array.from({ length: 20 }, (_, index) => ({
              integrationId: `unknown-${index}`,
              config: {},
            })),
          ],
        },
        schemas,
      );
      throw Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const diagnostics = (error as { errors: string[] }).errors;
      expect(diagnostics).toHaveLength(8);
      expect(diagnostics[0]).toMatch(/Entry 1.*alpha.*choice.*allowed-choice constraint/);
      expect(diagnostics.every((entry) => entry.length <= 512)).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /internal-schema-marker|supplied-secret|unknown-secret-name|another-secret/,
      );
    }
  });
  it("omits declared secrets and preserves optional enabled and valid nested JSON", () => {
    expect(
      prepareIntegrationImport(
        input({ secret: "synthetic", enabled: false, nested: { count: 2 } }),
        manifests,
      ),
    ).toEqual([{ integrationId: "alpha", config: { enabled: false, nested: { count: 2 } } }]);
    expect(prepareIntegrationImport(input({}), manifests)[0].config).not.toHaveProperty("enabled");
  });
  it("exports only current writable nonsecret fields and round trips its metadata", () => {
    const exported = exportIntegrationConfigs(
      [
        {
          integrationId: "alpha",
          config: {
            label: "safe",
            secret: "synthetic",
            fixed: "x",
            retired: "old",
            enabled: false,
          },
        },
        { integrationId: "retired", config: { secret: "synthetic" } },
      ],
      manifests,
    );
    expect(exported.integrations).toEqual([
      { integrationId: "alpha", config: { label: "safe", enabled: false } },
    ]);
    expect(prepareIntegrationImport(exported, manifests)).toEqual(exported.integrations);
    expect(JSON.stringify(exported)).not.toContain("synthetic");
  });
});

function fixture() {
  const rows = new Map<string, Record<string, string | boolean>>([
    ["alpha", { label: "old", enabled: false }],
    ["beta", { label: "before" }],
  ]);
  let version = 0;
  const host: TrustedConfigurationPayload = {
    domain: "fixture.invalid",
    serviceConfigs: [],
    serviceSecrets: [],
    integrationConfigs: [
      { integrationId: "alpha", values: { label: "old", enabled: false } },
      { integrationId: "beta", values: { label: "before" } },
    ],
  };
  const events: string[] = [];
  let revision = "A";
  const state = {
    rows,
    events,
    host,
    applyMode: "ok",
    reloadFails: false,
    restoreFails: false,
    compensateMode: "ok",
    beforeApply: () => {},
    beforeRecovery: () => {},
    writesFail: false,
  };
  const ports = {
    async persist(entries: ReturnType<typeof prepareIntegrationImport>) {
      events.push("persist");
      if (state.writesFail) throw Error("synthetic credential must not escape");
      const previous = entries.map((e) => ({
        integrationId: e.integrationId,
        config: structuredClone(rows.get(e.integrationId) ?? null),
      }));
      for (const entry of entries)
        rows.set(entry.integrationId, {
          ...entry.config,
          enabled: entry.config.enabled ?? rows.get(entry.integrationId)?.enabled,
        } as never);
      const owned = ++version;
      return {
        previous,
        async owns() {
          return owned === version;
        },
        async restore() {
          events.push("restore");
          state.beforeRecovery();
          if (state.restoreFails || owned !== version) return false;
          for (const entry of previous) {
            if (entry.config) rows.set(entry.integrationId, entry.config as never);
            else rows.delete(entry.integrationId);
          }
          return true;
        },
      };
    },
    async apply() {
      events.push("apply");
      const previousApplied: OpsResultFor<"configuration.inspect"> = {
        revisionId: revision,
        integrationConfigDigests: state.host.integrationConfigs.map(
          ({ integrationId, values }) => ({
            integrationId,
            digest: configurationProjectionFingerprint(values),
          }),
        ),
      };
      state.beforeApply();
      const payload = {
        ...host,
        integrationConfigs: [...rows].map(([integrationId, config]) => ({
          integrationId,
          values: config,
        })),
      };
      if (state.applyMode === "unknown")
        return {
          payload,
          previousApplied,
          outcome: {
            outcome: "unknown",
            reason: "transport_or_result",
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          },
        };
      if (state.applyMode === "noncommit")
        return {
          payload,
          previousApplied,
          outcome: {
            outcome: "not_committed",
            reason: "failed",
            cleanupFailed: false,
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          },
        };
      state.host = structuredClone(payload);
      revision = "A";
      return {
        payload,
        previousApplied,
        outcome: {
          outcome: "committed",
          revisionId: "A",
          enabledServiceIds: [],
          followUp: state.applyMode === "incomplete" ? "failed" : "complete",
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        },
      };
    },
    async compensate(payload: typeof host, expected: string) {
      events.push("compensate");
      if (revision !== expected || state.compensateMode === "conflict")
        return {
          outcome: "not_committed",
          reason: "conflict",
          currentRevisionId: revision,
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        };
      if (state.compensateMode === "unknown")
        return {
          outcome: "unknown",
          reason: "transport_or_result",
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        };
      state.host = structuredClone(payload);
      revision = "R";
      return {
        outcome: "committed",
        revisionId: "R",
        enabledServiceIds: [],
        followUp: "complete",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      };
    },
    async reload() {
      events.push("reload");
      if (state.reloadFails) {
        state.reloadFails = false;
        throw Error("synthetic secret");
      }
      return { message: "Reloaded", reloaded: 2, enabled: 1 };
    },
  };
  return {
    state,
    ports,
    editNamed() {
      version++;
      rows.set("alpha", { label: "competitor", enabled: true });
    },
    editHost() {
      revision = "B";
      state.host.integrationConfigs[1].values.label = "competitor";
    },
  };
}

describe("real batch coordinator with stateful storage and host boundaries", () => {
  it.each(["reload", "runtime-unchanged"])(
    "does not invent prior applied values after preexisting divergence: %s",
    async (failure) => {
      const f = fixture();
      f.state.rows.set("alpha", { label: "saved-but-not-applied", enabled: false });
      f.state.host.integrationConfigs[0].values = { label: "live-before", enabled: false };
      if (failure === "reload") f.state.reloadFails = true;
      else f.state.applyMode = "incomplete";
      const result = await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      );
      expect(result).toMatchObject({ ok: false, recovery: "reconciliation_required" });
      expect(f.state.host.integrationConfigs[0].values.label).not.toBe("saved-but-not-applied");
      expect(f.state.events).not.toContain("compensate");
    },
  );
  describe.each(["incomplete", "reload"] as const)("unproven prior state after %s", (failure) => {
    it.each(["conflict", "unknown", "retained"] as const)(
      "reports current database ownership as %s without restoring or compensating",
      async (database) => {
        const f = fixture();
        f.state.rows.set("alpha", { label: "saved-but-not-applied", enabled: false });
        f.state.host.integrationConfigs[0].values = { label: "live-before", enabled: false };
        f.state.applyMode = failure === "incomplete" ? "incomplete" : "ok";
        f.state.reloadFails = failure === "reload";
        let ownershipUnavailable = false;
        let ownershipChecks = 0;
        const settleFailure = () => {
          if (database === "conflict") f.editNamed();
          if (database === "unknown") ownershipUnavailable = true;
        };
        const original = f.ports as IntegrationImportPorts;
        const ports: IntegrationImportPorts = {
          ...original,
          async persist(entries) {
            const saved = await original.persist(entries);
            return {
              ...saved,
              async owns() {
                ownershipChecks++;
                if (ownershipUnavailable) throw Error("synthetic ownership failure");
                return saved.owns();
              },
            };
          },
          async apply() {
            const applied = await original.apply();
            if (failure === "incomplete") settleFailure();
            return applied;
          },
          async reload() {
            settleFailure();
            return original.reload();
          },
        };
        const result = await runIntegrationImport(
          prepareIntegrationImport(input(), manifests),
          manifests,
          ports,
        );
        expect(result).toEqual({
          ok: false,
          error: "Integration import failed",
          recovery: "reconciliation_required",
          phase: failure === "incomplete" ? "apply" : "reload",
          database,
          reason: "previous_applied_not_proven",
          apply: {
            outcome: "committed",
            revisionId: "A",
            enabledServiceIds: [],
            followUp: failure === "incomplete" ? "failed" : "complete",
            cleanupFailed: false,
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          },
          runtime: failure === "incomplete" ? "unchanged" : "unknown",
        });
        expect(f.state.rows.get("alpha")).toEqual(
          database === "conflict"
            ? { label: "competitor", enabled: true }
            : { label: "new", enabled: false },
        );
        expect(f.state.host.integrationConfigs[0].values).toEqual({ label: "new", enabled: false });
        expect(f.state.events).toEqual(
          failure === "incomplete" ? ["persist", "apply"] : ["persist", "apply", "reload"],
        );
        expect(ownershipChecks).toBe(failure === "incomplete" ? 1 : 2);
      },
    );
  });
  it("persists once, applies one complete snapshot and reloads once", async () => {
    const f = fixture();
    const result = await runIntegrationImport(
      prepareIntegrationImport(input(), manifests),
      manifests,
      f.ports as never,
    );
    expect(result).toMatchObject({ ok: true, imported: 1 });
    expect(f.state.events).toEqual(["persist", "apply", "reload"]);
    expect(f.state.rows.get("alpha")).toEqual({ label: "new", enabled: false });
    expect(f.state.rows.get("beta")).toEqual({ label: "before" });
  });
  it("does not apply after persistence or commit failure", async () => {
    const f = fixture();
    f.state.writesFail = true;
    const result = await runIntegrationImport(
      prepareIntegrationImport(input(), manifests),
      manifests,
      f.ports as never,
    );
    expect(result).toMatchObject({
      ok: false,
      phase: "persistence",
      recovery: "reconciliation_required",
    });
    expect(f.state.events).toEqual(["persist"]);
    expect(JSON.stringify(result)).not.toContain("synthetic");
  });
  it("restores owned rows only on explicit noncommit", async () => {
    const f = fixture();
    f.state.applyMode = "noncommit";
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ ok: false, recovery: "restored", apply: { outcome: "not_committed" } });
    expect(f.state.events).toEqual(["persist", "apply", "restore"]);
    expect(f.state.rows.get("alpha")?.label).toBe("old");
  });
  it("unknown completion never implies noncommit", async () => {
    const f = fixture();
    f.state.applyMode = "unknown";
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ ok: false, recovery: "reconciliation_required", database: "retained" });
    expect(f.state.events).toEqual(["persist", "apply"]);
  });
  it("compensates a known committed snapshot without reverting unrelated capture-to-apply edits", async () => {
    const f = fixture();
    f.state.reloadFails = true;
    f.state.beforeApply = () => {
      f.state.rows.set("beta", { label: "newer" });
    };
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({
      ok: false,
      recovery: "restored",
      database: "restored",
      compensation: { outcome: "committed" },
    });
    expect(f.state.events).toEqual([
      "persist",
      "apply",
      "reload",
      "restore",
      "compensate",
      "reload",
    ]);
    expect(f.state.host.integrationConfigs).toEqual([
      { integrationId: "alpha", values: { label: "old", enabled: false } },
      { integrationId: "beta", values: { label: "newer" } },
    ]);
  });
  it("preserves every unrelated field of the actual submitted payload during compensation", async () => {
    const f = fixture();
    f.state.reloadFails = true;
    const apply = f.ports.apply;
    f.ports.apply = async () => {
      const result = await apply();
      Object.assign(result.payload, {
        domain: "submitted.invalid",
        serviceConfigs: [{ serviceId: "service", values: { flag: true }, envKeys: ["env"] }],
        serviceSecrets: [{ serviceId: "service", values: { key: "synthetic-only" } }],
      });
      return result;
    };
    const result = await runIntegrationImport(
      prepareIntegrationImport(input(), manifests),
      manifests,
      f.ports as never,
    );
    expect(result).toMatchObject({ recovery: "restored" });
    expect(f.state.host).toMatchObject({
      domain: "submitted.invalid",
      serviceConfigs: [{ serviceId: "service", values: { flag: true }, envKeys: ["env"] }],
      serviceSecrets: [{ serviceId: "service", values: { key: "synthetic-only" } }],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-only");
  });
  it("does not overwrite an intervening DB edit", async () => {
    const f = fixture();
    f.state.reloadFails = true;
    f.state.beforeRecovery = f.editNamed;
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ recovery: "reconciliation_required", database: "conflict" });
    expect(f.state.rows.get("alpha")?.label).toBe("competitor");
    expect(f.state.events).not.toContain("compensate");
  });
  it("preserves newer host generation on stale compensation", async () => {
    const f = fixture();
    f.state.reloadFails = true;
    f.state.beforeRecovery = f.editHost;
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({
      recovery: "reconciliation_required",
      compensation: { outcome: "not_committed", reason: "conflict" },
    });
    expect(f.state.host.integrationConfigs[1].values.label).toBe("competitor");
  });
  it("preserves committed evidence and compensates a failed follow-up without unnecessary runtime reload", async () => {
    const f = fixture();
    f.state.applyMode = "incomplete";
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ recovery: "restored", apply: { outcome: "committed", followUp: "failed" } });
    expect(f.state.events).toEqual(["persist", "apply", "restore", "compensate"]);
  });
  it.each(["publisherCleanupFailed", "cleanupFailed", "registryUpdateFailed"] as const)(
    "retains original %s evidence after successful compensation",
    async (fault) => {
      const f = fixture();
      const apply = f.ports.apply;
      f.ports.apply = async () => {
        const result = await apply();
        result.outcome[fault] = true;
        return result;
      };
      const result = await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      );
      expect(result).toMatchObject({
        ok: false,
        phase: "apply",
        database: "restored",
        runtime: "unchanged",
        recovery: fault === "registryUpdateFailed" ? "restored" : "reconciliation_required",
        apply: {
          outcome: "committed",
          revisionId: "A",
          enabledServiceIds: [],
          followUp: "complete",
          cleanupFailed: fault === "cleanupFailed",
          publisherCleanupFailed: fault === "publisherCleanupFailed",
          registryUpdateFailed: fault === "registryUpdateFailed",
        },
        compensation: {
          outcome: "committed",
          followUp: "complete",
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        },
      });
      expect(f.state.rows.get("alpha")).toEqual({ label: "old", enabled: false });
      expect(f.state.host.integrationConfigs[0].values).toEqual({ label: "old", enabled: false });
      expect(f.state.events).toEqual(["persist", "apply", "restore", "compensate"]);
    },
  );
  it("does not claim restored when a competing named edit arrives during compensation", async () => {
    const f = fixture();
    f.state.applyMode = "incomplete";
    const original = f.ports.compensate;
    f.ports.compensate = async (...args) => {
      const result = await original(...args);
      f.editNamed();
      return result;
    };
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ recovery: "reconciliation_required", database: "conflict" });
    expect(f.state.rows.get("alpha")?.label).toBe("competitor");
  });
  it("reports a failed recovery reload as reconciliation despite restored DB and host", async () => {
    const f = fixture();
    f.ports.reload = async () => {
      throw Error("synthetic secret");
    };
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({
      recovery: "reconciliation_required",
      database: "restored",
      runtime: "unknown",
      compensation: { outcome: "committed" },
    });
  });
  it("does not compensate a submitted snapshot containing a competing named override", async () => {
    const f = fixture();
    f.state.applyMode = "incomplete";
    f.state.beforeApply = f.editNamed;
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({
      recovery: "reconciliation_required",
      reason: "submitted_snapshot_not_owned",
    });
    expect(f.state.events).toEqual(["persist", "apply"]);
  });
  it.each(["unknown", "conflict"])("reports incomplete compensation %s", async (mode) => {
    const f = fixture();
    f.state.reloadFails = true;
    f.state.compensateMode = mode;
    expect(
      await runIntegrationImport(
        prepareIntegrationImport(input(), manifests),
        manifests,
        f.ports as never,
      ),
    ).toMatchObject({ recovery: "reconciliation_required", database: "restored" });
  });
});

describe("coordinator against the actual conditional generation writer", () => {
  it.each([false, true])(
    "fences capture -> completed B -> initial A, even when A would need recovery (%s)",
    async (reloadFails) => {
      const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { services } = await import("@openmapx/core/server");
      const root = mkdtempSync(join(tmpdir(), "initial-import-race-"));
      const infraDir = join(root, "infra/docker");
      mkdirSync(infraDir, { recursive: true });
      const f = fixture();
      f.state.reloadFails = reloadFails;
      const commit = (
        payload: TrustedConfigurationPayload,
        expectedCurrentRevisionId?: string | null,
      ) =>
        services.commitConfigurationGeneration({
          infraDir,
          services: [],
          input: { ...payload, selectedRoots: [] },
          expectedCurrentRevisionId,
        });
      let release!: () => void, captured!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const prepare = f.ports.apply;
      f.ports.apply = async () => {
        const previousApplied = await services.withConfigurationGenerationWriter(
          infraDir,
          async () => services.inspectAppliedConfiguration(infraDir),
        );
        const { payload } = await prepare();
        captured();
        await barrier;
        try {
          const applied = await commit(payload, previousApplied.revisionId);
          return {
            payload,
            previousApplied,
            outcome: {
              outcome: "committed",
              revisionId: applied.revisionId,
              enabledServiceIds: [],
              followUp: "complete",
              cleanupFailed: false,
              publisherCleanupFailed: false,
              registryUpdateFailed: false,
            },
          };
        } catch (error) {
          if (!(error instanceof services.ConfigurationGenerationError)) throw error;
          return {
            payload,
            previousApplied,
            outcome: {
              ...error.result,
              publisherCleanupFailed: false,
              registryUpdateFailed: false,
            },
          } as Awaited<ReturnType<typeof prepare>>;
        }
      };
      try {
        await commit(f.state.host);
        const pending = runIntegrationImport(
          prepareIntegrationImport(input(), manifests),
          manifests,
          f.ports as never,
        );
        await reached;
        f.state.rows.set("beta", { label: "completed-B" });
        await commit({
          ...f.state.host,
          integrationConfigs: [
            { integrationId: "alpha", values: { label: "new", enabled: false } },
            { integrationId: "beta", values: { label: "completed-B" } },
          ],
        });
        release();
        const result = await pending;
        expect(result).toMatchObject({
          ok: false,
          recovery: "reconciliation_required",
          apply: { outcome: "not_committed", reason: "conflict" },
          database: "restored",
        });
        expect(services.readAppliedConfiguration(infraDir).integrationConfigs[1].values.label).toBe(
          "completed-B",
        );
        expect(f.state.rows.get("beta")?.label).toBe("completed-B");
        expect(f.state.events).not.toContain("reload");
        expect(f.state.events).not.toContain("compensate");
      } finally {
        release?.();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([false, true])(
    "preserves unrelated pre-apply changes and fences a newer generation (stale=%s)",
    async (stale) => {
      const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { services } = await import("@openmapx/core/server");
      const root = mkdtempSync(join(tmpdir(), "import-writer-"));
      const infraDir = join(root, "infra/docker");
      mkdirSync(infraDir, { recursive: true });
      const f = fixture();
      f.state.reloadFails = true;
      f.state.beforeApply = () => f.state.rows.set("beta", { label: "newer-before-apply" });
      let submitted: import("@openmapx/core/ops").TrustedConfigurationPayload;
      const commit = async (payload: typeof submitted, expectedCurrentRevisionId?: string) => {
        try {
          const result = await services.commitConfigurationGeneration({
            infraDir,
            services: [],
            input: { ...payload, selectedRoots: [] },
            expectedCurrentRevisionId,
          });
          return {
            outcome: "committed" as const,
            revisionId: result.revisionId,
            enabledServiceIds: result.enabledServiceIds,
            followUp: "complete" as const,
            cleanupFailed: false,
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          };
        } catch (error) {
          if (!(error instanceof services.ConfigurationGenerationError)) throw error;
          return { ...error.result, publisherCleanupFailed: false, registryUpdateFailed: false };
        }
      };
      const prepare = f.ports.apply;
      const ports = {
        ...f.ports,
        async apply() {
          const previousApplied = await services.withConfigurationGenerationWriter(
            infraDir,
            async () => services.inspectAppliedConfiguration(infraDir),
          );
          const { payload } = await prepare();
          submitted = payload;
          return {
            payload,
            previousApplied,
            outcome: await commit(payload, previousApplied.revisionId ?? undefined),
          };
        },
        async compensate(payload: typeof submitted, expected: string) {
          if (stale)
            await commit({
              ...submitted,
              integrationConfigs: submitted.integrationConfigs.map((entry) =>
                entry.integrationId === "beta"
                  ? { ...entry, values: { label: "competing-host" } }
                  : entry,
              ),
            });
          return commit(payload, expected);
        },
      };
      try {
        await commit(f.state.host);
        const result = await runIntegrationImport(
          prepareIntegrationImport(input(), manifests),
          manifests,
          ports,
        );
        expect(result).toMatchObject({
          recovery: stale ? "reconciliation_required" : "restored",
          compensation: stale
            ? { outcome: "not_committed", reason: "conflict" }
            : { outcome: "committed" },
        });
        const applied = services.readAppliedConfiguration(infraDir);
        expect(
          applied.integrationConfigs.find((e) => e.integrationId === "beta")?.values.label,
        ).toBe(stale ? "competing-host" : "newer-before-apply");
        expect(
          applied.integrationConfigs.find((e) => e.integrationId === "alpha")?.values.label,
        ).toBe(stale ? "new" : "old");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
