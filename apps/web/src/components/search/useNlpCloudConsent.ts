"use client";

import type { NlpCloudAccess } from "@openmapx/core";
import { useNlpSearch, useSession } from "@openmapx/core";
import { useEffect, useState } from "react";
import { hasNlpConsent, isNlpCloudDeclined, setNlpConsent } from "@/components/ui/nlpConsent";
import {
  useAiSearchDisclosure,
  useIntegrationDisclosures,
} from "@/lib/integrationDisclosuresContext";
import type { NlpSubmissionContext } from "./searchSubmission";

type NlpCloudConsentInput = {
  /** The submitted search the parse answers, or null before any submit. */
  submission: NlpSubmissionContext | null;
  /** Whether this surface owns that submission as of this render. */
  owned: boolean;
  /** The same ownership, read at event time. */
  ownsSubmission: () => boolean;
  locale: string;
};

/**
 * Runs the natural-language parse of a submitted search under the cloud
 * consent rules. Consent decides both whether the parse may be sent yet and
 * whether it may use a cloud model, and the parse's answer can in turn reveal
 * the server's cloud policy, so the parse lives here with the consent state.
 */
export function useNlpCloudConsent({
  submission,
  owned,
  ownsSubmission,
  locale,
}: NlpCloudConsentInput) {
  // Cloud consent gating is fail-closed: until consent is already stored, the
  // first parse is local-only. The server response then tells us whether cloud
  // is available and whether this deployment requires an explicit opt-in.
  const [cloudAccess, setCloudAccess] = useState<NlpCloudAccess>(() =>
    hasNlpConsent() ? "consented" : "deny",
  );
  // consentGranted tracks local acceptance within this session so the card
  // renders immediately after the user clicks "Enable" without a re-fetch.
  const [consentGranted, setConsentGranted] = useState(false);
  const [consentDeclined, setConsentDeclined] = useState(false);
  const disclosures = useIntegrationDisclosures();
  const aiSearchDisclosure = useAiSearchDisclosure();
  const { data: session, isPending: sessionPending } = useSession();
  // Where the server offers cloud parsing only to signed-in users, an
  // anonymous visitor's consent could never be used, so it is not asked for.
  // Until the session is known the usual prompt stands; the server decides
  // cloud use either way.
  const cloudOutOfReach =
    aiSearchDisclosure?.cloudRequiresSignIn === true && !sessionPending && !session?.user;
  const storedConsent = hasNlpConsent();
  const cloudDeclined = consentDeclined || isNlpCloudDeclined();
  const waitingForConsent =
    owned &&
    cloudAccess === "deny" &&
    !cloudOutOfReach &&
    aiSearchDisclosure?.cloudAvailable === true &&
    aiSearchDisclosure.cloudConsentRequired &&
    !consentGranted &&
    !storedConsent &&
    !cloudDeclined;
  const integrationsLoading = disclosures === undefined;
  const effectiveCloudAccess: NlpCloudAccess =
    cloudAccess === "deny" &&
    aiSearchDisclosure?.cloudAvailable === true &&
    !aiSearchDisclosure.cloudConsentRequired &&
    !cloudDeclined
      ? "defer-to-server"
      : cloudAccess;

  const {
    data,
    isFetching: fetching,
    isError: failed,
  } = useNlpSearch(
    submission?.query ?? "",
    submission?.mapCenter ?? null,
    submission?.mapBbox ?? null,
    owned && !waitingForConsent && !integrationsLoading,
    locale,
    effectiveCloudAccess,
  );

  // Fallback for a server that reveals an open cloud policy on the parse
  // response rather than in its integration metadata. Current servers normally
  // select defer-to-server before the first request via effectiveCloudAccess.
  useEffect(() => {
    if (
      ownsSubmission() &&
      cloudAccess === "deny" &&
      data?.cloudAvailable &&
      !data.cloudConsentRequired &&
      !isNlpCloudDeclined()
    ) {
      setCloudAccess("defer-to-server");
    }
  }, [cloudAccess, data, ownsSubmission]);

  // The answer can still change while a cloud consent prompt or the automatic
  // retry with cloud access (see the effect above) is outstanding.
  const awaitingCloud =
    data?.cloudAvailable === true &&
    !cloudDeclined &&
    (data.cloudConsentRequired ? !consentGranted && !storedConsent : cloudAccess === "deny");

  return {
    data,
    fetching,
    failed,
    waitingForConsent,
    awaitingCloud,
    showConsent:
      waitingForConsent ||
      (owned &&
        !cloudOutOfReach &&
        data?.cloudAvailable === true &&
        data.cloudConsentRequired &&
        !consentGranted &&
        !storedConsent &&
        !cloudDeclined),
    consentProviders: aiSearchDisclosure?.cloudProviderLabels ?? data?.cloudProviderLabels ?? [],
    acceptConsent: () => {
      if (!ownsSubmission()) return;
      setNlpConsent(true);
      setConsentGranted(true);
      setConsentDeclined(false);
      setCloudAccess("consented");
    },
    declineConsent: () => {
      if (!ownsSubmission()) return;
      setNlpConsent(false);
      setConsentDeclined(true);
      setCloudAccess("deny");
    },
  };
}
