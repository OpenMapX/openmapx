/** Real read-only source witness for standalone runtime fixtures. Never a
 * caller-generated UUID or a replacement mutation/inspection handler. */
import { provisionControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { opsOperationFingerprint } from "@openmapx/core/ops";
import { dispatchOpsOperation, type OpsRuntime } from "../runtime";
import { testExecution } from "./execution";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const sources = new WeakMap<OpsRuntime, { revision: string | null; value: Promise<string> }>();
export async function configurationSource(runtime: OpsRuntime, infraDir: string) {
  let environment: string | null = null;
  try { environment = readFileSync(join(infraDir, ".env"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const revision = JSON.stringify([services.currentConfigurationGeneration(infraDir), environment]);
  let retained = sources.get(runtime);
  if (!retained || retained.revision !== revision) {
    const value = (async () => {
      mkdirSync(join(infraDir, "data"), { recursive: true, mode: 0o700 });
      await provisionControlInstallation(infraDir);
      const operation = { kind: "configuration.sources.inspect" } as const;
      const source = await dispatchOpsOperation(runtime, operation, { execution: testExecution(), signal: new AbortController().signal,
        emitLog() {}, claim: { operation, fingerprint: opsOperationFingerprint(operation), source: "registry",
          capability: { revisionId: "registry-v1", values: {} } } });
      return source.sourceRevision;
    })();
    retained = { revision, value }; sources.set(runtime, retained);
  }
  return { expectedSourceRevision: await retained.value, coordinatorMode: "require-running" as const };
}
