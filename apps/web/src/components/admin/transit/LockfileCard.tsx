"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { DEFAULT_CATALOG_BRANCH } from "@openmapx/core/data-manager-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AdminJobLink } from "@/components/admin/activity/AdminJobLink";
import { TransitCredentialsSection } from "@/components/admin/services/TransitCredentialsSection";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import type { TransitStateSummary } from "@/lib/admin/transitHooks";
import {
  transitPinExecutionPending,
  useActivateTransitPins,
  useCancelTransitPinExecution,
  useProposeTransitPins,
  useTransitPinExecution,
  useTransitPins,
  useValidateTransitPins,
} from "@/lib/admin/transitPinHooks";
export function LockfileCard(_props: { state?: TransitStateSummary } = {}) {
  const { apiUrl, actorId } = useAccountAdmin();
  return <CatalogPinView key={JSON.stringify([apiUrl, actorId])} />;
}
function CatalogPinView() {
  const t = useTranslations("adminTransit");
  const tShared = useTranslations("adminShared");
  const format = useAdminFormat();
  const [branch, setBranch] = useState(DEFAULT_CATALOG_BRANCH),
    [proposalId, setProposalId] = useState<string | undefined>(),
    [offset, setOffset] = useState(0),
    [diffOffset, setDiffOffset] = useState(0),
    [history, setHistory] = useState<number[]>([]),
    [countries, setCountries] = useState(""),
    [ackScope, setAckScope] = useState<string | null>(null),
    [confirmScope, setConfirmScope] = useState<string | null>(null),
    [ownedJobId, setOwnedJobId] = useState<string | null>(null);
  const touched = useRef(false),
    alive = useRef(true),
    announced = useRef<string | null>(null);
  const query = useTransitPins({ proposalId, offset, diffOffset }),
    propose = useProposeTransitPins(),
    validate = useValidateTransitPins(),
    activate = useActivateTransitPins(),
    cancel = useCancelTransitPinExecution(),
    own = useTransitPinExecution(ownedJobId),
    toast = useAdminToast();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const data = query.data,
    configuredCountries = data?.allowedCountries.join(",") ?? "";
  useEffect(() => {
    if (!touched.current) setCountries(configuredCountries);
  }, [configuredCountries]);
  const reviewScope = JSON.stringify([
    proposalId,
    data?.diff?.digest,
    data?.validation?.validationId,
    data?.validationEligible,
  ]);
  const ack = ackScope === reviewScope,
    confirm = confirmScope === reviewScope && ack;
  const setAck = (value: boolean) => setAckScope(value ? reviewScope : null);
  const setConfirm = (value: boolean) => setConfirmScope(value ? reviewScope : null);
  useEffect(() => {
    const result = own.data;
    if (!result || transitPinExecutionPending(result) || announced.current === result.id) return;
    announced.current = result.id;
    if (
      result.status === "ok" &&
      result.result?.kind === "catalog.activate" &&
      result.result.outcome === "activated"
    )
      toast(t("validatedCatalogPairActivated"), "success");
    else if (
      result.status === "ok" &&
      result.result?.kind === "catalog.validate" &&
      result.result.status === "passed"
    )
      toast(t("validationPassedReviewAndAcknowledge"), "success");
  }, [own.data, toast, t]);
  const execution = ownedJobId ? own.data : data?.execution,
    observing = Boolean(ownedJobId && !own.data),
    busy =
      observing ||
      transitPinExecutionPending(execution) ||
      transitPinExecutionPending(data?.execution),
    submitting = propose.isPending || validate.isPending || activate.isPending || cancel.isPending;
  const selectedCountries = [
      ...new Set(
        countries
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].sort(),
    invalidCountries =
      selectedCountries.length > 256 ||
      selectedCountries.some((value) => !/^[a-z]{2,3}$/.test(value));
  const errors = Object.entries({
    propose: propose.error,
    validate: validate.error,
    activate: activate.error,
    cancel: cancel.error,
  }).filter(([, error]) => Boolean(error));
  const choose = (id: string) => {
    setProposalId(id || undefined);
    setDiffOffset(0);
    setHistory([]);
    setAck(false);
    setConfirm(false);
    propose.reset();
    validate.reset();
    activate.reset();
    cancel.reset();
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {t("catalogPins")}
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => {
              void query.refetch();
              if (ownedJobId) void own.refetch();
            }}
          >
            {t("refresh")}
          </Button>
        </Stack>
        {query.isLoading && <CircularProgress size={24} aria-label={t("loadingCatalogReview")} />}
        {query.isError && <Alert severity="error">{t("catalogReviewIsUnavailableRestore")}</Alert>}
        {data && (
          <>
            <Box>
              <Chip
                size="small"
                label={t("activePair")}
                color={data.active ? "success" : "warning"}
              />
              <Typography variant="body2" sx={{ mt: 1, overflowWrap: "anywhere" }}>
                {t("transitousRef", { ref: data.active?.transitous.ref ?? t("notInitialized") })}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                {t("atlasRef", {
                  ref: data.active?.transitous.submodules["transitland-atlas"] ?? "—",
                })}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                {t("gbfsCommit", { commit: data.active?.gbfs.commit ?? "—" })}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("activePinsStaySelectedWhile")}
              </Typography>
            </Box>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1}
              sx={{ alignItems: { sm: "center" } }}
            >
              <TextField
                label={t("catalogBranch")}
                size="small"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              />
              <Button
                variant="outlined"
                disabled={submitting || busy || !branch.trim()}
                onClick={async () => {
                  try {
                    const result = await propose.mutateAsync({ branch: branch.trim() });
                    if (alive.current) {
                      choose(result.value.proposalId);
                      toast(t("proposalCreatedActivePinsAre"), "success");
                    }
                  } catch {
                    /* Render the retained request error below. */
                  }
                }}
              >
                {t("createProposal")}
              </Button>
            </Stack>
            <TextField
              select
              label={t("proposal")}
              size="small"
              value={proposalId ?? ""}
              onChange={(event) => choose(event.target.value)}
            >
              <MenuItem value="">{t("selectAProposal")}</MenuItem>
              {data.proposal &&
                !data.page.proposals.some(
                  (entry) => entry.proposalId === data.proposal?.proposalId,
                ) && (
                  <MenuItem value={data.proposal.proposalId}>
                    {data.proposal.pins.transitous.ref} · {data.proposal.proposalId.slice(0, 8)}
                  </MenuItem>
                )}
              {data.page.proposals.map((entry) => (
                <MenuItem key={entry.proposalId} value={entry.proposalId}>
                  {t("proposalOption", {
                    ref: entry.transitousRef,
                    createdAt: format.timestamp(entry.createdAt),
                    id: entry.proposalId.slice(0, 8),
                  })}
                </MenuItem>
              ))}
            </TextField>
            {data.page.total > 100 && (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Button
                  disabled={offset === 0 || query.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  {t("previousProposals")}
                </Button>
                <Typography variant="caption">
                  {t("pageRange", {
                    from: offset + 1,
                    to: offset + data.page.proposals.length,
                    total: data.page.total,
                  })}
                </Typography>
                <Button
                  disabled={data.page.nextOffset === null || query.isFetching}
                  onClick={() => {
                    if (data.page.nextOffset !== null) setOffset(data.page.nextOffset);
                  }}
                >
                  {t("nextProposals")}
                </Button>
              </Stack>
            )}
            {data.proposal && (
              <>
                <Box>
                  <Chip
                    size="small"
                    label={
                      data.catalogRevisionId === data.proposal.pins.generationId
                        ? t("selectedPair")
                        : t("proposedPair")
                    }
                    variant="outlined"
                  />
                  <Typography variant="body2" sx={{ mt: 1, overflowWrap: "anywhere" }}>
                    {t("transitousRef", { ref: data.proposal.pins.transitous.ref })}
                  </Typography>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    {t("atlasRef", {
                      ref: data.proposal.pins.transitous.submodules["transitland-atlas"] ?? "—",
                    })}
                  </Typography>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    {t("gbfsCommit", { commit: data.proposal.pins.gbfs.commit })}
                  </Typography>
                </Box>
                {data.diff && (
                  <Box>
                    <Typography variant="subtitle2">
                      {t("sourceLicenseReview", { total: data.diff.total })}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ overflowWrap: "anywhere" }}
                    >
                      {t("exactDiffDigest", { digest: data.diff.digest })}
                    </Typography>
                    {data.diff.rows.map((row) => (
                      <Box
                        component="details"
                        key={row.id}
                        sx={{ mt: 1, p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}
                      >
                        <Box
                          component="summary"
                          sx={{ cursor: "pointer", overflowWrap: "anywhere" }}
                        >
                          {t("catalogDiffRow", {
                            change: row.change,
                            region: row.region,
                            sourceId: row.source,
                            fields: row.fields
                              .map((field) => t("catalogField", { field }))
                              .join(", "),
                            licenseStatus: row.licenseStatus,
                          })}
                        </Box>
                        <Typography
                          component="pre"
                          variant="caption"
                          sx={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            maxHeight: 400,
                            overflow: "auto",
                          }}
                        >
                          {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
                        </Typography>
                      </Box>
                    ))}
                    {data.diff.total === 0 && (
                      <Typography variant="body2">{t("noSourceMetadataChangesIn")}</Typography>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
                      <Button
                        disabled={!history.length || query.isFetching}
                        onClick={() => {
                          const previous = history.at(-1);
                          if (previous !== undefined) {
                            setDiffOffset(previous);
                            setHistory(history.slice(0, -1));
                          }
                        }}
                      >
                        {t("previousChanges")}
                      </Button>
                      <Typography variant="caption">
                        {data.diff.total
                          ? t("pageRange", {
                              from: data.diff.offset + 1,
                              to: data.diff.offset + data.diff.rows.length,
                              total: data.diff.total,
                            })
                          : t("pageEmpty")}
                      </Typography>
                      <Button
                        disabled={data.diff.nextOffset === null || query.isFetching}
                        onClick={() => {
                          if (data.diff?.nextOffset != null) {
                            setHistory([...history, diffOffset]);
                            setDiffOffset(data.diff.nextOffset);
                          }
                        }}
                      >
                        {t("nextChanges")}
                      </Button>
                    </Stack>
                  </Box>
                )}
                {data.blocker && <Alert severity="info">{data.blocker}</Alert>}
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1}
                  sx={{ alignItems: { sm: "center" } }}
                >
                  <TextField
                    label={t("validationCountries")}
                    size="small"
                    value={countries}
                    error={invalidCountries}
                    helperText={t("commaSeparatedCountryCodesEmpty")}
                    onChange={(event) => {
                      touched.current = true;
                      setCountries(event.target.value);
                      setAck(false);
                    }}
                  />
                  <Button
                    variant="outlined"
                    disabled={submitting || busy || !data.validationInputs || invalidCountries}
                    onClick={async () => {
                      if (!proposalId) return;
                      try {
                        const result = await validate.mutateAsync({
                          proposalId,
                          countries: selectedCountries,
                        });
                        if (alive.current) {
                          setOwnedJobId(result.value.jobId);
                          setAck(false);
                        }
                      } catch {
                        /* Retain this attempt identity for explicit retry. */
                      }
                    }}
                  >
                    {t("validateInactiveSlot")}
                  </Button>
                </Stack>
                {data.validation && (
                  <Alert
                    severity={
                      data.validation.status === "passed"
                        ? data.validationEligible
                          ? "success"
                          : "info"
                        : "error"
                    }
                  >
                    {data.validation.status === "passed"
                      ? t(
                          data.validationEligible
                            ? "validationPassed"
                            : "validationNoLongerEligible",
                          {
                            countries: data.validation.countries.join(", ") || t("wholePlanet"),
                            expiresAt: format.timestamp(data.validation.expiresAt),
                          },
                        )
                      : data.validation.reason}
                  </Alert>
                )}
                {data.validation?.status === "passed" && (
                  <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                    {t("testedSlotSlotEpochEpoch", {
                      slot: data.validation.slot,
                      epoch: data.validation.epoch,
                      imageDigest: data.validation.imageDigest,
                      manifestHash: data.validation.manifestHash,
                    })}
                  </Typography>
                )}
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={ack}
                      onChange={(event) => setAck(event.target.checked)}
                      disabled={!data.validationEligible || busy || submitting}
                    />
                  }
                  label={t("iReviewedThisExactSource")}
                />
                <Button
                  variant="contained"
                  disabled={!data.validationEligible || !ack || busy || submitting}
                  onClick={() => setConfirm(true)}
                >
                  {t("activateValidatedPair")}
                </Button>
                <TransitCredentialsSection
                  key={data.proposal.proposalId}
                  proposalId={
                    data.proposal.pins.generationId === data.catalogRevisionId
                      ? undefined
                      : data.proposal.proposalId
                  }
                />
              </>
            )}
          </>
        )}
        {(observing || execution) && (
          <Alert
            severity={
              execution?.publication === "unknown"
                ? "warning"
                : execution?.status === "error"
                  ? "error"
                  : "info"
            }
          >
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              {(ownedJobId ?? execution?.id) && (
                <AdminJobLink id={(ownedJobId ?? execution?.id) as string} source="data-manager" />
              )}
              {t("catalogJobStatus", {
                jobId: ownedJobId ?? execution?.id ?? "",
                statusLabel: execution
                  ? tShared("jobStatusLabel", { status: execution.status })
                  : t("connectingToRetainedExecution"),
              })}
            </Typography>
            {execution?.progress != null && (
              <Typography variant="caption">{format.percent(execution.progress)}</Typography>
            )}
            {Array.from(
              new Map(
                execution?.diagnostics.tail
                  .slice(-3)
                  .map((line) => [`${line.stream}:${line.message}`, line]),
              ).values(),
            ).map((line) => (
              <Typography
                key={`${line.stream}:${line.message}`}
                variant="body2"
                sx={{ overflowWrap: "anywhere" }}
              >
                {line.message}
              </Typography>
            ))}
            {execution && transitPinExecutionPending(execution) && (
              <Button
                size="small"
                disabled={cancel.isPending || execution.status === "cancel_pending"}
                onClick={async () => {
                  try {
                    await cancel.mutateAsync({
                      id: execution.id,
                      operationKey: execution.operationKey,
                      fingerprint: execution.fingerprint,
                    });
                    if (alive.current && ownedJobId) void own.refetch();
                  } catch {
                    /* Show the operation error below. */
                  }
                }}
              >
                {t("requestCancellation")}
              </Button>
            )}
            {execution?.publication === "unknown" && (
              <Typography variant="caption">{t("outcomeIsStillBeingReconciled")}</Typography>
            )}
          </Alert>
        )}
        {own.isError && <Alert severity="warning">{t("theJobObserverDisconnectedIts")}</Alert>}
        {errors.map(([kind, error]) => (
          <Alert key={kind} severity="error">
            {adminErrorText(error, t("catalogRequestFailedInspectIts"))}
          </Alert>
        ))}
      </Stack>
      <ConfirmDialog
        open={confirm}
        title={t("activateValidatedCatalogPair")}
        message={t("promoteTheTestedInactiveSlot")}
        confirmLabel={t("activateValidatedPair")}
        confirmColor="warning"
        loading={activate.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          const selected = data?.proposal,
            validation = data?.validation,
            diff = data?.diff;
          if (!selected || !validation || !diff || !ack || !data?.validationEligible) return;
          try {
            const result = await activate.mutateAsync({
              proposalId: selected.proposalId,
              validationId: validation.validationId,
              expectedGenerationId: selected.baseGenerationId,
              diffDigest: diff.digest,
              acknowledgeLicenseChanges: true,
            });
            if (alive.current) {
              setOwnedJobId(result.value.jobId);
              setConfirm(false);
              setAck(false);
            }
          } catch {
            /* Keep exact request identity and show error. */
          }
        }}
      />
    </Paper>
  );
}
