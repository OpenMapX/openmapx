import type { WebToNativeMessage } from "@openmapx/core/navigation";
import {
  type BridgePort,
  type CommandResponse,
  sendResponse,
} from "../navigation/NavigationCoordinator";

/**
 * The page's one-shot requests: a location fix, opening OS settings and a
 * system-browser sign-in. None of them is about a navigation session, and each
 * can wait on the user for as long as a prompt or a browser is open, so they
 * are answered beside the navigation queue, never inside it.
 */
const AUXILIARY_COMMANDS = new Set<WebToNativeMessage["type"]>([
  "location.request",
  "settings.open",
  "auth.open",
]);

export function isAuxiliaryCommand(type: WebToNativeMessage["type"]): boolean {
  return AUXILIARY_COMMANDS.has(type);
}

/** Answers an auxiliary command, or declines it with null. */
export type AuxiliaryCommandHandler = (
  command: WebToNativeMessage,
) => Promise<CommandResponse | null>;

/**
 * Turns a handler's answer into a reply on the bridge.
 *
 * A command nothing in this shell handles is refused explicitly.
 */
export async function answerCommand(
  message: WebToNativeMessage,
  handle: AuxiliaryCommandHandler,
  send: BridgePort["send"],
): Promise<void> {
  if (message.type === "web.hello") return;
  const response = await handle(message);
  if (!response) {
    send("native.error", { code: "unsupported-capability" }, { forMessageId: message.messageId });
    return;
  }
  const outcome = sendResponse(send, response, { forMessageId: message.messageId });
  // An answer that fails its schema is refused instead, so the page is not
  // left waiting out its deadline.
  if (outcome === "invalid" && response.type !== "native.error") {
    send("native.error", { code: "internal-error" }, { forMessageId: message.messageId });
  }
}
