"use client";

import EditLocationAltOutlinedIcon from "@mui/icons-material/EditLocationAltOutlined";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { parseOsmElementId, useCapabilities, useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { consumeContributeCallbackMarker, OsmContributionDialog } from "./OsmContributionDialog";
import { callbackUrlFor } from "./OsmContributionGate";

interface Props {
  /** The canonical `Place.ids.osm` value, or undefined when the place has none. */
  osmId: string | undefined;
}

/**
 * The contribution entry point.
 *
 * It accepts only the canonical OSM reference: every editable value comes from
 * the server's live element read, so no merged or enriched `Place` property can
 * ever prefill an editor control.
 */
export function OsmContributionEntry({ osmId }: Props) {
  const t = useTranslations("osmContributions");
  const { osmContributionsEnabled } = useCapabilities();
  const { data: session } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const entryRef = useRef<HTMLDivElement>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [callbackPath, setCallbackPath] = useState<string>();

  const ref = useMemo(() => parseOsmElementId(osmId), [osmId]);
  const refKey = ref ? `${ref.type}/${ref.id}` : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new place cancels the previous flow
  useEffect(() => {
    setPendingRef(null);
    setAuthOpen(false);
    setEditorOpen(false);
  }, [refKey]);

  useEffect(() => {
    if (pendingRef && pendingRef === refKey && session?.user && osmContributionsEnabled) {
      setPendingRef(null);
      setAuthOpen(false);
      setEditorOpen(true);
    }
  }, [pendingRef, refKey, session?.user, osmContributionsEnabled]);

  // Returning from the OAuth consent screen reopens the flow. The marker is a
  // boolean only — the public place link is retained, but no draft enters the URL.
  useEffect(() => {
    if (consumeContributeCallbackMarker()) setEditorOpen(true);
  }, []);

  if (!osmContributionsEnabled || !ref) return null;

  const handleClick = () => {
    if (!session?.user) {
      setPendingRef(refKey);
      const callback = new URL(callbackUrlFor(window.location.href));
      callback.searchParams.set("place", `osm:${ref.type}:${ref.id}`);
      setCallbackPath(`${callback.pathname}${callback.search}${callback.hash}`);
      setAuthOpen(true);
      return;
    }
    setEditorOpen(true);
  };

  const closeAuth = () => {
    setPendingRef(null);
    setAuthOpen(false);
    entryRef.current?.focus();
  };

  const closeEditor = () => {
    setEditorOpen(false);
    entryRef.current?.focus();
  };

  return (
    <>
      <ListItemButton
        ref={entryRef}
        onClick={handleClick}
        sx={{ minHeight: 44, borderRadius: 1 }}
        data-testid="osm-contribution-entry"
      >
        <ListItemIcon sx={{ minWidth: 40 }}>
          <EditLocationAltOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={t("entry")} secondary={t("entryDescription")} />
      </ListItemButton>

      <AuthDialog
        open={authOpen}
        onClose={closeAuth}
        onAuthenticated={() => setAuthOpen(false)}
        callbackPath={callbackPath}
      />
      {editorOpen && session?.user && (
        <OsmContributionDialog open ref_={ref} onClose={closeEditor} />
      )}
    </>
  );
}
