"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  // Operator-only fields: the API returns these to admins and withholds them
  // from anonymous callers, because interpolated health-check URLs and probe
  // errors disclose credentials and internal hostnames.
  url?: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

interface StatusResponse {
  timestamp: string;
  services: ServiceStatus[];
}

/**
 * Category display order — derived from the API response order.
 * The API returns services grouped by manifest category.
 * We preserve that order but ensure "Infrastructure" always comes first.
 */
function deriveCategoryOrder(services: ServiceStatus[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const s of services) {
    if (!seen.has(s.category)) {
      seen.add(s.category);
      order.push(s.category);
    }
  }
  // Infrastructure always first
  const infraIdx = order.indexOf("Infrastructure");
  if (infraIdx > 0) {
    order.splice(infraIdx, 1);
    order.unshift("Infrastructure");
  }
  return order;
}

/** Palette color for a status, shared by its dot and its label. */
const STATUS_COLORS: Record<string, string> = {
  up: "success.main",
  down: "error.main",
  unconfigured: "text.disabled",
};

const STATUS_LABELS: Record<string, string> = {
  up: "Operational",
  down: "Down",
  unconfigured: "Not configured",
};

export default function StatusDashboard() {
  const { apiUrl } = useEnv();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/status`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void fetchStatus();
    }, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchStatus]);

  const grouped = data
    ? data.services.reduce<Record<string, ServiceStatus[]>>((acc, s) => {
        if (!acc[s.category]) acc[s.category] = [];
        acc[s.category].push(s);
        return acc;
      }, {})
    : {};

  const categories = data
    ? deriveCategoryOrder(data.services).filter((c) => grouped[c]?.length)
    : [];

  const upCount = data?.services.filter((s) => s.status === "up").length ?? 0;
  const downCount = data?.services.filter((s) => s.status === "down").length ?? 0;
  const unconfiguredCount = data?.services.filter((s) => s.status === "unconfigured").length ?? 0;

  return (
    <Box sx={{ maxWidth: 896, mx: "auto" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          mb: 1,
        }}
      >
        <Typography component="h1" sx={{ fontSize: 24, lineHeight: "32px", fontWeight: 700 }}>
          System Status
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
            }
            label="Auto-refresh"
            sx={{
              mr: 0,
              color: "text.secondary",
              "& .MuiFormControlLabel-label": { fontSize: 14 },
            }}
          />
          <Button variant="outlined" size="small" onClick={fetchStatus} disabled={loading}>
            {loading ? "Checking…" : "Refresh"}
          </Button>
        </Box>
      </Box>

      {data && (
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            columnGap: 2,
            rowGap: 0.5,
            mb: 3,
            fontSize: 14,
          }}
        >
          <Box component="span" sx={{ color: "success.main", fontWeight: 500 }}>
            {upCount} operational
          </Box>
          {downCount > 0 && (
            <Box component="span" sx={{ color: "error.main", fontWeight: 500 }}>
              {downCount} down
            </Box>
          )}
          {unconfiguredCount > 0 && (
            <Box component="span" sx={{ color: "text.disabled" }}>
              {unconfiguredCount} not configured
            </Box>
          )}
          <Box component="span" sx={{ color: "text.disabled", ml: "auto" }}>
            {new Date(data.timestamp).toLocaleString()}
          </Box>
        </Box>
      )}

      {error && !data && (
        <Alert severity="error" sx={{ mb: 3 }}>
          Failed to load status: {error}
        </Alert>
      )}

      {loading && !data && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {[1, 2, 3].map((i) => (
            <Box key={i}>
              <Skeleton variant="rounded" width={128} height={16} sx={{ mb: 1 }} />
              <Paper
                variant="outlined"
                sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}
              >
                <Skeleton variant="rounded" height={16} />
                <Skeleton variant="rounded" height={16} width="75%" />
              </Paper>
            </Box>
          ))}
        </Box>
      )}

      {categories.map((category) => {
        const services = grouped[category];
        if (!services?.length) return null;
        return (
          <Box key={category} sx={{ mb: 3 }}>
            <Typography
              component="h2"
              sx={{
                mb: 1,
                fontSize: 12,
                fontWeight: 600,
                color: "text.secondary",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {category}
            </Typography>
            <Paper
              variant="outlined"
              sx={{ "& > :not(:last-child)": { borderBottom: 1, borderColor: "divider" } }}
            >
              {services.map((s) => {
                const color = STATUS_COLORS[s.status] ?? "text.disabled";
                return (
                  <Box
                    key={s.id}
                    sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, px: 2, py: 1.5 }}
                  >
                    <Box
                      component="span"
                      sx={{
                        mt: 0.75,
                        flexShrink: 0,
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        bgcolor: color,
                      }}
                    />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Box
                        sx={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 1 }}
                      >
                        <Typography component="span" sx={{ fontSize: 14, fontWeight: 500 }}>
                          {s.name}
                        </Typography>
                        <Typography component="span" sx={{ fontSize: 12, fontWeight: 500, color }}>
                          {STATUS_LABELS[s.status] ?? s.status}
                        </Typography>
                        {s.responseTime != null && (
                          <Typography
                            component="span"
                            sx={{ fontSize: 12, color: "text.disabled" }}
                          >
                            {s.responseTime}ms
                          </Typography>
                        )}
                      </Box>
                      {s.url && (
                        <Typography
                          noWrap
                          title={s.url}
                          sx={{
                            mt: 0.25,
                            fontSize: 12,
                            fontFamily: "monospace",
                            color: "text.secondary",
                          }}
                        >
                          {s.url}
                        </Typography>
                      )}
                      {s.error && (
                        <Typography sx={{ mt: 0.25, fontSize: 12, color: "error.main" }}>
                          {s.error}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              })}
            </Paper>
          </Box>
        );
      })}

      <Typography sx={{ mt: 4, pb: 2, textAlign: "center", fontSize: 12, color: "text.disabled" }}>
        OpenMapX Status Dashboard
      </Typography>
    </Box>
  );
}
