/** Data-only comparison of the actual normalized Compose/Docker observations.
 * No parsed resource object supplies a target, source or settlement authority. */
import { z } from "zod";
import {
  maintenanceDockerHostResourcesSchema,
  maintenanceDockerResourceSpecSchema,
} from "../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records";

export function verifyConfigurationRuntimeResources(
  spec: unknown,
  container: unknown,
): { memoryBytes: number; nanoCpus: number } {
  const expected = maintenanceDockerResourceSpecSchema.parse(spec),
    actual = z
      .object({ HostConfig: maintenanceDockerHostResourcesSchema })
      .parse(container).HostConfig,
    limits = expected.deploy?.resources?.limits,
    memoryBytes = Number(limits?.memory ?? expected.mem_limit ?? 0),
    nanoCpus = Math.round(Number(limits?.cpus ?? expected.cpus ?? 0) * 1e9),
    quotaNanoCpus =
      actual.CpuQuota > 0 && actual.CpuPeriod > 0
        ? Math.round((actual.CpuQuota / actual.CpuPeriod) * 1e9)
        : 0;
  if (
    !Number.isSafeInteger(memoryBytes) ||
    !Number.isSafeInteger(nanoCpus) ||
    (limits?.memory !== undefined &&
      expected.mem_limit !== undefined &&
      Number(limits.memory) !== Number(expected.mem_limit)) ||
    (limits?.cpus !== undefined &&
      expected.cpus !== undefined &&
      Number(limits.cpus) !== Number(expected.cpus)) ||
    (actual.CpuQuota > 0 && actual.CpuPeriod === 0) ||
    (actual.NanoCpus > 0 && quotaNanoCpus > 0 && actual.NanoCpus !== quotaNanoCpus) ||
    actual.Memory !== memoryBytes ||
    (actual.NanoCpus || quotaNanoCpus) !== nanoCpus
  )
    throw Error("Original applied runtime resources differ");
  return { memoryBytes, nanoCpus };
}
