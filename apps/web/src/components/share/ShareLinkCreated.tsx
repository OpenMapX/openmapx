"use client";

import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { shareUrl } from "@/lib/deepLink";

/** One-time display of a freshly minted share URL with copy + system share. */
export function ShareLinkCreated({ token }: { token: string }) {
  const t = useTranslations("share");
  const tCommon = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/s/${token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The field is selectable; manual copy still works.
    }
  };

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {t("linkReady")}
      </Typography>
      <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
        <TextField
          fullWidth
          size="small"
          value={url}
          slotProps={{ input: { readOnly: true } }}
          onFocus={(e) => e.target.select()}
        />
        <IconButton aria-label={t("copyLink")} onClick={copy}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
        <IconButton aria-label={tCommon("share")} onClick={() => void shareUrl({ url })}>
          <ShareIcon fontSize="small" />
        </IconButton>
      </Box>
      {copied && (
        <Typography variant="caption" sx={{ color: "success.main" }}>
          {tCommon("copied")}
        </Typography>
      )}
    </Box>
  );
}
