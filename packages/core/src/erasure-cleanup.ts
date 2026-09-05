export const TERMINAL_PRIVACY_REQUEST_STATES = [
  "delivered",
  "artifact_expired",
  "withdrawn",
  "refused",
  "closed",
] as const;

const terminalPrivacyRequestStates = new Set<string>(TERMINAL_PRIVACY_REQUEST_STATES);

export function isTerminalPrivacyRequestState(state: string): boolean {
  return terminalPrivacyRequestStates.has(state);
}

export function erasureVerificationIdentifiers(user: {
  id: string;
  email: string;
}): readonly [string, string] {
  return [user.email, `change-email:${user.id}:${user.email}`];
}
