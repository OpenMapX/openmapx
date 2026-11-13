import type { RequestState } from "../privacy/request-states";
import { apiClient, apiUrl } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export type PrivacyRequestKind = "access" | "portability" | "access_and_portability";
export type PrivacyRequestState = RequestState;

export interface PrivacyRequestView {
  id: string;
  kind: PrivacyRequestKind;
  channel: string;
  state: PrivacyRequestState;
  locale: string;
  timeZone: string;
  receivedAt: string;
  registeredAt?: string | null;
  snapshotAt?: string | null;
  dueAt: string;
  extension?: Record<string, unknown> | null;
  identityMethod: string | null;
  refusalCode?: string | null;
  completedAt?: string | null;
  closedAt?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyTaskView {
  registrationId: string;
  status: "open" | "resolved";
}

export interface PrivacyRequestDetail extends PrivacyRequestView {
  tasks: PrivacyTaskView[];
}

/** The API refuses an export until the session has a recent interactive sign-in. */
export const FRESH_SIGN_IN_REQUIRED = "FRESH_SIGN_IN_REQUIRED";

function mutationKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `privacy-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function mutationOptions(key = mutationKey()): { headers: Record<string, string> } {
  return { headers: { "Idempotency-Key": key } };
}

export function getPrivacyDataRequests(): Promise<{ requests: PrivacyRequestView[] }> {
  return apiClient.get(API_ENDPOINTS.privacyDataRequests);
}

export function getPrivacyDataRequest(requestId: string): Promise<PrivacyRequestDetail> {
  return apiClient.get(`${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}`);
}

export function withdrawPrivacyDataRequest(requestId: string, version: number) {
  return apiClient.post<PrivacyRequestView>(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/withdraw`,
    { version },
    mutationOptions(),
  );
}

/**
 * Start the self-service export. The response body is the ZIP archive itself,
 * so the caller reads it as a stream or blob. A 401 with the code
 * `FRESH_SIGN_IN_REQUIRED` means the person must sign in again first.
 */
export function requestPrivacyExport(
  kind: PrivacyRequestKind = "access_and_portability",
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  const locale = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
  const timeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : "UTC";
  return fetch(apiUrl(API_ENDPOINTS.privacyExport), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, locale, timeZone }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}
