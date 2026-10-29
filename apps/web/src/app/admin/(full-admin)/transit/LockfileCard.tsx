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
import { adminErrorMessage } from "@openmapx/core/api-admin-sdk";
import { useEffect, useRef, useState } from "react";
import { TransitCredentialsSection } from "@/components/admin/services/TransitCredentialsSection";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { formatTransitAdminTimestamp } from "@/components/admin/shared/adminTimestamp";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
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
export function LockfileCard(_props: { state: TransitStateSummary }) {
  const { apiUrl, actorId } = useAccountAdmin();
  return <CatalogPinView key={JSON.stringify([apiUrl, actorId])} />;
}
function CatalogPinView() {
  const [branch, setBranch] = useState("main"),
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
      toast("Validated catalog pair activated", "success");
    else if (
      result.status === "ok" &&
      result.result?.kind === "catalog.validate" &&
      result.result.status === "passed"
    )
      toast("Validation passed; review and acknowledge the diff before activation", "success");
  }, [own.data, toast]);
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
            Catalog pins
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => {
              void query.refetch();
              if (ownedJobId) void own.refetch();
            }}
          >
            Refresh
          </Button>
        </Stack>
        {query.isLoading && <CircularProgress size={24} aria-label="Loading catalog review" />}
        {query.isError && (
          <Alert severity="error">
            Catalog review is unavailable. Restore instance connectivity and refresh.
          </Alert>
        )}
        {data && (
          <>
            <Box>
              <Chip size="small" label="Active pair" color={data.active ? "success" : "warning"} />
              <Typography variant="body2" sx={{ mt: 1, overflowWrap: "anywhere" }}>
                Transitous: {data.active?.transitous.ref ?? "Not initialized"}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                Atlas: {data.active?.transitous.submodules["transitland-atlas"] ?? "—"}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                GBFS: {data.active?.gbfs.commit ?? "—"}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Active pins stay selected while a proposal is validated.
              </Typography>
            </Box>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1}
              sx={{ alignItems: { sm: "center" } }}
            >
              <TextField
                label="Catalog branch"
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
                      toast("Proposal created; active pins are unchanged", "success");
                    }
                  } catch {
                    /* Render the retained request error below. */
                  }
                }}
              >
                Create proposal
              </Button>
            </Stack>
            <TextField
              select
              label="Proposal"
              size="small"
              value={proposalId ?? ""}
              onChange={(event) => choose(event.target.value)}
            >
              <MenuItem value="">Select a proposal</MenuItem>
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
                  {entry.transitousRef} · {formatTransitAdminTimestamp(entry.createdAt)} ·{" "}
                  {entry.proposalId.slice(0, 8)}
                </MenuItem>
              ))}
            </TextField>
            {data.page.total > 100 && (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Button
                  disabled={offset === 0 || query.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  Previous proposals
                </Button>
                <Typography variant="caption">
                  {offset + 1}–{offset + data.page.proposals.length} of {data.page.total}
                </Typography>
                <Button
                  disabled={data.page.nextOffset === null || query.isFetching}
                  onClick={() => {
                    if (data.page.nextOffset !== null) setOffset(data.page.nextOffset);
                  }}
                >
                  Next proposals
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
                        ? "Selected pair"
                        : "Proposed pair"
                    }
                    variant="outlined"
                  />
                  <Typography variant="body2" sx={{ mt: 1, overflowWrap: "anywhere" }}>
                    Transitous: {data.proposal.pins.transitous.ref}
                  </Typography>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    Atlas: {data.proposal.pins.transitous.submodules["transitland-atlas"] ?? "—"}
                  </Typography>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    GBFS: {data.proposal.pins.gbfs.commit}
                  </Typography>
                </Box>
                {data.diff && (
                  <Box>
                    <Typography variant="subtitle2">
                      Source and license review · {data.diff.total} changes
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ overflowWrap: "anywhere" }}
                    >
                      Exact diff: {data.diff.digest}
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
                          {row.change}: {row.region} / {row.source} · {row.fields.join(", ")} ·
                          license {row.licenseStatus === "unknown" ? "unknown" : "declared"}
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
                      <Typography variant="body2">
                        No source metadata changes in this pair.
                      </Typography>
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
                        Previous changes
                      </Button>
                      <Typography variant="caption">
                        {data.diff.total
                          ? `${data.diff.offset + 1}–${data.diff.offset + data.diff.rows.length}`
                          : "0"}{" "}
                        of {data.diff.total}
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
                        Next changes
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
                    label="Validation countries"
                    size="small"
                    value={countries}
                    error={invalidCountries}
                    helperText="Comma-separated country codes. Empty scope requires the configured planet profile."
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
                    Validate inactive slot
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
                      ? `Validation ${data.validationEligible ? "passed" : "is no longer eligible for activation"}. Countries: ${data.validation.countries.join(", ") || "planet"}. Valid until ${formatTransitAdminTimestamp(data.validation.expiresAt)}.`
                      : data.validation.reason}
                  </Alert>
                )}
                {data.validation?.status === "passed" && (
                  <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                    Tested slot {data.validation.slot} · epoch {data.validation.epoch} · image{" "}
                    {data.validation.imageDigest} · manifest {data.validation.manifestHash}
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
                  label="I reviewed this exact source and licensing diff, including entries with unknown licensing."
                />
                <Button
                  variant="contained"
                  disabled={!data.validationEligible || !ack || busy || submitting}
                  onClick={() => setConfirm(true)}
                >
                  Activate validated pair
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
              Catalog job {ownedJobId ?? execution?.id}:{" "}
              {execution?.status ?? "connecting to retained execution"}
            </Typography>
            {execution?.progress != null && (
              <Typography variant="caption">{Math.round(execution.progress * 100)}%</Typography>
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
                Request cancellation
              </Button>
            )}
            {execution?.publication === "unknown" && (
              <Typography variant="caption">
                Outcome is still being reconciled. New conflicting work stays blocked.
              </Typography>
            )}
          </Alert>
        )}
        {own.isError && (
          <Alert severity="warning">
            The job observer disconnected. Its retained execution continues; refresh to reconnect.
          </Alert>
        )}
        {errors.map(([kind, error]) => (
          <Alert key={kind} severity="error">
            {adminErrorMessage(
              error,
              "Catalog request failed. Inspect its retained job before retrying.",
            )}
          </Alert>
        ))}
      </Stack>
      <ConfirmDialog
        open={confirm}
        title="Activate validated catalog pair"
        message="Promote the tested inactive slot and then select its exact Transitous and GBFS pins. The previous healthy generation remains available for recovery."
        confirmLabel="Activate validated pair"
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
