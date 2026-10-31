import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { opsOperationFingerprint } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { closeControlInstallation, observeConfigurationSources, openControlInstallation, provisionControlInstallation } from "@openmapx/core/build-artifacts";
import { renderComposeForRepo } from "../../../../packages/cli/src/commands/compose";
import { createUnavailableRuntime, dispatchOpsOperation } from "../runtime";
import { testExecution } from "./execution";
import { installConfigurationRuntimeFixture as installTrustedConfigurationRuntime } from "./configuration-runtime";

const [root, mode, letter, expected, hold] = process.argv.slice(2);
const infraDir = join(root, "infra/docker");
const service = {
  manifest: {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    quality: "built-in",
    container: { image: "example/alpha", tag: "1" },
    configSchema: { properties: { label: { type: "string" } } },
  },
  directory: join(root, "services/alpha"),
  isBuiltIn: true,
  enabled: true,
};
process.send?.({ event: "started" });
try {
  let result;
  if (mode === "cli") {
    result = await renderComposeForRepo({
      rootDir: root,
      domain: "cli.example.test",
      services: ["alpha"],
    });
  } else if (mode === "initialize") {
    result = await coreServices.initializeConfigurationGenerations(infraDir);
  } else {
    const runtime = createUnavailableRuntime();
    const barrier = async () => {
      const released = once(process, "message");
      process.send?.({ event: "held" });
      await released;
    };
    installTrustedConfigurationRuntime(runtime, {
      services: [service],
      integrationSchemas: new Map(),
      infraDir,
      env: {},
      ...(hold === "before"
        ? { beforeCommit: barrier }
        : hold === "after"
          ? { afterCommit: barrier }
          : hold === "renamed"
            ? { afterGenerationRename: barrier }
            : {}),
    });
    const payload = {
      domain: `${letter}.example.test`,
      serviceConfigs: [{ serviceId: "alpha", values: { label: letter } }],
      integrationConfigs: [],
      serviceSecrets: [],
    };
    mkdirSync(join(infraDir, "data"), { recursive: true, mode: 0o700 });
    await provisionControlInstallation(infraDir);
    const installation = openControlInstallation({ infraDir, role: "ops-agent", serviceIds: ["alpha"] });
    let source;
    try { source = observeConfigurationSources({ installation, infraDir, services: [service], authorityRevision: "registry-v1", env: {} }); }
    finally { closeControlInstallation(installation); }
    const operation = {
      kind: "stack.render",
      revisionId: `cfg1_${letter.repeat(43)}`,
      expectedSourceRevision: source.sourceRevision,
      coordinatorMode: "ensure-running",
      // This synthetic writer captures its initial baseline before entering the
      // held activation schedule. Explicit values model stale compensation.
      expectedCurrentRevisionId: expected
        ? expected === "null"
          ? null
          : expected
        : coreServices.currentConfigurationGeneration(infraDir),
    };
    if (hold === "captured") await barrier();
    result = await dispatchOpsOperation(runtime, operation, {
      // Adapter identity only; this native fixture proves writer exclusion, not admission.
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog() {},
      claim: {
        operation,
        fingerprint: opsOperationFingerprint(operation),
        source: "trusted-data",
        capability: {
          revisionId: operation.revisionId,
          values: { authorityRevision: "registry-v1" },
          trustedConfiguration: payload,
        },
      },
    });
  }
  process.send?.({ event: "done", result });
} catch (error) {
  process.send?.({ event: "error", message: error instanceof Error ? error.message : "unknown" });
} finally {
  process.disconnect?.();
}
