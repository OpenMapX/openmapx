import { isAssuranceSufficient, type ReauthenticationSession } from "../privacy/reauthentication";
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
