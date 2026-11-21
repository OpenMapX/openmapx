"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import type { AdminReauthProofRef } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminDraftExit } from "@/lib/admin/AdminDraftProvider";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { navigateAdminDocument } from "@/lib/admin/adminDocumentExit";
import {
  type AdminReauthIntent,
  adminReauthStorageKey,
  completeStoredAdminReauthentication,
  readStoredAdminReauthentication,
  type StoredAdminReauth,
  startStoredAdminReauthentication,
} from "@/lib/admin/adminReauthentication";
import { AdminDisplayError } from "@/lib/admin/adminRequestError";

type Props = (
  | {
      purpose: AdminReauthIntent["purpose"];
      targetId: string;
      intentFingerprint?: string;
      purposes?: never;
    }
  | {
      purposes: readonly [
        AdminReauthIntent & { purpose: "credentials.import" },
        AdminReauthIntent & { purpose: "transit.credentials" },
      ];
      purpose?: never;
      targetId?: never;
      intentFingerprint?: never;
    }
) & { onCompleted: (proofs: AdminReauthProofRef[]) => void; onClose: () => void };
export function AdminReauthenticationDialog(props: Props) {
  const t = useTranslations("adminUsers");
  const tCommon = useTranslations("common");
  const requestExit = useAdminDraftExit();
  const { apiUrl, actorId } = useAccountAdmin(),
    requests: AdminReauthIntent[] = props.purposes
      ? [...props.purposes]
      : [
          {
            purpose: props.purpose,
            targetId: props.targetId,
            ...(props.intentFingerprint ? { intentFingerprint: props.intentFingerprint } : {}),
          },
        ],
    identity = intentKey(requests),
    ownerKey = JSON.stringify([apiUrl, actorId, identity]),
    [prepared, setPrepared] = useState<{ ownerKey: string; value: StoredAdminReauth } | null>(null);
  const previous =
      prepared?.ownerKey === ownerKey ? prepared.value : readStoredAdminReauthentication(apiUrl),
    stored =
      previous &&
      intentKey(previous.requests) === identity &&
      Date.parse(previous.expiresAt) > Date.now()
        ? previous
        : null;
  const clearMatching = () => {
    const current = readStoredAdminReauthentication(apiUrl);
    if (current && intentKey(current.requests) === identity)
      sessionStorage.removeItem(adminReauthStorageKey(apiUrl));
    setPrepared(null);
  };
  const start = useAccountAction<StoredAdminReauth>(identity, {
    onSuccess: (value) => setPrepared({ ownerKey, value }),
  });
  const confirm = useAccountAction<AdminReauthProofRef[]>(identity, {
    onSuccess: (proofs) => {
      clearMatching();
      props.onCompleted(proofs);
    },
    onError: clearMatching,
  });
  const close = () => {
    start.invalidateOwner();
    confirm.invalidateOwner();
    clearMatching();
    props.onClose();
  };
  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{t("confirmYourAdministratorSignIn")}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("signInAgainToAuthorize")}</DialogContentText>
        {(start.error || confirm.error) && (
          <Alert severity="error">{t("couldNotConfirmAdministratorSign")}</Alert>
        )}
        {stored?.phase === "completed" && (
          <Alert severity="success">{t("signInVerifiedReviewAnd")}</Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{tCommon("cancel")}</Button>
        {stored?.phase === "completed" ? (
          <Button
            disabled={confirm.isPending}
            onClick={() =>
              confirm.mutate(async () => {
                const current = readStoredAdminReauthentication(apiUrl);
                if (
                  !current ||
                  intentKey(current.requests) !== identity ||
                  JSON.stringify(current.challengeIds) !== JSON.stringify(stored.challengeIds)
                )
                  throw new AdminDisplayError(t("administratorActionChanged"));
                await completeStoredAdminReauthentication(apiUrl);
                return stored.challengeIds.map((challengeId) => ({ challengeId }));
              })
            }
          >
            {t("continueWithVerifiedSignIn")}
          </Button>
        ) : stored ? (
          <Button
            component="a"
            href="/auth/admin"
            onClick={async (event) => {
              event.preventDefault();
              if (
                await requestExit(
                  t("administratorReauthenticationLeavesThisPage"),
                  "reauthentication",
                )
              )
                navigateAdminDocument("/auth/admin", "reauthentication");
            }}
          >
            {t("signInAgain")}
          </Button>
        ) : (
          <Button
            disabled={start.isPending}
            onClick={() => start.mutate(() => startStoredAdminReauthentication(apiUrl, requests))}
          >
            {t("prepareSignIn")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function intentKey(requests: readonly AdminReauthIntent[]) {
  return JSON.stringify(
    requests.map(({ purpose, targetId, intentFingerprint }) => [
      purpose,
      targetId,
      intentFingerprint ?? null,
    ]),
  );
}
