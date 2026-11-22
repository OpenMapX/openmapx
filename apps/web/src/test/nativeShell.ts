import { MOBILE_PROTOCOL_MAX, MOBILE_PROTOCOL_MIN } from "@openmapx/core/navigation";
import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";

export const NATIVE_SHELL_HELLO_PAYLOAD = {
  shellVersion: "1.0.0",
  shellBuild: "1",
  selectedProtocolVersion: MOBILE_PROTOCOL_MAX,
  minProtocolVersion: MOBILE_PROTOCOL_MIN,
  maxProtocolVersion: MOBILE_PROTOCOL_MAX,
  platform: "ios",
  capabilities: {
    groundNavigation: true,
    transitNavigation: true,
    backgroundLocation: true,
    localNotifications: true,
    speech: true,
  },
  permission: "background",
  locationDriver: "expo",
  activeSession: null,
};

function nativeReplyType(type: string): string {
  switch (type) {
    case "web.hello":
      return "native.hello";
    case "session.prepare":
      return "session.prepared";
    case "session.start":
      return "session.started";
    default:
      return "snapshot.update";
  }
}

export interface SentNativeMessage {
  type: string;
  payload: unknown;
}

/**
 * Builds a fake WebView host scope for `MobileRuntimeProvider` tests so tests
 * inspect what crosses the real bridge without faking the provider itself.
 */
export function createNativeShellScope(
  reply: (type: string) => unknown | Promise<unknown>,
  nonce = "nonce-abc",
) {
  const sent: SentNativeMessage[] = [];
  const handlers = new Map<string, (event: Event) => void>();

  const scope: Record<string, unknown> = {
    __OPENMAPX_MOBILE_CHANNEL__: { nonce },
    addEventListener: (type: string, handler: (event: Event) => void) => {
      handlers.set(type, handler);
    },
    removeEventListener: (type: string) => handlers.delete(type),
    ReactNativeWebView: {
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        sent.push({ type: message.type, payload: message.payload });
        void Promise.resolve(reply(message.type)).then((payload) => {
          if (payload === undefined) return;
          const isNativeError =
            typeof payload === "object" &&
            payload !== null &&
            "nativeError" in payload &&
            typeof (payload as { nativeError: unknown }).nativeError === "string";
          const detailType = isNativeError ? "native.error" : nativeReplyType(message.type);
          const detailPayload = isNativeError
            ? {
                code: (payload as { nativeError: string }).nativeError,
                forMessageId: message.messageId,
              }
            : { ...(payload as Record<string, unknown>), forMessageId: message.messageId };
          handlers.get("openmapx:native")?.({
            detail: {
              protocolVersion: MOBILE_PROTOCOL_MAX,
              type: detailType,
              // The envelope schema is strict, so a reply carrying a field it
              // does not name is dropped rather than delivered.
              messageId: `n-${sent.length}`,
              channelNonce: nonce,
              sentAtMs: 1_700_000_000_000,
              payload: detailPayload,
            },
          } as unknown as Event);
        });
      },
    },
  };

  return { scope, sent };
}

/**
 * Waits until the shell's hello has been answered and applied.
 *
 * The reply arrives on a microtask after `postMessage`, so a click issued the
 * moment the hello was *sent* would land while the runtime is still negotiating.
 */
export async function waitForNativeShellNegotiated(sent: readonly { type: string }[]) {
  await waitFor(() => expect(sent.some((message) => message.type === "web.hello")).toBe(true));
  await act(async () => {
    await Promise.resolve();
  });
}

export function nativeSessionMessageTypes(sent: readonly { type: string }[]): string[] {
  return sent.map((message) => message.type).filter((type) => type.startsWith("session."));
}
