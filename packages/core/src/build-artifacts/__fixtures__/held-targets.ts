import { leaseStoreDirectory, openLeaseStore } from "../lease-store";

/** Every target some lease in the installation's store holds. */
export function heldTargets(infraDir: string): string[] {
  const store = openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" });
  return [...new Set(store.list().flatMap((lease) => lease.targets))].sort();
}
