"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useState } from "react";

interface Props {
  packageName: string;
  version: string;
  license: string;
  text: string;
  triggerLabel: string;
  dialogTitle: string;
  closeLabel: string;
}

export function LicenseTextDialog({ license, text, triggerLabel, dialogTitle, closeLabel }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="small"
        variant="text"
        onClick={() => setOpen(true)}
        sx={{ textTransform: "none", minWidth: 0 }}
      >
        {triggerLabel}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ pr: 6 }}>
          <Typography component="span" sx={{ fontWeight: 600 }}>
            {dialogTitle}
          </Typography>
          <Typography component="span" color="text.secondary" sx={{ ml: 1, fontSize: 14 }}>
            ({license})
          </Typography>
          <IconButton
            aria-label={closeLabel}
            onClick={() => setOpen(false)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box
            component="pre"
            sx={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {text}
          </Box>
        </DialogContent>
      </Dialog>
    </>
  );
}
