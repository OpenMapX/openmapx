"use client";

import EditLocationAltOutlinedIcon from "@mui/icons-material/EditLocationAltOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
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
  const entryRef = useRef<HTMLButtonElement>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [callbackPath, setCallbackPath] = useState<string>();

  const ref = useMemo(() => parseOsmElementId(osmId), [osmId]);
  const refKey = ref ? `${ref.type}/${ref.id}` : null;

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
      <Box sx={{ display: "flex", justifyContent: "center", py: 1.5 }}>
        <Tooltip title={t("entryDescription")}>
          <Button
            ref={entryRef}
            variant="tonal"
            onClick={handleClick}
            startIcon={<EditLocationAltOutlinedIcon />}
            data-testid="osm-contribution-entry"
          >
            {t("entry")}
          </Button>
        </Tooltip>
      </Box>

      <AuthDialog
        open={authOpen}
        onClose={closeAuth}
        onAuthenticated={() => setAuthOpen(false)}
        callbackPath={callbackPath}
      />
      {/* A new place means a new flow: the key never carries a draft across references. */}
      {editorOpen && session?.user && (
        <OsmContributionDialog key={refKey} open ref_={ref} onClose={closeEditor} />
      )}
    </>
  );
}
