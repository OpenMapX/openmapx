"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  type PersonalTimelineApiError,
  type TimelineConnectionView,
  usePersonalTimelineDay,
  usePersonalTimelineStore,
  useSession,
  useSidebarStore,
  useTestTimelineConnection,
  useTimelineConnection,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";
import { calendarDateInTimeZone, TimelineDayHeader } from "./TimelineDayHeader";
import { TimelineEntryList } from "./TimelineEntryList";
import { TimelineSummary } from "./TimelineSummary";

function stableErrorKey(error: PersonalTimelineApiError | null): string {
  switch (error?.code) {
    case "TIMELINE_NOT_CONNECTED":
    case "TIMELINE_MANAGED_DISABLED":
    case "TIMELINE_CREDENTIAL_INVALID":
    case "TIMELINE_INSTANCE_UNSUPPORTED":
    case "TIMELINE_PLAN_RESTRICTED":
    case "TIMELINE_RATE_LIMITED":
    case "TIMELINE_UPSTREAM_UNAVAILABLE":
    case "TIMELINE_RESPONSE_INVALID":
      return error.code;
    default:
      return "unknown";
  }
}

function needsConnectionRecovery(error: PersonalTimelineApiError | null): boolean {
  return (
    error?.code === "TIMELINE_NOT_CONNECTED" ||
    error?.code === "TIMELINE_MANAGED_DISABLED" ||
    error?.code === "TIMELINE_CREDENTIAL_INVALID"
  );
}

function TimelineLoading({ label }: { label: string }) {
  return (
    <Stack role="status" aria-label={label} spacing={1.25} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Skeleton variant="rounded" height={72} />
      <Skeleton variant="rounded" height={112} />
      <Skeleton variant="rounded" height={112} />
    </Stack>
  );
}

function RecoveryActions({ ownerId }: { ownerId: string }) {
  const t = useTranslations("timeline");
  const testMutation = useTestTimelineConnection(ownerId);
  const showSettings = useAccountSettingsStore((state) => state.show);
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      <Button
        onClick={() => void testMutation.mutateAsync().catch(() => undefined)}
        disabled={testMutation.isPending}
        sx={{ minHeight: 44 }}
      >
        {testMutation.isPending ? t("testingConnection") : t("testConnection")}
      </Button>
      <Button onClick={() => showSettings("timeline")} sx={{ minHeight: 44 }}>
        {t("replaceConnection")}
      </Button>
    </Stack>
  );
}

