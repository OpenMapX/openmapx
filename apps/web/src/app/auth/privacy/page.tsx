"use client";

import { AuthDialog } from "@/components/auth/AuthDialog";

/** Always ask for an interactive login, even when an ordinary session exists.
 * The API verifies that this creates a new, sufficiently assured session. */
export default function PrivacySignInPage() {
  return (
    <AuthDialog
      open
      dismissible={false}
      callbackPath="/settings/privacy"
      onClose={() => window.location.assign("/settings/privacy")}
    />
  );
}
