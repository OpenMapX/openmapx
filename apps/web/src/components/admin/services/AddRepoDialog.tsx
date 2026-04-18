"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useAddRepo, usePreviewRepo } from "@/hooks/useServiceRepos";
import { InstallPreview } from "./InstallPreview";

export function AddRepoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const preview = usePreviewRepo();
  const add = useAddRepo();

  const handlePreview = () => {
    preview.mutate(url);
  };

  const handleInstall = async () => {
    await add.mutateAsync(url);
    setUrl("");
    setAcknowledged(false);
    preview.reset();
    onClose();
  };

  const handleClose = () => {
    setUrl("");
    setAcknowledged(false);
    preview.reset();
    onClose();
  };

  const previewData = preview.data;
  const hasInvalid = previewData?.services.some((s) => s.validationErrors.length > 0);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>Add service repository</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Git URL"
            placeholder="https://github.com/someone/openmapx-services-foo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            fullWidth
            size="small"
          />
          <Button
            variant="outlined"
            onClick={handlePreview}
            disabled={!url || preview.isPending}
            sx={{ alignSelf: "flex-start" }}
          >
            {preview.isPending ? "Fetching…" : "Preview"}
          </Button>

          {preview.isError && <Alert severity="error">{(preview.error as Error).message}</Alert>}

          {previewData && (
            <>
              <InstallPreview services={previewData.services} />
              {!hasInvalid && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                  }
                  label="I understand that community services are not reviewed by OpenMapX and I take responsibility for the code I install."
                />
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!previewData || !acknowledged || !!hasInvalid || add.isPending}
          onClick={handleInstall}
        >
          {add.isPending ? <CircularProgress size={18} /> : "Install"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
