import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../index";
import { parkedLocation, personalVehicle, user } from "../schema";

/**
 * The garage's correctness lives in two constraints that no mocked driver can
 * check: the parked-location uniqueness is `NULLS NOT DISTINCT`, and the
 * vehicle foreign key cascades. Both only mean anything against real
 * PostgreSQL, so this suite runs where the migrations have been applied.
 */
const TEST_USER = "vehicles-parking-test-user";
const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

async function reset(): Promise<void> {
  // Both tables cascade from the user, so one delete clears the fixture.
  await db.delete(user).where(eq(user.id, TEST_USER));
}

describe.skipIf(skipDatabase)("personal vehicles and parking with PostgreSQL", () => {
  beforeEach(async () => {
    await reset();
    await db.insert(user).values({
      id: TEST_USER,
      name: "Vehicles Parking Test",
      email: `${TEST_USER}@example.test`,
    });
  });

  afterEach(reset);

  async function addVehicle(id: string, name: string): Promise<void> {
    await db
      .insert(personalVehicle)
      .values({ id, userId: TEST_USER, name, kind: "car", powertrain: "petrol" });
  }

  async function park(id: string, vehicleId: string | null, lat: number): Promise<void> {
    await db
      .insert(parkedLocation)
      .values({ id, userId: TEST_USER, vehicleId, lat, lng: 6.6, source: "manual" });
  }

  it("rejects a second vehicle with the same name for one user", async () => {
    await addVehicle("v1", "Blue Golf");
    await expect(addVehicle("v2", "Blue Golf")).rejects.toThrow();
  });

  it("keeps one unassigned parked record per user", async () => {
    await park("p1", null, 51.55);
    // Without NULLS NOT DISTINCT PostgreSQL treats each null vehicle_id as its
    // own row, and the unassigned pin would silently accumulate duplicates.
    await expect(park("p2", null, 52.0)).rejects.toThrow();
  });

  it("upserts the unassigned record in place instead of duplicating it", async () => {
    await park("p1", null, 51.55);

    const now = new Date();
    await db
      .insert(parkedLocation)
      .values({
        id: "p-second-attempt",
        userId: TEST_USER,
        vehicleId: null,
        lat: 48.13,
        lng: 11.58,
        source: "device",
        savedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [parkedLocation.userId, parkedLocation.vehicleId],
        set: { lat: 48.13, lng: 11.58, source: "device", updatedAt: now },
      });

    const rows = await db.select().from(parkedLocation).where(eq(parkedLocation.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("p1");
    expect(rows[0].lat).toBeCloseTo(48.13);
    expect(rows[0].source).toBe("device");
  });

  it("lets an assigned and an unassigned record coexist", async () => {
    await addVehicle("v1", "Blue Golf");
    await park("p-null", null, 51.55);
    await park("p-v1", "v1", 50.0);

    const rows = await db.select().from(parkedLocation).where(eq(parkedLocation.userId, TEST_USER));
    expect(rows).toHaveLength(2);
  });

  it("deletes a vehicle even when an unassigned record exists, and cascades only its own pin", async () => {
    await addVehicle("v1", "Blue Golf");
    await park("p-null", null, 51.55);
    await park("p-v1", "v1", 50.0);

    // `ON DELETE SET NULL` would fail here: nulling vehicle_id collides with the
    // unassigned row under the same NULLS NOT DISTINCT constraint.
    await db.delete(personalVehicle).where(eq(personalVehicle.id, "v1"));

    const rows = await db.select().from(parkedLocation).where(eq(parkedLocation.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("p-null");
    expect(rows[0].vehicleId).toBeNull();
  });

  it("cascades both tables when the account is deleted", async () => {
    await addVehicle("v1", "Blue Golf");
    await park("p-v1", "v1", 50.0);
    await park("p-null", null, 51.55);

    await db.delete(user).where(eq(user.id, TEST_USER));

    expect(
      await db.select().from(personalVehicle).where(eq(personalVehicle.userId, TEST_USER)),
    ).toHaveLength(0);
    expect(
      await db.select().from(parkedLocation).where(eq(parkedLocation.userId, TEST_USER)),
    ).toHaveLength(0);
  });

  it("round-trips the jsonb battery spec", async () => {
    const ev = {
      batteryKwh: 64,
      baseWhPerKm: 170,
      massTonnes: 2,
      maxDcKw: 150,
      maxAcKw: 11,
      vehicleTaperSocPct: 80,
      connectors: ["ccs2" as const],
    };
    await db.insert(personalVehicle).values({
      id: "v-ev",
      userId: TEST_USER,
      name: "Blue Leaf",
      kind: "car",
      powertrain: "electric",
      ev,
    });

    const [row] = await db
      .select()
      .from(personalVehicle)
      .where(and(eq(personalVehicle.id, "v-ev"), eq(personalVehicle.userId, TEST_USER)));
    expect(row.ev).toEqual(ev);
  });

  it("finds the unassigned record with an IS NULL predicate", async () => {
    await park("p-null", null, 51.55);
    const rows = await db
      .select()
      .from(parkedLocation)
      .where(and(eq(parkedLocation.userId, TEST_USER), isNull(parkedLocation.vehicleId)));
    expect(rows).toHaveLength(1);
  });
});
