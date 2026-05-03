"use client";

import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTranslations } from "next-intl";

const KBD_SX = {
  fontFamily: "monospace",
  fontSize: 11,
  px: 0.5,
  py: 0.1,
  border: 1,
  borderColor: "divider",
  borderRadius: 0.5,
  color: "text.secondary",
} as const;

export function CommandPaletteFooter() {
  const t = useTranslations("commandPalette");
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down("sm"));
  if (isXs) return null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        px: 2,
        py: 0.75,
        borderTop: 1,
        borderColor: "divider",
        bgcolor: "background.default",
      }}
    >
      <FooterHint kbd={["↑", "↓"]} label={t("footerNavigate")} />
      <FooterHint kbd={["↵"]} label={t("footerSelect")} />
      <FooterHint kbd={["⌘", "↵"]} label={t("footerSelectAndKeep")} />
      <FooterHint kbd={["esc"]} label={t("footerClose")} />
    </Box>
  );
}

function FooterHint({ kbd, label }: { kbd: string[]; label: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      {kbd.map((k) => (
        <Typography key={k} component="kbd" sx={KBD_SX}>
          {k}
        </Typography>
      ))}
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}
