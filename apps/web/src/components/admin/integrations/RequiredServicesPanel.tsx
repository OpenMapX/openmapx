"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceSummary } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useServicesList } from "@/hooks/useServices";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { CapabilityBindingPicker } from "./CapabilityBindingPicker";

type RequireEntry =
  import("@openmapx/core/api-contracts").AdminIntegrationSummary["requires"][number];

function ServiceRequireRow({
  req,
  services,
}: {
  req: RequireEntry & { service: string };
  services: AdminServiceSummary[];
}) {
  const installed = services.find((s) => s.id === req.service);

  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{
        alignItems: "center",
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontFamily: "monospace",
          minWidth: 180,
        }}
      >
        {req.service}
        {req.optional && (
          <Typography
            component="span"
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {" "}
            (optional)
          </Typography>
        )}
      </Typography>
      {installed ? (
        <Alert severity="success" sx={{ flex: 1, py: 0 }}>
          Installed — {installed.status}
        </Alert>
      ) : req.optional ? (
        <Alert severity="info" sx={{ flex: 1, py: 0 }}>
          Not installed — using public fallback
        </Alert>
      ) : (
        <Alert severity="warning" sx={{ flex: 1, py: 0 }}>
          Required but not installed
        </Alert>
      )}
    </Stack>
  );
}

function CapabilityRequireRow({
  req,
  services,
  currentBinding,
  onBind,
  disabled,
  activeServiceId,
}: {
  req: RequireEntry & { capability: string };
  services: AdminServiceSummary[];
  currentBinding: string | null;
  onBind: (serviceId: string | null) => void;
  disabled: boolean;
  activeServiceId: string | null;
}) {
  const providers = services.filter((s) => s.provides.includes(req.capability));

  return (
    <Stack
      direction={{ xs: "column", md: "row" }}
      spacing={2}
      sx={{
        alignItems: { xs: "stretch", md: "center" },
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontFamily: "monospace",
          minWidth: 180,
        }}
      >
        any {req.capability}
        {req.optional && (
          <Typography
            component="span"
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {" "}
            (optional)
          </Typography>
        )}
      </Typography>
      <CapabilityBindingPicker
        capability={req.capability}
        providers={providers}
        value={currentBinding}
        onChange={onBind}
        disabled={disabled}
      />
      <Stack>
        <Typography variant="caption">Saved: {currentBinding ?? "automatic"}</Typography>
        <Typography variant="caption">Active: {activeServiceId ?? "unresolved"}</Typography>
        <Button size="small" disabled={disabled} onClick={() => onBind(currentBinding)}>
          Apply saved binding
        </Button>
      </Stack>
      {providers.length === 0 && (
        <Alert severity="info" sx={{ flex: 1, py: 0 }}>
          No installed services provide this capability
        </Alert>
      )}
    </Stack>
  );
}

export function RequiredServicesPanel({
  integrationId,
  requires,
}: {
  integrationId: string;
  requires: RequireEntry[];
}) {
  const admin = useIntegrationAdmin();
  const { data: servicesData } = useServicesList();
  const { data: bindingsData, error: bindingsError } = useQuery(
    admin.queries.bindings(integrationId),
  );
  const pendingIntent = useRef<{ signature: string; key: string } | null>(null);
  const setBinding = useMutation({
    mutationKey: ["integration-binding", admin.apiUrl, integrationId],
    retry: false,
    mutationFn: async (input: {
      apiUrl: string;
      integrationId: string;
      capability: string;
      serviceId: string | null;
      expectedServiceId: string | null;
      expectedRevision: string;
      operationId: string;
    }) => {
      const value = await admin.setBinding(
        input.integrationId,
        input.capability,
        input.serviceId,
        input,
      );
      if (pendingIntent.current?.key === input.operationId) pendingIntent.current = null;
      void admin.refresh();
      return value;
    },
  });
  const owned =
    setBinding.variables?.integrationId === integrationId &&
    setBinding.variables?.apiUrl === admin.apiUrl;
  const observedReceipt =
    owned && setBinding.data ? setBinding.data : bindingsData?.lastApplication;
  const receipt =
    observedReceipt &&
    observedReceipt.desiredRevision === bindingsData?.desiredRevision &&
    (observedReceipt.runtime === "unknown" ||
      observedReceipt.runtimeGenerationId === (bindingsData?.runtime?.generationId ?? null))
      ? observedReceipt
      : null;
  const busy = owned && setBinding.isPending;
  function bind(capability: string, serviceId: string | null) {
    if (!bindingsData?.revision || busy) return;
    const expectedServiceId =
      bindingsData.bindings.find((b) => b.capability === capability)?.serviceId ?? null;
    const signature = JSON.stringify([
      admin.apiUrl,
      integrationId,
      capability,
      serviceId,
      expectedServiceId,
      bindingsData.revision,
    ]);
    if (pendingIntent.current?.signature !== signature)
      pendingIntent.current = { signature, key: crypto.randomUUID() };
    setBinding.mutate({
      apiUrl: admin.apiUrl,
      integrationId,
      capability,
      serviceId,
      expectedServiceId,
      expectedRevision: bindingsData.revision,
      operationId: pendingIntent.current.key,
    });
  }

  if (requires.length === 0) return null;

  const services = servicesData?.services ?? [];
  const bindings = new Map((bindingsData?.bindings ?? []).map((b) => [b.capability, b.serviceId]));

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography
          variant="subtitle2"
          gutterBottom
          sx={{
            color: "text.secondary",
          }}
        >
          Required Services
        </Typography>
        <Stack
          sx={{
            gap: 1.5,
          }}
        >
          {((owned && setBinding.error) || bindingsError) && (
            <Alert severity="error">
              {((owned && setBinding.error) || bindingsError)?.message}
            </Alert>
          )}
          {receipt && (
            <Alert
              severity={
                receipt.runtime === "applied"
                  ? "success"
                  : receipt.runtime === "failed"
                    ? "warning"
                    : "info"
              }
            >
              {receipt.runtime === "applied"
                ? "Binding saved and active."
                : receipt.reason === "integration_disabled"
                  ? "Binding saved. Integration is disabled; activation is pending."
                  : receipt.runtime === "failed"
                    ? "Binding saved. Reload failed; previous provider remains active."
                    : "Binding status requires reconciliation. Review the saved and live provider before retrying."}
            </Alert>
          )}
          {!bindingsData?.runtime && (
            <Typography variant="caption">Runtime unavailable or integration disabled</Typography>
          )}
          <Button size="small" onClick={() => void admin.refresh()}>
            Refresh binding status
          </Button>
          {requires.map((r, idx) => {
            const key = r.service ?? r.capability ?? `req-${idx}`;
            if (r.service) {
              return (
                <ServiceRequireRow
                  key={key}
                  req={r as RequireEntry & { service: string }}
                  services={services}
                />
              );
            }
            if (r.capability) {
              const capability = r.capability;
              return (
                <CapabilityRequireRow
                  key={key}
                  req={r as RequireEntry & { capability: string }}
                  services={services}
                  currentBinding={bindings.get(capability) ?? null}
                  onBind={(serviceId) => bind(capability, serviceId)}
                  disabled={busy || !bindingsData?.revision || !!bindingsError}
                  activeServiceId={bindingsData?.runtime?.bindings[capability] ?? null}
                />
              );
            }
            return null;
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}
