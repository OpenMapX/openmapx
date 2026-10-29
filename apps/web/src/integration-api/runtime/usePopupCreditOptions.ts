"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import type { PopupCreditsOptions } from "@/integration-api/map/popupCredits";
import { useAttributionLabels } from "@/lib/attributionLabels";

/**
 * The viewer's wording for popup credits — the change notice, the credits
 * disclosure and source links — as panel credit strips use it. Keep the
 * result in a ref for popups built in imperative map handlers.
 */
export function usePopupCreditOptions(): PopupCreditsOptions {
  const t = useTranslations("footer");
  const labels = useAttributionLabels();
  const detailsLabel = t("attributions");
  const sourceLinkLabel = t("sourceLink");
  return useMemo(
    () => ({ labels, detailsLabel, sourceLinkLabel }),
    [labels, detailsLabel, sourceLinkLabel],
  );
}
