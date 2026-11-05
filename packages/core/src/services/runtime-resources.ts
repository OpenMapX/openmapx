import type { ServiceManifest } from "./types";

export { SERVICE_RESOURCE_FIELDS as RUNTIME_RESOURCE_KEYS } from "../configuration-values";

import { SERVICE_RESOURCE_FIELDS } from "../configuration-values";
export function isRuntimeResourceKey(key: string): boolean {
  return (SERVICE_RESOURCE_FIELDS as readonly string[]).includes(key);
}
export function runtimeResourceNumber(key: string, value: unknown): number {
  const [minimum, maximum, integer] =
    key === "OPENMAPX_CPU_LIMIT"
      ? [0.125, 256, false]
      : key === "OPENMAPX_JAVA_HEAP_MIB"
        ? [128, 262144, true]
        : [16, 1048576, true];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  )
    throw Error(`Invalid ${key}`);
  return value;
}
export function resolveServiceRuntimeResources(
  manifest: ServiceManifest,
  values: Record<string, unknown>,
): { memory?: string; cpus?: string } {
  const memory = values.OPENMAPX_MEMORY_MIB;
  const cpu = values.OPENMAPX_CPU_LIMIT;
  return {
    ...(memory === undefined
      ? manifest.container.memory
        ? { memory: manifest.container.memory }
        : {}
      : { memory: `${runtimeResourceNumber("OPENMAPX_MEMORY_MIB", memory)}m` }),
    ...(cpu === undefined
      ? {}
      : { cpus: String(runtimeResourceNumber("OPENMAPX_CPU_LIMIT", cpu)) }),
  };
}
/** These public, typed scalars need rendering adapters rather than raw Compose references. */
export function materializeServiceConfigKey(serviceId: string, key: string): boolean {
  return isRuntimeResourceKey(key) || serviceId === "valhalla";
}
/** Only a manifest-declared resource expression can establish legacy host ownership. */
export function memoryHostVariable(memory: string | undefined): string | undefined {
  return memory?.match(/^\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}$/)?.[1];
}
