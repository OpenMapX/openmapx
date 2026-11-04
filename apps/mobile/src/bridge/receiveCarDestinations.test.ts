import { carDestinationsSchema } from "@openmapx/core/navigation";
import { getDatabase } from "../storage/database";
import { openTestDatabase } from "../storage/testing/nodeSqliteDatabase";
import { readCarDestinations, receiveCarDestinations } from "./receiveCarDestinations";

jest.mock("../storage/database", () => ({ getDatabase: jest.fn() }));
jest.mock("../car/nativeCar", () => ({ nativeCar: () => null }));
it("persists minimal scoped places, replaces accounts, clears on logout and instance changes", async () => {
  const database = openTestDatabase();
  (getDatabase as jest.Mock).mockResolvedValue(database);
  const payload = carDestinationsSchema.parse({
    account: "a",
    recent: [],
    saved: [{ id: "p", label: "Place", coordinates: [13, 52] }],
    locale: "de",
    units: "imperial",
    avoidHighways: false,
    avoidTolls: false,
    avoidFerries: false,
    avoidClosures: false,
    voiceEnabled: true,
    keepScreenOn: true,
    voiceTiming: "normal",
  });
  try {
    await receiveCarDestinations("https://one.example", payload);
    expect(await readCarDestinations("https://one.example")).toEqual(payload);
    await receiveCarDestinations("https://one.example", { ...payload, account: "b", saved: [] });
    expect((await readCarDestinations("https://one.example"))?.saved).toEqual([]);
    await receiveCarDestinations("https://one.example", { ...payload, account: null });
    expect((await readCarDestinations("https://one.example"))?.saved).toEqual([]);
    expect(await readCarDestinations("https://two.example")).toBeNull();
  } finally {
    await database.closeAsync();
  }
});
