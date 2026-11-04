const mockPreferences = {
  locale: "de",
  units: "metric",
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  avoidClosures: false,
  voiceEnabled: true,
  keepScreenOn: true,
  voiceTiming: "normal",
};
const mockDriver = {
  isRunning: jest.fn(async () => false),
  getCurrentFix: jest.fn(async () => ({ coords: [6.0834, 50.7753], timestampMs: 0, accuracy: 9 })),
};
jest.mock("../bridge/receiveCarDestinations", () => ({
  readCarDestinations: jest.fn(async () => mockPreferences),
}));
jest.mock("../location/createLocationDriver", () => ({ createLocationDriver: () => mockDriver }));

const mockPlan = jest.fn();
const mockStart = jest.fn();
jest.mock("./CarRoutePlanner", () => ({
  ...jest.requireActual("./CarRoutePlanner"),
  CarRoutePlanner: jest.fn(() => ({
    plan: mockPlan,
    start: mockStart,
    cancel: jest.fn(),
    candidateGeometry: () => [
      [13.41, 52.52],
      [13.38, 52.52],
    ],
    previewRoutes: () => [
      {
        coordinates: [
          [6, 50],
          [7, 51],
        ],
      },
      {
        coordinates: [
          [6, 50],
          [7.5, 51],
        ],
      },
    ],
  })),
}));

import { AUTO_DRIVE_ORIGIN, CarCommands } from "./CarCommands";
import type { NativeCar } from "./nativeCar";

function native() {
  const results: unknown[] = [];
  const previews: unknown[] = [];
  const car = {
    result: jest.fn(async (json: string) => {
      results.push(JSON.parse(json));
    }),
    preview: jest.fn(async (json: string) => {
      previews.push(JSON.parse(json));
    }),
    startEligible: jest.fn(async () => true),
  } as unknown as NativeCar;
  return { car, results, previews };
}
const destination = { id: "berlin", label: "Berlin", coordinates: [13.4, 52.5] };
const commands = (car: NativeCar) =>
  new CarCommands(car, "https://openmapx.com", "https://openmapx.com", async () => {
    throw new Error("unused");
  });

beforeEach(() => {
  mockPlan.mockReset();
  mockStart.mockReset();
});

test("sends each route's time and distance with the preview", async () => {
  const { car, results, previews } = native();
  mockPlan.mockResolvedValue([
    {
      coordinates: [
        [6, 50],
        [13.4, 52.5],
      ],
      durationSeconds: 23820,
      distanceMeters: 637000,
    },
  ]);
  await commands(car).handle(`car:${JSON.stringify({ action: "plan", destination })}`);
  expect(previews).toEqual([
    {
      v: 1,
      type: "car-preview",
      routes: [
        {
          coordinates: [
            [6, 50],
            [13.4, 52.5],
          ],
        },
      ],
      selected: 0,
    },
  ]);
  expect(results).toEqual([
    {
      routes: [
        {
          durationSeconds: 23820,
          distanceMeters: 637000,
          // The phone banner's rounding, shown by the car as is.
          distance: { value: 637, unit: "km", decimals: 0 },
        },
      ],
    },
  ]);
});

test("reports why planning failed instead of always asking for phone setup", async () => {
  const { car, results } = native();
  mockPlan.mockRejectedValue(new Error("location-unavailable"));
  await commands(car).handle(`car:${JSON.stringify({ action: "plan", destination })}`);
  expect(results).toEqual([{ error: "location-unavailable" }]);
});

test("re-highlights a selected route and clears the preview once the trip starts", async () => {
  const { car, results, previews } = native();
  mockPlan.mockResolvedValue([
    {
      coordinates: [
        [6, 50],
        [7, 51],
      ],
      durationSeconds: 1,
      distanceMeters: 1,
    },
  ]);
  mockStart.mockResolvedValue({ type: "session.started", payload: {} });
  const c = commands(car);
  await c.handle(`car:${JSON.stringify({ action: "plan", destination })}`);
  await c.handle(`car:${JSON.stringify({ action: "select", index: 1 })}`);
  expect(previews.at(-1)).toMatchObject({ type: "car-preview", selected: 1 });
  await c.handle(`car:${JSON.stringify({ action: "start", index: 1 })}`);
  expect(mockStart).toHaveBeenCalledWith(1, undefined);
  expect(previews.at(-1)).toEqual({ v: 1, type: "car-preview", routes: [] });
  expect(results.at(-1)).toEqual({ started: true });
});

