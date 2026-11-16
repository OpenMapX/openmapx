"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { safeReturnPath } from "@/components/auth/freshSignIn";

/**
 * Always asks for an interactive sign-in, even when a session exists, so an
 * account change refused for an old sign-in can be repeated. Afterwards, or
 * when the dialog is left, the person returns to the page they came from.
 */
export default function ConfirmSignInPage() {
  const t = useTranslations("account.freshSignIn");
  const [returnPath] = useState(() =>
    typeof window === "undefined"
      ? "/"
      : safeReturnPath(new URLSearchParams(window.location.search).get("return")),
  );
  return (
    <AuthDialog
      open
      dismissible={false}
      notice={t("notice")}
      callbackPath={returnPath}
      onClose={() => window.location.assign(returnPath)}
    />
  );
}
