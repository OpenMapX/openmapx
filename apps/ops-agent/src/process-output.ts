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
const CREDENTIAL_KEYS = new Set([
  "authorization",
  "apikey",
  "api-key",
  "api_key",
  "access-token",
  "access_token",
  "token",
  "secret",
  "password",
  "passwd",
  "auth",
  "key",
]);
interface CredentialScan {
  phase: "word" | "key" | "value" | "bare" | "quote";
  word: string;
  quote: string;
  escaped: boolean;
}
function scanCredential(scan: CredentialScan, character: string): void {
  if (scan.phase === "quote") {
    if (scan.escaped) scan.escaped = false;
    else if (character === "\\") scan.escaped = true;
    else if (character === scan.quote) scan.phase = "word";
    return;
  }
  if (scan.phase === "bare") {
    if (/[\s'"&,;)\]}]/.test(character)) scan.phase = "word";
    else return;
  }
  if (scan.phase === "value") {
    if (/\s/.test(character)) return;
    if (character === '"' || character === "'") {
      scan.phase = "quote";
      scan.quote = character;
      scan.escaped = false;
    } else scan.phase = "bare";
    return;
  }
  if (scan.phase === "key") {
    if (/\s/.test(character)) return;
    scan.phase = character === ":" || character === "=" ? "value" : "word";
    if (scan.phase === "value") return;
  }
  if (/[\w-]/.test(character)) {
    scan.word = (scan.word + character.toLowerCase()).slice(-32);
    return;
  }
  const key = CREDENTIAL_KEYS.has(scan.word.replace(/^--/, ""));
  scan.word = "";
  if (key && (character === ":" || character === "=")) scan.phase = "value";
  else if (key && /\s/.test(character)) scan.phase = "key";
}

// Normalize before both state tracking and projection, including split ANSI sequences.
function controlFree(state: { control: string }, character: string): string {
  if (state.control === "osc" || state.control === "string") {
    if (character === "\x07" || character === "\x9c") state.control = "";
    else if (character === "\x1b") state.control += "-escape";
    return "";
  }
  if (state.control.endsWith("-escape")) {
    state.control = character === "\\" ? "" : state.control.replace("-escape", "");
    return "";
  }
  if (state.control === "escape") {
    state.control =
      character === "["
        ? "csi"
        : character === "]"
          ? "osc"
          : ["P", "^", "_"].includes(character)
            ? "string"
            : character >= " " && character <= "/"
              ? "escape-intermediate"
              : "";
    return "";
  }
  if (state.control === "escape-intermediate") {
    if (character < " " || character > "/") state.control = "";
    return "";
  }
  if (state.control === "csi") {
    if (character >= "@" && character <= "~") state.control = "";
    if (character !== "\n" && character !== "\r") return "";
    state.control = "";
  }
  const code = character.codePointAt(0) ?? 0;
  if (code === 27) {
    state.control = "escape";
    return "";
  }
  if (code === 155) {
    state.control = "csi";
    return "";
  }
  if ([144, 152, 158, 159].includes(code)) {
    state.control = "string";
    return "";
  }
  if (code === 157) {
    state.control = "osc";
    return "";
  }
  if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159)) return "";
  return character;
}
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
  const streamState = () => ({
    decoder: new StringDecoder("utf8"),
    text: "",
    bytes: 0,
    dropping: false,
    protected: false,
    cr: false,
    control: "",
    scan: { phase: "word", word: "", quote: "", escaped: false } as CredentialScan,
  });
  const streams = { stdout: streamState(), stderr: streamState() };
  const tail: ProcessDiagnostics["tail"] = [];
  let truncated = false;
  let detached = false;
  let ended = false;
  // Bound serialized storage as well as payload bytes, including tiny-line floods.
  let retainedBytes = 0;
  const streamBytes = { stdout: 0, stderr: 0 };
  const emit = (stream: Stream) => {
    const state = streams[stream];
    const raw = state.text;
    if (raw) {
      let message: string;
      try {
        message = safeProcessDiagnostic(
          options.redact(safeProcessDiagnostic(state.protected ? "[redacted]" : raw)),
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
    state.text = "";
    state.bytes = 0;
  };
  const consume = (stream: Stream, text: string) => {
    const state = streams[stream];
    for (const decoded of text) {
      const character = controlFree(state, decoded);
      if (!character) continue;
      const progressSecret = character === "\r" && state.scan.phase === "bare";
      scanCredential(state.scan, character);
      if (character === "\n" || character === "\r") {
        if (!(character === "\n" && state.cr)) {
          if (!state.dropping) emit(stream);
          else {
            state.text = "";
            state.bytes = 0;
          }
          state.protected =
            state.scan.phase === "quote" ||
            state.scan.phase === "value" ||
            state.scan.phase === "key" ||
            progressSecret;
          state.dropping = false;
        }
        state.cr = character === "\r";
        continue;
      }
      state.cr = false;
      if (state.dropping) continue;
      const size = Buffer.byteLength(character);
      if (state.bytes + size > 4096) {
        // A valid-looking URL prefix can still be userinfo. Never publish an artificial frame.
        state.text = "";
        state.bytes = 0;
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
        if (truncated && !detached) {
          try {
            options.onLine("stderr", PROCESS_OUTPUT_TRUNCATED);
          } catch {
            detached = true;
          }
        }
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
