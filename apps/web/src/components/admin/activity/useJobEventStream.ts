"use client";

import type { ApiClient } from "@openmapx/core";
import { streamAdminActivityJobEvents } from "@openmapx/core/api-admin-sdk";
import {
  type AdminActivityJobDetail,
  adminJobStreamEventSchemas,
} from "@openmapx/core/api-contracts";
import { useEffect, useReducer } from "react";

export type JobStreamConnection = "connecting" | "live" | "reconnecting" | "polling" | "closed";

export interface JobStreamState {
  data: AdminActivityJobDetail | null;
  connection: JobStreamConnection;
}

const ACTIVE_STATUSES = new Set(["queued", "running"]);
/** Consecutive transport errors without a successful open before giving up. */
const MAX_CONSECUTIVE_ERRORS = 3;
const STREAM_EVENTS = ["snapshot", "status", "progress", "log", "end", "overflow"] as const;

/** Validates before applying an event, including terminal control frames. */
export function reduceJobEvent(
  state: AdminActivityJobDetail | null,
  type: string,
  data: unknown,
): AdminActivityJobDetail | null {
  switch (type) {
    case "snapshot": {
      const parsed = adminJobStreamEventSchemas.snapshot.safeParse(data);
      return parsed.success ? parsed.data.job : state;
    }
    case "log": {
      const parsed = adminJobStreamEventSchemas.log.safeParse(data);
      if (!parsed.success || !state || state.logs.some((log) => log.id === parsed.data.id))
        return state;
      const { type: _, ...log } = parsed.data;
      return {
        ...state,
        logs: [...state.logs, { ...log, jobId: state.id }].sort((a, b) => a.seq - b.seq),
      };
    }
    case "progress": {
      const parsed = adminJobStreamEventSchemas.progress.safeParse(data);
      return parsed.success && state ? { ...state, progress: parsed.data.progress } : state;
    }
    case "status": {
      const parsed = adminJobStreamEventSchemas.status.safeParse(data);
      if (!parsed.success || !state || state.source !== "application") return state;
      const { type: _, ...update } = parsed.data;
      return { ...state, ...update, cancelable: ACTIVE_STATUSES.has(update.status) };
    }
    case "end": {
      const parsed = adminJobStreamEventSchemas.end.safeParse(data);
      return parsed.success && state && state.source === "application"
        ? { ...state, status: parsed.data.status, cancelable: false }
        : state;
    }
    default:
      return state;
  }
}

interface OwnedState extends JobStreamState {
  client: ApiClient;
  jobId: string | null;
}
type Action =
  | { type: "event"; event: string; data: unknown }
  | { type: "connection"; connection: JobStreamConnection }
  | { type: "reset"; client: ApiClient; jobId: string | null }
  | { type: "fallback" };

function reducer(state: OwnedState, action: Action): OwnedState {
  switch (action.type) {
    case "event":
      return { ...state, data: reduceJobEvent(state.data, action.event, action.data) };
    case "connection":
      return { ...state, connection: action.connection };
    case "reset":
      return { client: action.client, jobId: action.jobId, data: null, connection: "connecting" };
    case "fallback":
      // Polling must become authoritative, including after an earlier snapshot.
      return { ...state, data: null, connection: "polling" };
  }
}

/** Browser-owned replay/reconnection; finite JSON request deadlines do not own this stream. */
export function useJobEventStream(client: ApiClient, jobId: string | null): JobStreamState {
  const [state, dispatch] = useReducer(reducer, {
    client,
    jobId,
    data: null,
    connection: "connecting",
  });

  useEffect(() => {
    dispatch({ type: "reset", client, jobId });
    if (!jobId || typeof EventSource === "undefined") {
      dispatch({ type: "fallback" });
      return;
    }

    const controller = new AbortController();
    let source: EventSource | undefined;
    let disposed = false;
    let finished = false;
    let consecutiveErrors = 0;
    const current = () => !disposed && !finished;
    const fallback = () => {
      if (!current()) return;
      finished = true;
      source?.close();
      dispatch({ type: "fallback" });
    };
    const onEvent = (name: (typeof STREAM_EVENTS)[number]) => (event: MessageEvent<string>) => {
      if (!current()) return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        fallback();
        return;
      }
      const parsed = adminJobStreamEventSchemas[name].safeParse(payload);
      if (!parsed.success) {
        fallback();
        return;
      }
      if (name === "snapshot") {
        const snapshot = adminJobStreamEventSchemas.snapshot.parse(payload);
        if (snapshot.job.id !== jobId) {
          fallback();
          return;
        }
      }
      dispatch({ type: "event", event: name, data: parsed.data });
      if (name === "end") {
        finished = true;
        source?.close();
        dispatch({ type: "connection", connection: "closed" });
      } else if (name === "overflow") {
        // Preserve native reconnection/Last-Event-ID replay after a slow-consumer close.
        dispatch({ type: "connection", connection: "reconnecting" });
      }
    };
    const listeners = STREAM_EVENTS.map((name) => [name, onEvent(name)] as const);
    const onOpen = () => {
      if (!current()) return;
      consecutiveErrors = 0;
      dispatch({ type: "connection", connection: "live" });
    };
    const onError = () => {
      if (!current()) return;
      consecutiveErrors += 1;
      if (
        consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ||
        source?.readyState === EventSource.CLOSED
      ) {
        fallback();
      } else {
        dispatch({ type: "connection", connection: "reconnecting" });
      }
    };

    void (async () => {
      try {
        const target = await streamAdminActivityJobEvents(
          jobId,
          { source: "application" },
          {
            client,
            signal: controller.signal,
          },
        );
        if (!current() || controller.signal.aborted) return;
        source = new EventSource(target.url, { withCredentials: target.withCredentials });
        for (const [name, listener] of listeners) source.addEventListener(name, listener);
        source.addEventListener("open", onOpen);
        source.addEventListener("error", onError);
      } catch {
        fallback();
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (!source) return;
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [client, jobId]);

  // Never render a previous origin/job's data while its replacement effect starts.
  return state.client === client && state.jobId === jobId
    ? state
    : { data: null, connection: "connecting" };
}
