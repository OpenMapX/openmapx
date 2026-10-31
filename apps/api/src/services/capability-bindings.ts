import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { capabilityBinding } from "../db/schema";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./administrative-configuration-context";

export interface BindingKey {
  integrationId: string;
  capability: string;
}

export async function listBindingsForIntegration(
  integrationId: string,
): Promise<Array<{ capability: string; serviceId: string }>> {
  return db
    .select({
      capability: capabilityBinding.capability,
      serviceId: capabilityBinding.serviceId,
    })
    .from(capabilityBinding)
    .where(eq(capabilityBinding.integrationId, integrationId));
}

export async function getBinding(key: BindingKey): Promise<string | null> {
  const [row] = await db
    .select({ serviceId: capabilityBinding.serviceId })
    .from(capabilityBinding)
    .where(
      and(
        eq(capabilityBinding.integrationId, key.integrationId),
        eq(capabilityBinding.capability, key.capability),
      ),
    )
    .limit(1);
  return row?.serviceId ?? null;
}

export async function setBinding(key: BindingKey, serviceId: string): Promise<void> {
  await db
    .insert(capabilityBinding)
    .values({
      integrationId: key.integrationId,
      capability: key.capability,
      serviceId,
    })
    .onConflictDoUpdate({
      target: [capabilityBinding.integrationId, capabilityBinding.capability],
      set: { serviceId, updatedAt: new Date() },
    });
}

export async function removeBinding(key: BindingKey): Promise<void> {
  await db
    .delete(capabilityBinding)
    .where(
      and(
        eq(capabilityBinding.integrationId, key.integrationId),
        eq(capabilityBinding.capability, key.capability),
      ),
    );
}

export async function loadAllBindingsByIntegration(
  context?: AdministrativeConfigurationReadContext,
): Promise<Map<string, Map<string, string>>> {
  if (context) {
    assertAdministrativeConfigurationRead(context);
    if (context.integrationBindingSnapshot)
      return new Map(
        Object.entries(context.integrationBindingSnapshot).map(([id, bindings]) => [
          id,
          new Map(Object.entries(bindings)),
        ]),
      );
    if (!context.bindingRows) throw Error("Captured binding authority unavailable");
    const out = new Map<string, Map<string, string>>();
    for (const row of context.bindingRows) {
      if (!out.has(row.integrationId)) out.set(row.integrationId, new Map());
      out.get(row.integrationId)?.set(row.capability, row.serviceId);
    }
    return out;
  }
  const rows = await db
    .select({
      integrationId: capabilityBinding.integrationId,
      capability: capabilityBinding.capability,
      serviceId: capabilityBinding.serviceId,
    })
    .from(capabilityBinding);

  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!out.has(r.integrationId)) out.set(r.integrationId, new Map());
    out.get(r.integrationId)?.set(r.capability, r.serviceId);
  }
  return out;
}
