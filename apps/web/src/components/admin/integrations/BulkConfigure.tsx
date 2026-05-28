"use client";

import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import KeyIcon from "@mui/icons-material/Key";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";
import { ConfigSchemaForm } from "./ConfigSchemaForm";
import { SetCredentialDialog } from "./SetCredentialDialog";

type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

interface CredentialStatus {
  key: string;
  title: string;
  description?: string;
  source: "vault" | "env" | "missing";
  sharedSecretName?: string;
  updatedAt?: string;
  updatedBy?: string | null;
  isLegacyEnvVar: boolean;
  required: boolean;
}

interface IntegrationListEntry {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
}

interface IntegrationDetail {
  id: string;
  name: string;
  manifest: { configSchema?: Record<string, unknown> };
  resolvedConfig: Record<string, { value: unknown; source: ConfigSource }>;
  credentialStatus: CredentialStatus[];
  secretsConfigured: boolean;
}

interface EnvVarEntry {
  key: string;
  name: string;
  title: string;
  description?: string;
  secret: boolean;
  present: boolean;
  defaultValue?: unknown;
}

interface EnvVarIntegration {
  id: string;
  name: string;
  enabled: boolean;
  envVars: EnvVarEntry[];
}

export function BulkConfigure() {
  const env = useEnv();
  const apiUrl = env.apiUrl;

  const integrationsQuery = useQuery<IntegrationListEntry[]>({
    queryKey: ["admin", "integrations", "list"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load integrations");
      return res.json();
    },
  });

  const envVarsQuery = useQuery<{ integrations: EnvVarIntegration[] }>({
    queryKey: ["admin", "integrations", "env-vars"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/env-vars`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load env-var catalogue");
      return res.json();
    },
  });

  // The env-vars endpoint already filters out integrations whose configSchema
  // exposes nothing beyond the `enabled` toggle (no real fields, no
  // credentials). Use the same set on the integrations panel so we don't
  // render rows that just say "No editable configuration fields…" and waste
  // vertical space.
  const configurableIds = useMemo(
    () => new Set((envVarsQuery.data?.integrations ?? []).map((i) => i.id)),
    [envVarsQuery.data],
  );

  const sortedIntegrations = useMemo(() => {
    const list = integrationsQuery.data ?? [];
    // Until the env-vars query lands, fall back to showing everything so the
    // page isn't blank — the filter applies once both queries resolve.
    const filtered =
      configurableIds.size > 0 ? list.filter((i) => configurableIds.has(i.id)) : list;
    // Unconfigured first, then by name — surfaces what needs attention.
    return [...filtered].sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [integrationsQuery.data, configurableIds]);

  const unconfiguredCount = sortedIntegrations.filter((i) => !i.configured).length;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: { xs: "flex-start", sm: "center" },
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Typography
          variant="h5"
          sx={{
            fontWeight: 700,
          }}
        >
          Bulk Configure Integrations
        </Typography>
        <Stack
          direction="row"
          sx={{
            gap: 0.75,
            flexWrap: "wrap",
          }}
        >
          <Chip label={`${sortedIntegrations.length} total`} size="small" variant="outlined" />
          {unconfiguredCount > 0 && (
            <Chip
              label={`${unconfiguredCount} unconfigured`}
              size="small"
              color="warning"
              variant="outlined"
            />
          )}
        </Stack>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
        Configure all integrations on a single page — each panel exposes the same form fields and
        credentials as its per-integration page. The env-var catalogue at the bottom lists every
        override key ready to paste into <code>infra/docker/.env</code>.
      </Typography>
      {integrationsQuery.isLoading && <Skeleton variant="rounded" height={200} />}
      {integrationsQuery.isError && (
        <Alert severity="error" variant="outlined">
          Failed to load integrations.
        </Alert>
      )}
      {sortedIntegrations.map((entry) => (
        <IntegrationAccordion key={entry.id} entry={entry} />
      ))}
      <EnvVarReferenceSection
        loading={envVarsQuery.isLoading}
        error={envVarsQuery.isError}
        integrations={envVarsQuery.data?.integrations ?? []}
      />
    </Stack>
  );
}

function IntegrationAccordion({ entry }: { entry: IntegrationListEntry }) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const [open, setOpen] = useState(false);

  const detailQuery = useQuery<IntegrationDetail>({
    queryKey: ["admin", "integrations", entry.id],
    enabled: open,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${entry.id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load ${entry.id}`);
      return res.json();
    },
  });

  return (
    <Accordion
      expanded={open}
      onChange={(_, v) => setOpen(v)}
      disableGutters
      // Disable the Collapse animation. The body lazy-loads on expand, so
      // MUI measures `scrollHeight` (= the Skeleton's height) when the
      // animation starts and the accordion settles to that, then jumps to
      // the real content height once the query resolves. Snapping open is
      // cleaner than animate-then-jump.
      slotProps={{ transition: { timeout: 0 } }}
      sx={{
        "&.MuiAccordion-rounded": {
          borderRadius: 1,
          "&:first-of-type, &:last-of-type": { borderRadius: 1 },
        },
      }}
      variant="outlined"
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1.5,
            flexWrap: "wrap",
            flex: 1,
          }}
        >
          <Typography
            sx={{
              fontWeight: 600,
            }}
          >
            {entry.name}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontFamily: "monospace",
            }}
          >
            {entry.id}
          </Typography>
          {!entry.configured && (
            <Chip label="unconfigured" size="small" color="warning" variant="outlined" />
          )}
          {!entry.enabled && (
            <Chip label="disabled" size="small" color="default" variant="outlined" />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        {/* No loading skeleton — the lazy-load is short enough that the
            shimmer is more distracting than waiting briefly on an empty
            panel. Errors and resolved data render normally. */}
        {detailQuery.isError && (
          <Alert severity="error" variant="outlined">
            Failed to load configuration for {entry.id}.
          </Alert>
        )}
        {detailQuery.data && <IntegrationPanel data={detailQuery.data} />}
      </AccordionDetails>
    </Accordion>
  );
}

