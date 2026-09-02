"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutlined";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { Waypoint } from "@openmapx/core";
import type { useTranslations } from "next-intl";
import { WaypointRow } from "@/components/panels/directions/WaypointRow";
import { BRAND } from "@/integration-api/runtime/theme";

const MAX_WAYPOINTS = 10;

interface WaypointListProps {
  waypoints: Waypoint[];
  inputValues: string[];
  onInputChange: (index: number, value: string) => void;
  onFocus: (index: number) => void;
  onBlur: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onAdd: (afterIndex: number) => void;
  onRemove: (index: number) => void;
  onReverse: () => void;
  onUseMyLocation?: () => void;
  /** Opens the per-stop time editor. Omitted where schedules do not apply (EV). */
  onEditSchedule?: (index: number) => void;
  /** EV mode only supports origin + destination (see ev-plan.ts re-route assumption) — hides the add-stop affordance. */
  isEvMode?: boolean;
  t: ReturnType<typeof useTranslations>;
}

export function WaypointList({
  waypoints,
  inputValues,
  onInputChange,
  onFocus,
  onBlur,
  onReorder,
  onAdd,
  onRemove,
  onReverse,
  onUseMyLocation,
  onEditSchedule,
  isEvMode = false,
  t,
}: WaypointListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = waypoints.findIndex((w) => w.id === active.id);
    const newIndex = waypoints.findIndex((w) => w.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      onReorder(oldIndex, newIndex);
    }
  };

  const canAddMore = waypoints.length < MAX_WAYPOINTS && !isEvMode;

  return (
    <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
      <Box sx={{ display: "flex", alignItems: "stretch", gap: 0.5 }}>
        {/* Waypoint rows with drag and drop */}
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis]}
          >
            <SortableContext
              items={waypoints.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              {waypoints.map((wp, i) => (
                <WaypointRow
                  key={wp.id}
                  waypoint={wp}
                  index={i}
                  total={waypoints.length}
                  inputValue={inputValues[i] ?? ""}
                  onInputChange={(v) => onInputChange(i, v)}
                  onFocus={() => onFocus(i)}
                  onBlur={onBlur}
                  onRemove={() => onRemove(i)}
                  onUseMyLocation={onUseMyLocation}
                  onEditSchedule={onEditSchedule ? () => onEditSchedule(i) : undefined}
                  removeLabel={t("removeStop")}
                  useMyLocationLabel={t("useMyLocation")}
                  scheduleLabel={t("scheduleStop")}
                  scheduleEditLabel={t("scheduleEdit")}
                  placeholder={
                    i === 0
                      ? t("chooseOrigin")
                      : i === waypoints.length - 1
                        ? t("chooseDestination")
                        : `${t("addStop")} ${i}`
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        </Box>

        {/* Swap / reverse button */}
        <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
          <IconButton size="small" onClick={onReverse}>
            <SwapVertIcon sx={{ fontSize: 22 }} />
          </IconButton>
        </Box>
      </Box>
      {/* Add stop button */}
      {canAddMore && (
        <Box
          onClick={() => onAdd(waypoints.length - 2)}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            mt: 0.5,
            py: 0.75,
            px: 0.25,
            cursor: "pointer",
            color: "text.secondary",
            "&:hover": { color: BRAND },
          }}
        >
          <AddCircleOutlineIcon sx={{ fontSize: 18, ml: 3 }} />
          <Typography variant="body2">{t("addStop")}</Typography>
        </Box>
      )}
    </Box>
  );
}
