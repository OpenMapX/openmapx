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

  const ref = useMemo(() => parseOsmElementId(osmId), [osmId]);

  // Returning from the OAuth consent screen reopens the flow. The marker is a
  // boolean only — the element reference and draft are never in the URL.
  useEffect(() => {
    if (consumeContributeCallbackMarker()) setEditorOpen(true);
  }, []);

  if (!osmContributionsEnabled || !ref) return null;

  const handleClick = () => {
    if (!session?.user) {
      setAuthOpen(true);
      return;
    }
    setEditorOpen(true);
  };

  const closeAuth = () => {
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

      <AuthDialog open={authOpen} onClose={closeAuth} />
      {editorOpen && session?.user && (
        <OsmContributionDialog open ref_={ref} onClose={closeEditor} />
      )}
    </>
  );
}
