import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { PROCESS_OUTPUT_TRUNCATED, type ProcessDiagnostics } from "@openmapx/core/ops";
import { scrubSecrets } from "@openmapx/core/scrub-secrets";

type Stream = "stdout" | "stderr";
interface OutputOptions {
  onLine(stream: Stream, message: string): void;
  redact: (message: string) => string;
  maxTailBytes?: number;
}
const QUOTED_CREDENTIAL =
  /\b((?:authorization|api[-_]?key|access[-_]?token|token|secret|password|passwd|auth|key)\s*[:=]\s*)(["']).*$/gi;
const QUOTED_CREDENTIAL_START =
  /\b(?:authorization|api[-_]?key|access[-_]?token|token|secret|password|passwd|auth|key)\s*[:=]\s*(["'])/i;
export function safeProcessDiagnostic(message: string): string {
  return scrubSecrets(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostic sanitization intentionally strips C0/C1 controls.
    stripVTControlCharacters(message).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""),
  ).replace(QUOTED_CREDENTIAL, "$1[redacted]");
}

/** Fixed-size framing, incremental decoding and a rolling redacted tail. Never owns termination. */
export function createBoundedProcessOutput(options: OutputOptions): {
  write(stream: Stream, chunk: Uint8Array): void;
  end(): ProcessDiagnostics;
} {
  const maximum = options.maxTailBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 256 || maximum > 16 * 1024)
    throw Error("Invalid diagnostic budget");
  const streams = {
    stdout: {
      decoder: new StringDecoder("utf8"),
      text: "",
      bytes: 0,
      dropping: false,
      sensitive: false,
      credentialQuote: undefined as string | undefined,
      cr: false,
    },
    stderr: {
      decoder: new StringDecoder("utf8"),
      text: "",
      bytes: 0,
      dropping: false,
      sensitive: false,
      credentialQuote: undefined as string | undefined,
      cr: false,
    },
  };
  const tail: ProcessDiagnostics["tail"] = [];
  let truncated = false;
  let detached = false;
  let ended = false;
  // Bound serialized storage as well as payload bytes, including tiny-line floods.
  let retainedBytes = 0;
  const streamBytes = { stdout: 0, stderr: 0 };
  const emit = (stream: Stream, progress = false) => {
    const state = streams[stream];
    const raw = state.text;
    const carriedQuote = state.credentialQuote;
    if (carriedQuote) {
      if (raw.includes(carriedQuote)) state.credentialQuote = undefined;
    } else {
      const start = QUOTED_CREDENTIAL_START.exec(raw);
      if (start && !raw.slice(start.index + start[0].length).includes(start[1] as string))
        state.credentialQuote = start[1];
    }
    const sensitiveNext =
      !!state.credentialQuote ||
      /(?:\b(?:authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s*)?|(?:password|passwd|token|secret|api[-_]?key|access[-_]?token|auth|key)\s*[:=]\s*)|\b(?:https?|ftps?):\/\/[^\s]*|AGE-ENCRYPTED:)$/i.test(
        raw,
      ) ||
      (progress &&
        /(?:authorization|password|passwd|token|secret|api[-_]?key|auth)\s*[:=]\s*\S*$/i.test(raw));
    if (raw) {
      let message: string;
      try {
        message = safeProcessDiagnostic(
          options.redact(
            safeProcessDiagnostic(state.sensitive || carriedQuote ? "[redacted]" : raw),
          ),
        );
      } catch {
        message = "[redacted]";
        detached = true;
        truncated = true;
      }
      // A custom projector can expand text. Bound its returned message as well.
      if (Buffer.byteLength(message) > 4096) {
        message = "[output truncated]";
        truncated = true;
      }
      const entry = { stream, message };
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      tail.push(entry);
      retainedBytes += bytes;
      streamBytes[stream] += bytes;
      while (tail.length > 255 || retainedBytes + 128 > maximum) {
        // A stdout flood must not evict the last stderr diagnostic (and vice versa).
        const evictStream = streamBytes.stdout >= streamBytes.stderr ? "stdout" : "stderr";
        const index = tail.findIndex((entry) => entry.stream === evictStream);
        const [removed] = tail.splice(index, 1);
        if (!removed) break;
        const removedBytes = Buffer.byteLength(JSON.stringify(removed)) + 1;
        retainedBytes -= removedBytes;
        streamBytes[removed.stream] -= removedBytes;
        truncated = true;
      }
      if (!detached) {
        try {
          options.onLine(stream, message);
        } catch {
          detached = true;
          truncated = true;
        }
      }
    }
    state.sensitive = sensitiveNext;
    state.text = "";
    state.bytes = 0;
  };
  const consume = (stream: Stream, text: string) => {
    const state = streams[stream];
    for (const character of text) {
      if (character === "\n" || character === "\r") {
        if (!(character === "\n" && state.cr)) {
          if (!state.dropping) emit(stream, character === "\r");
          else {
            state.text = "";
            state.bytes = 0;
            state.sensitive = !!state.credentialQuote;
          }
          state.dropping = false;
        }
        state.cr = character === "\r";
        continue;
      }
      state.cr = false;
      if (state.dropping) {
        if (character === state.credentialQuote) state.credentialQuote = undefined;
        continue;
      }
      const size = Buffer.byteLength(character);
      if (state.bytes + size > 4096) {
        // Never project an artificial continuation: it may be the middle of a credential.
        emit(stream);
        state.dropping = true;
        truncated = true;
        continue;
      }
      state.text += character;
      state.bytes += size;
    }
  };
  return {
    write(stream, chunk) {
      if (ended) return;
      // Decode bounded slices even when a caller supplies one enormous chunk.
      for (let i = 0; i < chunk.length; i += 4096)
        consume(stream, streams[stream].decoder.write(Buffer.from(chunk.subarray(i, i + 4096))));
    },
    end() {
      if (!ended) {
        for (const stream of ["stdout", "stderr"] as const) {
          consume(stream, streams[stream].decoder.end());
          if (!streams[stream].dropping) emit(stream);
        }
        ended = true;
      }
      return {
        tail: [
          ...(truncated ? [{ stream: "stderr" as const, message: PROCESS_OUTPUT_TRUNCATED }] : []),
          ...tail,
        ],
        truncated,
      };
    },
  };
}
