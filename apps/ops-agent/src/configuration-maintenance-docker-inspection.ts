/** Fixed production Docker inspector. Only execFile is an external-I/O seam;
 * no injected result/inspector can qualify the original maintenance final. */
import { createHmac, type KeyObject, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  maintenanceDockerComposeSchema as compose,
  maintenanceDockerContainerSchema as container,
} from "../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records";
import type { ConfigurationMaintenanceOwnerRecord } from "./configuration-maintenance-store";
import { verifyConfigurationRuntimeResources } from "./configuration-resource-inspection";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { OwnedServiceSnapshot } from "./owned-services";

export async function inspectMaintenanceDockerRuntime(options: {
  stack: services.StackPaths;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  owner: ConfigurationMaintenanceOwnerRecord;
  containers: readonly OwnedServiceSnapshot[];
  privateKey: KeyObject;
  signal: AbortSignal;
  /** Interim fixed-helper check only; the final producer always checks all targets. */
  handoffTargetId?: string;
}) {
  const { owner, containers, signal } = options,
    checks = [],
    details = [],
    inspectedRevision =
      owner.receipt.generation === "not_committed"
        ? owner.plan.operation.expectedCurrentRevisionId
        : owner.plan.operation.revisionId,
    allIds = [
      ...new Set([
        ...owner.plan.steps
          .filter((value) => value.phase === "maintenance-recreate")
          .map((value) => ("serviceId" in value.operation ? value.operation.serviceId : "")),
        ...(owner.plan.handoff?.serviceIds ?? []),
      ]),
    ].sort(),
    ids = options.handoffTargetId ? [options.handoffTargetId] : allIds;
  if (options.handoffTargetId && !owner.plan.handoff?.serviceIds.includes(options.handoffTargetId))
    throw Error("Original handoff target required");
  const run = async (args: string[]) => {
      signal.throwIfAborted();
      const response = await options.execFile("docker", args, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      if (Buffer.byteLength(response.stdout) > 1024 * 1024)
        throw Error("Maintenance Docker observation capacity");
      signal.throwIfAborted();
      return response.stdout;
    },
    keyed = (value: string | Buffer) =>
      createHmac("sha256", options.privateKey.export({ type: "pkcs8", format: "der" }))
        .update("openmapx-private-maintenance-runtime-v1\0")
        .update(value)
        .digest("hex"),
    lock = await services.acquireReleaseStoreLock(options.stack.infraDir, {}, { failIfBusy: true });
  try {
    if (
      !inspectedRevision ||
      services.currentConfigurationGeneration(options.stack.infraDir) !== inspectedRevision
    )
      throw Error("Original inspected generation changed");
    const args = services.stackComposeArgs(options.stack),
      expected = compose.parse(JSON.parse(await run([...args, "config", "--format", "json"])));
    for (const id of ids) {
      const current = containers.filter((value) => value.serviceId === id),
        original = owner.originalContainers.filter((value) => value.serviceId === id),
        spec = expected.services[id];
      if (!spec || current.length !== 1 || original.length !== 1 || current[0]!.state !== "running")
        throw Error("Original applied container expectation unavailable");
      const frozenImage =
          id === "data-manager" && owner.receipt.generation === "committed"
            ? owner.plan.coordinatorImage
            : undefined,
        expectedImageId = frozenImage?.imageId ?? original[0]!.provenance.imageId;
      if (frozenImage && spec.image !== frozenImage.imageReference)
        throw Error("Frozen coordinator image reference changed");
      const owned = current[0]!,
        observed = container.parse(
          JSON.parse(
            (
              await run(["container", "inspect", "--format", "{{json .}}", owned.containerId])
            ).trim(),
          ),
        ),
        hashLine = (await run([...args, "config", "--hash", id])).trim().split(/\s+/),
        hash = hashLine.at(-1);
      if (
        hashLine.length !== 2 ||
        hashLine[0] !== id ||
        !hash ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        observed.Id !== owned.containerId ||
        observed.Config.Labels["com.docker.compose.config-hash"] !== hash ||
        observed.Config.Image !== spec.image
      )
        throw Error("Original applied runtime configuration differs");
      const actualEnv = Object.fromEntries(
          observed.Config.Env.map((value) => {
            const separator = value.indexOf("=");
            if (separator < 1) throw Error("Malformed runtime environment");
            return [value.slice(0, separator), value.slice(separator + 1)];
          }),
        ),
        expectedEnv = Object.fromEntries(
          Object.entries(spec.environment).map(([key, value]) => [
            key,
            value === null ? "" : String(value),
          ]),
        );
      if (Object.keys(expectedEnv).some((key) => actualEnv[key] !== expectedEnv[key]))
        throw Error("Original applied runtime environment differs");
      const resources = verifyConfigurationRuntimeResources(spec, observed);
      checks.push({
        serviceId: id,
        ordinal: null,
        check: "configuration",
        expectedRevisionId: inspectedRevision,
        expectedImageId,
      });
      details.push({
        containerId: owned.containerId,
        expectedConfigHash: hash,
        actualConfigHash: observed.Config.Labels["com.docker.compose.config-hash"],
        resources,
        expectedEnvironmentDigest: keyed(canonicalJson(expectedEnv)),
        actualEnvironmentDigest: keyed(
          canonicalJson(
            Object.fromEntries(Object.keys(expectedEnv).map((key) => [key, actualEnv[key]])),
          ),
        ),
      });
      if (observed.Image !== expectedImageId || observed.Image !== owned.provenance.imageId)
        throw Error("Original applied image differs");
      checks.push({
        serviceId: id,
        ordinal: null,
        check: "image",
        expectedRevisionId: inspectedRevision,
        expectedImageId,
      });
      details.push({
        containerId: owned.containerId,
        imageId: observed.Image,
        expectedImageId,
      });
      const mounts = [];
      for (const volume of spec.volumes) {
        const matches = observed.Mounts.filter((value) => value.Destination === volume.target),
          actual = matches[0];
        if (
          matches.length !== 1 ||
          !actual ||
          actual.Type !== volume.type ||
          actual.RW !== !volume.read_only
        )
          throw Error("Original applied mount differs");
        if (
          volume.type === "bind"
            ? !volume.source ||
              !actual.Source ||
              (await realpath(volume.source)) !== (await realpath(actual.Source))
            : volume.type === "volume" &&
              (!volume.source ||
                actual.Name !== (expected.volumes[volume.source]?.name ?? volume.source))
        )
          throw Error("Original applied mount source differs");
        mounts.push({
          targetDigest: keyed(volume.target),
          type: actual.Type,
          sourceDigest: volume.type === "bind" ? keyed(await realpath(volume.source!)) : null,
          nameDigest: actual.Name ? keyed(actual.Name) : null,
          readOnly: !actual.RW,
        });
      }
      for (const secret of spec.secrets) {
        const path = expected.secrets[secret.source]?.file,
          target = `/run/secrets/${secret.target ?? secret.source}`,
          matches = observed.Mounts.filter((value) => value.Destination === target),
          actual = matches[0];
        if (
          !path ||
          matches.length !== 1 ||
          !actual ||
          actual.Type !== "bind" ||
          actual.RW ||
          !actual.Source ||
          (await realpath(path)) !== (await realpath(actual.Source))
        )
          throw Error("Original applied secret mount differs");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await file.stat(),
            named = await lstat(path);
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > 65536 * 4 ||
            before.dev !== named.dev ||
            before.ino !== named.ino
          )
            throw Error("Original secret source unavailable");
          const expectedBytes = await file.readFile(),
            encoded = (await run(["container", "exec", observed.Id, "base64", target])).replace(
              /[\r\n]/g,
              "",
            ),
            actualBytes = Buffer.from(encoded, "base64"),
            expectedDigest = keyed(expectedBytes),
            actualDigest = keyed(actualBytes),
            after = await file.stat(),
            latest = await lstat(path);
          if (
            before.dev !== latest.dev ||
            before.ino !== latest.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            encoded !== actualBytes.toString("base64") ||
            !timingSafeEqual(Buffer.from(expectedDigest, "hex"), Buffer.from(actualDigest, "hex"))
          )
            throw Error("Original runtime secret content differs");
          mounts.push({
            targetDigest: keyed(target),
            type: actual.Type,
            sourceDigest: keyed(await realpath(path)),
            readOnly: true,
            expectedDigest,
            actualDigest,
          });
        } finally {
          await file.close();
        }
      }
      checks.push({
        serviceId: id,
        ordinal: null,
        check: "mount",
        expectedRevisionId: inspectedRevision,
        expectedImageId,
      });
      details.push({ containerId: owned.containerId, mounts });
      if (
        observed.State.Status !== "running" ||
        !observed.State.Running ||
        (observed.State.Health && observed.State.Health.Status !== "healthy") ||
        (spec.healthcheck &&
          !spec.healthcheck.disable &&
          observed.State.Health?.Status !== "healthy")
      )
        throw Error("Original applied container not ready");
      checks.push({
        serviceId: id,
        ordinal: null,
        check: "readiness",
        expectedRevisionId: inspectedRevision,
        expectedImageId,
      });
      details.push({
        containerId: owned.containerId,
        state: observed.State.Status,
        running: observed.State.Running,
        health: observed.State.Health?.Status ?? null,
      });
    }
    if (services.currentConfigurationGeneration(options.stack.infraDir) !== inspectedRevision)
      throw Error("Original inspected generation changed");
    return { checks, details };
  } finally {
    lock.release();
  }
}
