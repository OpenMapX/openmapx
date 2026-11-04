import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { SessionRepository } from "../storage/SessionRepository";

/** Host stop enters the same serial executor as phone commands and GPS batches. */
export class CarSessionAdapter {
  constructor(
    private readonly coordinator: NavigationCoordinator,
    private readonly repository: SessionRepository,
    private readonly now = Date.now,
  ) {}
  async stop(): Promise<void> {
    const session = await this.repository.loadActive(this.now());
    await this.coordinator.dispatch({
      protocolVersion: 3,
      type: "session.stop",
      messageId: `car-stop-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      channelNonce: "car-native",
      sentAtMs: this.now(),
      payload: {},
      ...(session ? { sessionId: session.sessionId } : {}),
    });
  }
}
