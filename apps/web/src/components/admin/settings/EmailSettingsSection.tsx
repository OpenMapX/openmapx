"use client";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { type ReactNode, useEffect, useState } from "react";
export type EmailProvider = "emaillabs" | "lettermint" | "smtp";
export const EMAIL_PROVIDER_NAMES = {
  emaillabs: "EmailLabs",
  lettermint: "Lettermint",
  smtp: "SMTP",
};
const present = (value: unknown) => typeof value === "string" && value.length > 0;
export function configuredEmailProvider(
  provider: string | undefined,
  values: Record<string, unknown>,
) {
  if (provider === "emaillabs")
    return ["emailLabsAppKey", "emailLabsSecretKey", "emailLabsSmtpAccount"].every((key) =>
      present(values[key]),
    );
  if (provider === "lettermint") return present(values.lettermintApiToken);
  return provider === "smtp" && present(values.smtpHost);
}
/** Mirrors saved-field precedence, never a delivery-health claim or a provider switch. */
export function savedEmailProvider(values: Record<string, unknown>): EmailProvider {
  return configuredEmailProvider("emaillabs", values)
    ? "emaillabs"
    : configuredEmailProvider("lettermint", values)
      ? "lettermint"
      : "smtp";
}
export function EmailSettingsSection({
  provider,
  label,
  description,
  focused,
  selected,
  configured,
  children,
}: {
  provider?: string;
  label?: string;
  description?: string;
  focused: boolean;
  selected: boolean;
  configured: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(selected);
  useEffect(() => {
    if (focused) setExpanded(true);
  }, [focused]);
  if (!provider || !["emaillabs", "lettermint", "smtp"].includes(provider))
    return <Stack sx={{ gap: 1.25 }}>{children}</Stack>;
  return (
    <Box
      component="details"
      open={expanded}
      onToggle={(event) => setExpanded((event.currentTarget as HTMLDetailsElement).open)}
      sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.5 }}
    >
      <Box
        component="summary"
        sx={{ cursor: "pointer", minHeight: 28, fontSize: 14, fontWeight: 600 }}
      >
        {label}{" "}
        <Chip
          size="small"
          variant="outlined"
          label={selected ? "Saved provider" : configured ? "Configured" : "Optional"}
          sx={{ ml: 0.75 }}
        />
      </Box>
      {description && (
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 0.75, mb: 1.5 }}
        >
          {description}
        </Typography>
      )}
      {children}
    </Box>
  );
}
