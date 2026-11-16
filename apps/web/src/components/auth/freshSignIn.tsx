"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { FRESH_SIGN_IN_REQUIRED, IMPERSONATION_NOT_ALLOWED } from "@openmapx/core";
import { useTranslations } from "next-intl";

/** Why the API refused a credential change, if it was one of its account-security refusals. */
export type CredentialRefusal = "sign-in" | "impersonating";

function codeOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { code?: unknown; body?: unknown };
  if (record.code !== undefined) return record.code;
  return typeof record.body === "object" && record.body !== null
    ? (record.body as { code?: unknown }).code
    : undefined;
}

/**
 * Reads the refusal from an auth-client error, a returned response body or a
 * thrown error that carries the API body.
 */
export function credentialRefusal(error: unknown): CredentialRefusal | null {
  const code = codeOf(error);
  if (code === FRESH_SIGN_IN_REQUIRED) return "sign-in";
  if (code === IMPERSONATION_NOT_ALLOWED) return "impersonating";
  return null;
}

/** A status line in the account UI; a refused change can ask for a new sign-in instead. */
export type AccountMessage =
  | { type: "success" | "error"; text: string }
  | { type: "fresh-sign-in"; returnPath: string };

/**
 * The message for an account-security refusal, or null for any other error,
 * which the caller handles as before.
 */
export function useCredentialRefusalMessage(): (error: unknown) => AccountMessage | null {
  const t = useTranslations("account.freshSignIn");
  return (error) => {
    const refusal = credentialRefusal(error);
    if (refusal === "sign-in") return { type: "fresh-sign-in", returnPath: currentReturnPath() };
    if (refusal === "impersonating") return { type: "error", text: t("impersonating") };
    return null;
  };
}

/** The page that asks for a new sign-in and then returns to `return`. */
export const FRESH_SIGN_IN_PAGE = "/auth/confirm";

const RETURN_BASE = "https://return.invalid";

/**
 * A return target is accepted only as a path on this site: it starts with one
 * `/`, carries no scheme, host, backslash or control character, and resolves
 * to the same place against any origin. Anything else returns to `/`.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return "/";
  try {
    const url = new URL(value, RETURN_BASE);
    if (url.origin !== RETURN_BASE) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

export function freshSignInHref(returnPath: string): string {
  return `${FRESH_SIGN_IN_PAGE}?${new URLSearchParams({ return: safeReturnPath(returnPath) })}`;
}

/** The current page, as the place to come back to after signing in again. */
export function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Explains that the change needs a recent sign-in and links to the sign-in
 * page. Nothing resumes afterwards; the person repeats the change.
 */
export function FreshSignInPrompt({ returnPath }: { returnPath: string }) {
  const t = useTranslations("account.freshSignIn");
  return (
    <Alert
      severity="warning"
      action={
        <Button color="inherit" size="small" href={freshSignInHref(returnPath)}>
          {t("signInAgain")}
        </Button>
      }
    >
      {t("notice")}
    </Alert>
  );
}
