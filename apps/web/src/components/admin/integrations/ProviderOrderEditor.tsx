"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { AdminProviderOrder } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef } from "react";
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

type Control = "up" | "down" | "remove";

/** One save: the list to store, what to announce once it is stored, and where focus goes. */
interface Change {
  providerOrder: string[];
  announcement: string;
  focus: readonly (readonly [id: string, control: Control])[];
}

/** The manifests' bound on a stored order, used when a schema states none. */
const DEFAULT_MAX_ITEMS = 64;

/** The `providerOrder` property of a configuration schema, if it declares one. */
function providerOrderProperty(configSchema: unknown): Record<string, unknown> | undefined {
  if (typeof configSchema !== "object" || configSchema === null) return undefined;
  const properties = (configSchema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const property = (properties as Record<string, unknown>).providerOrder;
  return typeof property === "object" && property !== null
    ? (property as Record<string, unknown>)
    : undefined;
}

/**
 * Whether an integration's configuration schema stores a provider order. An
 * orchestrator without the setting refuses a saved order, so it gets no editor.
 */
export function declaresProviderOrder(configSchema: unknown): boolean {
  return providerOrderProperty(configSchema) !== undefined;
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
 * The list cut to the schema's bound. Where unlisted providers join at the
 * end, only the trailing ones that are not stored are dropped: they are served
 * after every listed one anyway, so the served order does not change. A
 * selection serves only what it lists, so nothing is dropped from it. `null`
 * when the list cannot be cut that way.
 */
function withinLimit(
  ids: readonly string[],
  stored: readonly string[],
  max: number,
  selection: boolean,
) {
  const next = [...ids];
  while (next.length > max) {
    const last = next.at(-1);
    if (selection || last === undefined || stored.includes(last)) return null;
    next.pop();
  }
  return next;
}

/**
 * Keyboard focus is visible on every control here; the theme's ripple alone
 * is too faint against the card. A control stays focusable while a save is
 * open, because a browser drops focus from a control that becomes disabled.
 */
const controlSx: SxProps<Theme> = {
  "&.Mui-focusVisible, &:focus-visible": {
    outline: "2px solid",
    outlineColor: "primary.main",
    outlineOffset: 2,
  },
  '&[aria-disabled="true"]': { color: "action.disabled", cursor: "default" },
};

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
  const controls = useRef(new Map<string, HTMLElement>());
  const editor = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterSave = useRef<Change["focus"] | null>(null);
  const restoredTo = useRef<Element | null>(null);

  const save = useMutation({
    mutationKey: ["integration-provider-order", admin.apiUrl, orchestratorId],
    retry: false,
    mutationFn: async (change: Change) => {
      try {
        await admin.patchConfig(orchestratorId, { providerOrder: change.providerOrder });
        // The rows stay on the saved order until the served order is read back.
        await admin.refresh();
        if (owner.active) showToast(change.announcement);
      } catch (err) {
        if (owner.active) showToast(adminErrorText(err, t("providerOrderSaveFailed")), "error");
        throw err;
      }
    },
  });

  // Rows move in the DOM as the order changes, which drops focus; put it back
  // on the control the operator used, or the nearest one that still applies.
  useLayoutEffect(() => {
    const wanted = focusAfterSave.current;
    if (!wanted) return;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (!lost && !editor.current?.contains(active)) {
      focusAfterSave.current = null;
      return;
    }
    const target =
      wanted
        .map(([id, control]) => controls.current.get(`${id}:${control}`))
        .find((element) => element && !element.hasAttribute("disabled")) ?? heading.current;
    restoredTo.current = target ?? null;
    if (target && target !== active) target.focus();
    if (!save.isPending) focusAfterSave.current = null;
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
  // Nothing can be saved: the host sets the order, or its settings are unknown.
  const locked = overridden || !detail.data;
  const pending = save.isPending;
  const selection = order.unlisted === "exclude";
  const shownIds = pending && save.variables ? save.variables.providerOrder : order.stored;
  const { listed, available } = orderRows(order, shownIds);
  const ids = listed.map((row) => row.id);
  const declaredMax = providerOrderProperty(detail.data?.manifest.configSchema)?.maxItems;
  const maxItems = typeof declaredMax === "number" ? declaredMax : DEFAULT_MAX_ITEMS;

  const register = (id: string, control: Control) => (element: HTMLElement | null) => {
    if (element) controls.current.set(`${id}:${control}`, element);
    else controls.current.delete(`${id}:${control}`);
  };

  const submit = (change: Change) => {
    if (pending || locked) return;
    const providerOrder = withinLimit(change.providerOrder, order.stored, maxItems, selection);
    if (!providerOrder) {
      showToast(t("providerOrderTooMany", { max: maxItems }), "error");
      return;
    }
    focusAfterSave.current = change.focus;
    save.mutate({ ...change, providerOrder });
  };

  const move = (row: Row, index: number, offset: -1 | 1) => {
    const control: Control = offset < 0 ? "up" : "down";
    submit({
      providerOrder: moved(ids, index, offset),
      announcement: t("providerOrderMoved", { name: row.name, position: index + offset + 1 }),
      focus: [
        [row.id, control],
        [row.id, control === "up" ? "down" : "up"],
      ],
    });
  };

  const remove = (row: Row, index: number) => {
    const neighbour = ids[index + 1] ?? ids[index - 1];
    submit({
      providerOrder: ids.filter((id) => id !== row.id),
      announcement: t("providerOrderRemoved", { name: row.name }),
      focus: neighbour
        ? [
            [neighbour, "remove"],
            [neighbour, "up"],
            [neighbour, "down"],
          ]
        : [],
    });
  };

  const add = (row: Row) =>
    submit({
      providerOrder: [...ids, row.id],
      announcement: t("providerOrderAdded", { name: row.name, position: ids.length + 1 }),
      focus: [
        [row.id, "remove"],
        [row.id, "up"],
      ],
    });

  return (
    <Card
      variant="outlined"
      ref={editor}
      onFocus={(event) => {
        // The operator went on to another control while the save was open.
        if (event.target !== restoredTo.current) focusAfterSave.current = null;
      }}
    >
      <CardContent>
        <Stack sx={{ gap: 1.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Typography
              ref={heading}
              tabIndex={-1}
              component="h2"
              variant="subtitle2"
              sx={{ color: "text.secondary", outline: "none" }}
            >
              {t("providerOrderTitle")}
            </Typography>
            <DomainChip domain={domain} />
            {pending && <CircularProgress size={14} aria-hidden />}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {selection ? t("providerOrderSelectionHint") : t("providerOrderAppendHint")}
          </Typography>
          {detail.isError && (
            <Alert severity="error" variant="outlined">
              {t("providerOrderSettingsLoadFailed")}
            </Alert>
          )}
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
                      variant="outlined"
                      icon={<WarningAmberIcon />}
                      sx={{
                        "& .MuiChip-icon": {
                          color: (theme) =>
                            theme.palette.mode === "dark"
                              ? theme.palette.warning.light
                              : theme.palette.warning.dark,
                        },
                      }}
                    />
                  )}
                  <Stack direction="row" sx={{ alignItems: "center", gap: 0.5, ml: "auto" }}>
                    <IconButton
                      ref={register(row.id, "up")}
                      size="small"
                      aria-label={t("providerOrderMoveUp", { name: row.name })}
                      disabled={locked || index === 0}
                      aria-disabled={pending || undefined}
                      onClick={() => move(row, index, -1)}
                      sx={controlSx}
                    >
                      <ArrowUpwardIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      ref={register(row.id, "down")}
                      size="small"
                      aria-label={t("providerOrderMoveDown", { name: row.name })}
                      disabled={locked || index === listed.length - 1}
                      aria-disabled={pending || undefined}
                      onClick={() => move(row, index, 1)}
                      sx={controlSx}
                    >
                      <ArrowDownwardIcon fontSize="small" />
                    </IconButton>
                    {(selection || !row.loaded) && (
                      <Button
                        ref={register(row.id, "remove")}
                        size="small"
                        color="error"
                        aria-label={t("providerOrderRemoveNamed", { name: row.name })}
                        disabled={locked}
                        aria-disabled={pending || undefined}
                        onClick={() => remove(row, index)}
                        sx={controlSx}
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
                      aria-disabled={pending || undefined}
                      onClick={() => add(row)}
                      sx={[controlSx, { ml: "auto" }] as SxProps<Theme>}
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
