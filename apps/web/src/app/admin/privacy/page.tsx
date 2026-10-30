"use client";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { PrivacyArtifactDelivery } from "@/components/admin/privacy/PrivacyArtifactDelivery";
import { PrivacyAttachments } from "@/components/admin/privacy/PrivacyAttachments";
import { PrivacyBackupReview } from "@/components/admin/privacy/PrivacyBackupReview";
import { PrivacyCaseDecisionForms } from "@/components/admin/privacy/PrivacyCaseDecisionForms";
import { PrivacyIdentityReview } from "@/components/admin/privacy/PrivacyIdentityReview";
import { PrivacyReadinessChecklist } from "@/components/admin/privacy/PrivacyReadinessChecklist";
import { PrivacyTaskActions } from "@/components/admin/privacy/PrivacyTaskActions";
import {
  type PrivacyAdminBinding,
  privacyResult,
  usePrivacyAdmin,
  usePrivacyCaseClient,
  usePrivacyMutationClient,
} from "@/lib/admin/privacyAdmin";
import {
  clearPendingPrivacyAdminDelivery,
  readPendingPrivacyAdminDelivery,
} from "@/lib/admin/privacyReauthentication";
export default function PrivacyAdminPage() {
  const binding = usePrivacyAdmin();
  return <Workspace key={`${binding.apiOrigin}\0${binding.actorId}`} binding={binding} />;
}
function Workspace({ binding }: { binding: PrivacyAdminBinding }) {
  const t = useTranslations("privacyAdmin"),
    account = useTranslations("account.privacyData");
  const queue = useQuery(binding.queries.queue()),
    readiness = useQuery(binding.queries.readiness());
  const [selected, setSelected] = useState<string | null>(null),
    [intake, setIntake] = useState(false);
  useEffect(() => {
    if (selected || !queue.data || !binding.actorId) return;
    const pending = readPendingPrivacyAdminDelivery(binding.apiOrigin, binding.actorId);
    setSelected(pending?.requestId ?? queue.data.requests[0]?.id ?? null);
  }, [queue.data, selected, binding.actorId, binding.apiOrigin]);
  const choose = (id: string) => {
    if (id !== selected) clearPendingPrivacyAdminDelivery();
    setSelected(id);
  };
  return (
    <Stack spacing={3} sx={{ p: { xs: 1, sm: 3 }, maxWidth: 1500, mx: "auto" }}>
      <Stack
        direction="row"
        useFlexGap
        sx={{ flexWrap: "wrap", justifyContent: "space-between" }}
        spacing={1}
      >
        <Typography variant="h4">{t("title")}</Typography>
        <Stack direction="row" spacing={1}>
          <Button
            onClick={() => {
              void queue.refetch();
              void readiness.refetch();
            }}
          >
            {t("refresh")}
          </Button>
          <Button variant="contained" onClick={() => setIntake(true)}>
            {t("newAssistedRequest")}
          </Button>
        </Stack>
      </Stack>
      {queue.isError && <Alert severity="error">{t("loadFailed")}</Alert>}
      {readiness.isError && <Alert severity="error">{t("notReady")}</Alert>}
      {readiness.data && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <PrivacyReadinessChecklist readiness={readiness.data} canConfigure={false} />
        </Paper>
      )}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper variant="outlined" sx={{ p: 1 }}>
            <Typography variant="h6" sx={{ px: 1 }}>
              {t("queue", { count: queue.data?.requests.length ?? 0 })}
            </Typography>
            {queue.isLoading && <CircularProgress size={24} />}
            <List>
              {queue.data?.requests.map((r) => (
                <ListItemButton
                  key={r.id}
                  selected={selected === r.id}
                  onClick={() => choose(r.id)}
                >
                  <ListItemText
                    primary={`${account("accessAndPortability")} ${r.id.slice(0, 8)}`}
                    secondary={`${r.state} · ${r.dueAt}`}
                  />
                </ListItemButton>
              ))}
            </List>
            {queue.data?.requests.length === 0 && <Typography>{t("empty")}</Typography>}
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 8 }}>
          {selected ? (
            <Case key={selected} requestId={selected} binding={binding} />
          ) : (
            <Typography>{t("selectRequest")}</Typography>
          )}
        </Grid>
      </Grid>
      <Dialog open={intake} onClose={() => setIntake(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t("assistedIntake")}</DialogTitle>
        <DialogContent>
          <Intake
            key={`${binding.apiOrigin}\0${binding.actorId}`}
            binding={binding}
            onCreated={(id) => {
              setIntake(false);
              setSelected(id);
            }}
          />
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
function Case({ requestId, binding }: { requestId: string; binding: PrivacyAdminBinding }) {
  const t = useTranslations("privacyAdmin");
  const query = useQuery(binding.queries.detail(requestId));
  return (
    <Stack spacing={2}>
      {query.isError && <Alert severity="error">{t("caseFailed")}</Alert>}
      {query.isLoading && <CircularProgress />}
      {query.data && <CaseForms detail={query.data} binding={binding} />}
    </Stack>
  );
}
function CaseForms({
  detail,
  binding,
}: {
  detail: PrivacyAdminDetail;
  binding: PrivacyAdminBinding;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows");
  const client = usePrivacyCaseClient(detail, binding);
  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 3 }, overflowWrap: "anywhere" }}>
      <Stack spacing={3}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Typography variant="h5">{t("case", { id: detail.request.id.slice(0, 8) })}</Typography>
          <Chip label={detail.request.state} />
          <Chip label={`v${detail.request.version}`} />
        </Stack>
        {client.errorCode && (
          <Alert severity="error">
            {client.errorCode === "REQUEST_VERSION_CONFLICT"
              ? w("versionConflict")
              : t("actionFailed")}{" "}
            ({client.errorCode})
          </Alert>
        )}
        <PrivacyIdentityReview detail={detail} client={client} />
        <Divider />
        <PrivacyTaskActions detail={detail} client={client} />
        <Divider />
        <PrivacyCaseDecisionForms detail={detail} client={client} />
        <Divider />
        <PrivacyAttachments detail={detail} client={client} />
        <Divider />
        <PrivacyBackupReview detail={detail} client={client} />
        <Divider />
        {!detail.capabilities.generate && (
          <Alert severity="info">
            {w("generationBlocked")} ({detail.capabilities.reasons.generate})
          </Alert>
        )}
        <Button
          variant="contained"
          disabled={client.pending || !detail.capabilities.generate}
          onClick={() =>
            void client.execute("generate", (c, h) =>
              privacyResult(
                sdk.generatePrivacyAdminArtifact(detail.request.id, {}, h, {
                  client: c,
                  timeoutMs: 180000,
                }),
              ),
            )
          }
        >
          {t("generateAfterReview")}
        </Button>
        <PrivacyArtifactDelivery detail={detail} client={client} />
        <Typography variant="h6">{w("caseEvents")}</Typography>
        {detail.events.map((e) => (
          <Typography key={`${e.createdAt}-${e.eventType}-${e.actorKind}`} variant="body2">
            {e.createdAt} · {e.eventType} · {e.actorKind} {e.payload?.reasonCode ?? ""}
          </Typography>
        ))}
      </Stack>
    </Paper>
  );
}
function Intake({
  binding,
  onCreated,
}: {
  binding: PrivacyAdminBinding;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("privacyAdmin");
  const mutation = usePrivacyMutationClient("intake", 1, binding);
  const [channel, setChannel] = useState<"email" | "post" | "representative" | "internal">("email"),
    [locator, setLocator] = useState(""),
    [locatorType, setLocatorType] = useState<
      "email" | "user_id" | "username" | "erasure_reference" | "other_reference"
    >("email"),
    [accountState, setAccountState] = useState<"current" | "inaccessible" | "deleted" | "unknown">(
      "inaccessible",
    ),
    [contact, setContact] = useState(""),
    [received, setReceived] = useState("");
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Typography>{t("assistedIntakeHelp")}</Typography>
      {mutation.errorCode && <Alert severity="error">{t("actionFailed")}</Alert>}
      <TextField
        select
        label={t("channel")}
        value={channel}
        onChange={(e) => setChannel(e.target.value as typeof channel)}
      >
        {(["email", "post", "representative", "internal"] as const).map((x) => (
          <MenuItem key={x} value={x}>
            {t(`channels.${x}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label={t("locatorType")}
        value={locatorType}
        onChange={(e) => setLocatorType(e.target.value as typeof locatorType)}
      >
        {(["email", "user_id", "username", "erasure_reference", "other_reference"] as const).map(
          (x) => (
            <MenuItem key={x} value={x}>
              {x}
            </MenuItem>
          ),
        )}
      </TextField>
      <TextField
        label={t("subjectLocator")}
        value={locator}
        onChange={(e) => setLocator(e.target.value)}
        helperText={t("subjectLocatorHelp")}
      />
      <TextField
        select
        label={t("accountState")}
        value={accountState}
        onChange={(e) => setAccountState(e.target.value as typeof accountState)}
      >
        {(["current", "inaccessible", "deleted", "unknown"] as const).map((x) => (
          <MenuItem key={x} value={x}>
            {t(`accountStates.${x}`)}
          </MenuItem>
        ))}
      </TextField>
      {channel === "representative" && (
        <TextField
          label={t("representativeContact")}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      )}
      <TextField
        label={t("receivedAt")}
        type="datetime-local"
        value={received}
        slotProps={{ inputLabel: { shrink: true } }}
        onChange={(e) => setReceived(e.target.value)}
      />
      <Button
        variant="contained"
        disabled={mutation.pending || !locator || (channel === "representative" && !contact)}
        onClick={async () => {
          const result = await mutation.execute("intake", (c, h) =>
            privacyResult(
              sdk.createPrivacyAdminCase(
                {
                  channel,
                  subject: { locatorType, locator, accountState },
                  ...(channel === "representative"
                    ? { representative: { contactType: "email", contact } }
                    : {}),
                  ...(received ? { receivedAt: new Date(received).toISOString() } : {}),
                  locale: document.documentElement.lang || "en",
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                },
                h,
                { client: c },
              ),
            ),
          );
          if (result) onCreated(result.request.id);
        }}
      >
        {t("recordRequest")}
      </Button>
    </Stack>
  );
}
