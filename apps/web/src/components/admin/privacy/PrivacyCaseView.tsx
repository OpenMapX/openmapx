"use client";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { PRIVACY_CASE_SECTIONS, type PrivacyCaseSection } from "@/lib/admin/adminNavigationState";
import {
  type PrivacyAdminBinding,
  type PrivacyCaseClient,
  privacyResult,
  usePrivacyCaseClient,
} from "@/lib/admin/privacyAdmin";
import { PrivacyCaseDecisionForms } from "./PrivacyCaseDecisionForms";
import { PrivacyExportDownload } from "./PrivacyExportDownload";
import { PrivacyTaskActions } from "./PrivacyTaskActions";

/** Identity: a self-service request is proven by the fresh sign-in; an
 * assisted one needs the operator to record a manual check. */
function PrivacyIdentityVerification({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows");
  const [reason, setReason] = useState("");
  const method = detail.request.identityMethod;
  return (
    <Stack spacing={2}>
      <Typography>
        {method
          ? t("identityVerified", { method: t(`identityMethods.${method}`) })
          : t("unverified")}
      </Typography>
      {detail.capabilities.verifyIdentity && (
        <>
          <Typography variant="body2">{w("verifyIdentityHelp")}</Typography>
          <TextField
            label={w("reasonCode")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={client.pending}
          />
          <Button
            variant="contained"
            disabled={client.pending || !reason}
            onClick={() =>
              void client.execute("identity-verification", (c, h) =>
                privacyResult(
                  sdk.verifyPrivacyAdminIdentity(
                    detail.request.id,
                    { version: detail.request.version, reasonCode: reason },
                    h,
                    { client: c },
                  ),
                ),
              )
            }
          >
            {t("verifyIdentity")}
          </Button>
        </>
      )}
    </Stack>
  );
}

export function PrivacyCaseView({
  detail,
  binding,
  section,
  onSectionChange,
  onRefresh,
}: {
  detail: PrivacyAdminDetail;
  binding: PrivacyAdminBinding;
  section: PrivacyCaseSection;
  onSectionChange: (value: PrivacyCaseSection) => void;
  onRefresh: () => void;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows"),
    nav = useTranslations("adminNavigation");
  const client = usePrivacyCaseClient(detail, binding);
  const [expanded, setExpanded] = useState<PrivacyCaseSection | null>(section),
    [eventCount, setEventCount] = useState(100);
  useEffect(() => setExpanded(section), [section]);
  const capabilitySections = {
    verifyIdentity: "identity",
    resolveTasks: "tasks",
    extendDeadline: "decisions",
    caseDecision: "decisions",
    export: "export",
  } as const;
  const allowed = [
    ...new Set(
      Object.entries(capabilitySections)
        .filter(([key]) => detail.capabilities[key as keyof typeof capabilitySections])
        .map(([, value]) => value),
    ),
  ];
  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, overflowWrap: "anywhere" }}>
      <Stack sx={{ gap: 2 }}>
        <Stack direction="row" useFlexGap sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <Typography variant="h6" component="h2">
            {t("case", { id: detail.request.id.slice(0, 8) })}
          </Typography>
          <Chip size="small" label={detail.request.state} />
          <Chip size="small" label={`v${detail.request.version}`} />
          <Button size="small" onClick={onRefresh} sx={{ ml: "auto" }}>
            {t("refresh")}
          </Button>
        </Stack>
        <Typography variant="body2">
          {nav("privacyDue", { date: new Date(detail.request.dueAt).toLocaleString() })}
        </Typography>
        <Stack
          direction="row"
          useFlexGap
          sx={{ gap: 0.5, flexWrap: "wrap" }}
          aria-label={nav("privacyAvailable")}
        >
          <Typography variant="caption" sx={{ alignSelf: "center" }}>
            {nav("privacyAvailable")}
          </Typography>
          {allowed.map((value) => (
            <Button
              key={value}
              size="small"
              onClick={() => {
                setExpanded(value);
                onSectionChange(value);
              }}
            >
              {nav(`privacySections.${value}`)}
            </Button>
          ))}
        </Stack>
        {client.errorCode && (
          <Alert severity="error">
            {client.errorCode === "REQUEST_VERSION_CONFLICT"
              ? w("versionConflict")
              : t("actionFailed")}{" "}
            ({client.errorCode})
          </Alert>
        )}
        {Object.entries(detail.capabilities.reasons)
          .filter(([key]) => key !== "export")
          .map(([key, reason]) => (
            <Alert key={key} severity="info">
              {key}: {reason}
            </Alert>
          ))}
        <div>
          {PRIVACY_CASE_SECTIONS.map((value) => (
            <Accordion
              key={value}
              expanded={expanded === value}
              onChange={(_, open) => {
                setExpanded(open ? value : null);
                if (open) onSectionChange(value);
              }}
              disableGutters
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                id={`case-section-${value}`}
                aria-controls={`case-content-${value}`}
              >
                <Typography component="h3" variant="subtitle1">
                  {nav(`privacySections.${value}`)}
                </Typography>
              </AccordionSummary>
              <AccordionDetails id={`case-content-${value}`}>
                {value === "identity" && (
                  <PrivacyIdentityVerification detail={detail} client={client} />
                )}
                {value === "tasks" && <PrivacyTaskActions detail={detail} client={client} />}
                {value === "decisions" && (
                  <PrivacyCaseDecisionForms detail={detail} client={client} />
                )}
                {value === "export" && expanded === value && (
                  <PrivacyExportDownload detail={detail} client={client} />
                )}
                {value === "events" && (
                  <Stack sx={{ gap: 1 }}>
                    {detail.events.slice(-eventCount).map((event) => (
                      <Typography
                        key={`${event.createdAt}-${event.eventType}-${event.actorKind}`}
                        variant="body2"
                      >
                        {event.createdAt} · {event.eventType} · {event.actorKind}{" "}
                        {event.payload?.reasonCode ?? ""}
                      </Typography>
                    ))}
                    {detail.events.length > eventCount && (
                      <Button onClick={() => setEventCount((n) => n + 100)}>
                        {nav("privacyOlderEvents")}
                      </Button>
                    )}
                  </Stack>
                )}
              </AccordionDetails>
            </Accordion>
          ))}
        </div>
      </Stack>
    </Paper>
  );
}
