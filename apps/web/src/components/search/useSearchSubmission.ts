"use client";

import type { BoundingBox, LngLat, NlpCloudAccess } from "@openmapx/core";
import {
  PANEL,
  useCategorySearchStore,
  useDirectionsStore,
  useNlpSearch,
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
  useStreetLevelStore,
} from "@openmapx/core";
import { isPlausibleNlSearch } from "@openmapx/integration-framework";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { hasNlpConsent, isNlpCloudDeclined, setNlpConsent } from "@/components/ui/nlpConsent";
import {
  useAiSearchDisclosure,
  useIntegrationDisclosures,
} from "@/lib/integrationDisclosuresContext";
import type { NlpSubmissionContext, SearchBarSurface } from "./searchSubmission";

const SUBMIT_SETTLE_TIMEOUT_MS = 2_500;
const NLP_MIN_QUERY_LENGTH = 4;

type SubmissionActions = {
  surface: SearchBarSurface;
  query: string;
  locale: string;
  directionsOpen: boolean;
  captureViewport: () => { mapCenter: LngLat | null; mapBbox: BoundingBox | null };
  executeResolvedSubmit: (context: NlpSubmissionContext) => void;
  cancelEnrichment: () => void;
  blurInput: () => void;
  searchText: (query: string) => void;
};

