"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { RepoHostPort, RepoPreviewService } from "@/hooks/useServiceRepos";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(bind?: string): boolean {
  return !!bind && LOOPBACK_HOSTS.has(bind);
}

function formatPort(p: RepoHostPort): string {
  const proto = p.protocol ? `/${p.protocol}` : "";
  return p.bindAddress
    ? `${p.bindAddress}:${p.host}→${p.container}${proto}`
    : `${p.host}→${p.container}${proto} (all interfaces)`;
}

export function InstallPreview({ services }: { services: RepoPreviewService[] }) {
  return (
    <Stack spacing={2}>
      {services.map((s) => {
        const risky =
          s.needsCapabilities.length > 0 ||
          s.devices.length > 0 ||
          s.hostPorts.length > 0 ||
          s.proxyEnabled;
        return (
          <Paper key={s.slug} sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle1" fontWeight={500}>
                {s.name}
              </Typography>
              <Chip size="small" label={`v${s.version}`} variant="outlined" />
              <Chip
                size="small"
                label={s.quality}
                color={s.quality === "community" ? "warning" : "default"}
              />
            </Stack>
            {s.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {s.description}
              </Typography>
            )}

            {s.validationErrors.length > 0 && (
              <Alert severity="error" sx={{ mt: 2 }}>
                <strong>Invalid manifest — cannot install:</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {s.validationErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {risky && s.validationErrors.length === 0 && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                This community service requests elevated access. Review before installing:
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {s.needsCapabilities.length > 0 && (
                    <li>
                      Linux capabilities: <code>{s.needsCapabilities.join(", ")}</code>
                    </li>
                  )}
                  {s.devices.length > 0 && (
                    <li>
                      Devices: <code>{s.devices.join(", ")}</code>
                    </li>
                  )}
                  {s.hostPorts.length > 0 && (
                    <li>
                      Host port bindings:
                      <Box component="ul" sx={{ pl: 2.5, my: 0 }}>
                        {s.hostPorts.map((p) => {
                          const publiclyExposed = !isLoopback(p.bindAddress);
                          return (
                            <li key={`${p.bindAddress ?? "*"}:${p.host}/${p.protocol ?? "tcp"}`}>
                              <code>{formatPort(p)}</code>
                              {publiclyExposed && (
                                <strong style={{ marginLeft: 6, color: "#b71c1c" }}>
                                  ⚠ publicly accessible
                                </strong>
                              )}
                            </li>
                          );
                        })}
                      </Box>
                    </li>
                  )}
                  {s.proxyEnabled && <li>Publicly exposes itself via the reverse proxy</li>}
                </ul>
              </Alert>
            )}

            {s.provides.length > 0 && (
              <Stack direction="row" spacing={0.5} sx={{ mt: 1.5 }}>
                {s.provides.map((p) => (
                  <Chip key={p} size="small" label={p} variant="outlined" />
                ))}
              </Stack>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}
