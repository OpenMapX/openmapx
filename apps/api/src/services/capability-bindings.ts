import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { capabilityBinding } from "../db/schema";

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

export async function loadAllBindingsByIntegration(): Promise<Map<string, Map<string, string>>> {
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
