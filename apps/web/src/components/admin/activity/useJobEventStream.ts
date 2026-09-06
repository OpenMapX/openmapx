"use client";

import { useEffect, useReducer } from "react";

export interface JobLog {
  id: string;
  seq: number;
  stream: string;
  line: string;
  createdAt: string;
}

export interface JobStage {
  id: string;
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message: string | null;
  error: unknown;
  artifacts: unknown;
}

export interface JobDetailData {
  source: "application" | "data-manager";
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelable: boolean;
  logs: JobLog[];
  stages: JobStage[];
}

export type JobStreamConnection = "connecting" | "live" | "reconnecting" | "polling" | "closed";

export interface JobStreamState {
  data: JobDetailData | null;
  connection: JobStreamConnection;
}

const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_pending"]);
/** Consecutive transport errors without a successful open before giving up. */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Applies one server event to the last known job state. Exported for tests. */
export function reduceJobEvent(
  state: JobDetailData | null,
  type: string,
  data: unknown,
): JobDetailData | null {
  const payload = (data ?? {}) as Record<string, unknown>;
  if (type === "snapshot") {
    const job = payload.job as JobDetailData | undefined;
    return job ?? state;
  }
  if (!state) return state;
  if (type === "log") {
    const log = payload as unknown as JobLog;
    if (state.logs.some((existing) => existing.id === log.id)) return state;
    const logs = [...state.logs, log].sort((a, b) => a.seq - b.seq);
    return { ...state, logs };
  }
  if (type === "progress") {
    const progress = typeof payload.progress === "number" ? payload.progress : state.progress;
    return { ...state, progress };
  }
  if (type === "status") {
    const status = typeof payload.status === "string" ? payload.status : state.status;
    return {
      ...state,
      status,
      cancelable: ACTIVE_STATUSES.has(status),
      progress:
        payload.progress === undefined ? state.progress : (payload.progress as number | null),
      error: payload.error === undefined ? state.error : (payload.error as string | null),
      result:
        payload.result === undefined
          ? state.result
          : (payload.result as Record<string, unknown> | null),
      startedAt:
        payload.startedAt === undefined ? state.startedAt : (payload.startedAt as string | null),
      finishedAt:
        payload.finishedAt === undefined ? state.finishedAt : (payload.finishedAt as string | null),
    };
  }
  return state;
}

type Action =
  | { type: "event"; event: string; data: unknown }
  | { type: "connection"; connection: JobStreamConnection }
  | { type: "reset" };

function reducer(state: JobStreamState, action: Action): JobStreamState {
  switch (action.type) {
    case "event":
      return { ...state, data: reduceJobEvent(state.data, action.event, action.data) };
    case "connection":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case "reset":
      return { data: null, connection: "connecting" };
  }
}

const STREAM_EVENTS = ["snapshot", "log", "progress", "status"] as const;

/**
 * Subscribes to a job's Server-Sent Events stream. The browser handles
 * reconnects and resends the last event id; the server replays or sends a
 * fresh snapshot. When the transport keeps failing, or the browser has no
 * EventSource, the hook reports `polling` so the caller can fall back.
 */
export function useJobEventStream(url: string | null): JobStreamState {
  const [state, dispatch] = useReducer(reducer, { data: null, connection: "connecting" });

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!url) {
      dispatch({ type: "connection", connection: "polling" });
      return;
    }
    if (typeof EventSource === "undefined") {
      dispatch({ type: "connection", connection: "polling" });
      return;
    }

    const source = new EventSource(url, { withCredentials: true });
    let consecutiveErrors = 0;
    let finished = false;

    const parse = (raw: string): unknown => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const onEvent = (name: string) => (event: MessageEvent<string>) => {
      dispatch({ type: "event", event: name, data: parse(event.data) });
    };
    const listeners = STREAM_EVENTS.map((name) => [name, onEvent(name)] as const);
    for (const [name, listener] of listeners) source.addEventListener(name, listener);

    const onEnd = () => {
      finished = true;
      source.close();
      dispatch({ type: "connection", connection: "closed" });
    };
    const onOverflow = () => {
      // The server dropped us as a slow consumer; a reconnect resnapshots.
      dispatch({ type: "connection", connection: "reconnecting" });
    };
    const onOpen = () => {
      consecutiveErrors = 0;
      dispatch({ type: "connection", connection: "live" });
    };
    const onError = () => {
      if (finished) return;
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || source.readyState === EventSource.CLOSED) {
        source.close();
        dispatch({ type: "connection", connection: "polling" });
        return;
      }
      dispatch({ type: "connection", connection: "reconnecting" });
    };
    source.addEventListener("end", onEnd);
    source.addEventListener("overflow", onOverflow);
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);

    return () => {
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.removeEventListener("end", onEnd);
      source.removeEventListener("overflow", onOverflow);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [url]);

  return state;
}
