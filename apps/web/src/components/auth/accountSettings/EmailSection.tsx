import EditIcon from "@mui/icons-material/Edit";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { type AccountMessage, useCredentialRefusalMessage } from "../freshSignIn";
import { AccountSectionTitle, type SetAccountMessage } from "./shared";

/** Lets the dialog retire a pending email request when it is closed. */
export interface EmailFlowHandle {
  retire: () => void;
}

/** One open-account lifetime for the email-code flow; `generation` retires work within it. */
function createEmailLifetime() {
  return { active: false, busy: false, generation: 0 };
}

export function EmailSection({
  ref,
  open,
  email,
  setMessage,
}: {
  ref?: Ref<EmailFlowHandle>;
  open: boolean;
  email: string;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const refusalMessage = useCredentialRefusalMessage();
  const [changingEmail, setChangingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [emailPending, setEmailPending] = useState<"send" | "confirm" | null>(null);
  const [emailLifetime] = useState(createEmailLifetime);
  // The last message published by the email flow, so retiring an address clears only that message.
  const emailMessageRef = useRef<AccountMessage | null>(null);

  // The email flow runs only while the dialog is open; closing retires it.
  useLayoutEffect(() => {
    if (!open) return;
    emailLifetime.active = true;
    return () => {
      emailLifetime.active = false;
    };
  }, [emailLifetime, open]);

  // Work is owned by the open-account lifetime and the editor generation it
  // started in; retiring bumps the generation so older continuations cannot publish.
  const publishEmailMessage = (next: AccountMessage) => {
    emailMessageRef.current = next;
    setMessage(next);
  };

  const clearEmailMessage = () => {
    const owned = emailMessageRef.current;
    emailMessageRef.current = null;
    setMessage((current) => (current === owned ? null : current));
  };

  const releaseEmailRequest = () => {
    emailLifetime.busy = false;
    setEmailPending(null);
  };

  const retireEmailFlow = () => {
    emailLifetime.generation++;
    releaseEmailRequest();
  };
  useImperativeHandle(ref, () => ({ retire: retireEmailFlow }));

  const resetEmailFlow = (changing: boolean) => {
    retireEmailFlow();
    setChangingEmail(changing);
    setNewEmail("");
    setEmailOtp("");
    setEmailOtpSent(false);
  };

  // The synchronous busy flag covers repeated activation before React renders disabled controls.
  const beginEmailRequest = (kind: "send" | "confirm") => {
    if (!emailLifetime.active || emailLifetime.busy) return null;
    emailLifetime.busy = true;
    setEmailPending(kind);
    setMessage(null);
    const generation = emailLifetime.generation;
    return () => emailLifetime.active && emailLifetime.generation === generation;
  };

  const requestEmailChange = async () => {
    const owned = beginEmailRequest("send");
    if (!owned) return;
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({ newEmail });
      if (!owned()) return;
      if (error) {
        publishEmailMessage(
          refusalMessage(error) ?? {
            type: "error",
            text: String(error.message ?? t("failedEmailChange")),
          },
        );
        return;
      }
      setEmailOtpSent(true);
      publishEmailMessage({ type: "success", text: t("verificationCodeSent") });
    } catch {
      if (owned()) publishEmailMessage({ type: "error", text: t("failedChangeEmail") });
    } finally {
      if (owned()) releaseEmailRequest();
    }
  };

  const confirmEmailChange = async () => {
    const owned = beginEmailRequest("confirm");
    if (!owned) return;
    try {
      const { error } = await authClient.emailOtp.changeEmail({ newEmail, otp: emailOtp });
      if (!owned()) return;
      if (error) {
        publishEmailMessage(
          refusalMessage(error) ?? {
            type: "error",
            text: String(error.message ?? t("failedChangeEmail")),
          },
        );
        return;
      }
      publishEmailMessage({ type: "success", text: t("emailUpdated") });
      resetEmailFlow(false);
    } catch {
      if (owned()) publishEmailMessage({ type: "error", text: t("failedChangeEmail") });
    } finally {
      if (owned()) releaseEmailRequest();
    }
  };

  const changeAddress = (value: string) => {
    // A different address abandons the previous request and any code sent for it.
    clearEmailMessage();
    retireEmailFlow();
    setEmailOtp("");
    setEmailOtpSent(false);
    setNewEmail(value);
  };

  return (
    <>
      <AccountSectionTitle>{t("emailAddress")}</AccountSectionTitle>
      {!changingEmail ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3 }}>
          <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
            {email}
          </Typography>
          <Button size="small" startIcon={<EditIcon />} onClick={() => resetEmailFlow(true)}>
            {tc("change")}
          </Button>
        </Box>
      ) : (
        <Box sx={{ mb: 3 }}>
          <TextField
            fullWidth
            label={t("newEmailAddress")}
            type="email"
            value={newEmail}
            onChange={(e) => changeAddress(e.target.value)}
            size="small"
            sx={{ mb: 1.5 }}
          />
          {emailOtpSent && (
            <TextField
              fullWidth
              label={t("verificationCode")}
              value={emailOtp}
              onChange={(e) => setEmailOtp(e.target.value)}
              disabled={emailPending === "confirm"}
              size="small"
              sx={{ mb: 1.5 }}
              helperText={t("verificationCodeHelper")}
            />
          )}
          <Box sx={{ display: "flex", gap: 1 }}>
            {!emailOtpSent ? (
              <Button
                variant="contained"
                size="small"
                onClick={requestEmailChange}
                disabled={!newEmail || emailPending !== null}
              >
                {t("sendVerificationCode")}
              </Button>
            ) : (
              <Button
                variant="contained"
                size="small"
                onClick={confirmEmailChange}
                disabled={!emailOtp || emailPending !== null}
              >
                {t("confirmChange")}
              </Button>
            )}
            <Button variant="outlined" size="small" onClick={() => resetEmailFlow(false)}>
              {tc("cancel")}
            </Button>
          </Box>
        </Box>
      )}
    </>
  );
}
