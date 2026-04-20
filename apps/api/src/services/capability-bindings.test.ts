import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../db";
import { capabilityBinding } from "../db/schema";
import {
  getBinding,
  listBindingsForIntegration,
  removeBinding,
  setBinding,
} from "./capability-bindings";

const TEST_INT = "routing-test";

beforeAll(async () => {
  // Some local test DB setups don't run migrations ahead of this suite.
  // Bootstrap the table minimally so DAO tests remain hermetic.
  await sql`
    create table if not exists capability_binding (
      integration_id text not null,
      capability text not null,
      service_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (integration_id, capability)
    )
  `;
  await sql`
    create index if not exists idx_capability_binding_service
      on capability_binding (service_id)
  `;
});

beforeEach(async () => {
  await db.delete(capabilityBinding).where(eq(capabilityBinding.integrationId, TEST_INT));
});

afterEach(async () => {
  await db.delete(capabilityBinding).where(eq(capabilityBinding.integrationId, TEST_INT));
});

describe("capability-bindings DAO", () => {
  it("set and get", async () => {
    await setBinding({ integrationId: TEST_INT, capability: "routing-engine" }, "valhalla");
    expect(await getBinding({ integrationId: TEST_INT, capability: "routing-engine" })).toBe(
      "valhalla",
    );
  });

  it("overwrites on set", async () => {
    await setBinding({ integrationId: TEST_INT, capability: "routing-engine" }, "valhalla");
    await setBinding({ integrationId: TEST_INT, capability: "routing-engine" }, "osrm");
    expect(await getBinding({ integrationId: TEST_INT, capability: "routing-engine" })).toBe(
      "osrm",
    );
  });

  it("lists all bindings for integration", async () => {
    await setBinding({ integrationId: TEST_INT, capability: "routing-engine" }, "valhalla");
    await setBinding({ integrationId: TEST_INT, capability: "geocoder" }, "nominatim");
    const rows = await listBindingsForIntegration(TEST_INT);
    expect(rows.sort((a, b) => a.capability.localeCompare(b.capability))).toEqual([
      { capability: "geocoder", serviceId: "nominatim" },
      { capability: "routing-engine", serviceId: "valhalla" },
    ]);
  });

  it("removeBinding", async () => {
    await setBinding({ integrationId: TEST_INT, capability: "routing-engine" }, "valhalla");
    await removeBinding({ integrationId: TEST_INT, capability: "routing-engine" });
    expect(await getBinding({ integrationId: TEST_INT, capability: "routing-engine" })).toBeNull();
  });
});
