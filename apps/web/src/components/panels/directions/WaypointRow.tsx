"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import CloseIcon from "@mui/icons-material/Close";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import type { Waypoint } from "@openmapx/core";
import { WaypointInput } from "@/components/panels/directions/WaypointInput";
import { BRAND } from "@/integration-api/runtime/theme";

interface WaypointRowProps {
  waypoint: Waypoint;
  index: number;
  total: number;
  inputValue: string;
  onInputChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onRemove: () => void;
  onUseMyLocation?: () => void;
  removeLabel: string;
  useMyLocationLabel?: string;
  placeholder: string;
}

export function WaypointRow({
  waypoint,
  index,
  total,
  inputValue,
  onInputChange,
  onFocus,
  onBlur,
  onRemove,
  onUseMyLocation,
  removeLabel,
  useMyLocationLabel,
  placeholder,
}: WaypointRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: waypoint.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const isOrigin = index === 0;
  const isDestination = index === total - 1;
  const canRemove = total > 2;
  const waypointNumber = index; // intermediates are 1-based, but origin is 0

  return (
    <Box ref={setNodeRef} style={style} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      {/* Marker icon column */}
      <Box
        sx={{
          width: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {isOrigin ? (
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "2px solid",
              borderColor: "text.secondary",
            }}
          />
        ) : isDestination ? (
          <LocationOnIcon sx={{ fontSize: 18, color: "#EA4335" }} />
        ) : (
          <Box
            sx={{
              width: 20,
              height: 20,
              borderRadius: "4px",
              bgcolor: BRAND,
              color: "#fff",
              fontWeight: 700,
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {waypointNumber}
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "8px",
          bgcolor: "action.hover",
          "&:focus-within": {
            borderColor: BRAND,
            bgcolor: "background.paper",
            boxShadow: `0 0 0 2px ${BRAND}22`,
          },
          transition: "box-shadow 0.15s",
        }}
      >
        <WaypointInput
          value={inputValue}
          placeholder={placeholder}
          onChange={onInputChange}
          onUseMyLocation={isOrigin ? onUseMyLocation : undefined}
          onFocus={onFocus}
          onBlur={onBlur}
          useMyLocationLabel={useMyLocationLabel}
        />
      </Box>

      {/* Remove button */}
      {canRemove && (
        <Tooltip title={removeLabel}>
          <IconButton
            size="small"
            onClick={onRemove}
            sx={{
              p: 0.25,
              flexShrink: 0,
              color: "text.disabled",
              "&:hover": { color: "text.secondary" },
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}

      {/* Drag handle */}
      <Box
        {...attributes}
        {...listeners}
        sx={{
          cursor: "grab",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          color: "text.disabled",
          "&:hover": { color: "text.secondary" },
          touchAction: "none",
        }}
      >
        <DragIndicatorIcon sx={{ fontSize: 18 }} />
      </Box>
    </Box>
  );
}
