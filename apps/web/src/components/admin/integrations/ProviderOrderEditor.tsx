"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminProviderOrder } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminToast } from "../shared/AdminToast";
import { DomainChip } from "./DomainChip";

type DomainOrder = AdminProviderOrder["domains"][number];

interface Row {
  id: string;
  name: string;
  loaded: boolean;
}

/**
 * The rows the operator orders: the stored entries in their stored order,
 * including ones that are not loaded, which keep their place rather than
 * vanishing from the saved list. Where unlisted providers join at the end they
 * are rows too, so saving writes the order that is served; where the list is a
 * selection they are only offered.
 */
function orderRows(order: DomainOrder, ids: readonly string[]) {
  const loaded = new Map(order.effective.map((entry) => [entry.integrationId, entry]));
  const listed: Row[] = ids.map((id) => ({
    id,
    name: loaded.get(id)?.name ?? id,
    loaded: loaded.has(id),
  }));
  const rest: Row[] = order.effective
    .filter((entry) => !ids.includes(entry.integrationId))
    .map((entry) => ({ id: entry.integrationId, name: entry.name, loaded: true }));
  return order.unlisted === "append"
    ? { listed: [...listed, ...rest], available: [] }
    : { listed, available: rest };
}

function moved(ids: readonly string[], index: number, offset: -1 | 1): string[] {
  const next = [...ids];
  const target = index + offset;
  const [entry] = next.splice(index, 1);
  if (entry === undefined || target < 0 || target > next.length) return [...ids];
  next.splice(target, 0, entry);
  return next;
}

/**
 * Orders the providers of one domain through its orchestrator's
 * `providerOrder` setting. Each change is saved at once; an order the host
 * environment sets is shown, not offered for editing, because a saved one
 * would not take effect.
 */
export function ProviderOrderEditor({
  orchestratorId,
  domain,
}: {
  orchestratorId: string;
  domain: string;
}) {
  const t = useTranslations("adminIntegrations");
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client, `${orchestratorId}:${domain}`);
  const showToast = useAdminToast();
  const orders = useQuery(admin.queries.providerOrder());
  const detail = useQuery(admin.queries.detail(orchestratorId));

  const save = useMutation({
    mutationKey: ["integration-provider-order", admin.apiUrl, orchestratorId],
    retry: false,
    mutationFn: async (providerOrder: string[]) => {
      try {
        await admin.patchConfig(orchestratorId, { providerOrder });
        // The rows stay on the saved order until the served order is read back.
        await admin.refresh();
        if (owner.active) showToast(t("providerOrderSaved"));
      } catch (err) {
        if (owner.active) showToast(adminErrorText(err, t("providerOrderSaveFailed")), "error");
        throw err;
      }
    },
  });

  if (orders.isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }
  if (orders.isError) {
    return (
      <Alert severity="error" variant="outlined">
        {t("providerOrderLoadFailed")}
      </Alert>
    );
  }
  const order = orders.data?.domains.find(
    (entry) => entry.domain === domain && entry.orchestratorId === orchestratorId,
  );
  if (!order) return null;

  const resolved = detail.data?.resolvedConfig.providerOrder;
  const ownership = detail.data?.ownership?.providerOrder;
  const overridden =
    resolved?.source === "env" ||
    resolved?.source === "config.json" ||
    ownership?.writable === false;
  const locked = overridden || !detail.data || save.isPending;
  const selection = order.unlisted === "exclude";
  const shownIds = save.isPending && save.variables ? save.variables : order.stored;
  const { listed, available } = orderRows(order, shownIds);
  const ids = listed.map((row) => row.id);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack sx={{ gap: 1.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Typography component="h2" variant="subtitle2" sx={{ color: "text.secondary" }}>
              {t("providerOrderTitle")}
            </Typography>
            <DomainChip domain={domain} />
            {save.isPending && <CircularProgress size={14} aria-hidden />}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {selection ? t("providerOrderSelectionHint") : t("providerOrderAppendHint")}
          </Typography>
          {overridden && (
            <Alert
              severity="info"
              variant="outlined"
              sx={{ "& .MuiAlert-message": { minWidth: 0, overflowWrap: "anywhere" } }}
            >
              {ownership?.envVar
                ? t.rich("providerOrderOverriddenByVariable", {
                    envVar: ownership.envVar,
                    code: (chunks) => <code>{chunks}</code>,
                  })
                : t("providerOrderOverridden")}
            </Alert>
          )}
          {listed.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {selection ? t("providerOrderNoneSelected") : t("providerOrderEmpty")}
            </Typography>
          ) : (
            <Box
              component="ol"
              aria-label={t("providerOrderTitle")}
              sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 0.75 }}
            >
              {listed.map((row, index) => (
                <Box
                  component="li"
                  key={row.id}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 1,
                    px: 1.5,
                    py: 0.75,
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{ color: "text.secondary", minWidth: "1.5em", textAlign: "right" }}
                    aria-hidden
                  >
                    {index + 1}.
                  </Typography>
                  <Stack sx={{ flex: "1 1 6rem", minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                        overflowWrap: "anywhere",
                        fontFamily: row.loaded ? undefined : "monospace",
                      }}
                    >
                      {row.name}
                    </Typography>
                    {!row.loaded && (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {t("providerOrderNotLoadedHint")}
                      </Typography>
                    )}
                  </Stack>
                  {!row.loaded && (
                    <Chip
                      label={t("providerOrderNotLoaded")}
                      size="small"
                      color="warning"
                      variant="outlined"
                    />
                  )}
                  <Stack direction="row" sx={{ alignItems: "center", gap: 0.5, ml: "auto" }}>
                    <IconButton
                      size="small"
                      aria-label={t("providerOrderMoveUp", { name: row.name })}
                      disabled={locked || index === 0}
                      onClick={() => save.mutate(moved(ids, index, -1))}
                    >
                      <ArrowUpwardIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label={t("providerOrderMoveDown", { name: row.name })}
                      disabled={locked || index === listed.length - 1}
                      onClick={() => save.mutate(moved(ids, index, 1))}
                    >
                      <ArrowDownwardIcon fontSize="small" />
                    </IconButton>
                    {(selection || !row.loaded) && (
                      <Button
                        size="small"
                        color="error"
                        aria-label={t("providerOrderRemoveNamed", { name: row.name })}
                        disabled={locked}
                        onClick={() => save.mutate(ids.filter((id) => id !== row.id))}
                      >
                        {t("providerOrderRemove")}
                      </Button>
                    )}
                  </Stack>
                </Box>
              ))}
            </Box>
          )}
          {selection && available.length > 0 && (
            <Stack sx={{ gap: 0.75 }}>
              <Typography component="h3" variant="subtitle2" sx={{ color: "text.secondary" }}>
                {t("providerOrderAvailable")}
              </Typography>
              <Box
                component="ul"
                sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 0.75 }}
              >
                {available.map((row) => (
                  <Box
                    component="li"
                    key={row.id}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 1,
                      px: 1.5,
                      py: 0.75,
                      border: 1,
                      borderColor: "divider",
                      borderStyle: "dashed",
                      borderRadius: 1,
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{ flex: "1 1 6rem", minWidth: 0, overflowWrap: "anywhere" }}
                    >
                      {row.name}
                    </Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      aria-label={t("providerOrderAddNamed", { name: row.name })}
                      disabled={locked}
                      onClick={() => save.mutate([...ids, row.id])}
                      sx={{ ml: "auto" }}
                    >
                      {t("providerOrderAdd")}
                    </Button>
                  </Box>
                ))}
              </Box>
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
