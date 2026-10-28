"use client";

import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { IntegrationApplyReceipt } from "@openmapx/core/api-contracts";
import type { CredentialSetup } from "@openmapx/integration-framework";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { CredentialSetupGuide } from "./CredentialSetupGuide";

interface SetCredentialDialogProps {
  open: boolean;
  onClose: () => void;
  integrationId: string;
  credentialKey: string;
  title: string;
  description?: string;
  setup?: CredentialSetup;
  expectedRevision?: string;
}

export function SetCredentialDialog({
  open,
  onClose,
  integrationId,
  credentialKey,
  title,
  description,
  setup,
  expectedRevision,
}: SetCredentialDialogProps) {
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(
    admin.client,
    JSON.stringify([integrationId, credentialKey, open]),
  );

  const draft = useRef<{ scope: string; revision?: string; value: string; key: string } | null>(
    null,
  );
  const scope = JSON.stringify([admin.apiUrl, integrationId, credentialKey, open]);
  if (draft.current?.scope !== scope)
    draft.current = { scope, revision: expectedRevision, value: "", key: crypto.randomUUID() };
  const [receipt, setReceipt] = useState<IntegrationApplyReceipt | null>(null);
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.current?.scope !== scope) return;
    setReceipt(null);
    setValue("");
    setError(null);
    setShowValue(false);
  }, [scope]);

  const mutation = useMutation({
    mutationKey: ["integration-credential", admin.apiUrl, integrationId, credentialKey, open],
    retry: false,
    mutationFn: async () => {
      try {
        if (!draft.current?.revision) throw Error("Refresh credential metadata before saving.");
        const revision = draft.current.revision;
        if (draft.current.value !== value)
          draft.current = { ...draft.current, value, key: crypto.randomUUID() };
        const applied = await admin.setCredential(
          integrationId,
          credentialKey,
          value,
          revision,
          draft.current.key,
        );
        void admin.refresh();
        if (!owner.active) return;
        setValue("");
        if (draft.current?.scope === scope) draft.current.value = "";
        setShowValue(false);
        setError(null);
        if (applied.runtime === "applied") onClose();
        else setReceipt(applied);
      } catch (err) {
        if (owner.active)
          setError(err instanceof Error ? err.message : "Failed to save credential");
        throw err;
      }
    },
  });

  function handleClose() {
    if (mutation.isPending) return;
    setValue("");
    setShowValue(false);
    setError(null);
    onClose();
  }

  function handleSave() {
    if (!value.trim()) {
      setError("Value cannot be empty");
      return;
    }
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Set Credential — {title}</DialogTitle>
      <DialogContent>
        <Stack
          sx={{
            gap: 2,
            pt: 1,
          }}
        >
          {receipt && (
            <Alert severity={receipt.runtime === "failed" ? "warning" : "info"}>
              {receipt.runtime === "failed"
                ? "Credential saved. Provider reload failed; the previous provider remains active."
                : "Credential saved. Activation is pending or requires reconciliation. Review the operation before retrying."}
            </Alert>
          )}
          {description && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {description}
            </Typography>
          )}
          {setup && <CredentialSetupGuide setup={setup} defaultExpanded />}
          <TextField
            label={title}
            type={showValue ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={mutation.isPending || !!receipt}
            error={!!error}
            helperText={error}
            autoComplete="new-password"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowValue((v) => !v)}
                      edge="end"
                      size="small"
                      tabIndex={-1}
                    >
                      {showValue ? (
                        <VisibilityOffIcon fontSize="small" />
                      ) : (
                        <VisibilityIcon fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={mutation.isPending}>
          {receipt ? "Done" : "Cancel"}
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={mutation.isPending || !value.trim() || !draft.current?.revision || !!receipt}
          startIcon={mutation.isPending ? <CircularProgress size={14} /> : undefined}
        >
          Save Credential
        </Button>
      </DialogActions>
    </Dialog>
  );
}
