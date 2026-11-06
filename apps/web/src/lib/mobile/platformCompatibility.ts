import type { WebToNativeMessage } from "@openmapx/core/navigation";

/** Installed v3/v4 shells validate capture stops strictly. */
export function platformCompatibleCommand(message: WebToNativeMessage): WebToNativeMessage {
  if (
    message.protocolVersion >= 5 ||
    (message.type !== "session.prepare" && message.type !== "session.replace")
  )
    return message;
  const pkg = message.payload.startPackage;
  if (pkg.kind !== "transit") return message;
  return {
    ...message,
    payload: {
      ...message.payload,
      startPackage: {
        ...pkg,
        captures: pkg.captures.map((capture) => ({
          ...capture,
          stops: capture.stops.map((stop) => {
            const { arrivalPlatform: _arrival, departurePlatform: _departure, ...legacy } = stop;
            return legacy;
          }),
        })),
      },
    },
  } as WebToNativeMessage;
}
