import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { capabilityBinding } from "../db/schema";
import {
  getBinding,
  listBindingsForIntegration,
  removeBinding,
  setBinding,
} from "./capability-bindings";

const TEST_INT = "routing-test";

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
