const mockStart = jest.fn(async () => {});
const mockSetDebug = jest.fn(async () => {});
jest.mock("../location/createLocationDriver", () => ({
  createLocationDriver: () => ({ start: mockStart }),
  setDebugLocationDriver: (...args: unknown[]) => mockSetDebug(...(args as [])),
}));
jest.mock("../navigation/foregroundCoordinator", () => ({ foregroundCoordinator: () => null }));

import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { SessionRepository } from "../storage/SessionRepository";
import { prepareAutoDrive, simulatedSessionId, stopTestDrive } from "./testDrive";

const ground = (sessionId: string) => ({
  sessionId,
  kind: "ground",
  status: "active",
  payload: { startPackage: { mode: "driving" } },
});
const repository = (session: unknown) =>
  ({ loadActive: jest.fn(async () => session) }) as unknown as SessionRepository;
const geometry: [number, number][] = [
  [13.41, 52.52],
  [13.38, 52.52],
];

beforeEach(() => {
  mockStart.mockClear();
  mockSetDebug.mockClear();
});

it("gives a trip the replay never drove its real location back", async () => {
  // A simulated start failed; the earlier trip is still active and lost its location.
  const repo = repository(ground("earlier"));
  await prepareAutoDrive(geometry, {} as NavigationCoordinator, repo);
  await stopTestDrive(repo);
  expect(mockSetDebug).toHaveBeenLastCalledWith(null, { hostAutoDrive: true });
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(simulatedSessionId()).toBeNull();
});

it("does not restart real location when no trip remains", async () => {
  const repo = repository(null);
  await prepareAutoDrive(geometry, {} as NavigationCoordinator, repo);
  await stopTestDrive(repo);
  expect(mockStart).not.toHaveBeenCalled();
});
