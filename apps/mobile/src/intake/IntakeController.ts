import type {
  NativeToWebPayload,
  NativeToWebType,
  WebToNativeMessage,
} from "@openmapx/core/navigation";
import { NativeIntakeError, type NativeIntakePort } from "./nativeIntakeModule";

interface Dependencies {
  port: NativeIntakePort;
  currentNonce(): string | undefined;
  send<T extends NativeToWebType>(
    type: T,
    payload: NativeToWebPayload<T>,
    options: { forMessageId: string },
  ): unknown;
  canApply(): Promise<boolean>;
  scheme: string;
}
/** The bridge has already authenticated commands. Every async reply is fenced to its document. */
export class IntakeController {
  constructor(private readonly deps: Dependencies) {}
  async dispatch(message: WebToNativeMessage): Promise<void> {
    const current = () => this.deps.currentNonce() === message.channelNonce;
    if (!current()) return;
    const reply = <T extends NativeToWebType>(type: T, payload: NativeToWebPayload<T>) => {
      if (current()) this.deps.send(type, payload, { forMessageId: message.messageId });
    };
    try {
      switch (message.type) {
        case "intake.list": {
          const items = await this.deps.port.list();
          const canApply = items.length > 0 ? await this.deps.canApply() : false;
          reply("intake.items", { items, canApply, scheme: this.deps.scheme });
          break;
        }
        case "intake.read":
          reply("intake.chunk", {
            ...(await this.deps.port.read(message.payload.id, message.payload.offset)),
          });
          break;
        case "intake.complete":
          if (message.payload.disposition === "opened" && !(await this.deps.canApply())) {
            reply("native.error", { code: "navigation-active" });
            break;
          }
          if (!current()) return;
          await this.deps.port.complete(message.payload.id);
          reply("intake.completed", { id: message.payload.id });
          break;
      }
    } catch (error) {
      reply("native.error", {
        code: error instanceof NativeIntakeError ? error.code : "unavailable",
      });
    }
  }
}