function ConnectedTimeline({
  ownerId,
  connection,
}: {
  ownerId: string;
  connection: NonNullable<TimelineConnectionView["connection"]>;
}) {
  const t = useTranslations("timeline");
  const tc = useTranslations("common");
  const selectedDate = usePersonalTimelineStore((state) => state.selectedDate);
  const setSelectedDate = usePersonalTimelineStore((state) => state.setSelectedDate);

  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calendarDateInTimeZone(new Date(), connection.timeZone);
  const effectiveDate = selectedDate ?? today;
  const future = effectiveDate > today;
  const canRead = connection.status !== "invalid" && !future;
  const dayQuery = usePersonalTimelineDay(ownerId, effectiveDate, canRead);

  useEffect(() => {
    if (selectedDate === null) setSelectedDate(today);
  }, [selectedDate, setSelectedDate, today]);

  return (
    <>
      <TimelineDayHeader
        date={effectiveDate}
        today={today}
        timeZone={connection.timeZone}
        browserTimeZone={browserTimeZone}
        onDateChange={setSelectedDate}
      />

      {connection.status !== "connected" && (
        <Alert severity={connection.status === "invalid" ? "error" : "warning"} sx={{ mb: 1.5 }}>
          {t(`connection.${connection.status}`)}
        </Alert>
      )}
      {connection.status !== "connected" && (
        <Box sx={{ mb: 2 }}>
          <RecoveryActions ownerId={ownerId} />
        </Box>
      )}

      {future ? (
        <Alert severity="info">{t("futureDay")}</Alert>
      ) : connection.status === "invalid" ? null : dayQuery.isPending && !dayQuery.data ? (
        <TimelineLoading label={t("loadingDay")} />
      ) : dayQuery.error ? (
        <>
          <Alert
            severity="error"
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => void dayQuery.refetch()}
                sx={{ minHeight: 44, minWidth: 44 }}
              >
                {tc("retry")}
              </Button>
            }
          >
            {t(`errors.${stableErrorKey(dayQuery.error)}`)}
          </Alert>
          {needsConnectionRecovery(dayQuery.error) && (
            <Box sx={{ mt: 1.5 }}>
              <RecoveryActions ownerId={ownerId} />
            </Box>
          )}
        </>
      ) : dayQuery.data?.entries.length === 0 ? (
        <Box sx={{ py: 5, px: 2, textAlign: "center" }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 650 }}>
            {t("emptyDay")}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            {t("emptyDayHint")}
          </Typography>
        </Box>
      ) : dayQuery.data ? (
        <>
          <TimelineSummary
            summary={dayQuery.data.summary}
            distanceUnit={dayQuery.data.distanceUnit}
          />
          {dayQuery.data.warnings.map((warning) => (
            <Alert key={warning} severity="warning" sx={{ mb: 1 }}>
              {t(`warnings.${warning}`)}
            </Alert>
          ))}
          <TimelineEntryList day={dayQuery.data} />
        </>
      ) : null}
    </>
  );
}

function AuthenticatedTimeline({ ownerId }: { ownerId: string }) {
  const t = useTranslations("timeline");
  const tc = useTranslations("common");
  const showSettings = useAccountSettingsStore((state) => state.show);
  const connectionQuery = useTimelineConnection(ownerId);

  if (connectionQuery.isPending && !connectionQuery.data) {
    return <TimelineLoading label={t("loadingConnection")} />;
  }

  if (connectionQuery.error && !connectionQuery.data) {
    return (
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => void connectionQuery.refetch()}
            sx={{ minHeight: 44, minWidth: 44 }}
          >
            {tc("retry")}
          </Button>
        }
      >
        {t(`errors.${stableErrorKey(connectionQuery.error)}`)}
      </Alert>
    );
  }

  if (!connectionQuery.data?.connected || !connectionQuery.data.connection) {
    return (
      <Box sx={{ py: 5, px: 2, textAlign: "center" }}>
        <Typography component="h1" variant="h6" sx={{ fontWeight: 650, letterSpacing: "-0.012em" }}>
          {t("onboardingTitle")}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1, mb: 2.5, lineHeight: 1.55 }}
        >
          {t("onboardingReadOnly")}
        </Typography>
        <Button variant="contained" onClick={() => showSettings("timeline")} sx={{ minHeight: 44 }}>
          {t("openSettings")}
        </Button>
      </Box>
    );
  }

  return <ConnectedTimeline ownerId={ownerId} connection={connectionQuery.data.connection} />;
}

export function TimelinePanelContent() {
  const t = useTranslations("timeline");
  const { data: session, isPending } = useSession();
  const ownerId = session?.user?.id ?? null;

  useEffect(() => {
    if (!isPending && !ownerId) useSidebarStore.getState().closeAll();
  }, [isPending, ownerId]);

  if (isPending) {
    return (
      <Box sx={{ p: 2 }}>
        <TimelineLoading label={t("loadingConnection")} />
      </Box>
    );
  }
  if (!ownerId) return null;

  return (
    <Box
      data-testid="timeline-panel-root"
      sx={{
        p: { xs: 2, sm: 2.25 },
        pb: "max(24px, env(safe-area-inset-bottom))",
        minWidth: 0,
      }}
    >
      <AuthenticatedTimeline ownerId={ownerId} />
    </Box>
  );
}