function hasEditableConfigFields(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false;
  const props = (schema.properties ?? schema) as Record<string, { "x-openmapx-secret"?: boolean }>;
  return Object.entries(props).some(([key, def]) => {
    if (key === "type" || key === "properties") return false;
    if (key === "enabled") return false;
    if (def?.["x-openmapx-secret"]) return false;
    return true;
  });
}

function IntegrationPanel({ data }: { data: IntegrationDetail }) {
  const secretCredentials = data.credentialStatus.filter((c) => !c.isLegacyEnvVar);
  // Only render the Configuration block if ConfigSchemaForm would actually
  // produce inputs. Otherwise it falls back to a "No editable configuration
  // fields…" info alert which is just noise next to a Credentials table.
  const showConfig = hasEditableConfigFields(data.manifest.configSchema);

  if (!showConfig && data.credentialStatus.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        This integration has no configurable fields or credentials.
      </Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 2.5,
      }}
    >
      {showConfig && (
        <Box>
          <Typography
            variant="subtitle2"
            gutterBottom
            sx={{
              color: "text.secondary",
            }}
          >
            Configuration
          </Typography>
          <ConfigSchemaForm
            integrationId={data.id}
            schema={data.manifest.configSchema}
            resolvedConfig={data.resolvedConfig}
          />
        </Box>
      )}
      {secretCredentials.length > 0 && (
        <Box>
          {showConfig && <Divider sx={{ my: 1 }} />}
          <Typography
            variant="subtitle2"
            gutterBottom
            sx={{
              color: "text.secondary",
            }}
          >
            Credentials
          </Typography>
          <CredentialsTable
            integrationId={data.id}
            secretsConfigured={data.secretsConfigured}
            credentials={secretCredentials}
          />
        </Box>
      )}
    </Stack>
  );
}

