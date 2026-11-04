import { type CarDestinations, carDestinationsSchema } from "@openmapx/core/navigation";
import { nativeCar } from "../car/nativeCar";
import { getDatabase } from "../storage/database";

/** One scope at a time: replacing the account also removes its predecessor's places. */
export async function receiveCarDestinations(
  instance: string,
  input: CarDestinations,
): Promise<void> {
  const payload = carDestinationsSchema.parse(input);
  const database = await getDatabase();
  await database.execAsync(
    "CREATE TABLE IF NOT EXISTS car_destinations (id INTEGER PRIMARY KEY CHECK(id = 1), instance TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  const value = payload.account === null ? { ...payload, saved: [] } : payload;
  await database.runAsync(
    "INSERT OR REPLACE INTO car_destinations (id, instance, payload) VALUES (1, ?, ?)",
    [instance, JSON.stringify(value)],
  );
  await nativeCar()?.destinations(JSON.stringify(value));
}
export async function readCarDestinations(instance: string): Promise<CarDestinations | null> {
  const database = await getDatabase();
  await database.execAsync(
    "CREATE TABLE IF NOT EXISTS car_destinations (id INTEGER PRIMARY KEY CHECK(id = 1), instance TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  await database.runAsync("DELETE FROM car_destinations WHERE instance <> ?", [instance]);
  const row = await database.getFirstAsync<{ payload: string }>(
    "SELECT payload FROM car_destinations WHERE id = 1",
  );
  if (!row) return null;
  try {
    return carDestinationsSchema.parse(JSON.parse(row.payload));
  } catch {
    return null;
  }
}
