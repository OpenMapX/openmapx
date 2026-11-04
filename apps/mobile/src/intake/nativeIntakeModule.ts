import {
  INTAKE_CHUNK_BYTES,
  INTAKE_ERROR_CODES,
  type IntakeChunk,
  type IntakeErrorCode,
  type IntakeItem,
  intakeChunkSchema,
  intakeIdSchema,
  intakeItemSchema,
  MAX_INTAKE_FILE_BYTES,
} from "@openmapx/core/navigation";
import { requireOptionalNativeModule } from "expo";
import { z } from "zod";

interface NativeIntake {
  isAvailableAsync(): Promise<boolean>;
  listAsync(): Promise<unknown>;
  readChunkAsync(id: string, offset: number): Promise<unknown>;
  completeAsync(id: string): Promise<unknown>;
  addListener(name: "onInboxChanged", listener: () => void): { remove(): void };
}
export class NativeIntakeError extends Error {
  constructor(readonly code: IntakeErrorCode) {
    super(code);
  }
}
export interface NativeIntakePort {
  available(): Promise<boolean>;
  list(): Promise<IntakeItem[]>;
  read(id: string, offset: number): Promise<IntakeChunk>;
  complete(id: string): Promise<void>;
  listen(listener: () => void): () => void;
}
export function createNativeIntakePort(): NativeIntakePort {
  let native: NativeIntake | null;
  try {
    native = requireOptionalNativeModule<NativeIntake>("OpenMapXIntake");
  } catch {
    native = null;
  }
  async function invoke(work: (module: NativeIntake) => Promise<unknown>): Promise<unknown> {
    if (!native) throw new NativeIntakeError("unavailable");
    let result: unknown;
    try {
      result = await work(native);
    } catch {
      throw new NativeIntakeError("unavailable");
    }
    if (result && typeof result === "object" && "errorCode" in result) {
      const code = (result as { errorCode?: unknown }).errorCode;
      throw new NativeIntakeError(
        typeof code === "string" && (INTAKE_ERROR_CODES as readonly string[]).includes(code)
          ? (code as IntakeErrorCode)
          : "unavailable",
      );
    }
    return result;
  }
  function validId(id: string): void {
    if (!intakeIdSchema.safeParse(id).success) throw new NativeIntakeError("invalid-data");
  }
  return {
    async available() {
      try {
        return Boolean(await native?.isAvailableAsync());
      } catch {
        return false;
      }
    },
    async list() {
      const parsed = z
        .object({ items: z.array(intakeItemSchema).max(10) })
        .strict()
        .safeParse(await invoke((m) => m.listAsync()));
      if (!parsed.success) throw new NativeIntakeError("invalid-data");
      return parsed.data.items;
    },
    async read(id, offset) {
      validId(id);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > MAX_INTAKE_FILE_BYTES ||
        offset % INTAKE_CHUNK_BYTES !== 0
      )
        throw new NativeIntakeError("invalid-data");
      const parsed = intakeChunkSchema.safeParse(await invoke((m) => m.readChunkAsync(id, offset)));
      if (!parsed.success || parsed.data.id !== id || parsed.data.offset !== offset)
        throw new NativeIntakeError("invalid-data");
      return parsed.data;
    },
    async complete(id) {
      validId(id);
      const result = await invoke((m) => m.completeAsync(id));
      if (
        !z
          .object({ ok: z.literal(true) })
          .strict()
          .safeParse(result).success
      )
        throw new NativeIntakeError("invalid-data");
    },
    listen(listener) {
      if (!native) return () => undefined;
      try {
        const subscription = native.addListener("onInboxChanged", listener);
        return () => subscription.remove();
      } catch {
        return () => undefined;
      }
    },
  };
}
