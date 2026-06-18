"use client";

import EmailIcon from "@mui/icons-material/Email";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import HelpOutlineIcon from "@mui/icons-material/InfoOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { safeHref } from "@openmapx/core";
import type { CredentialSetup } from "@openmapx/integration-framework";
import { useState } from "react";

interface CredentialSetupGuideProps {
  setup: CredentialSetup;
  /** Start with the step list expanded (used in the focused Set-credential dialog). */
  defaultExpanded?: boolean;
}

/** Build a `mailto:` URI with the subject/body pre-filled. */
function buildMailto(email: NonNullable<CredentialSetup["email"]>): string {
  const params = new URLSearchParams();
  if (email.subject) params.set("subject", email.subject);
  if (email.body) params.set("body", email.body);
  const query = params.toString();
  // URLSearchParams encodes spaces as "+"; mail clients expect %20 in the body.
  return `mailto:${email.to}${query ? `?${query.replace(/\+/g, "%20")}` : ""}`;
}

/**
 * Operator-facing "how to obtain this API key" helper rendered next to a
 * credential input. Surfaces the registration URL, a pre-written request email,
 * a free-tier/pricing hint, and a collapsible step-by-step guide — all sourced
 * from the manifest's `x-openmapx-setup` block.
 */
export function CredentialSetupGuide({
  setup,
  defaultExpanded = false,
}: CredentialSetupGuideProps) {
  const hasSteps = !!setup.steps?.length;
  const [open, setOpen] = useState(defaultExpanded);

  // Run the manifest-authored URL through the shared href sanitiser (blocks
  // javascript:/data: and other unsafe schemes) before it becomes a clickable
  // link in the admin panel — same treatment as every other data-sourced URL.
  const url = safeHref(setup.url);

  // Nothing actionable — render nothing rather than an empty shell.
  if (!url && !setup.email && !setup.cost && !setup.notes && !hasSteps) {
    return null;
  }

  return (
    <Box
      sx={{
        mt: 0.75,
        p: 1,
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
        bgcolor: "action.hover",
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 0.75,
          flexWrap: "wrap",
        }}
      >
        {url && (
          <Button
            size="small"
            variant="contained"
            color="primary"
            component={Link}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            startIcon={<OpenInNewIcon />}
            sx={{ textTransform: "none" }}
          >
            {setup.urlLabel ?? "Get API key"}
          </Button>
        )}
        {setup.email && (
          <Button
            size="small"
            variant="outlined"
            component={Link}
            href={buildMailto(setup.email)}
            startIcon={<EmailIcon />}
            sx={{ textTransform: "none" }}
          >
            Email request
          </Button>
        )}
        {setup.cost && <Chip label={setup.cost} size="small" color="success" variant="outlined" />}
        {hasSteps && (
          <Button
            size="small"
            variant="text"
            onClick={() => setOpen((v) => !v)}
            startIcon={<HelpOutlineIcon />}
            endIcon={
              <ExpandMoreIcon
                sx={{
                  transition: "transform 150ms",
                  transform: open ? "rotate(180deg)" : "none",
                }}
              />
            }
            sx={{ textTransform: "none" }}
          >
            How to get this key
          </Button>
        )}
      </Stack>
      {setup.notes && (
        <Typography
          variant="caption"
          sx={{
            display: "block",
            color: "text.secondary",
            mt: 0.75,
          }}
        >
          {setup.notes}
        </Typography>
      )}
      {hasSteps && (
        <Collapse in={open} unmountOnExit>
          <Box
            component="ol"
            sx={{
              m: 0,
              mt: 1,
              pl: 2.5,
              display: "flex",
              flexDirection: "column",
              gap: 0.5,
            }}
          >
            {setup.steps?.map((step, i) => (
              // Steps are static, manifest-authored, and order-bearing — index keys are correct here.
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered static list
              <Typography key={i} component="li" variant="body2" sx={{ color: "text.secondary" }}>
                {step}
              </Typography>
            ))}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}
