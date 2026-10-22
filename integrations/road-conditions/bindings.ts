import type {
  RoadConditionBinding,
  RoadConditionBindingDetail,
  RoadConditionEvent,
} from "@openmapx/core";

/** How long a read binding is reused before a popup asks again. */
const BINDING_TTL_MS = 60_000;

/** At most this many situations of one popup have their bindings read. */
const MAX_BINDING_READS = 12;

const read = new Map<string, { at: number; detail: RoadConditionBindingDetail | null }>();

function bindingOf(raw: unknown): RoadConditionBinding | null {
  if (raw === null || typeof raw !== "object") return null;
  const { status, reason } = raw as Record<string, unknown>;
  if (typeof status !== "string" || status.length === 0) return null;
  return { status, reason: typeof reason === "string" && reason.length > 0 ? reason : null };
}

/**
 * A `/bindings` answer, keeping only well-typed bindings; null for anything
 * else, and for an answer without a single binding.
 */
export function parseBindingDetail(raw: unknown): RoadConditionBindingDetail | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { situation, effects } = raw as Record<string, unknown>;
  const effectEntries =
    effects !== null && typeof effects === "object" && !Array.isArray(effects)
      ? Object.entries(effects).flatMap(([id, binding]) => {
          const parsed = bindingOf(binding);
          return parsed ? [[id, parsed] as const] : [];
        })
      : [];
  const own = bindingOf(situation);
  if (!own && effectEntries.length === 0) return null;
  return { situation: own, effects: Object.fromEntries(effectEntries) };
}

async function readBindings(
  apiUrl: string,
  event: Pick<RoadConditionEvent, "id" | "provider">,
  now: number,
): Promise<RoadConditionBindingDetail | null> {
  const key = `${event.provider}\u0000${event.id}`;
  const cached = read.get(key);
  if (cached && now - cached.at < BINDING_TTL_MS) return cached.detail;
  const params = new URLSearchParams({ provider: event.provider, id: event.id });
  const url = `${apiUrl.replace(/\/$/, "")}/api/integrations/road-conditions/bindings?${params.toString()}`;
  try {
    const res = await fetch(url, { credentials: "include" });
    // A situation without bindings is an answer; a failed read is retried next time.
    if (res.status === 404) {
      read.set(key, { at: now, detail: null });
      return null;
    }
    if (!res.ok) return null;
    const detail = parseBindingDetail(await res.json());
    read.set(key, { at: now, detail });
    return detail;
  } catch {
    return null;
  }
}

/**
 * The graph bindings of the situations a popup shows, by situation id. A
 * situation whose bindings could not be read is left out: its card keeps
 * what its routing evidence says.
 */
export async function loadRoadConditionBindings(
  apiUrl: string,
  events: readonly Pick<RoadConditionEvent, "id" | "provider">[],
  now = Date.now(),
): Promise<Map<string, RoadConditionBindingDetail>> {
  const asked = events.filter((event) => event.provider).slice(0, MAX_BINDING_READS);
  const answers = await Promise.all(asked.map((event) => readBindings(apiUrl, event, now)));
  const out = new Map<string, RoadConditionBindingDetail>();
  asked.forEach((event, i) => {
    const detail = answers[i];
    if (detail) out.set(event.id, detail);
  });
  return out;
}

/** Forgets every binding read, so the next popup asks again. */
export function clearRoadConditionBindings(): void {
  read.clear();
}
