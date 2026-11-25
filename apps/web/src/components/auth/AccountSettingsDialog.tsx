"use client";

import CloseIcon from "@mui/icons-material/Close";
import PersonIcon from "@mui/icons-material/Person";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { User } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import type { AccountSettingsSection } from "@/stores/accountSettingsStore";
import { ConnectedAccountsSection } from "./accountSettings/ConnectedAccountsSection";
import { DeletionSection } from "./accountSettings/DeletionSection";
import { type EmailFlowHandle, EmailSection } from "./accountSettings/EmailSection";
import { PasskeysSection } from "./accountSettings/PasskeysSection";
import { PasswordSection } from "./accountSettings/PasswordSection";
import { ProfileSection } from "./accountSettings/ProfileSection";
import { TwoFactorSection } from "./accountSettings/TwoFactorSection";
import { type AccountMessage, FreshSignInPrompt } from "./freshSignIn";
import { MangroveAccountSection } from "./MangroveAccountSection";
import { PrivacyDataSection } from "./PrivacyDataSection";
import { SharedLinksSection } from "./SharedLinksSection";
import { TimelineConnectionSection } from "./TimelineConnectionSection";
import { useAccountCredentials } from "./useAccountCredentials";

interface AccountSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The account was deleted; the caller closes the dialog and tells an incomplete cleanup. */
  onAccountDeleted: (cleanupIncomplete: boolean) => void;
  user: User;
  initialSection: AccountSettingsSection;
}

/**
 * Account settings. Every opening and every account start the dialog afresh,
 * so no draft, code or message from one carries into the next; closing keeps
 * the content in place while the dialog fades out. Each flow is its own
 * section and owns its state; they share the status line at the top.
 */
export function AccountSettingsDialog(props: AccountSettingsDialogProps) {
  const [openings, setOpenings] = useState({ open: props.open, count: 0 });
  if (openings.open !== props.open) {
    setOpenings({ open: props.open, count: openings.count + (props.open ? 1 : 0) });
  }
  return <AccountSettingsDialogContent key={`${props.user.id}:${openings.count}`} {...props} />;
}

function AccountSettingsDialogContent({
  open,
  onClose,
  onAccountDeleted,
  user,
  initialSection,
}: AccountSettingsDialogProps) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const fullScreen = useFullScreenOnMobile();
  const [message, setMessage] = useState<AccountMessage | null>(null);
  const credentials = useAccountCredentials(open ? user.id : null, setMessage);
  const emailFlow = useRef<EmailFlowHandle>(null);
  const timelineHeadingRef = useRef<HTMLHeadingElement>(null);
  const sharingHeadingRef = useRef<HTMLHeadingElement>(null);
  const privacyHeadingRef = useRef<HTMLHeadingElement>(null);

  const focusInitialSection = () => {
    const heading =
      initialSection === "timeline"
        ? timelineHeadingRef.current
        : initialSection === "sharing"
          ? sharingHeadingRef.current
          : initialSection === "privacy"
            ? privacyHeadingRef.current
            : null;
    if (!heading) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      block: "start",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  const closeDialog = () => {
    emailFlow.current?.retire();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{
        paper: { sx: mobileFullScreenDialogPaperSx },
        transition: { onEntered: focusInitialSection },
      }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <PersonIcon />
        <Typography variant="h6" component="span" sx={{ flex: 1, fontWeight: 600 }}>
          {t("accountSettings")}
        </Typography>
        <IconButton onClick={closeDialog} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {message?.type === "fresh-sign-in" ? (
          <Box sx={{ mb: 2 }}>
            <FreshSignInPrompt returnPath={message.returnPath} />
          </Box>
        ) : (
          message && (
            <Alert severity={message.type} sx={{ mb: 2 }}>
              {message.text}
            </Alert>
          )
        )}

        <ProfileSection user={user} setMessage={setMessage} />
        <Divider sx={{ mb: 2 }} />
        <EmailSection ref={emailFlow} open={open} email={user.email} setMessage={setMessage} />
        <Divider sx={{ mb: 2 }} />
        <PasswordSection setMessage={setMessage} />
        <Divider sx={{ mb: 2 }} />
        <TwoFactorSection
          initiallyEnabled={Boolean((user as Record<string, unknown>).twoFactorEnabled)}
          setMessage={setMessage}
        />
        <Divider sx={{ mb: 2 }} />
        <ConnectedAccountsSection credentials={credentials} />
        <Divider sx={{ my: 2 }} />
        <TimelineConnectionSection key={user.id} ref={timelineHeadingRef} ownerId={user.id} />
        <Divider sx={{ my: 2 }} />
        <SharedLinksSection ref={sharingHeadingRef} />
        <Divider sx={{ my: 2 }} />
        <PrivacyDataSection ref={privacyHeadingRef} />
        <Divider sx={{ my: 2 }} />
        <PasskeysSection credentials={credentials} />
        <Divider sx={{ mb: 2 }} />
        <MangroveAccountSection />
        <Divider sx={{ mb: 2 }} />
        <DeletionSection onDeleted={onAccountDeleted} setMessage={setMessage} />
      </DialogContent>
    </Dialog>
  );
}
