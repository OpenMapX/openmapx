import type { Waypoint } from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface WaypointDraft {
  text: string;
  /** The stored label the text was typed over; a different label supersedes the draft. */
  label: string;
}

export interface WaypointDrafts {
  /** What each field shows, in waypoint order: typed text, else the stored label. */
  values: string[];
  /** Record text typed into a waypoint's field without committing it to the store. */
  setDraft: (waypoint: Waypoint, text: string) => void;
  /** Forget a waypoint's typed text, so the field shows its stored label again. */
  clearDraft: (waypointId: string) => void;
  /** Whether the waypoint's field currently holds text the store does not have. */
  hasDraft: (waypointId: string) => boolean;
}

/**
 * Typed-but-uncommitted text for each directions field, kept per waypoint.
 *
 * Drafts are keyed by waypoint id, so they follow a stop through reorders and
 * reversals, disappear with a removed stop, and are not touched when another
 * waypoint changes (such as the origin being filled from a location fix). A
 * draft only stands while the stored label is the one it was typed over; once
 * something else writes a different label the stored value wins.
 */
export function useWaypointDrafts(waypoints: Waypoint[]): WaypointDrafts {
  const [drafts, setDrafts] = useState<Record<string, WaypointDraft>>({});

  const effective = useMemo(() => {
    const standing: Record<string, WaypointDraft> = {};
    for (const waypoint of waypoints) {
      const draft = drafts[waypoint.id];
      if (draft && draft.label === waypoint.label) standing[waypoint.id] = draft;
    }
    return standing;
  }, [drafts, waypoints]);

  const standingRef = useRef(effective);
  useEffect(() => {
    standingRef.current = effective;
    // Drop what no longer stands so an old draft cannot return if its label does.
    setDrafts((current) =>
      Object.keys(current).length === Object.keys(effective).length ? current : effective,
    );
  }, [effective]);

  const values = useMemo(
    () => waypoints.map((waypoint) => effective[waypoint.id]?.text ?? waypoint.label),
    [effective, waypoints],
  );

  const setDraft = useCallback((waypoint: Waypoint, text: string) => {
    setDrafts((current) => {
      if (text === waypoint.label) {
        if (!(waypoint.id in current)) return current;
        const { [waypoint.id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [waypoint.id]: { text, label: waypoint.label } };
    });
  }, []);

  const clearDraft = useCallback((waypointId: string) => {
    setDrafts((current) => {
      if (!(waypointId in current)) return current;
      const { [waypointId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const hasDraft = useCallback((waypointId: string) => waypointId in standingRef.current, []);

  return { values, setDraft, clearDraft, hasDraft };
}
