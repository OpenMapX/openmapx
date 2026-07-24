"use client";

import Box from "@mui/material/Box";
import ListItemButton from "@mui/material/ListItemButton";
import Typography from "@mui/material/Typography";
import type { SearchIntent } from "@openmapx/integration-framework";
import { useTranslations } from "next-intl";
import { AiBadge } from "@/components/ui/AiBadge";
import { BRAND } from "@/lib/theme";

interface NlpSearchCardProps {
  intent: SearchIntent;
  provider: string;
  onActivate: () => void;
}

export function NlpSearchCard({ intent, provider, onActivate }: NlpSearchCardProps) {
  const t = useTranslations("search");

  return (
    <ListItemButton
      onClick={onActivate}
      sx={{
        alignItems: "flex-start",
        gap: 1,
        borderLeft: `3px solid ${BRAND}`,
        bgcolor: "rgba(0,128,128,0.06)",
      }}
    >
      <Box sx={{ flex: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <AiBadge />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {intent.explanation}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t("aiPoweredSearch")} · {provider}
        </Typography>
      </Box>
    </ListItemButton>
  );
}
