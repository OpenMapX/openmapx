"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { DomainChip } from "../integrations/DomainChip";
import { StatusBadge } from "../integrations/StatusBadge";

export interface StoreCatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  version: string;
  minPlatform: string;
  domains: string[];
  quality: "community-verified" | "community";
  tags: string[];
  lastUpdated: string;
  compatible: boolean;
  installed: boolean;
  installedVersion: string | null;
  hasUpdate: boolean;
}

interface StoreCardProps {
  entry: StoreCatalogEntry;
  onSelect: (entry: StoreCatalogEntry) => void;
  onInstall?: (entry: StoreCatalogEntry) => void;
}

export function StoreCard({ entry, onSelect, onInstall }: StoreCardProps) {
  const handleInstall = (e: React.MouseEvent) => {
    e.stopPropagation();
    onInstall?.(entry);
  };

  return (
    <Card
      variant="outlined"
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        transition: "box-shadow 0.15s",
        "&:hover": { boxShadow: 3 },
      }}
    >
      <CardActionArea onClick={() => onSelect(entry)} sx={{ flex: 1, alignItems: "flex-start" }}>
        <CardContent sx={{ pb: 1 }}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={0.5}>
            <Typography variant="subtitle2" fontWeight={700} lineHeight={1.3}>
              {entry.name}
            </Typography>
            <StatusBadge quality={entry.quality} />
          </Stack>

          <Typography variant="caption" color="text.secondary" display="block" mb={1}>
            by {entry.author}
          </Typography>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              mb: 1.5,
              minHeight: "2.6em",
            }}
          >
            {entry.description}
          </Typography>

          <Stack direction="row" flexWrap="wrap" gap={0.5} mb={1.5}>
            {entry.domains.map((d) => (
              <DomainChip key={d} domain={d} />
            ))}
          </Stack>

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="caption" color="text.secondary">
              v{entry.version}
            </Typography>

            {!entry.compatible && (
              <Tooltip title={`Requires platform ≥ ${entry.minPlatform}`}>
                <Box display="flex" alignItems="center" gap={0.5} color="warning.main">
                  <WarningAmberIcon sx={{ fontSize: "0.9rem" }} />
                  <Typography variant="caption" color="warning.main">
                    Incompatible
                  </Typography>
                </Box>
              </Tooltip>
            )}
          </Stack>
        </CardContent>
      </CardActionArea>

      <Box px={2} pb={2}>
        {entry.installed && !entry.hasUpdate && (
          <Button
            fullWidth
            size="small"
            variant="outlined"
            color="success"
            startIcon={<CheckCircleIcon />}
            disabled
          >
            Installed
          </Button>
        )}
        {entry.installed && entry.hasUpdate && (
          <Button
            fullWidth
            size="small"
            variant="contained"
            color="warning"
            startIcon={<SystemUpdateAltIcon />}
            onClick={handleInstall}
          >
            Update Available
          </Button>
        )}
        {!entry.installed && (
          <Button
            fullWidth
            size="small"
            variant="contained"
            disabled={!entry.compatible}
            onClick={handleInstall}
          >
            Install
          </Button>
        )}
      </Box>
    </Card>
  );
}
