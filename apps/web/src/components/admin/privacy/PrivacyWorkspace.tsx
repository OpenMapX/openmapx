"use client";
import {
  Alert,
  Button,
  CircularProgress,
  DialogContent,
  DialogTitle,
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
import { useSession } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { parseAdminCaseSelection } from "@/lib/admin/adminNavigationState";
import {
  type PrivacyAdminBinding,
  privacyResult,
  usePrivacyAdmin,
  usePrivacyMutationClient,
} from "@/lib/admin/privacyAdmin";
import {
  clearPendingPrivacyAdminDelivery,
  readPendingPrivacyAdminDelivery,
} from "@/lib/admin/privacyReauthentication";
import { useAdminQueryState } from "@/lib/admin/useAdminQueryState";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { PrivacyCaseView } from "./PrivacyCaseView";
export function PrivacyWorkspace() {
  const binding = usePrivacyAdmin();
  return <Workspace key={`${binding.apiOrigin}\0${binding.actorId}`} binding={binding} />;
}
function Workspace({ binding }: { binding: PrivacyAdminBinding }) {
  const t = useTranslations("privacyAdmin"),
    account = useTranslations("account.privacyData"),
    setup = useTranslations("privacySetup"),
    nav = useTranslations("adminNavigation");
  const queue = useQuery(binding.queries.queue()),
    readiness = useQuery(binding.queries.readiness());
  const { params, update } = useAdminQueryState();
  const { caseId, section } = parseAdminCaseSelection(params);
  const { data: session } = useSession();
  const initialized = useRef(false),
    previous = useRef<string | null>(null);
  const [ready, setReady] = useState(false),
    [intake, setIntake] = useState(false);
  useEffect(() => {
    if (initialized.current || !binding.actorId) return;
    const pending = readPendingPrivacyAdminDelivery(binding.apiOrigin, binding.actorId);
    if (caseId) {
      if (pending && pending.requestId !== caseId) clearPendingPrivacyAdminDelivery();
    } else if (pending) update({ case: pending.requestId, section: "delivery" }, "replace");
    else if (!queue.data) return;
    else if (queue.data.requests[0]) update({ case: queue.data.requests[0].id }, "replace");
    initialized.current = true;
    setReady(true);
  }, [caseId, queue.data, binding.apiOrigin, binding.actorId, update]);
  useEffect(() => {
    if (!ready || !caseId) return;
    if (previous.current && previous.current !== caseId) clearPendingPrivacyAdminDelivery();
    previous.current = caseId;
  }, [ready, caseId]);
  const selected = caseId ?? previous.current;
  const choose = (id: string) => {
    if (id !== selected) clearPendingPrivacyAdminDelivery();
    update({ case: id, section: "identity" });
  };
  return (
    <Stack spacing={3} sx={{ maxWidth: 1500, mx: "auto", width: "100%" }}>
      <AdminPageHeader
        title={t("title")}
        actions={
          <>
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
          </>
        }
      />
      {queue.isError && <Alert severity="error">{t("loadFailed")}</Alert>}
      {readiness.isError && <Alert severity="error">{t("notReady")}</Alert>}
      {readiness.data && (
        <Alert
          severity={readiness.data.ready ? "success" : "warning"}
          action={
            session?.user.role === "admin" ? (
              <Button component={Link} href="/admin/privacy-setup">
                {setup("title")}
              </Button>
            ) : undefined
          }
        >
          {readiness.data.ready ? nav("privacyReadinessReady") : nav("privacyReadinessBlocked")}
          {!readiness.data.ready && session?.user.role !== "admin" && (
            <Typography variant="body2">{setup("readiness.contactFullAdmin")}</Typography>
          )}
        </Alert>
      )}
      <TextField
        select
        size="small"
        sx={{ display: { xs: "flex", md: "none" } }}
        label={t("queue", { count: queue.data?.requests.length ?? 0 })}
        value={selected ?? ""}
        onChange={(e) => choose(e.target.value)}
      >
        {selected && !queue.data?.requests.some((r) => r.id === selected) && (
          <MenuItem value={selected}>{t("case", { id: selected.slice(0, 8) })}</MenuItem>
        )}
        {queue.data?.requests.map((r) => (
          <MenuItem key={r.id} value={r.id}>
            {r.id.slice(0, 8)} · {r.state}
          </MenuItem>
        ))}
      </TextField>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }} sx={{ display: { xs: "none", md: "block" } }}>
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
          {ready && selected ? (
            <Case
              key={selected}
              requestId={selected}
              binding={binding}
              section={section}
              onSectionChange={(value) => update({ case: selected, section: value })}
            />
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
              choose(id);
            }}
          />
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
function Case({
  requestId,
  binding,
  section,
  onSectionChange,
}: {
  requestId: string;
  binding: PrivacyAdminBinding;
  section: import("@/lib/admin/adminNavigationState").PrivacyCaseSection;
  onSectionChange: (value: import("@/lib/admin/adminNavigationState").PrivacyCaseSection) => void;
}) {
  const t = useTranslations("privacyAdmin");
  const query = useQuery(binding.queries.detail(requestId));
  return (
    <Stack spacing={2}>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>{t("refresh")}</Button>}
        >
          {t("caseFailed")}
        </Alert>
      )}
      {query.isLoading && <CircularProgress />}
      {query.data && (
        <PrivacyCaseView
          onRefresh={() => void query.refetch()}
          detail={query.data}
          binding={binding}
          section={section}
          onSectionChange={onSectionChange}
        />
      )}
    </Stack>
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