function CredentialsTable({
  integrationId,
  secretsConfigured,
  credentials,
}: {
  integrationId: string;
  secretsConfigured: boolean;
  credentials: CredentialStatus[];
}) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [dialogField, setDialogField] = useState<CredentialStatus | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`${apiUrl}/api/admin/credentials/${integrationId}/${key}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete credential");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      showToast("Credential deleted");
    },
    onError: (e) => showToast(e instanceof Error ? e.message : "Delete failed", "error"),
  });

  return (
    <>
      {!secretsConfigured && (
        <Alert severity="warning" variant="outlined" sx={{ mb: 1 }}>
          Vault not configured — set <code>OPENMAPX_SECRETS_KEY</code> to enable storing credentials
          in the admin panel. You can still set them via environment variables.
        </Alert>
      )}
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Credential</TableCell>
              <TableCell>Source</TableCell>
              <TableCell align="right">Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {credentials.map((cred) => (
              <TableRow key={cred.key}>
                <TableCell>
                  <Stack
                    direction="row"
                    sx={{
                      alignItems: "center",
                      gap: 0.75,
                    }}
                  >
                    <KeyIcon fontSize="small" sx={{ color: "text.secondary" }} />
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                      }}
                    >
                      {cred.title}
                    </Typography>
                  </Stack>
                  {cred.description && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        pl: 2.5,
                      }}
                    >
                      {cred.description}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Chip
                    label={cred.source}
                    size="small"
                    color={
                      cred.source === "vault" ? "info" : cred.source === "env" ? "success" : "error"
                    }
                    variant="outlined"
                    sx={{ fontSize: "0.7rem" }}
                  />
                </TableCell>
                <TableCell align="right">
                  <Stack
                    direction="row"
                    sx={{
                      justifyContent: "flex-end",
                      gap: 0.5,
                    }}
                  >
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setDialogField(cred)}
                      disabled={!secretsConfigured}
                    >
                      {cred.source === "vault" ? "Rotate" : "Set"}
                    </Button>
                    {cred.source === "vault" && (
                      <Tooltip title="Delete from vault">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => deleteMutation.mutate(cred.key)}
                          disabled={deleteMutation.isPending}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {dialogField && (
        <SetCredentialDialog
          open={true}
          onClose={() => setDialogField(null)}
          integrationId={integrationId}
          credentialKey={dialogField.key}
          title={dialogField.title}
          description={dialogField.description}
        />
      )}
    </>
  );
}

function EnvVarReferenceSection({
  loading,
  error,
  integrations,
}: {
  loading: boolean;
  error: boolean;
  integrations: EnvVarIntegration[];
}) {
  const showToast = useAdminToast();

  const allBlock = useMemo(() => buildEnvBlock(integrations, () => true), [integrations]);
  const configBlock = useMemo(() => buildEnvBlock(integrations, (v) => !v.secret), [integrations]);
  const credentialBlock = useMemo(
    () => buildEnvBlock(integrations, (v) => v.secret),
    [integrations],
  );
  const hasConfigVars = configBlock.length > 0;
  const hasCredentialVars = credentialBlock.length > 0;

  async function copy(text: string, label: string) {
    if (!text) {
      showToast(`Nothing to copy (${label})`, "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label}`);
    } catch {
      showToast("Copy failed — select and copy manually", "error");
    }
  }

  async function copyOne(line: string) {
    try {
      await navigator.clipboard.writeText(line);
      showToast("Copied");
    } catch {
      showToast("Copy failed", "error");
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 1,
          mb: 1,
          flexWrap: "wrap",
        }}
      >
        <Typography variant="h6">Environment Variables</Typography>
        <Box
          sx={{
            flex: 1,
          }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<ContentCopyIcon />}
          onClick={() => copy(configBlock, "config env vars")}
          disabled={loading || error || !hasConfigVars}
        >
          Copy config
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<ContentCopyIcon />}
          onClick={() => copy(credentialBlock, "credential env vars")}
          disabled={loading || error || !hasCredentialVars}
        >
          Copy credentials
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<ContentCopyIcon />}
          onClick={() => copy(allBlock, "env-var catalogue")}
          disabled={loading || error || integrations.length === 0}
        >
          Copy all
        </Button>
      </Stack>
      <Typography
        variant="body2"
        gutterBottom
        sx={{
          color: "text.secondary",
        }}
      >
        Every integration field can be set via host env using the pattern{" "}
        <code>INTEGRATION_&lt;ID&gt;_&lt;KEY&gt;</code>. Env always wins over admin-stored values.
        Paste any subset of the lines below into <code>infra/docker/.env</code> and fill in the
        right-hand side.
      </Typography>
      {loading && <Skeleton variant="rounded" height={200} sx={{ mt: 1 }} />}
      {error && (
        <Alert severity="error" variant="outlined" sx={{ mt: 1 }}>
          Failed to load env-var catalogue.
        </Alert>
      )}
      {!loading && !error && (
        <Stack
          sx={{
            gap: 2,
            mt: 2,
          }}
        >
          {integrations.map((entry) => (
            <Box key={entry.id}>
              <Stack
                direction="row"
                sx={{
                  alignItems: "center",
                  gap: 1,
                  mb: 0.5,
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {entry.name}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontFamily: "monospace",
                  }}
                >
                  {entry.id}
                </Typography>
                {!entry.enabled && <Chip label="disabled" size="small" variant="outlined" />}
              </Stack>
              <Stack
                component="pre"
                sx={{
                  m: 0,
                  p: 1.25,
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  bgcolor: "action.hover",
                  borderRadius: 1,
                  overflowX: "auto",
                }}
              >
                {entry.envVars.map((v) => {
                  const line = formatEnvLine(v);
                  return (
                    <Box
                      key={v.key}
                      component="span"
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        py: 0.25,
                        color: v.present ? "success.main" : "text.primary",
                      }}
                    >
                      <Box component="span" sx={{ flex: 1, whiteSpace: "pre" }}>
                        {line}
                      </Box>
                      {v.present && (
                        <Chip label="set" size="small" color="success" variant="outlined" />
                      )}
                      <Tooltip title="Copy line">
                        <IconButton size="small" onClick={() => copyOne(line)}>
                          <ContentCopyIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  );
                })}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function formatEnvLine(v: EnvVarEntry): string {
  // Show non-secret defaults as a hint after the equals sign so the operator
  // knows what value the integration falls back to. Secrets get an empty
  // value; the operator pastes the real one.
  if (v.secret) return `# ${v.title}\n${v.name}=`;
  const hasDefault =
    v.defaultValue !== undefined && v.defaultValue !== null && v.defaultValue !== "";
  const trailing = hasDefault ? `   # default: ${formatDefault(v.defaultValue)}` : "";
  return `# ${v.title}\n${v.name}=${trailing}`;
}

function formatDefault(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildEnvBlock(
  integrations: EnvVarIntegration[],
  filter: (v: EnvVarEntry) => boolean,
): string {
  const sections: string[] = [];
  for (const entry of integrations) {
    const filtered = entry.envVars.filter(filter);
    // Skip integrations whose envVars all got filtered out so the block
    // doesn't end up with orphan section headers when copying just config
    // or just credentials.
    if (filtered.length === 0) continue;
    sections.push(`# ─── ${entry.name} (${entry.id}) ───`);
    for (const v of filtered) {
      sections.push(formatEnvLine(v));
    }
    sections.push("");
  }
  return sections.join("\n").trimEnd();
}
