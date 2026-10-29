import {
  API_ENDPOINTS,
  apiClient,
  isApiClientError,
  type RoadConditionBinding,
  type RoadConditionBindingDetail,
  type RoadConditionEvent,
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
  event: Pick<RoadConditionEvent, "id" | "provider">,
  now: number,
): Promise<RoadConditionBindingDetail | null> {
  const key = `${event.provider}\u0000${event.id}`;
  const cached = read.get(key);
  if (cached && now - cached.at < BINDING_TTL_MS) return cached.detail;
  try {
    const detail = parseBindingDetail(
      await apiClient.get<unknown>(API_ENDPOINTS.roadConditionBindings, {
        provider: event.provider,
        id: event.id,
      }),
    );
    read.set(key, { at: now, detail });
    return detail;
  } catch (error) {
    // A situation without bindings is an answer; a failed read is retried next time.
    if (isApiClientError(error) && error.status === 404) read.set(key, { at: now, detail: null });
    return null;
  }
}

/**
 * The graph bindings of the situations a popup shows, by situation id. A
 * situation whose bindings could not be read is left out: its card keeps
 * what its routing evidence says.
 */
export async function loadRoadConditionBindings(
  events: readonly Pick<RoadConditionEvent, "id" | "provider">[],
  now = Date.now(),
): Promise<Map<string, RoadConditionBindingDetail>> {
  const asked = events.filter((event) => event.provider).slice(0, MAX_BINDING_READS);
  const answers = await Promise.all(asked.map((event) => readBindings(event, now)));
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
