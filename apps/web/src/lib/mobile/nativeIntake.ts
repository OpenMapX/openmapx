import {
  INTAKE_CHUNK_BYTES,
  INTAKE_ERROR_CODES,
  type IntakeItem,
  intakeChunkSchema,
  intakeItemSchema,
  intakeListingSchema,
  type NativeToWebMessage,
} from "@openmapx/core/navigation";
import type { BridgeClient } from "./bridgeClient";
export class IntakeTransferError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function rejectNativeError(reply: NativeToWebMessage): void {
  if (reply.type !== "native.error") return;
  const code = reply.payload.code;
  throw new IntakeTransferError(
    (INTAKE_ERROR_CODES as readonly string[]).includes(code) || code === "navigation-active"
      ? code
      : "unavailable",
  );
}
export class NativeIntakeClient {
  constructor(private readonly client: Pick<BridgeClient, "request">) {}
  async list() {
    const reply = await this.client.request("intake.list", {});
    rejectNativeError(reply);
    if (reply.type !== "intake.items") throw new IntakeTransferError("unavailable");
    const { forMessageId: _, ...payload } = reply.payload;
    return intakeListingSchema.parse(payload);
  }
  async text(item: IntakeItem, signal: AbortSignal): Promise<string> {
    item = intakeItemSchema.parse(item);
    if (item.kind === "error") throw new IntakeTransferError(item.errorCode);
    const deadline = Date.now() + 60000;
    const bytes = new Uint8Array(item.byteLength);
    for (let offset = 0; offset < item.byteLength; offset += INTAKE_CHUNK_BYTES) {
      if (signal.aborted || Date.now() >= deadline) throw new IntakeTransferError("unavailable");
      const reply = await this.client.request(
        "intake.read",
        { id: item.id, offset },
        { timeoutMs: Math.min(5000, deadline - Date.now()) },
      );
      rejectNativeError(reply);
      if (signal.aborted || Date.now() >= deadline || reply.type !== "intake.chunk")
        throw new IntakeTransferError("unavailable");
      const { forMessageId: _, ...payload } = reply.payload;
      const chunk = intakeChunkSchema.parse(payload);
      const count = Math.min(INTAKE_CHUNK_BYTES, item.byteLength - offset);
      if (
        chunk.id !== item.id ||
        chunk.offset !== offset ||
        chunk.byteLength !== count ||
        chunk.eof !== (offset + count === item.byteLength)
      )
        throw new IntakeTransferError("invalid-data");
      const decoded = atob(chunk.data);
      if (decoded.length !== count) throw new IntakeTransferError("invalid-data");
      for (let i = 0; i < count; i++) bytes[offset + i] = decoded.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async complete(id: string, disposition: "opened" | "discarded") {
    const reply = await this.client.request("intake.complete", { id, disposition });
    rejectNativeError(reply);
    if (reply.type !== "intake.completed" || reply.payload.id !== id)
      throw new IntakeTransferError("unavailable");
  }
}
