import { type CarDestinations, carDestinationsSchema } from "@openmapx/core/navigation";
import { nativeCar } from "../car/nativeCar";
import { getDatabase } from "../storage/database";
import {
  DELETE_OTHER_INSTANCE_CAR_DESTINATIONS,
  SELECT_CAR_DESTINATIONS,
  UPSERT_CAR_DESTINATIONS,
} from "../storage/sql";

/** One scope at a time: replacing the account also removes its predecessor's places. */
export async function receiveCarDestinations(
  instance: string,
  input: CarDestinations,
): Promise<void> {
  const payload = carDestinationsSchema.parse(input);
  const database = await getDatabase();
  const value = payload.account === null ? { ...payload, saved: [] } : payload;
  await database.runAsync(UPSERT_CAR_DESTINATIONS, [instance, JSON.stringify(value)]);
  await nativeCar()?.destinations(JSON.stringify(value));
}
export async function readCarDestinations(instance: string): Promise<CarDestinations | null> {
  const database = await getDatabase();
  await database.runAsync(DELETE_OTHER_INSTANCE_CAR_DESTINATIONS, [instance]);
  const row = await database.getFirstAsync<{ payload: string }>(SELECT_CAR_DESTINATIONS);
  if (!row) return null;
  try {
    return carDestinationsSchema.parse(JSON.parse(row.payload));
  } catch {
    return null;
  }
}
