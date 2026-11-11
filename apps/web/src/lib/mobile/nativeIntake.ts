import {
  INTAKE_CHUNK_BYTES,
  INTAKE_ERROR_CODES,
  type IntakeItem,
  intakeChunkSchema,
  intakeItemSchema,
  intakeListingSchema,
  type NativeToWebMessage,
} from "@openmapx/core/navigation";
import { type BridgeClient, NativeCommandError } from "./bridgeClient";
export class IntakeTransferError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** A shell refusal carries the intake reason; anything else is unavailability. */
async function intakeRequest(
  client: Pick<BridgeClient, "request">,
  ...args: Parameters<BridgeClient["request"]>
): Promise<NativeToWebMessage> {
  try {
    return await client.request(...args);
  } catch (error) {
    if (!(error instanceof NativeCommandError)) throw error;
    const code = error.code;
    throw new IntakeTransferError(
      (INTAKE_ERROR_CODES as readonly string[]).includes(code) ||
        code === "navigation-active" ||
        code === "navigation-unavailable"
        ? code
        : "unavailable",
    );
  }
}
export class NativeIntakeClient {
  constructor(private readonly client: Pick<BridgeClient, "request">) {}
  async list() {
    const reply = await intakeRequest(this.client, "intake.list", {});
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
      const reply = await intakeRequest(
        this.client,
        "intake.read",
        { id: item.id, offset },
        { timeoutMs: Math.min(5000, deadline - Date.now()) },
      );
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
    const reply = await intakeRequest(this.client, "intake.complete", { id, disposition });
    if (reply.type !== "intake.completed" || reply.payload.id !== id)
      throw new IntakeTransferError("unavailable");
  }
}
