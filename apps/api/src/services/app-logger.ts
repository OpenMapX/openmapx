import { Writable } from "node:stream";
import { db } from "../db/index";
import { appLog } from "../db/schema";
import { sanitizeLogMetadata, sanitizeLogString } from "../utils/safe-log-fields.js";

export interface AppLogEntry {
  id: number;
  level: string;
  source: string;
  msg: string;
  time: number;
  metadata?: Record<string, unknown>;
}

const LEVEL_MAP: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const PERSIST_LEVELS = new Set(["warn", "error", "fatal"]);

const OMIT_KEYS = new Set([
  "level",
  "msg",
  "time",
  "name",
  "hostname",
  "pid",
  "reqId",
  "req",
  "res",
  "responseTime",
]);

export interface AppLoggerOptions {
  maxSize?: number;
  persist?: (entry: AppLogEntry) => Promise<void>;
}

async function persistAppLog(entry: AppLogEntry): Promise<void> {
  await db.insert(appLog).values({
    level: entry.level,
    source: entry.source,
    msg: entry.msg,
    metadata: entry.metadata ?? null,
  });
}

function sanitizeEntry(entry: AppLogEntry): AppLogEntry {
  return {
    id: entry.id,
    level: sanitizeLogString(entry.level),
    source: sanitizeLogString(entry.source),
    msg: sanitizeLogString(entry.msg),
    time: Number.isFinite(entry.time) ? entry.time : Date.now(),
    ...(entry.metadata === undefined ? {} : { metadata: sanitizeLogMetadata(entry.metadata) }),
  };
}

export class AppLogger {
  private buffer: AppLogEntry[] = [];
  private readonly maxSize: number;
  private readonly persistAdapter: (entry: AppLogEntry) => Promise<void>;
  private nextId = 1;

  constructor(options: AppLoggerOptions = {}) {
    this.maxSize = options.maxSize ?? 10_000;
    this.persistAdapter = options.persist ?? persistAppLog;
  }

  add(entry: Omit<AppLogEntry, "id">) {
    const full = sanitizeEntry({ ...entry, id: this.nextId++ });
    this.buffer.push(full);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    if (PERSIST_LEVELS.has(entry.level)) {
      this.persist(full).catch(() => {});
    }
  }

  private async persist(entry: AppLogEntry) {
    try {
      // Re-sanitize at the adapter boundary so later buffer readers cannot
      // mutate a retained entry into a persistence bypass.
      await this.persistAdapter(sanitizeEntry(entry));
    } catch {
      // silently fail — DB may not be available during startup
    }
  }

  getEntries(opts: {
    level?: string;
    source?: string;
    search?: string;
    since?: number;
    limit?: number;
    offset?: number;
  }): { entries: AppLogEntry[]; total: number } {
    let filtered = this.buffer;

    if (opts.level && opts.level !== "all") {
      const lvl = opts.level.toLowerCase();
      const ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];
      const minIdx = ORDER.indexOf(lvl);
      if (minIdx >= 0) {
        filtered = filtered.filter((e) => ORDER.indexOf(e.level) >= minIdx);
      }
    }

    if (opts.source && opts.source !== "all") {
      filtered = filtered.filter((e) => e.source === opts.source);
    }

    if (opts.since) {
      const since = opts.since;
      filtered = filtered.filter((e) => e.time >= since);
    }

    if (opts.search) {
      const q = opts.search.toLowerCase();
      filtered = filtered.filter(
        (e) => e.msg.toLowerCase().includes(q) || e.source.toLowerCase().includes(q),
      );
    }

    const total = filtered.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const reversed = [...filtered].reverse();
    const entries = reversed.slice(offset, offset + limit);

    return { entries, total };
  }

  getSources(): string[] {
    const seen = new Set<string>();
    for (const e of this.buffer) seen.add(e.source);
    return Array.from(seen).sort();
  }

  createPinoStream(): Writable {
    const self = this;
    return new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void) {
        try {
          const raw = chunk.toString().trim();
          if (!raw) {
            callback();
            return;
          }
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const levelNum = typeof parsed.level === "number" ? parsed.level : 30;
          const level = LEVEL_MAP[levelNum] ?? "info";
          const source = typeof parsed.name === "string" ? parsed.name : "platform";
          const msg = typeof parsed.msg === "string" ? parsed.msg : "";
          const time = typeof parsed.time === "number" ? parsed.time : Date.now();

          const metadata = Object.create(null) as Record<string, unknown>;
          for (const [k, v] of Object.entries(parsed)) {
            if (!OMIT_KEYS.has(k)) metadata[k] = v;
          }

          self.add({
            level,
            source,
            msg,
            time,
            metadata: Object.keys(metadata).length ? metadata : undefined,
          });
        } catch {
          // ignore parse errors
        }
        callback();
      },
    });
  }
}

export const appLogger = new AppLogger();
