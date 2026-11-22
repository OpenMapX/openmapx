import { z } from "zod";
import { PROTECTED_CONFIGURATION_SERVICE_IDS } from "./core-service-ids";

const serviceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * The order a self-update recreates services in: every other service first,
 * by id, then the protected ones in their fixed order, so the database comes
 * before its clients and the operations agent is replaced last. Rollback uses
 * the same order.
 */
export function selfUpdateServiceOrder(serviceIds: readonly string[]): string[] {
  const values = z.array(serviceId).min(1).max(64).parse(serviceIds);
  if (new Set(values).size !== values.length) throw Error("Duplicate frozen handoff target");
  const protectedIds = new Set<string>(PROTECTED_CONFIGURATION_SERVICE_IDS);
  return [
    ...values.filter((value) => !protectedIds.has(value)).sort(),
    ...PROTECTED_CONFIGURATION_SERVICE_IDS.filter((value) => values.includes(value)),
  ];
}
