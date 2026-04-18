"use client";

import Alert from "@mui/material/Alert";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ServiceSummary, useServicesList } from "@/hooks/useServices";
import { useEnv } from "@/lib/EnvProvider";
import { CapabilityBindingPicker } from "./CapabilityBindingPicker";

interface RequireEntry {
  service?: string;
  capability?: string;
  optional?: boolean;
}

interface Binding {
  capability: string;
  serviceId: string;
}

function useBindings(integrationId: string, apiUrl: string) {
  return useQuery({
    queryKey: ["capability-bindings", integrationId],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/bindings`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { bindings: Binding[] };
    },
  });
}

function useSetBinding(integrationId: string, apiUrl: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      capability,
      serviceId,
    }: {
      capability: string;
      serviceId: string | null;
    }) => {
      if (serviceId === null) {
        await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/bindings/${capability}`, {
          method: "DELETE",
          credentials: "include",
        });
      } else {
        await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/bindings/${capability}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceId }),
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capability-bindings", integrationId] });
    },
  });
}

function ServiceRequireRow({
  req,
  services,
}: {
  req: RequireEntry & { service: string };
  services: ServiceSummary[];
}) {
  const installed = services.find((s) => s.id === req.service);

  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Typography variant="body2" fontFamily="monospace" sx={{ minWidth: 180 }}>
        {req.service}
        {req.optional && (
          <Typography component="span" variant="caption" color="text.secondary">
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
  services: ServiceSummary[];
  currentBinding: string | null;
  onBind: (serviceId: string | null) => void;
}) {
  const providers = services.filter((s) => s.provides.includes(req.capability));

  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Typography variant="body2" fontFamily="monospace" sx={{ minWidth: 180 }}>
        any {req.capability}
        {req.optional && (
          <Typography component="span" variant="caption" color="text.secondary">
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
  const { apiUrl } = useEnv();
  const { data: servicesData } = useServicesList();
  const { data: bindingsData } = useBindings(integrationId, apiUrl);
  const setBinding = useSetBinding(integrationId, apiUrl);

  if (requires.length === 0) return null;

  const services = servicesData?.services ?? [];
  const bindings = new Map((bindingsData?.bindings ?? []).map((b) => [b.capability, b.serviceId]));

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Required Services
        </Typography>
        <Stack gap={1.5}>
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
