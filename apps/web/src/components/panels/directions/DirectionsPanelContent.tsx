"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Snackbar from "@mui/material/Snackbar";
import type { TravelMode } from "@openmapx/core";
import { useDirectionsStore } from "@openmapx/core";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { PhoneWaypointCard } from "@/components/panels/directions/PhoneWaypointCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import { TimeModePicker } from "@/components/panels/directions/TimeModePicker";
import { WaypointList } from "@/components/panels/directions/WaypointList";
import { WaypointScheduleDialog } from "@/components/panels/directions/WaypointScheduleDialog";
import { useExpandOnBackgroundTap, useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { DirectionsPanelHeader } from "./DirectionsPanelHeader";
import { DirectionsResults } from "./DirectionsResults";
import { isTimedGroundMode } from "./directionsRequests";
import { GroundRouteDetails } from "./GroundRouteResults";
import { OptimizeStopsRow } from "./OptimizeStopsRow";
import { openTransitItinerary, TransitItineraryDetails } from "./TransitItineraryResults";
import { DrivingKindRow, TravelModeRow, travelModeButtons } from "./TravelModeRow";
import { TripTimeChip } from "./TripTimeChip";
import { useDirectionsDetailsNavigation } from "./useDirectionsDetailsNavigation";
import { useGroundDirectionsPlan } from "./useGroundDirectionsPlan";
import { useRouteRecovery } from "./useRouteRecovery";
import { useTransitDirectionsPlan } from "./useTransitDirectionsPlan";
import { useTripTimeControl } from "./useTripTimeControl";
import { useWaypointFields } from "./useWaypointFields";
import { WaypointSuggestions } from "./WaypointSuggestions";

export function DirectionsPanelContent() {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { inSheet } = useMobileSheet();
  const expandOnBackgroundTap = useExpandOnBackgroundTap();
  const { waypoints, mode, isEvMode } = useDirectionsStore(
    useShallow((s) => ({ waypoints: s.waypoints, mode: s.mode, isEvMode: s.isEvMode })),
  );
  const transitOptions = useDirectionsStore(
    useShallow((s) => ({
      timeMode: s.transitTimeMode,
      transitDepartureTime: s.transitDepartureTime,
      transitArrivalTime: s.transitArrivalTime,
      transitPreferredModes: s.transitPreferredModes,
      transitRoutePreference: s.transitRoutePreference,
      transitAccessMode: s.transitAccessMode,
      wheelchairRequired: s.wheelchairRequired,
      maxTransfers: s.maxTransfers,
      transferBuffer: s.transferBuffer,
      requireBikeTransport: s.requireBikeTransport,
      bikeHillPreference: s.bikeHillPreference,
      deutschlandticketOnly: s.deutschlandticketOnly,
    })),
  );
  const isTransitMode = mode === "transit";
  const ground = useGroundDirectionsPlan();
  const transit = useTransitDirectionsPlan({
    enabled: isTransitMode,
    waypoints,
    ...transitOptions,
  });
  const details = useDirectionsDetailsNavigation();
  const fields = useWaypointFields();
  const time = useTripTimeControl(isTransitMode);
  const [showOptions, setShowOptions] = useState(false);
  const [snackbar, setSnackbar] = useState<string | null>(null);

  const { selectionToOpen } = transit;
  const { openTransit } = details;
  useEffect(() => {
    if (selectionToOpen)
      openTransit({
        identity: selectionToOpen.queryIdentity,
        itinerary: selectionToOpen.itinerary,
      });
  }, [selectionToOpen, openTransit]);

  const switchMode = (nextMode: TravelMode) => {
    useDirectionsStore.getState().setMode(nextMode);
    details.leave();
  };
  const recovery = useRouteRecovery({ focusWaypoint: fields.focusWaypoint, switchMode });

  const transitDetails = openTransitItinerary(transit, details);
  if (transitDetails) {
    return (
      <TransitItineraryDetails transit={transit} itinerary={transitDetails} details={details} />
    );
  }
  const detailsRoute =
    details.routeIndex !== null ? ground.displayed?.routes[details.routeIndex] : undefined;
  if (detailsRoute) {
    return (
      <GroundRouteDetails
        route={detailsRoute}
        provider={ground.displayed?.provider}
        onBack={details.closeRoute}
      />
    );
  }

  const modeButtons = travelModeButtons({
    mode,
    activeRecord: isTransitMode ? transit.itineraries[0] : ground.directions.data?.routes[0],
    activeLoading: isTransitMode ? transit.planQuery.isLoading : ground.directionsQuery.isLoading,
    cachedDuration: ground.cachedDuration,
    locale,
  });
  // Rows that describe driving the route yourself (time picker, avoid options,
  // share, optimize) do not apply when someone else is doing the driving.
  const hidesRouteControls = mode === "flying" || mode === "ride";
  // The depart/arrive picker is shared by transit and timed driving.
  const showTimePicker = isTransitMode || isTimedGroundMode(mode);
  // In a phone's sheet the driving switch and the departure time share a row.
  const timeInModeRow = inSheet && mode === "driving" && showTimePicker;
  const timeChip = (
    <TripTimeChip
      mode={time.mode}
      value={time.value}
      open={time.pickerOpen}
      onToggle={time.togglePicker}
    />
  );

  const waypointList = (
    <Box ref={fields.listRef}>
      <WaypointList
        waypoints={waypoints}
        inputValues={fields.inputValues}
        onInputChange={fields.onInputChange}
        onFocus={fields.onFocus}
        onBlur={fields.onBlur}
        onReorder={useDirectionsStore.getState().reorderWaypoints}
        onAdd={useDirectionsStore.getState().addWaypoint}
        onRemove={fields.onRemove}
        onReverse={useDirectionsStore.getState().reverseWaypoints}
        onUseMyLocation={fields.onUseMyLocation}
        onEditSchedule={isEvMode || mode === "flying" ? undefined : fields.editSchedule}
        isEvMode={isEvMode}
        onFieldPress={inSheet ? fields.openStopSearch : undefined}
        t={t}
      />
    </Box>
  );
  const scheduleIndex = fields.scheduleEditIndex;
  const scheduleWaypoint = scheduleIndex !== null ? waypoints[scheduleIndex] : undefined;

  return (
    // Tapping the collapsed sheet's background opens it to mid. Keyboard users
    // change the sheet's height from the focusable sheet itself.
    // biome-ignore lint/plugin/noClickableLayoutElement: background tap, not an action
    <Box onClick={expandOnBackgroundTap}>
      <DirectionsPanelHeader
        showRouteControls={!hidesRouteControls}
        canShare={ground.allWaypointsFilled}
        optionsOpen={showOptions}
        onToggleOptions={() => setShowOptions((v) => !v)}
        onNotify={setSnackbar}
      />
      <TravelModeRow buttons={modeButtons} onSelect={switchMode} />
      {mode === "driving" && (
        <DrivingKindRow
          isEvMode={isEvMode}
          inSheet={inSheet}
          timeChip={timeInModeRow ? timeChip : null}
          onChange={(ev) => {
            useDirectionsStore.getState().setEvMode(ev);
            details.leave();
          }}
        />
      )}
      {/* Waypoint list with drag-and-drop: in the panel, or above the map on a phone. */}
      {inSheet ? <PhoneWaypointCard>{waypointList}</PhoneWaypointCard> : waypointList}
      <Box sx={{ position: "relative" }}>
        <Divider />
        <OptimizeStopsRow
          routeWaypoints={ground.routeWaypoints}
          allWaypointsFilled={ground.allWaypointsFilled}
          onNotify={setSnackbar}
        />
        {/* Flight and ride modes render their own forms below, so this row is hidden. */}
        {!hidesRouteControls && showTimePicker && !timeInModeRow && (
          <Box sx={{ display: "flex", alignItems: "center", px: 2, py: 1 }}>{timeChip}</Box>
        )}
        {showTimePicker && time.pickerOpen && (
          <TimeModePicker
            timeMode={time.mode}
            value={time.value}
            onTimeModeChange={time.changeMode}
            onValueChange={time.changeValue}
          />
        )}
        {showOptions && !hidesRouteControls && <RouteOptions />}
        <Divider />
        <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
          <AttributionStrip
            attributions={snapshotContributors(...modeButtons.map((b) => b.contributors))}
            provenanceDisplay="details"
          />
          <DirectionsResults
            ground={ground}
            transit={transit}
            recovery={recovery}
            details={details}
            onNotify={setSnackbar}
          />
        </AttributionDetailsGroup>
        {fields.showSuggestions && !inSheet && (
          <WaypointSuggestions
            suggestions={fields.suggestions}
            query={fields.suggestionQuery}
            userLocation={fields.userLocation}
            onSelect={fields.selectSuggestion}
          />
        )}
      </Box>
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar}
      />
      {scheduleIndex !== null && scheduleWaypoint?.coords && (
        <WaypointScheduleDialog
          open
          waypointLabel={scheduleWaypoint.label}
          coords={scheduleWaypoint.coords}
          schedule={scheduleWaypoint.schedule}
          onSave={(schedule) =>
            useDirectionsStore.getState().setWaypointSchedule(scheduleIndex, schedule)
          }
          onClose={() => fields.editSchedule(null)}
        />
      )}
    </Box>
  );
}
