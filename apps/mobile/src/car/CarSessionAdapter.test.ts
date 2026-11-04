import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { SessionRepository } from "../storage/SessionRepository";
import { CarSessionAdapter } from "./CarSessionAdapter";

it("sends host stop through coordinator dispatch with the active identity", async () => {
  const dispatch = jest.fn(async () => null);
  const adapter = new CarSessionAdapter(
    { dispatch } as unknown as NavigationCoordinator,
    { loadActive: async () => ({ sessionId: "trip" }) } as unknown as SessionRepository,
    () => 1234,
  );
  await adapter.stop();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "session.stop",
      sessionId: "trip",
      sentAtMs: 1234,
      payload: {},
    }),
  );
});
