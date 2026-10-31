/** Cache immutable content only; configured tags and container state are not changed. */
import { join } from "node:path";
import {
  assertControlExecutionForward,
  assertImageStageLeaseCompatibility,
  beginControlEffect,
  executionAuthorityState,
  retainConfigurationPreEffectRefusal,
} from "@openmapx/core/build-artifacts";
import { canonicalJson, opsOperationFingerprint } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  type DockerRuntimeOptions,
  runContainedProcess,
  runContainedStreamingProcess,
} from "./docker-runtime";
import { strictReadFile } from "./durable-files";
import { safeProcessDiagnostic } from "./process-output";
import { OpsExecutionFailure, type OpsRuntime } from "./runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

const imageId = /^sha256:[a-f0-9]{64}$/;
export function installImageStageRuntime(
  runtime: OpsRuntime,
  options: {
    infraDir: string;
    loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
    execFile?: DockerRuntimeOptions["execFile"];
  },
): void {
  runtime["service.image.stage"] = async (operation, context) => {
    const authority = context.controlAuthority;
    if (!authority || !context.execution || context.artifactLease || context.ownedTargetLease)
      throw Error("Original normal image-stage execution required");
    const admitted = executionAuthorityState(authority);
    if (
      admitted.kind !== operation.kind ||
      admitted.execution.operationFingerprint !== opsOperationFingerprint(operation) ||
      canonicalJson(admitted.execution) !== canonicalJson(context.execution)
    )
      throw Error("Original image-stage identity changed");
    const run = options.execFile ?? runContainedProcess;
    const remaining = () => {
      context.signal.throwIfAborted();
      const milliseconds = context.execution.deadlineAt - Date.now();
      if (milliseconds <= 0) throw new OpsExecutionFailure("timeout", {});
      return milliseconds;
    };
    const read = async (args: string[], maximum = 1024) =>
      run("docker", args, {
        signal: context.signal,
        timeout: Math.min(30000, remaining()),
        maxBuffer: maximum,
      });
    const inspect = async (reference: string): Promise<string> => {
      const value = (
        await read(["image", "inspect", "--format", "{{.Id}}", reference])
      ).stdout.trim();
      if (!imageId.test(value)) throw Error("Image cache identity is unavailable");
      return value;
    };
    const tagIdentity = async (reference: string): Promise<string | null> => {
      const raw = (
        await read([
          "image",
          "ls",
          "--no-trunc",
          "--format",
          "{{.ID}}",
          "--filter",
          `reference=${reference}`,
        ])
      ).stdout.trim();
      const values = new Set(raw ? raw.split(/\s+/) : []);
      if (values.size > 1 || [...values].some((value) => !imageId.test(value)))
        throw Error("Configured image tag identity is ambiguous");
      return [...values][0] ?? null;
    };
    try {
      return await services.withConfigurationGenerationWriter(
        options.infraDir,
        async () => {
          const directory = services.releaseStatePaths(options.infraDir).store,
            lock = await services.acquireReleaseStoreLock(directory);
          try {
            const source = await (async () => {
              try {
                assertControlExecutionForward(authority);
                if (
                  services.currentConfigurationGeneration(options.infraDir) !==
                  operation.expectedConfigurationRevisionId
                )
                  throw Error("Image-stage configuration changed");
                const registry = await options.loadAuthority();
                if (
                  !registry.services.some((service) => service.manifest.id === operation.serviceId)
                )
                  throw Error("Registered image source required");
                const selected = services.readServiceReleaseImageSelection(
                    options.infraDir,
                    operation.serviceId,
                  ),
                  requestedReference =
                    selected.imageReference ??
                    services.configurationImageReference(
                      strictReadFile(
                        services.configurationGenerationComposeFile(
                          options.infraDir,
                          operation.expectedConfigurationRevisionId,
                        ),
                        1024 * 1024,
                      ),
                      operation.serviceId,
                    );
                const normalized = services.coordinatorPullReferenceIdentity(requestedReference),
                  floating = !normalized.includes("@");
                const platform = services.imageStagePlatform(
                  (await read(["info", "--format", "{{.OSType}}/{{.Architecture}}"])).stdout,
                );
                const metadata = floating
                  ? JSON.parse(
                      (
                        await read(
                          ["manifest", "inspect", "--verbose", requestedReference],
                          1024 * 1024,
                        )
                      ).stdout,
                    )
                  : null;
                const stagedReference = services.immutableImageStageReference(
                    requestedReference,
                    metadata,
                    platform,
                  ),
                  before = floating ? await tagIdentity(requestedReference) : null;
                if (
                  (await options.loadAuthority()).revisionId !== registry.revisionId ||
                  services.currentConfigurationGeneration(options.infraDir) !==
                    operation.expectedConfigurationRevisionId
                )
                  throw Error("Image-stage source changed");
                assertImageStageLeaseCompatibility(authority);
                assertControlExecutionForward(authority);
                return {
                  requestedReference,
                  stagedReference,
                  floating,
                  before,
                  releaseSelectionDigest: selected.releaseSelectionDigest,
                };
              } catch (error) {
                retainConfigurationPreEffectRefusal(authority);
                throw error;
              }
            })();
            beginControlEffect(authority);
            const args = ["image", "pull", source.stagedReference];
            if (options.execFile)
              await run("docker", args, {
                signal: context.signal,
                timeout: remaining(),
                maxBuffer: 1024 * 1024,
              });
            else
              await runContainedStreamingProcess("docker", args, {
                signal: context.signal,
                timeout: remaining(),
                onLine: context.emitLog,
                redact: safeProcessDiagnostic,
              });
            const stagedId = await inspect(source.stagedReference);
            if (
              !stagedId ||
              (source.floating && (await tagIdentity(source.requestedReference)) !== source.before)
            )
              throw new OpsExecutionFailure("recovery_required", {});
            return {
              revisionId: operation.expectedConfigurationRevisionId,
              requestedReference: source.requestedReference,
              stagedReference: source.stagedReference,
              imageId: stagedId,
              releaseSelectionDigest: source.releaseSelectionDigest,
            };
          } finally {
            lock.release();
          }
        },
        context.signal,
      );
    } catch (error) {
      if (
        error instanceof services.ConfigurationGenerationError &&
        error.cause instanceof OpsExecutionFailure
      )
        throw error.cause;
      throw error;
    }
  };
}