test("only refusals the phone can fix ask for phone setup", async () => {
  for (const [code, error] of [
    ["app-not-visible", "phone-setup"],
    ["driver-start-failed", "unavailable"],
  ] as const) {
    const { car, results } = native();
    mockStart.mockResolvedValue({ type: "native.error", payload: { code } });
    await commands(car).handle(`car:${JSON.stringify({ action: "start", index: 0 })}`);
    expect(results.at(-1)).toEqual({ started: false, error });
  }
});

test("biases search to the car's rounded position", async () => {
  jest.useFakeTimers();
  const fetchMock = jest.fn(async () => ({ ok: true, json: async () => [] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const { car } = native();
    await commands(car).handle(`car:${JSON.stringify({ action: "search", query: "berlin" })}`);
    await jest.advanceTimersByTimeAsync(400);
    const calls = fetchMock.mock.calls as unknown as [string][];
    const url = new URL(calls[0]?.[0] ?? "");
    expect(url.searchParams.get("lat")).toBe("50.78");
    expect(url.searchParams.get("lng")).toBe("6.08");
  } finally {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  }
});

describe("Android Auto test-drive mode", () => {
  const route = {
    coordinates: [
      [13.41, 52.52],
      [13.38, 52.52],
    ],
    durationSeconds: 300,
    distanceMeters: 2500,
  };

  test("plans from Berlin and replays the started route, whatever the phone's state", async () => {
    const { car, results } = native();
    (car.startEligible as jest.Mock).mockResolvedValue(false);
    const prepare = jest.fn(async () => {});
    const stop = jest.fn(async () => {});
    const c = new CarCommands(
      car,
      "https://openmapx.com",
      "https://openmapx.com",
      async () => {
        throw new Error("unused");
      },
      prepare,
      stop,
    );
    expect(await c.handle("auto-drive")).toBe(true);
    mockPlan.mockResolvedValue([route]);
    await c.handle(`car:${JSON.stringify({ action: "plan", destination })}`);
    expect(mockPlan).toHaveBeenCalledWith(destination, mockPreferences, AUTO_DRIVE_ORIGIN);
    mockStart.mockResolvedValue({ type: "session.started", payload: {} });
    await c.handle(`car:${JSON.stringify({ action: "start", index: 0 })}`);
    expect(prepare).toHaveBeenCalledWith([
      [13.41, 52.52],
      [13.38, 52.52],
    ]);
    expect(results.at(-1)).toEqual({ started: true });
    expect(stop).not.toHaveBeenCalled();
  });

  test("removes the replay when the start fails", async () => {
    const { car } = native();
    const stop = jest.fn(async () => {});
    const c = new CarCommands(
      car,
      "https://openmapx.com",
      "https://openmapx.com",
      async () => {
        throw new Error("unused");
      },
      async () => {},
      stop,
    );
    await c.handle("auto-drive");
    mockStart.mockResolvedValue({ type: "native.error", payload: { code: "session-active" } });
    await c.handle(`car:${JSON.stringify({ action: "start", index: 0 })}`);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("ordinary sessions never replay and plan from the phone's position", async () => {
    const { car } = native();
    const prepare = jest.fn(async () => {});
    const c = new CarCommands(
      car,
      "https://openmapx.com",
      "https://openmapx.com",
      async () => {
        throw new Error("unused");
      },
      prepare,
    );
    mockPlan.mockResolvedValue([route]);
    await c.handle(`car:${JSON.stringify({ action: "plan", destination })}`);
    expect(mockPlan).toHaveBeenCalledWith(destination, mockPreferences, undefined);
    mockStart.mockResolvedValue({ type: "session.started", payload: {} });
    await c.handle(`car:${JSON.stringify({ action: "start", index: 0 })}`);
    expect(prepare).not.toHaveBeenCalled();
  });
});

test("a search still in flight does not overwrite the plan's result", async () => {
  jest.useFakeTimers();
  let answer: ((value: unknown) => void) | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  ) as unknown as typeof fetch;
  try {
    const { car, results } = native();
    mockPlan.mockResolvedValue([
      {
        coordinates: [
          [6, 50],
          [7, 51],
        ],
        durationSeconds: 1,
        distanceMeters: 1,
      },
    ]);
    const c = commands(car);
    await c.handle(`car:${JSON.stringify({ action: "search", query: "berlin" })}`);
    await jest.advanceTimersByTimeAsync(400);
    await c.handle(`car:${JSON.stringify({ action: "plan", destination })}`);
    answer?.({ ok: true, status: 200, headers: new Headers(), json: async () => [] });
    await jest.advanceTimersByTimeAsync(100);
    expect(results.at(-1)).toMatchObject({ routes: [expect.anything()] });
  } finally {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  }
});
