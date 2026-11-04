import { carDestinationsSchema } from "@openmapx/core/navigation";
import { createApiClient, fetchDirections } from "@openmapx/core/navigation/api";
import { createLocationDriver } from "../location/createLocationDriver";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { CarRoutePlanner } from "./CarRoutePlanner";

jest.mock("@openmapx/core/navigation/api", () => ({
  createApiClient: jest.fn(() => ({})),
  fetchDirections: jest.fn(),
}));
jest.mock("../location/createLocationDriver", () => ({ createLocationDriver: jest.fn() }));
const preferences = carDestinationsSchema.parse({
  account: "a",
  recent: [],
  saved: [],
  locale: "de",
  units: "imperial",
  avoidHighways: true,
  avoidTolls: true,
  avoidFerries: false,
  avoidClosures: true,
  voiceEnabled: true,
  keepScreenOn: true,
  voiceTiming: "normal",
});
const destination = { id: "d", label: "Place", coordinates: [13, 52] };
beforeEach(() => jest.clearAllMocks());
it("rejects missing background permission before requesting a fix or route", async () => {
  const getCurrentFix = jest.fn();
  (createLocationDriver as jest.Mock).mockReturnValue({
    getPermissionState: async () => "foreground",
    getCurrentFix,
  });
  const planner = new CarRoutePlanner("https://example.com", jest.fn(), () => ({
    kind: "background",
  }));
  await expect(planner.plan(destination, preferences)).rejects.toThrow("phone-setup");
  expect(getCurrentFix).not.toHaveBeenCalled();
  expect(fetchDirections).not.toHaveBeenCalled();
});
it("fetches outside the authority, omits credentials, preserves preferences and discards late completion after stop", async () => {
  (createLocationDriver as jest.Mock).mockReturnValue({
    getPermissionState: async () => "background",
    getCurrentFix: async () => ({ coords: [12, 51], timestampMs: Date.now(), accuracy: 5 }),
  });
  let complete: (value: unknown) => void = () => {};
  const requested = new Promise<void>((resolve) => {
    (fetchDirections as jest.Mock).mockImplementation(() => {
      resolve();
      return new Promise((done) => {
        complete = done;
      });
    });
  });
  const coordinator = jest.fn();
  const planner = new CarRoutePlanner("https://example.com", coordinator, () => ({
    kind: "background",
  }));
  const pending = planner.plan(destination, preferences);
  await requested;
  planner.cancel();
  complete({ routes: [] });
  expect(await pending).toBeNull();
  expect(coordinator).not.toHaveBeenCalled();
  expect(await planner.start(0)).toBeNull();
  expect(createApiClient).toHaveBeenCalledWith({
    baseUrl: "https://example.com",
    credentials: "omit",
  });
  expect(fetchDirections).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "driving",
      lang: "de",
      units: "imperial",
      avoidHighways: true,
      avoidTolls: true,
      avoidClosures: true,
    }),
    expect.anything(),
    expect.objectContaining({ signal: expect.anything() }),
  );
});
it("validates a real route package and starts only through the shared coordinator", async () => {
  const route = groundSessionFixture().payload.startPackage.route;
  (createLocationDriver as jest.Mock).mockReturnValue({
    getPermissionState: async () => "background",
    getCurrentFix: async () => ({ coords: [12, 51], timestampMs: Date.now(), accuracy: 5 }),
  });
  (fetchDirections as jest.Mock).mockResolvedValue({ routes: [route] });
  const startCarTrip = jest.fn(async () => ({ type: "session.started" }));
  const context = { kind: "car", hostAuthorized: true, locationServiceStartAllowed: true } as const;
  const planner = new CarRoutePlanner(
    "https://example.com",
    async () => ({ startCarTrip }) as never,
    () => context,
  );
  const preview = await planner.plan(destination, preferences);
  expect(preview).toEqual([{ coordinates: route.geometry }]);
  await planner.start(0, "previous-session");
  expect(startCarTrip).toHaveBeenCalledWith(
    expect.objectContaining({ locale: "de", units: "imperial", mode: "driving" }),
    expect.any(Function),
    expect.any(Function),
    "previous-session",
  );
});
