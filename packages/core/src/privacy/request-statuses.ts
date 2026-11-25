/** Lifecycle of a data-subject request. Every status change in the API goes
 * through `isValidRequestTransition`; the predicates below are the only place
 * that groups statuses, so callers never repeat their own status lists. */
export const REQUEST_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_requester",
  "completed",
  "refused",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const INITIAL_REQUEST_STATUS: RequestStatus = "open";

export const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> =
  Object.freeze({
    open: ["in_progress", "waiting_on_requester", "refused"],
    in_progress: ["waiting_on_requester", "completed", "refused"],
    waiting_on_requester: ["in_progress", "refused", "completed"],
    completed: [],
    refused: [],
  });

export const ACTIVE_REQUEST_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_requester",
] as const satisfies readonly RequestStatus[];
export const TERMINAL_REQUEST_STATUSES = [
  "completed",
  "refused",
] as const satisfies readonly RequestStatus[];

/**
 * What a case event records. A status change is one `status_changed` event;
 * its payload names the `from` and `to` statuses.
 */
export const PRIVACY_EVENT_TYPES = [
  "received",
  "status_changed",
  "identity_verified",
  "task_resolved",
  "extended",
  "export_started",
  "export_delivered",
  "export_failed",
] as const;
export type PrivacyEventType = (typeof PRIVACY_EVENT_TYPES)[number];

/** Who acted on a case: the data subject, an administrator or the system. */
export const PRIVACY_ACTOR_KINDS = ["subject", "admin", "system"] as const;
export type PrivacyActorKind = (typeof PRIVACY_ACTOR_KINDS)[number];

const active = new Set<string>(ACTIVE_REQUEST_STATUSES);
const terminal = new Set<string>(TERMINAL_REQUEST_STATUSES);

export function isValidRequestTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The request still needs work: it blocks a second request of the same kind. */
export function isActiveRequestStatus(status: string): boolean {
  return active.has(status);
}

/** The request is closed; its retention holds are released. */
export function isTerminalRequestStatus(status: string): boolean {
  return terminal.has(status);
}

/** An administrator may move, refuse or complete the case. */
export function acceptsCaseDecision(status: string): boolean {
  return active.has(status);
}

/** The statutory deadline may still be extended. */
export function canExtendDeadline(status: string): boolean {
  return active.has(status);
}

/** Operator-held sources may still be resolved. */
export function acceptsTaskResolution(status: string): boolean {
  return active.has(status);
}

/** A manual identity check moves an unverified case into work. */
export function acceptsManualIdentityVerification(status: string): boolean {
  return status === "open" || status === "waiting_on_requester";
}

/** The subject may still download an export for this request. */
export function acceptsSelfServiceExport(status: string): boolean {
  return active.has(status);
}

/** The subject may withdraw the request. */
export function acceptsWithdrawal(status: RequestStatus): boolean {
  return isValidRequestTransition(status, "completed");
}
