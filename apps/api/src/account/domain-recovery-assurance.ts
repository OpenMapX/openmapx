import { isAssuranceSufficient, type ReauthenticationSession } from "../privacy/session-assurance";
export function isDomainRecoveryAssuranceSufficient(
  session: ReauthenticationSession,
  originIndependentPasswordLogin: boolean,
): boolean {
  return (
    originIndependentPasswordLogin &&
    ["password", "password_totp", "password_recovery"].includes(session.method) &&
    isAssuranceSufficient(session.method, session.mfaConfigured)
  );
}
