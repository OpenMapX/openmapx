import { resolve } from "node:path";
import { services } from "@openmapx/core";

const { ServiceRegistry } = services;

let registry: InstanceType<typeof ServiceRegistry> | null = null;
const warnings: string[] = [];

export async function initServiceRegistry(): Promise<void> {
  const rootDir = resolve(process.cwd(), "..", "..");
  registry = new ServiceRegistry({ rootDir, warnings });
  await registry.load();
}

export function getServiceRegistry(): InstanceType<typeof ServiceRegistry> {
  if (!registry) throw new Error("Service registry not initialized");
  return registry;
}

export function getServiceRegistryWarnings(): string[] {
  return [...warnings];
}

/**
 * Resolve a reachable URL for a service by its id, using internal Docker networking.
 * Services only expose `expose:` ports (no host binding by default), reachable by
 * service hostname within the `openmapx` network.
 */
export function serviceUrl(serviceId: string): string | null {
  if (!registry) return null;
  const svc = registry.get(serviceId);
  if (!svc?.enabled) return null;
  const port = svc.manifest.container.expose?.[0];
  if (!port) return null;
  return `http://${serviceId}:${port}`;
}
