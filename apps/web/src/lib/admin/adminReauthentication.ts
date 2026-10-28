"use client";
import { createApiClient } from "@openmapx/core";
import {
  completeAdminReauthentication,
  startAdminReauthentication,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  type AdminReauthIntent,
  adminReauthIntentListSchema as intentSchema,
  type StoredAdminReauth,
  adminReauthStoredSchema as storedSchema,
} from "@openmapx/core/api-contracts";

export type { AdminReauthIntent, StoredAdminReauth } from "@openmapx/core/api-contracts";

import { browserAdminApiBase } from "./browserAdminApiBase";
export const adminReauthStorageKey = (apiUrl: string) =>
  `openmapx-admin-reauth:${browserAdminApiBase(apiUrl)}`;
export function safeAdminReturnPath(path: string) {
  return (
    ["/admin", "/admin/users", "/admin/settings", "/admin/integrations", "/admin/transit"].includes(
      path,
    ) || /^\/admin\/users\/[a-zA-Z0-9_-]{1,128}$/.test(path)
  );
}
function validRequests(requests: AdminReauthIntent[]) {
  if (requests.length === 2) {
    const purposes = new Set(requests.map((r) => r.purpose));
    if (!purposes.has("credentials.import") || !purposes.has("transit.credentials"))
      throw Error("Invalid reauthentication group");
  }
}
export function readStoredAdminReauthentication(apiUrl: string): StoredAdminReauth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(adminReauthStorageKey(apiUrl));
    if (!raw) return null;
    const value = storedSchema.parse(JSON.parse(raw));
    validRequests(value.requests);
    if (
      value.requests.length !== value.challengeIds.length ||
      new Set(value.challengeIds).size !== value.challengeIds.length ||
      Date.parse(value.expiresAt) <= Date.now() ||
      !safeAdminReturnPath(value.returnPath)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export async function startStoredAdminReauthentication(
  apiUrl: string,
  requests: AdminReauthIntent[],
): Promise<StoredAdminReauth> {
  const parsed = intentSchema.parse(requests);
  validRequests(parsed);
  const client = createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    challengeIds: string[] = [];
  let expiry = Infinity;
  sessionStorage.removeItem(adminReauthStorageKey(apiUrl));
  for (const input of parsed) {
    const result = unwrapAdminResponse(
      await startAdminReauthentication(
        { ...input, restart: challengeIds.length === 0 },
        { "idempotency-key": crypto.randomUUID() },
        { client },
      ),
    );
    challengeIds.push(result.challengeId);
    expiry = Math.min(expiry, Date.parse(result.expiresAt));
  }
  const path = window.location.pathname,
    value: StoredAdminReauth = {
      phase: "login",
      requests: parsed,
      challengeIds,
      expiresAt: new Date(expiry).toISOString(),
      returnPath: safeAdminReturnPath(path) ? path : "/admin",
    };
  sessionStorage.setItem(adminReauthStorageKey(apiUrl), JSON.stringify(value));
  return value;
}
export async function completeStoredAdminReauthentication(apiUrl: string): Promise<string> {
  const key = adminReauthStorageKey(apiUrl),
    original = sessionStorage.getItem(key),
    stored = readStoredAdminReauthentication(apiUrl);
  if (!stored) throw Error("The administrator sign-in has expired. Start again.");
  const client = createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" });
  for (const challengeId of stored.challengeIds)
    unwrapAdminResponse(
      await completeAdminReauthentication(
        { challengeId },
        { "idempotency-key": crypto.randomUUID() },
        { client },
      ),
    );
  if (sessionStorage.getItem(key) !== original)
    throw Error("The administrator action changed. Start again.");
  sessionStorage.setItem(key, JSON.stringify({ ...stored, phase: "completed" }));
  return stored.returnPath;
}
