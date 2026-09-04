import { apiClient, apiUrl } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export type PrivacyRequestKind = "access" | "portability" | "access_and_portability";
export type PrivacyRequestState =
  | "received"
  | "identity_pending"
  | "preserving"
  | "collecting"
  | "pending_processor"
  | "operator_review"
  | "assembling"
  | "ready"
  | "delivered"
  | "artifact_expired"
  | "clarification_needed"
  | "withdrawn"
  | "refused"
  | "closed";

export interface PrivacyRequestView {
  id: string;
  kind: PrivacyRequestKind;
  channel: string;
  state: PrivacyRequestState;
  locale: string;
  timeZone: string;
  receivedAt: string;
  registeredAt?: string | null;
  preservationAt?: string | null;
  snapshotAt?: string | null;
  dueAt: string;
  extension?: Record<string, unknown> | null;
  identityState: string;
  refusalCode?: string | null;
  deliveryState: string;
  withdrawalAt?: string | null;
  completedAt?: string | null;
  closedAt?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyArtifactView {
  id: string;
  state: "assembling" | "ready" | "revoked" | "expired" | "deleted" | "failed";
  filename: string;
  mediaType: string;
  plaintextBytes: number | null;
  expiresAt: string | null;
  readyAt: string | null;
  downloadCount?: number;
}

export interface PrivacyTaskView {
  registrationId: string;
  status: string;
  required: number;
  recordCount: number | null;
  exceptionCode: string | null;
  redactionCode: string | null;
}

export interface PrivacyRequestDetail extends PrivacyRequestView {
  artifacts: PrivacyArtifactView[];
  tasks: PrivacyTaskView[];
}

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

export function createPrivacyDataRequest(kind: PrivacyRequestKind = "access_and_portability") {
  const locale = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
  const timeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : "UTC";
  return apiClient.post<PrivacyRequestView>(
    API_ENDPOINTS.privacyDataRequests,
    { kind, locale, timeZone },
    mutationOptions(),
  );
}

export function withdrawPrivacyDataRequest(requestId: string, version: number) {
  return apiClient.post<PrivacyRequestView>(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/withdraw`,
    { version },
    mutationOptions(),
  );
}

export function regeneratePrivacyDataRequest(requestId: string, version: number) {
  return apiClient.post<PrivacyRequestView>(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/regenerate`,
    { version },
    mutationOptions(),
  );
}

export function revokePrivacyArtifact(requestId: string, artifactId: string): Promise<void> {
  return apiClient.delete(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}`,
    mutationOptions(),
  );
}

export function startPrivacyReauthentication(requestId: string, artifactId: string) {
  return apiClient.post<{ challengeId: string; expiresAt: string; loginPath: string }>(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}/reauth/start`,
    {},
    mutationOptions(),
  );
}

export function completePrivacyReauthentication(
  requestId: string,
  artifactId: string,
  challengeId: string,
) {
  return apiClient.post<{ completed: true }>(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}/reauth/complete`,
    { challengeId },
    mutationOptions(),
  );
}

export function privacyArtifactDownloadUrl(requestId: string, artifactId: string): string {
  return apiUrl(
    `${API_ENDPOINTS.privacyDataRequests}/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
  );
}

export type PrivacyAdminRole = "privacy_admin" | "user";

/** Full-admin-only least-privilege role mutation.  This intentionally does
 * not use Better Auth's broad admin plugin, whose role union is limited to
 * `admin` and `user` and would make it too easy to bypass the privacy boundary. */
export function setPrivacyAdminRole(userId: string, role: PrivacyAdminRole) {
  const action = role === "privacy_admin" ? "grant" : "revoke";
  return apiClient.post<{ userId: string; role: PrivacyAdminRole; changed: boolean }>(
    `${API_ENDPOINTS.privacyAdminRoles}/${encodeURIComponent(userId)}/${action}`,
    {},
    mutationOptions(),
  );
}
