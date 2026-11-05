"use client";
import { AuthDialog } from "@/components/auth/AuthDialog";
/** Fixed destination; case/artifact selection comes only from the tab's validated record. */
export default function PrivacyAdminSignInPage() {
  return (
    <AuthDialog
      open
      dismissible={false}
      callbackPath="/admin/privacy"
      onClose={() => window.location.assign("/admin/privacy")}
    />
  );
}
