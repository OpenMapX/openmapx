import type {
  CategoryCardEnrichmentRequest,
  CategoryCardEnrichmentResponse,
  CategoryPlace,
} from "@openmapx/core";
import {
  apiClient,
  isApiClientError,
  isApiRequestAbortedError,
  useCategorySearchStore,
} from "@openmapx/core";
import { type RefObject, useEffect, useRef, useState } from "react";

type CardInput = CategoryCardEnrichmentRequest["places"][number];
type CardSummary = CategoryCardEnrichmentResponse["results"][number];
type CardField = NonNullable<CardInput["fields"]>[number];
type CardFieldState = { attempts: number; settled: boolean; terminal: boolean; retryAt: number };
type CachedCardSummary = { summary: CardSummary; expiresAt: number };
const CARD_FIELDS: readonly CardField[] = ["photo", "rating"];
const CARD_CACHE_TTL_MS = 600_000;
const CARD_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHED_CARDS = 256;
const PHOTO_TAG_KEYS = [
  "image",
  "image:0",
  "image:1",
  "wikimedia_commons",
  "wikidata",
  "wikipedia",
] as const;
const WIKIPEDIA_LANGUAGE_RE = /^[a-z]{2,12}(?:-[a-z0-9]{1,12})*$/i;

function validWikipediaTag(tag: string): boolean {
  const colon = tag.indexOf(":");
  if (colon < 0) return true;
  const language = tag.slice(0, colon);
  return (
    language.length <= 32 &&
    WIKIPEDIA_LANGUAGE_RE.test(language) &&
    Boolean(tag.slice(colon + 1).trim())
  );
}

