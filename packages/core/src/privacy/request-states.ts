/** Lifecycle of a data-subject request. Every state change in the API goes
 * through `isValidRequestTransition`; the predicates below are the only place
 * that groups states, so callers never repeat their own state lists. */
export const REQUEST_STATES = [
  "open",
  "in_progress",
  "waiting_on_requester",
  "completed",
  "refused",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const INITIAL_REQUEST_STATE: RequestState = "open";

export const REQUEST_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> =
  Object.freeze({
    open: ["in_progress", "waiting_on_requester", "refused"],
    in_progress: ["waiting_on_requester", "completed", "refused"],
    waiting_on_requester: ["in_progress", "refused", "completed"],
    completed: [],
    refused: [],
  });

export const ACTIVE_REQUEST_STATES = [
  "open",
  "in_progress",
  "waiting_on_requester",
] as const satisfies readonly RequestState[];
export const TERMINAL_REQUEST_STATES = [
  "completed",
  "refused",
] as const satisfies readonly RequestState[];

const active = new Set<string>(ACTIVE_REQUEST_STATES);
const terminal = new Set<string>(TERMINAL_REQUEST_STATES);

export function isValidRequestTransition(from: RequestState, to: RequestState): boolean {
  return REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The request still needs work: it blocks a second request of the same kind. */
export function isActiveRequestState(state: string): boolean {
  return active.has(state);
}

/** The request is closed; its retention holds are released. */
export function isTerminalRequestState(state: string): boolean {
  return terminal.has(state);
}

/** An administrator may move, refuse or complete the case. */
export function acceptsCaseDecision(state: string): boolean {
  return active.has(state);
}

/** The statutory deadline may still be extended. */
export function canExtendDeadline(state: string): boolean {
  return active.has(state);
}

/** Operator-held sources may still be resolved. */
export function acceptsTaskResolution(state: string): boolean {
  return active.has(state);
}

/** A manual identity check moves an unverified case into work. */
export function acceptsManualIdentityVerification(state: string): boolean {
  return state === "open" || state === "waiting_on_requester";
}

/** The subject may still download an export for this request. */
export function acceptsSelfServiceExport(state: string): boolean {
  return active.has(state);
}

/** The subject may withdraw the request. */
export function acceptsWithdrawal(state: RequestState): boolean {
  return isValidRequestTransition(state, "completed");
}