/** Owns the explicit Enter/NLP lifetime; suggestion acquisition and selection stay with the surface. */
export function useSearchSubmission({
  surface,
  query,
  locale,
  directionsOpen,
  captureViewport,
  executeResolvedSubmit,
  cancelEnrichment,
  blurInput,
  searchText,
}: SubmissionActions) {
  const setIsFocused = useSearchStore((s) => s.setIsFocused);
  const [pendingSubmit, setPendingSubmit] = useState<NlpSubmissionContext | null>(null);
  const pendingSubmitRef = useRef<NlpSubmissionContext | null>(null);
  const submitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingSubmit = useCallback(() => {
    pendingSubmitRef.current = null;
    if (submitTimeoutRef.current !== null) clearTimeout(submitTimeoutRef.current);
    submitTimeoutRef.current = null;
    setPendingSubmit(null);
  }, []);
  // Cloud consent gating is fail-closed: until consent is already stored, the
  // first parse is local-only. The server response then tells us whether cloud
  // is available and whether this deployment requires an explicit opt-in.
  const [nlpCloudAccess, setNlpCloudAccess] = useState<NlpCloudAccess>(() =>
    hasNlpConsent() ? "consented" : "deny",
  );
  // consentGranted tracks local acceptance within this session so the card
  // renders immediately after the user clicks "Enable" without a re-fetch.
  const [consentGranted, setConsentGranted] = useState(false);
  const [consentDeclined, setConsentDeclined] = useState(false);
  // The natural-language parse is expensive on this deployment (~10-20s CPU
  // inference), so it fires only when the user submits (Enter / search button),
  // never per keystroke. A query edit synchronously invalidates its owner.
  const [nlpSubmitted, setNlpSubmitted] = useState(false);
  const [nlpSubmission, setNlpSubmission] = useState<NlpSubmissionContext | null>(null);

  const nlpSubmissionRef = useRef<NlpSubmissionContext | null>(null);
  const cancelNlpSubmission = useCallback(() => {
    nlpSubmissionRef.current = null;
    setNlpSubmitted(false);
    setNlpSubmission(null);
  }, []);
  // Check stores as well as render state: another surface can supersede a
  // submission before React flushes its subscribed state or cancellation effect.
  const isCurrentSubmission = useCallback(
    (submission: NlpSubmissionContext) =>
      nlpSubmissionRef.current === submission &&
      useSearchStore.getState().query === submission.query &&
      usePlaceStore.getState().selectionRevision === submission.selectionRevision &&
      (useStreetLevelStore.getState().activeImage !== null) === (surface === "street-level") &&
      !useDirectionsStore.getState().isOpen &&
      (!submission.aiSearchEnabled || useSettingsStore.getState().aiSearchEnabled),
    [surface],
  );
  const ownsNlpSubmission = useCallback(
    () =>
      nlpSubmitted &&
      nlpSubmission !== null &&
      isCurrentSubmission(nlpSubmission) &&
      useSettingsStore.getState().aiSearchEnabled,
    [nlpSubmitted, nlpSubmission, isCurrentSubmission],
  );

  // The natural-language parse is opt-out: when AI search is disabled in
  // Settings the parse never fires, so search falls back to plain autocomplete.
  const aiSearchEnabled = useSettingsStore((s) => s.aiSearchEnabled);
  const nlpOwned = ownsNlpSubmission();
  useEffect(() => {
    if (
      directionsOpen ||
      (!aiSearchEnabled && nlpSubmission?.aiSearchEnabled) ||
      (nlpSubmission && nlpSubmission.query !== query)
    ) {
      cancelNlpSubmission();
      if (directionsOpen || !aiSearchEnabled) cancelPendingSubmit();
    }
  }, [
    directionsOpen,
    aiSearchEnabled,
    query,
    nlpSubmission,
    cancelNlpSubmission,
    cancelPendingSubmit,
  ]);
  // A superseding store transition must stay cancelled even if it changes back
  // before React renders (for example Settings off/on while Enter is settling).
  useEffect(() => {
    const cancel = () => {
      cancelPendingSubmit();
      cancelNlpSubmission();
    };
    const stopQuery = useSearchStore.subscribe((state) => {
      const submission = nlpSubmissionRef.current;
      if (submission && state.query !== submission.query) cancel();
    });
    const stopDirections = useDirectionsStore.subscribe((state) => {
      if (state.isOpen) cancel();
    });
    const stopSettings = useSettingsStore.subscribe((state) => {
      if (!state.aiSearchEnabled && nlpSubmissionRef.current?.aiSearchEnabled) cancel();
    });
    const stopPlace = usePlaceStore.subscribe((state) => {
      const submission = nlpSubmissionRef.current;
      if (submission && state.selectionRevision !== submission.selectionRevision) cancel();
    });
    const stopViewer = useStreetLevelStore.subscribe((state) => {
      if ((state.activeImage !== null) !== (surface === "street-level")) cancel();
    });
    return () => {
      stopQuery();
      stopDirections();
      stopSettings();
      stopPlace();
      stopViewer();
    };
  }, [cancelPendingSubmit, cancelNlpSubmission, surface]);
  const disclosures = useIntegrationDisclosures();
  const aiSearchDisclosure = useAiSearchDisclosure();
  const storedConsent = hasNlpConsent();
  const cloudDeclined = consentDeclined || isNlpCloudDeclined();
  const waitingForConsent =
    nlpOwned &&
    nlpCloudAccess === "deny" &&
    aiSearchDisclosure?.cloudAvailable === true &&
    aiSearchDisclosure.cloudConsentRequired &&
    !consentGranted &&
    !storedConsent &&
    !cloudDeclined;
  const integrationsLoading = disclosures === undefined;
  const effectiveCloudAccess: NlpCloudAccess =
    nlpCloudAccess === "deny" &&
    aiSearchDisclosure?.cloudAvailable === true &&
    !aiSearchDisclosure.cloudConsentRequired &&
    !cloudDeclined
      ? "defer-to-server"
      : nlpCloudAccess;

  const {
    data: nlpData,
    isFetching: nlpFetching,
    isError: nlpFailed,
  } = useNlpSearch(
    nlpSubmission?.query ?? "",
    nlpSubmission?.mapCenter ?? null,
    nlpSubmission?.mapBbox ?? null,
    nlpOwned && !waitingForConsent && !integrationsLoading,
    locale,
    effectiveCloudAccess,
  );

  // Fallback for a server that reveals an open cloud policy on the parse
  // response rather than in its integration metadata. Current servers normally
  // select defer-to-server before the first request via effectiveCloudAccess.
  useEffect(() => {
    if (
      ownsNlpSubmission() &&
      nlpCloudAccess === "deny" &&
      nlpData?.cloudAvailable &&
      !nlpData.cloudConsentRequired &&
      !isNlpCloudDeclined()
    ) {
      setNlpCloudAccess("defer-to-server");
    }
  }, [nlpCloudAccess, nlpData, ownsNlpSubmission]);

  // Once a natural-language parse finishes without anything to offer, fall
  // back to the plain search of the visible area rather than doing nothing.
  // Not while the answer can still change: a cloud consent prompt or the
  // automatic retry with cloud access (see the effect above) comes first.
  const nlpAwaitingCloud =
    nlpData?.cloudAvailable === true &&
    !cloudDeclined &&
    (nlpData.cloudConsentRequired ? !consentGranted && !storedConsent : nlpCloudAccess === "deny");
  const nlpSettledEmpty =
    nlpOwned &&
    !nlpFetching &&
    !waitingForConsent &&
    !nlpAwaitingCloud &&
    (nlpFailed || (nlpData !== undefined && !isPlausibleNlSearch(nlpData.intent)));
  useEffect(() => {
    if (!nlpSettledEmpty || !ownsNlpSubmission() || !nlpSubmission) return;
    const submittedQuery = nlpSubmission.query;
    cancelNlpSubmission();
    setIsFocused(false);
    blurInput();
    searchText(submittedQuery);
  }, [
    nlpSettledEmpty,
    ownsNlpSubmission,
    nlpSubmission,
    cancelNlpSubmission,
    blurInput,
    searchText,
    setIsFocused,
  ]);

  const handleActivateNlp = () => {
    if (!ownsNlpSubmission() || !nlpData) return;
    cancelEnrichment();
    const { intent, resolvedBbox, provider } = nlpData;
    if (intent.filter.selectors.length === 0) return;
    cancelNlpSubmission();
    useNlpSearchStore.getState().activate(intent, resolvedBbox, provider);
    useCategorySearchStore
      .getState()
      .setAdHocFilter(intent.filter, intent.explanation, { source: "nlp" });
    useCategorySearchStore.getState().setSearchBbox(resolvedBbox);
    useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
    setIsFocused(false);
    blurInput();
  };

  const cancelSubmission = useCallback(() => {
    cancelPendingSubmit();
    cancelEnrichment();
    cancelNlpSubmission();
  }, [cancelPendingSubmit, cancelEnrichment, cancelNlpSubmission]);

  const beginSubmission = () => {
    cancelSubmission();
    const context: NlpSubmissionContext = {
      query,
      aiSearchEnabled: useSettingsStore.getState().aiSearchEnabled,
      selectionRevision: usePlaceStore.getState().selectionRevision,
      ...captureViewport(),
    };
    nlpSubmissionRef.current = context;
    setNlpSubmission(context);
    return context;
  };
  const runSubmission = useCallback(
    (context: NlpSubmissionContext) => {
      if (context.query.trim() && isCurrentSubmission(context)) executeResolvedSubmit(context);
    },
    [isCurrentSubmission, executeResolvedSubmit],
  );
  const settlePending = useCallback(() => {
    const context = pendingSubmitRef.current;
    if (!context) return;
    cancelPendingSubmit();
    runSubmission(context);
  }, [cancelPendingSubmit, runSubmission]);
  // Only Effect-owned work uses an Effect Event: the deadline stays fixed while
  // the eventual action reads the latest committed suggestion results.
  const completeAtDeadline = useEffectEvent(() => settlePending());
  useEffect(() => {
    if (!pendingSubmit) return;
    const timer = setTimeout(() => completeAtDeadline(), SUBMIT_SETTLE_TIMEOUT_MS);
    submitTimeoutRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (submitTimeoutRef.current === timer) submitTimeoutRef.current = null;
    };
  }, [pendingSubmit]);
  useEffect(
    () => () => {
      pendingSubmitRef.current = null;
      nlpSubmissionRef.current = null;
      if (submitTimeoutRef.current !== null) clearTimeout(submitTimeoutRef.current);
    },
    [],
  );

  const deferSubmission = (context: NlpSubmissionContext) => {
    if (!isCurrentSubmission(context)) return;
    pendingSubmitRef.current = context;
    setPendingSubmit(context);
  };
  const startNlp = (context: NlpSubmissionContext): boolean => {
    if (
      !isCurrentSubmission(context) ||
      !context.aiSearchEnabled ||
      context.query.trim().length < NLP_MIN_QUERY_LENGTH ||
      !context.mapCenter ||
      !context.mapBbox
    )
      return false;
    setNlpSubmitted(true);
    setIsFocused(true);
    return true;
  };

  return {
    beginSubmission,
    runSubmission,
    deferSubmission,
    settlePending,
    startNlp,
    cancelSubmission,
    cancelPending: cancelPendingSubmit,
    pending: pendingSubmit !== null,
    nlp: {
      data: nlpData,
      pending: nlpOwned && nlpFetching && !nlpData,
      showCard: nlpOwned && nlpData !== undefined && isPlausibleNlSearch(nlpData.intent),
      showConsent:
        waitingForConsent ||
        (nlpOwned &&
          nlpData?.cloudAvailable === true &&
          nlpData.cloudConsentRequired &&
          !consentGranted &&
          !storedConsent &&
          !cloudDeclined),
      consentProviders:
        aiSearchDisclosure?.cloudProviderLabels ?? nlpData?.cloudProviderLabels ?? [],
      activate: handleActivateNlp,
      acceptConsent: () => {
        if (!ownsNlpSubmission()) return;
        setNlpConsent(true);
        setConsentGranted(true);
        setConsentDeclined(false);
        setNlpCloudAccess("consented");
      },
      declineConsent: () => {
        if (!ownsNlpSubmission()) return;
        setNlpConsent(false);
        setConsentDeclined(true);
        setNlpCloudAccess("deny");
      },
    },
  };
}