function validCardImageTag(value: string): boolean {
  if (value.startsWith("File:")) return Boolean(value.slice(5).trim());
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function cardInput(place: CategoryPlace): CardInput {
  const photoTags: NonNullable<CardInput["photoTags"]> = {};
  for (const key of PHOTO_TAG_KEYS) {
    const value = place.osmTags?.[key]?.trim();
    if (!value || value.length > (key.startsWith("image") ? 4096 : 512)) continue;
    if (key.startsWith("image") && !validCardImageTag(value)) continue;
    if (key === "wikidata" && !/^Q[1-9]\d*$/.test(value)) continue;
    if (key === "wikimedia_commons" && !/^(?:File|Category):\S/.test(value)) continue;
    if (key === "wikipedia" && !validWikipediaTag(value)) continue;
    photoTags[key] = value;
  }
  return { id: place.id, name: place.name, coordinates: place.coordinates, photoTags };
}

function cardIdentity(place: CategoryPlace, lang: string): string {
  return JSON.stringify([cardInput(place), lang]);
}

export function cachedSummary(
  cache: Map<string, CachedCardSummary>,
  place: CategoryPlace,
  lang: string,
): CardSummary | undefined {
  const entry = cache.get(cardIdentity(place, lang));
  return entry && entry.expiresAt > Date.now() ? entry.summary : undefined;
}

function cardFailureDelay(error: unknown): number | null {
  if (isApiRequestAbortedError(error)) return error.code === "timeout" ? 0 : null;
  if (isApiClientError(error)) {
    if (![408, 429, 502, 503, 504].includes(error.status)) return null;
    return (error.retryAfterSeconds ?? 0) * 1_000;
  }
  return error instanceof TypeError ? 0 : null;
}

export function useCardEnrichment({
  results,
  locale,
  searchRevision,
  activeCategory,
  isTransitCategory,
  scrollRef,
}: {
  results: CategoryPlace[] | undefined;
  locale: string;
  searchRevision: number;
  activeCategory: string | null;
  isTransitCategory: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}): Map<string, CachedCardSummary> {
  const cardCache = useRef(new Map<string, CachedCardSummary>());
  const cardRequestState = useRef({
    context: "",
    fields: new Map<string, CardFieldState>(),
  });
  const [cardSummaries, setCardSummaries] = useState<Map<string, CachedCardSummary>>(
    () => new Map(),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollRef is stable and the DOM node is read after commit.
  useEffect(() => {
    const root = scrollRef.current;
    if (
      !root ||
      isTransitCategory ||
      !results?.length ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const context = JSON.stringify([searchRevision, locale, activeCategory]);
    if (cardRequestState.current.context !== context) {
      cardRequestState.current = { context, fields: new Map() };
    }
    const fieldStates = cardRequestState.current.fields;
    const byId = new Map(results.map((place) => [place.id, place]));
    const visible = new Set<string>();
    let alive = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeRequest: {
      controller: AbortController;
      selections: Array<{ place: CategoryPlace; fields: CardField[] }>;
    } | null = null;

    const fieldState = (place: CategoryPlace, field: CardField): CardFieldState => {
      const identity = cardIdentity(place, locale);
      const key = JSON.stringify([identity, field]);
      let state = fieldStates.get(key);
      if (!state) {
        const cached = cardCache.current.get(identity);
        const valid = cached && cached.expiresAt > Date.now();
        state = {
          attempts: 0,
          settled: Boolean(valid && (!cached.summary.outcomes || cached.summary.outcomes[field])),
          terminal: false,
          retryAt: 0,
        };
        fieldStates.set(key, state);
      }
      return state;
    };

    const eligible = (place: CategoryPlace, field: CardField, now: number) => {
      const state = fieldState(place, field);
      return !state.settled && state.attempts < 2 && state.retryAt <= now;
    };

    const ready = () => navigator.onLine !== false && document.visibilityState !== "hidden";

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!alive || loading || !ready()) return;
      let nextAt = Number.POSITIVE_INFINITY;
      const now = Date.now();
      for (const id of visible) {
        const place = byId.get(id);
        if (!place) continue;
        for (const field of CARD_FIELDS) {
          const state = fieldState(place, field);
          if (!state.settled && state.attempts < 2) nextAt = Math.min(nextAt, state.retryAt);
        }
      }
      if (Number.isFinite(nextAt)) {
        timer = setTimeout(
          () => {
            timer = null;
            void flush();
          },
          Math.min(2_147_483_647, Math.max(40, nextAt - now)),
        );
      }
    };

    const cancelActive = () => {
      if (!activeRequest) return;
      activeRequest.controller.abort();
      activeRequest = null;
      loading = false;
    };

    const flush = async () => {
      if (!alive || loading || !ready()) return;
      const now = Date.now();
      const selections = [...visible]
        .map((id) => byId.get(id))
        .filter((place): place is CategoryPlace => Boolean(place))
        .map((place) => ({
          place,
          fields: CARD_FIELDS.filter((field) => eligible(place, field, now)),
        }))
        .filter(({ fields }) => fields.length > 0)
        .slice(0, 8);
      if (selections.length === 0) {
        schedule();
        return;
      }
      for (const { place, fields } of selections) {
        for (const field of fields) fieldState(place, field).attempts += 1;
      }
      const controller = new AbortController();
      activeRequest = { controller, selections };
      loading = true;
      try {
        const response = await apiClient.post<CategoryCardEnrichmentResponse>(
          "/api/places/card-enrichment",
          {
            places: selections.map(({ place, fields }) => ({ ...cardInput(place), fields })),
            lang: locale,
          } satisfies CategoryCardEnrichmentRequest,
          { signal: controller.signal, timeoutMs: CARD_REQUEST_TIMEOUT_MS },
        );
        if (
          !alive ||
          controller.signal.aborted ||
          useCategorySearchStore.getState().searchRevision !== searchRevision
        )
          return;
        const returned = new Map(response.results.map((summary) => [summary.id, summary]));
        let cacheChanged = false;
        for (const { place, fields } of selections) {
          const key = cardIdentity(place, locale);
          const received = returned.get(place.id);
          const old = cardCache.current.get(key)?.summary;
          const summary: CardSummary = {
            ...old,
            id: place.id,
            ...(received?.photo ? { photo: received.photo } : {}),
            ...(received?.rating ? { rating: received.rating } : {}),
            outcomes: { ...old?.outcomes },
          };
          let hasSettled = false;
          for (const field of fields) {
            const state = fieldState(place, field);
            const outcome = received?.outcomes?.[field];
            if (
              received &&
              (!received.outcomes ||
                outcome?.status === "available" ||
                outcome?.status === "absent")
            ) {
              state.settled = true;
              summary.outcomes = {
                ...summary.outcomes,
                [field]: outcome ?? { status: received[field] ? "available" : "absent" },
              };
              hasSettled = true;
            } else if (
              outcome?.status === "failed" &&
              outcome.retryAfterMs !== undefined &&
              state.attempts < 2
            ) {
              state.retryAt =
                Date.now() +
                Math.max(2_000 + Math.floor(Math.random() * 501), outcome.retryAfterMs);
            } else if (!received && state.attempts < 2) {
              state.retryAt = Date.now() + 2_000 + Math.floor(Math.random() * 501);
            } else {
              state.settled = true;
              state.terminal = true;
            }
          }
          if (hasSettled) {
            cardCache.current.delete(key);
            cardCache.current.set(key, { summary, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
            cacheChanged = true;
          }
          while (cardCache.current.size > MAX_CACHED_CARDS) {
            const oldest = cardCache.current.keys().next().value;
            if (oldest === undefined) break;
            cardCache.current.delete(oldest);
          }
        }
        if (cacheChanged) setCardSummaries(new Map(cardCache.current));
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        const retryAfterMs = cardFailureDelay(error);
        for (const { place, fields } of selections) {
          for (const field of fields) {
            const state = fieldState(place, field);
            if (retryAfterMs !== null && state.attempts < 2) {
              state.retryAt =
                Date.now() + Math.max(2_000 + Math.floor(Math.random() * 501), retryAfterMs);
            } else {
              state.settled = true;
              state.terminal = true;
            }
          }
        }
      } finally {
        if (activeRequest?.controller === controller) {
          activeRequest = null;
          loading = false;
          if (alive) schedule();
        }
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.cardId;
          const place = id ? byId.get(id) : undefined;
          if (!place) continue;
          const bounds = entry.boundingClientRect ?? entry.target.getBoundingClientRect();
          const nearViewport =
            bounds.bottom >= -120 &&
            bounds.top <= window.innerHeight + 120 &&
            bounds.right >= -120 &&
            bounds.left <= window.innerWidth + 120;
          if (entry.isIntersecting && nearViewport) {
            visible.add(id as string);
            const identity = cardIdentity(place, locale);
            const cached = cardCache.current.get(identity);
            if (cached && cached.expiresAt <= Date.now()) {
              cardCache.current.delete(identity);
              for (const field of CARD_FIELDS) {
                const state = fieldState(place, field);
                if (state.settled && !state.terminal) {
                  state.settled = false;
                  state.attempts = 0;
                  state.retryAt = 0;
                }
              }
            }
          } else {
            visible.delete(id as string);
          }
        }
        schedule();
      },
      { root: null, rootMargin: "120px 0px" },
    );
    root.querySelectorAll<HTMLElement>("[data-card-id]").forEach((row) => {
      observer.observe(row);
    });
    const onAvailability = () => {
      schedule();
    };
    window.addEventListener("online", onAvailability);
    window.addEventListener("offline", onAvailability);
    document.addEventListener("visibilitychange", onAvailability);
    return () => {
      alive = false;
      cancelActive();
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", onAvailability);
      window.removeEventListener("offline", onAvailability);
      document.removeEventListener("visibilitychange", onAvailability);
    };
  }, [results, searchRevision, isTransitCategory, locale, activeCategory]);
  return cardSummaries;
}
