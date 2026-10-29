"use client";

import Alert from "@mui/material/Alert";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceSummary } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
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
}: {
  req: RequireEntry & { capability: string };
  services: AdminServiceSummary[];
  currentBinding: string | null;
  onBind: (serviceId: string | null) => void;
}) {
  const providers = services.filter((s) => s.provides.includes(req.capability));

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
      />
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
  const setBinding = useMutation({
    mutationKey: ["integration-binding", admin.apiUrl, integrationId],
    retry: false,
    mutationFn: async ({
      capability,
      serviceId,
    }: {
      capability: string;
      serviceId: string | null;
    }) => {
      await admin.setBinding(integrationId, capability, serviceId);
      void admin.refresh();
    },
  });

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
          {(setBinding.error || bindingsError) && (
            <Alert severity="error">{(setBinding.error || bindingsError)?.message}</Alert>
          )}
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
                  onBind={(serviceId) => setBinding.mutate({ capability, serviceId })}
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
