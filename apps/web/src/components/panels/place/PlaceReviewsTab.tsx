"use client";

import type { ReviewAggregate as ReviewAggregateType } from "@integrations/reviews/types";
import EditIcon from "@mui/icons-material/Edit";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RateReviewIcon from "@mui/icons-material/RateReview";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { type Place, type Review, safeHref, useSession } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { usePlaceReviews, useReviewAggregate, useUserKeypair } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { MangroveSetupWizard } from "@/components/auth/MangroveSetupWizard";
import { MangroveUnlockDialog } from "@/components/auth/MangroveUnlockDialog";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { attributionsForSources } from "@/lib/attributionForProviders";
import { DeleteReviewDialog } from "./reviews/DeleteReviewDialog";
import { ReportAbuseDialog } from "./reviews/ReportAbuseDialog";
import { ReviewAggregate } from "./reviews/ReviewAggregate";
import { ReviewList } from "./reviews/ReviewList";
import { WriteReviewDialog } from "./reviews/WriteReviewDialog";

type PendingAction =
  | { kind: "write" }
  | { kind: "edit"; review: Review }
  | { kind: "delete"; review: Review }
  | { kind: "report"; review: Review }
  | null;

interface Props {
  place: Place;
}

export function PlaceReviewsTab({ place }: Props) {
  const t = useTranslations("place");
  const [lng, lat] = place.coordinates;
  const { data: session } = useSession();
  const isSignedIn = !!session?.user?.id;
  const { keypair, publicPem, needsSetup, needsUnlock } = useUserKeypair();
  const registry = useIntegrationRegistry();
  // `ids.osm` is only present when this place is linked to an OSM element —
  // Mangrove's metadata.osm_id is reserved for `node|way|relation/ID[/VERSION]`.
  const subject = { lat, lng, name: place.name, osmId: place.ids?.osm };

  const aggregateQuery = useReviewAggregate<ReviewAggregateType>(lat, lng, place.name, {
    osmId: place.ids?.osm,
  });
  const reviewsQuery = usePlaceReviews<Review>(lat, lng, place.name, { osmId: place.ids?.osm });

  // Credit only the review source(s) whose data is actually shown: the
  // providers that returned reviews, plus the aggregate's provider when a
  // rating summary is displayed. Each carries a `source` (= manifest sourceId)
  // tagged by the reviews orchestrator. An unknown source resolves to no
  // credit (never a domain-wide fallback), so nothing shown ⇒ nothing credited.
  const reviewAttributions = useMemo(() => {
    const ids = new Set<string>();
    for (const r of reviewsQuery.data ?? []) if (r.source) ids.add(r.source);
    const agg = aggregateQuery.data;
    if (agg?.source && agg.count > 0) ids.add(agg.source);
    return attributionsForSources(registry, ids);
  }, [registry, reviewsQuery.data, aggregateQuery.data]);

  const [writeOpen, setWriteOpen] = useState(false);
  const [editReview, setEditReview] = useState<Review | null>(null);
  const [deleteReview, setDeleteReview] = useState<Review | null>(null);
  const [reportReview, setReportReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const ownReview = reviewsQuery.data?.find((r) => publicPem && r.author.kid === publicPem) ?? null;

  const links = place.reviewLinks ?? [];

  /**
   * Attempt to run an action that needs a signed JWT. Diverts to setup or
   * unlock first when the user's Mangrove keypair is not ready. The
   * `pending` action replays once the keypair becomes available.
   */
  function gatedAction(action: PendingAction) {
    if (!action) return;
    if (needsSetup) {
      setPending(action);
      setSetupOpen(true);
      return;
    }
    if (needsUnlock) {
      setPending(action);
      setUnlockOpen(true);
      return;
    }
    runAction(action);
  }

  function runAction(action: PendingAction) {
    if (!action) return;
    if (action.kind === "write") {
      setEditReview(null);
      setWriteOpen(true);
    } else if (action.kind === "edit") {
      setEditReview(action.review);
      setWriteOpen(true);
    } else if (action.kind === "delete") {
      setDeleteReview(action.review);
    } else if (action.kind === "report") {
      setReportReview(action.review);
    }
  }

  // Replay the pending action once the keypair becomes ready (post-setup/unlock).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    if (!pending) return;
    if (needsSetup || needsUnlock) return;
    if (!keypair) return;
    const action = pending;
    setPending(null);
    runAction(action);
  }, [keypair, needsSetup, needsUnlock]);

  return (
    <Box sx={{ px: 2, pt: 2, pb: 2 }}>
      <ReviewAggregate
        aggregate={aggregateQuery.data}
        reviews={reviewsQuery.data}
        isLoading={aggregateQuery.isLoading}
      />
      {/* Write / edit CTA — logged-out users get the same button but it
          opens the auth dialog instead of starting the gated review flow. */}
      <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
        <Button
          variant="contained"
          color="primary"
          startIcon={ownReview ? <EditIcon /> : <RateReviewIcon />}
          onClick={() => {
            if (!isSignedIn) {
              setAuthOpen(true);
              return;
            }
            gatedAction(ownReview ? { kind: "edit", review: ownReview } : { kind: "write" });
          }}
          sx={{ flex: 1, textTransform: "none" }}
        >
          {ownReview ? t("editReview") : t("writeReview")}
        </Button>
      </Box>
      <ReviewList
        reviews={reviewsQuery.data}
        isLoading={reviewsQuery.isLoading}
        currentUserPem={publicPem}
        onEdit={(r) => gatedAction({ kind: "edit", review: r })}
        onDelete={(r) => gatedAction({ kind: "delete", review: r })}
        onReport={(r) => gatedAction({ kind: "report", review: r })}
      />
      {links.length > 0 && (
        <>
          <Divider sx={{ mt: 2, mb: 1.5 }} />
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              mb: 0.5,
              display: "block",
            }}
          >
            {t("findReviewsOn")}
          </Typography>
          {links.map((link) => (
            <Box
              key={link.platform}
              component="a"
              href={safeHref(link.url)}
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 1,
                mx: -2,
                px: 2,
                textDecoration: "none",
                color: "inherit",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ flex: 1 }}>
                {link.kind === "search"
                  ? t("searchReviewPlatform", { platform: link.platform })
                  : t("openReviewPlatform", { platform: link.platform })}
              </Typography>
              <OpenInNewIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
            </Box>
          ))}
        </>
      )}
      {reviewAttributions.length > 0 && (
        <>
          <Divider sx={{ mt: 2, mb: 1 }} />
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <AttributionStrip attributions={reviewAttributions} variant="inline" />
          </Box>
        </>
      )}
      <WriteReviewDialog
        open={writeOpen}
        onClose={() => {
          setWriteOpen(false);
          setEditReview(null);
        }}
        subject={subject}
        initial={editReview}
      />
      {deleteReview && (
        <DeleteReviewDialog
          open
          onClose={() => setDeleteReview(null)}
          review={deleteReview}
          subject={subject}
        />
      )}
      {reportReview && (
        <ReportAbuseDialog open onClose={() => setReportReview(null)} review={reportReview} />
      )}
      <MangroveSetupWizard
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          if (needsSetup) setPending(null);
        }}
      />
      <MangroveUnlockDialog
        open={unlockOpen}
        onClose={() => {
          setUnlockOpen(false);
          if (needsUnlock) setPending(null);
        }}
      />
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </Box>
  );
}
