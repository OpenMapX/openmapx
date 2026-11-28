"use client";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { accountError } from "./accountAdmin";

/** Catalogue keys under `adminShared.accountErrors` for the codes account requests refuse with. */
const ACCOUNT_ERROR_KEYS: Readonly<Record<string, string>> = {
  ACCOUNT_MAIL_RATE_LIMITED: "mailRateLimited",
  ACCOUNT_EMAIL_CHANGED: "emailChanged",
  ACCOUNT_ACTION_CONFLICT: "actionConflict",
  REAUTHENTICATION_REQUIRED: "reauthenticationRequired",
  AUTH_POLICY_CONFLICT: "policyConflict",
  ADMIN_OPERATION_IN_PROGRESS: "operationInProgress",
  LAST_ADMIN_REQUIRED: "lastAdminRequired",
  EXTENSION_BLOCKS_ACCOUNT_DELETION: "extensionBlocksDeletion",
  ROLE_VERSION_CONFLICT: "roleConflict",
  INVALID_PASSWORD: "passwordPolicy",
  PASSWORD_TOO_SHORT: "passwordPolicy",
  PASSWORD_TOO_LONG: "passwordTooLong",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  USER_ALREADY_EXISTS: "userExists",
};

/** Words a failed account request for the reader; unknown codes get the general failure. */
export function useAccountErrorText(): (error: unknown) => string {
  const t = useTranslations("adminShared.accountErrors");
  return useCallback(
    (error: unknown) => t(ACCOUNT_ERROR_KEYS[accountError(error).code] ?? "requestFailed"),
    [t],
  );
}
