"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import CloseIcon from "@mui/icons-material/Close";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Waypoint } from "@openmapx/core";
import { WaypointInput } from "@/components/panels/directions/WaypointInput";
import { describeSchedule } from "@/components/panels/directions/WaypointScheduleDialog";
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
  onEditSchedule?: () => void;
  removeLabel: string;
  useMyLocationLabel?: string;
  scheduleLabel?: string;
  scheduleEditLabel?: string;
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
  onEditSchedule,
  removeLabel,
  useMyLocationLabel,
  scheduleLabel,
  scheduleEditLabel,
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
  // The stop's wall clock is already local to it, so it is shown verbatim
  // rather than reformatted through the viewer's zone.
  const scheduleSummary = describeSchedule(waypoint.schedule, (wallClock) =>
    wallClock.slice(11, 16),
  );
  const waypointNumber = index; // intermediates are 1-based, but origin is 0

  const marker = isOrigin ? (
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
    <LocationOnIcon sx={{ fontSize: 20, color: "#EA4335" }} />
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
  );

  const scheduleButton = onEditSchedule && (
    <Tooltip title={scheduleSummary ? (scheduleEditLabel ?? "") : (scheduleLabel ?? "")}>
      <IconButton
        size="small"
        onClick={onEditSchedule}
        aria-label={
          scheduleSummary ? `${scheduleEditLabel ?? ""}: ${scheduleSummary}` : (scheduleLabel ?? "")
        }
        sx={{
          p: 0.25,
          flexShrink: 0,
          color: scheduleSummary ? BRAND : "text.secondary",
          // Inside the field and out of the way on an unconstrained trip: it
          // appears on hover, and keyboard focus still reaches it.
          display: scheduleSummary ? "inline-flex" : "none",
          "*:hover > * > &, *:focus-within > * > &": { display: "inline-flex" },
        }}
      >
        {scheduleSummary ? (
          <Typography variant="caption" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
            {scheduleSummary}
          </Typography>
        ) : (
          <ScheduleOutlinedIcon sx={{ fontSize: 18 }} />
        )}
      </IconButton>
    </Tooltip>
  );

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        "@media (hover: hover)": {
          "&:hover .waypoint-marker": { display: "none" },
          "&:hover .waypoint-grip": { display: "flex" },
        },
        "& .waypoint-handle:focus-visible .waypoint-marker": { display: "none" },
        "& .waypoint-handle:focus-visible .waypoint-grip": { display: "flex" },
      }}
    >
      {/* The marker doubles as the drag handle: hovering the row shows a grip
          in its place, and the whole column drags (or, focused, moves with the
          keyboard). */}
      <Box
        {...attributes}
        {...listeners}
        className="waypoint-handle"
        sx={{
          width: 24,
          height: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          cursor: "grab",
          touchAction: "none",
          borderRadius: 1,
          position: "relative",
          // A dotted line joins this stop's marker to the next one.
          ...(!isDestination && {
            "&::after": {
              content: '""',
              position: "absolute",
              left: "calc(50% - 1px)",
              top: 27,
              bottom: -13,
              borderLeft: "2px dotted",
              borderColor: "text.disabled",
              pointerEvents: "none",
            },
          }),
          "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
        }}
      >
        <Box className="waypoint-marker" sx={{ display: "flex" }}>
          {marker}
        </Box>
        <Box className="waypoint-grip" sx={{ display: "none", color: "text.secondary" }}>
          <DragIndicatorIcon sx={{ fontSize: 20 }} />
        </Box>
      </Box>

      {/* Input */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          border: "1px solid var(--omx-border)",
          borderRadius: "8px",
          bgcolor: "background.paper",
          "&:focus-within": {
            borderColor: BRAND,
            boxShadow: `inset 0 0 0 1px ${BRAND}`,
          },
          transition: "border-color 0.15s, box-shadow 0.15s",
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
          trailing={scheduleButton}
        />
      </Box>

      {/* Remove button */}
      {canRemove && (
        <Tooltip title={removeLabel}>
          <IconButton
            size="small"
            onClick={onRemove}
            aria-label={removeLabel}
            sx={{ p: 0.5, flexShrink: 0, color: "text.secondary" }}
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
