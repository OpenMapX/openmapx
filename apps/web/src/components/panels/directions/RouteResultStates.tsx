"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { isApiClientError } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

export const GROUND_FALLBACK_MODES = ["walking", "cycling", "driving", "motorcycle"] as const;
export type GroundFallbackMode = (typeof GROUND_FALLBACK_MODES)[number];

export type PlanStatus = "loading" | "error" | "empty" | "ready";

/** One planner's answer as the results area shows it. */
export interface PlanState<T> {
  status: PlanStatus;
  data: T | undefined;
  error: unknown;
  retry: () => void;
}

interface PlanQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

/**
 * A planner query's state: loading until it has an answer (and again while a
 * failed plan retries), then its error, an empty answer, or ready.
 */
export function planState<T>(query: PlanQuery<T>, isEmpty: (data: T) => boolean): PlanState<T> {
  const { data, isLoading, isError, isFetching } = query;
  const status: PlanStatus =
    isLoading || (isError && isFetching) || (!data && !isError)
      ? "loading"
      : isError
        ? "error"
        : data && isEmpty(data)
          ? "empty"
          : "ready";
  return {
    status,
    data,
    error: query.error,
    retry: () => void query.refetch?.(),
  };
}

/** What a person can do when no route came back. */
export interface RouteRecoveryActions {
  onEditOrigin: () => void;
  onEditDestination: () => void;
  modes: GroundFallbackMode[];
  onSelectMode: (mode: GroundFallbackMode) => void;
}

function RouteRecovery({
  failed,
  error,
  onRetry,
  actions,
}: {
  failed: boolean;
  error?: unknown;
  onRetry?: () => void;
  actions: RouteRecoveryActions;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const unavailable = isApiClientError(error) && [502, 503, 504].includes(error.status);
  return (
    <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
      <Typography variant="body2" sx={{ color: failed ? "error.main" : "text.secondary" }}>
        {t(
          failed
            ? unavailable
              ? "routeServiceUnavailable"
              : "routeRequestFailed"
            : "noRoutesFound",
        )}
      </Typography>
      {failed ? (
        <Button size="small" onClick={onRetry} sx={{ mt: 1 }}>
          {tc("retry")}
        </Button>
      ) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 1, mt: 1 }}>
          <Button size="small" onClick={actions.onEditOrigin}>
            {t("changeOrigin")}
          </Button>
          <Button size="small" onClick={actions.onEditDestination}>
            {t("changeDestination")}
          </Button>
          {actions.modes.map((mode) => (
            <Button key={mode} size="small" onClick={() => actions.onSelectMode(mode)}>
              {t("tryMode", { mode: t(mode) })}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The empty-answer notice, for a list that shows it beside other content. */
export function NoRoutesFound({ actions }: { actions: RouteRecoveryActions }) {
  return <RouteRecovery failed={false} actions={actions} />;
}

/**
 * A planner's results area: a spinner while it plans, the failure with a
 * retry, the empty answer with ways out, and the results once ready.
 */
export function RouteResultStates({
  state,
  recovery,
  children,
}: {
  state: Pick<PlanState<unknown>, "status" | "error" | "retry">;
  recovery: RouteRecoveryActions;
  children?: ReactNode;
}) {
  switch (state.status) {
    case "loading":
      return (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={28} sx={{ color: BRAND }} />
        </Box>
      );
    case "error":
      return <RouteRecovery failed error={state.error} onRetry={state.retry} actions={recovery} />;
    case "empty":
      return <NoRoutesFound actions={recovery} />;
    case "ready":
      return <>{children}</>;
  }
}
