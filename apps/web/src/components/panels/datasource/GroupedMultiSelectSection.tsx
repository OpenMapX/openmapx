"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { BRAND } from "@/integration-api/runtime/theme";

export interface GroupedMultiSelectGroup {
  label: string;
  icon: React.ReactNode;
  optionIds: (string | number)[];
  optionLabels: string[];
}

export function GroupedMultiSelectSection({
  label,
  groups,
  selected,
  onToggle,
  tintIcons = false,
}: {
  label: string;
  groups: GroupedMultiSelectGroup[];
  selected: (string | number)[];
  onToggle: (optionIds: (string | number)[]) => void;
  tintIcons?: boolean;
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
        {label}
      </Typography>
      <List dense disablePadding>
        {groups.map((group) => {
          const allSelected = group.optionIds.every((id) => selected.includes(id));
          return (
            <ListItemButton
              key={`${group.label}:${group.optionIds.join(",")}`}
              onClick={() => onToggle(group.optionIds)}
              selected={allSelected}
              aria-pressed={allSelected}
              sx={{
                borderRadius: 1,
                mb: 0.25,
                py: 0.5,
                ...(allSelected && {
                  bgcolor: `${BRAND}14`,
                  "&.Mui-selected": {
                    bgcolor: `${BRAND}14`,
                    "&:hover": { bgcolor: `${BRAND}22` },
                  },
                }),
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 32,
                  ...(tintIcons ? { color: allSelected ? BRAND : "text.secondary" } : {}),
                }}
              >
                {group.icon}
              </ListItemIcon>
              <ListItemText
                primary={group.label}
                slotProps={{
                  primary: {
                    variant: "body2",
                    sx: {
                      fontWeight: allSelected ? 600 : 400,
                      color: allSelected ? BRAND : "text.primary",
                    },
                  },
                }}
              />
              {group.optionLabels.length > 1 && (
                <Tooltip title={group.optionLabels.join(", ")} placement="right" arrow>
                  <InfoOutlinedIcon sx={{ fontSize: 16, color: "text.disabled", ml: 0.5 }} />
                </Tooltip>
              )}
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}
