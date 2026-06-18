"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import ErrorIcon from "@mui/icons-material/Error";
import KeyIcon from "@mui/icons-material/Key";
import LockIcon from "@mui/icons-material/Lock";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PowerSettingsNewIcon from "@mui/icons-material/PowerSettingsNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { CredentialSetup } from "@openmapx/integration-framework";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import NextLink from "next/link";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";
import { MetaRow } from "../shared/MetaRow";
import { ConfigSchemaForm } from "./ConfigSchemaForm";
import { CredentialSetupGuide } from "./CredentialSetupGuide";
import { DomainChip } from "./DomainChip";
import { HealthHistoryChart } from "./HealthHistoryChart";
import { IntegrationStatusDot } from "./IntegrationStatusDot";
import { RequiredServicesPanel } from "./RequiredServicesPanel";
import { SetCredentialDialog } from "./SetCredentialDialog";
import { StatusBadge } from "./StatusBadge";

type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

interface CredentialStatus {
  key: string;
  title: string;
  description?: string;
  source: "vault" | "env" | "missing";
  sharedSecretName?: string;
  setup?: CredentialSetup;
  updatedAt?: string;
  updatedBy?: string | null;
  isLegacyEnvVar: boolean;
  /** False for optional env-var overrides (built-in default exists). */
  required: boolean;
}

interface IntegrationDetailData {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  documentation?: string;
  domains: string[];
  quality: "built-in" | "community-verified" | "community";
  isBuiltIn: boolean;
  enabled: boolean;
  configured: boolean;
  hasHealthCheck: boolean;
  health: { status: "up" | "down" | "unconfigured"; responseTime?: number; error?: string } | null;
  dependencies: string[];
  requires: Array<{ service?: string; capability?: string; optional?: boolean }>;
  infrastructure: {
    dataRequirements?: string[];
    planetScale?: boolean;
  } | null;
  manifest: {
    configSchema?: Record<string, unknown>;
    dataSources?: Array<{
      name: string;
      url: string;
      license: string;
      licenseUrl?: string;
      attribution?: string;
      commercialUse?: string;
      providerCountry: string;
      providerPrivacyUrl: string;
      endUserExposure?: string;
      personalData?: boolean;
      cookies?: boolean;
      dpaAvailable?: boolean;
      dpaUrl?: string;
    }>;
  };
  resolvedConfig: Record<string, { value: unknown; source: ConfigSource }>;
  dependencyStatus: Array<{ id: string; loaded: boolean; enabled: boolean }>;
  envVarEntries: Array<{ name: string; present: boolean }>;
  credentialStatus: CredentialStatus[];
  secretsConfigured: boolean;
}

const SOURCE_COLOR: Record<string, "default" | "primary" | "secondary" | "success" | "info"> = {
  default: "default",
  database: "primary",
  vault: "info",
  "config.json": "secondary",
  env: "success",
};

function OverviewTab({ data }: { data: IntegrationDetailData }) {
  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      <Card variant="outlined">
        <CardContent>
          <Typography
            variant="subtitle2"
            gutterBottom
            sx={{
              color: "text.secondary",
            }}
          >
            Manifest
          </Typography>
          <Stack
            sx={{
              gap: 1,
            }}
          >
            <MetaRow
              label="ID"
              labelWidth={110}
              value={
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                  }}
                >
                  {data.id}
                </Typography>
              }
            />
            <MetaRow label="Version" labelWidth={110} value={data.version} />
            <MetaRow label="Author" labelWidth={110} value={data.author} />
            <MetaRow label="License" labelWidth={110} value={data.license} />
            {data.documentation && (
              <Stack
                direction="row"
                sx={{
                  gap: 1,
                  alignItems: "center",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    minWidth: 110,
                    flexShrink: 0,
                  }}
                >
                  Documentation
                </Typography>
                <Link
                  href={data.documentation}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                >
                  Open docs <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
                </Link>
              </Stack>
            )}
            <Stack
              direction="row"
              sx={{
                gap: 1,
                alignItems: "flex-start",
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  minWidth: 110,
                  flexShrink: 0,
                }}
              >
                Domains
              </Typography>
              <Stack
                direction="row"
                sx={{
                  gap: 0.5,
                  flexWrap: "wrap",
                }}
              >
                {data.domains.map((d) => (
                  <DomainChip key={d} domain={d} />
                ))}
              </Stack>
            </Stack>
            {data.description && (
              <Stack
                direction="row"
                sx={{
                  gap: 1,
                  alignItems: "flex-start",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    minWidth: 110,
                    flexShrink: 0,
                  }}
                >
                  Description
                </Typography>
                <Typography variant="body2">{data.description}</Typography>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
      {data.dependencies.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Dependencies
            </Typography>
            <Stack
              sx={{
                gap: 0.75,
              }}
            >
              {data.dependencyStatus.map((dep) => (
                <Stack
                  key={dep.id}
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  {dep.loaded ? (
                    <CheckCircleIcon
                      fontSize="small"
                      sx={{ color: dep.enabled ? "success.main" : "warning.main" }}
                    />
                  ) : (
                    <ErrorIcon fontSize="small" color="error" />
                  )}
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                    }}
                  >
                    {dep.id}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {dep.loaded
                      ? dep.enabled
                        ? "loaded, enabled"
                        : "loaded, disabled"
                      : "missing"}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
      {data.requires.length > 0 && (
        <RequiredServicesPanel integrationId={data.id} requires={data.requires} />
      )}
      {(data.infrastructure?.dataRequirements?.length || data.infrastructure?.planetScale) && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Infrastructure Requirements
            </Typography>
            <Stack
              sx={{
                gap: 0.75,
              }}
            >
              {data.infrastructure?.dataRequirements?.map((req) => (
                <Stack
                  key={req}
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <CheckCircleIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                    }}
                  >
                    {req}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    data requirement
                  </Typography>
                </Stack>
              ))}
              {data.infrastructure?.planetScale && (
                <Stack
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <CheckCircleIcon fontSize="small" sx={{ color: "warning.main" }} />
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                    }}
                  >
                    planet-scale
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    may require large resources
                  </Typography>
                </Stack>
              )}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function ConfigTab({
  data,
  integrationId,
  onRefresh,
}: {
  data: IntegrationDetailData;
  integrationId: string;
  onRefresh: () => void;
}) {
  const entries = Object.entries(data.resolvedConfig);

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      {/* Raw resolved config table */}
      <Card variant="outlined">
        <CardContent>
          <Typography
            variant="subtitle2"
            gutterBottom
            sx={{
              color: "text.secondary",
            }}
          >
            Resolved Values
          </Typography>
          {entries.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              No configuration keys found.
            </Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Key</TableCell>
                    <TableCell>Value</TableCell>
                    <TableCell>Source</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entries.map(([key, { value, source }]) => (
                    <TableRow key={key}>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: "monospace",
                            fontWeight: 500,
                          }}
                        >
                          {key}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          color={value === "***" ? "text.disabled" : "text.primary"}
                          sx={{
                            fontFamily: "monospace",
                          }}
                        >
                          {String(value)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={source}
                          size="small"
                          color={SOURCE_COLOR[source] ?? "default"}
                          variant="outlined"
                          sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
      {/* Editable config form */}
      {data.manifest.configSchema && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Edit Configuration
            </Typography>
            <ConfigSchemaForm
              integrationId={integrationId}
              schema={data.manifest.configSchema}
              resolvedConfig={data.resolvedConfig}
              onSaved={onRefresh}
            />
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function CredentialSourceBadge({ source }: { source: "vault" | "env" | "missing" }) {
  if (source === "vault")
    return (
      <Chip
        label="vault"
        size="small"
        color="info"
        variant="outlined"
        icon={<LockIcon />}
        sx={{ fontSize: "0.7rem" }}
      />
    );
  if (source === "env")
    return (
      <Chip
        label="env"
        size="small"
        color="success"
        variant="outlined"
        sx={{ fontSize: "0.7rem" }}
      />
    );
  return (
    <Chip
      label="missing"
      size="small"
      color="error"
      variant="outlined"
      sx={{ fontSize: "0.7rem" }}
    />
  );
}

function CredentialsTab({
  data,
  integrationId,
}: {
  data: IntegrationDetailData;
  integrationId: string;
}) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  const [dialogField, setDialogField] = useState<CredentialStatus | null>(null);
  const showToast = useAdminToast();

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`${apiUrl}/api/admin/credentials/${integrationId}/${key}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onSuccess: (_, key) => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      showToast(`Credential "${key}" deleted`);
    },
    onError: (_, key) => showToast(`Failed to delete "${key}"`, "error"),
  });

  const secretCredentials = data.credentialStatus.filter((c) => !c.isLegacyEnvVar);
  const legacyEnvVars = data.credentialStatus.filter((c) => c.isLegacyEnvVar);

  if (data.credentialStatus.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        This integration has no external credentials or environment variables.
      </Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {!data.secretsConfigured && secretCredentials.length > 0 && (
        <Alert severity="warning" variant="outlined">
          Vault not configured — secrets cannot be stored. Set <code>OPENMAPX_SECRETS_KEY</code>{" "}
          (generate with <code>openssl rand -hex 32</code>) to enable the credential vault.
        </Alert>
      )}
      {secretCredentials.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Secret Credentials
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Credential</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Last Updated</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {secretCredentials.map((cred) => (
                    <TableRow key={cred.key}>
                      <TableCell>
                        <Stack
                          sx={{
                            gap: 0.25,
                          }}
                        >
                          <Stack
                            direction="row"
                            sx={{
                              alignItems: "center",
                              gap: 0.75,
                            }}
                          >
                            <KeyIcon
                              fontSize="small"
                              sx={{ color: "text.secondary", fontSize: "0.95rem" }}
                            />
                            <Typography
                              variant="body2"
                              sx={{
                                fontWeight: 600,
                              }}
                            >
                              {cred.title}
                            </Typography>
                            {cred.sharedSecretName && (
                              <Chip
                                label={`shared: ${cred.sharedSecretName}`}
                                size="small"
                                variant="outlined"
                                sx={{ fontSize: "0.65rem" }}
                              />
                            )}
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
                          {cred.setup && (
                            <Box sx={{ pl: 2.5 }}>
                              <CredentialSetupGuide setup={cred.setup} />
                            </Box>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <CredentialSourceBadge source={cred.source} />
                      </TableCell>
                      <TableCell>
                        {cred.updatedAt ? (
                          <Tooltip title={cred.updatedBy ? `by ${cred.updatedBy}` : ""}>
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                              }}
                            >
                              {new Date(cred.updatedAt).toLocaleDateString()}
                            </Typography>
                          </Tooltip>
                        ) : (
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.disabled",
                            }}
                          >
                            —
                          </Typography>
                        )}
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
                            disabled={!data.secretsConfigured}
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
          </CardContent>
        </Card>
      )}
      {legacyEnvVars.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Environment Variables
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Variable</TableCell>
                    <TableCell>Requirement</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {legacyEnvVars.map((entry) => {
                    const isSet = entry.source === "env";
                    return (
                      <TableRow key={entry.key}>
                        <TableCell>
                          <Stack
                            sx={{
                              gap: 0.25,
                            }}
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                fontFamily: "monospace",
                                fontWeight: 500,
                              }}
                            >
                              {entry.key}
                            </Typography>
                            {entry.description && (
                              <Typography
                                variant="caption"
                                sx={{
                                  color: "text.secondary",
                                }}
                              >
                                {entry.description}
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={entry.required ? "Required" : "Optional"}
                            size="small"
                            color={entry.required ? "default" : "info"}
                            variant="outlined"
                            sx={{ fontSize: "0.7rem" }}
                          />
                        </TableCell>
                        <TableCell>
                          <Stack
                            direction="row"
                            sx={{
                              alignItems: "center",
                              gap: 0.75,
                            }}
                          >
                            {isSet ? (
                              <>
                                <CheckCircleIcon fontSize="small" sx={{ color: "success.main" }} />
                                <Typography
                                  variant="body2"
                                  sx={{
                                    color: "success.main",
                                  }}
                                >
                                  Set
                                </Typography>
                              </>
                            ) : entry.required ? (
                              <>
                                <ErrorIcon fontSize="small" color="error" />
                                <Typography
                                  variant="body2"
                                  sx={{
                                    color: "error.main",
                                  }}
                                >
                                  Not set
                                </Typography>
                              </>
                            ) : (
                              <Typography
                                variant="body2"
                                sx={{
                                  color: "text.secondary",
                                }}
                              >
                                Using default
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}
      {dialogField && (
        <SetCredentialDialog
          open={!!dialogField}
          onClose={() => setDialogField(null)}
          integrationId={integrationId}
          credentialKey={dialogField.key}
          title={dialogField.title}
          description={dialogField.description}
          setup={dialogField.setup}
        />
      )}
    </Stack>
  );
}

function HealthTab({
  data,
  integrationId,
  apiUrl,
}: {
  data: IntegrationDetailData;
  integrationId: string;
  apiUrl: string;
}) {
  const qc = useQueryClient();
  const showToast = useAdminToast();

  const healthMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/health`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Health check failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      showToast("Health check completed");
    },
    onError: () => showToast("Health check failed", "error"),
  });

  const health = data.health;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {!data.hasHealthCheck ? (
        <Alert severity="info" variant="outlined">
          This integration does not declare a health check.
        </Alert>
      ) : (
        <Card variant="outlined">
          <CardContent>
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                mb: 2,
              }}
            >
              <Typography
                variant="subtitle2"
                sx={{
                  color: "text.secondary",
                }}
              >
                Latest Health Status
              </Typography>
              <Button
                size="small"
                variant="outlined"
                startIcon={
                  healthMutation.isPending ? <CircularProgress size={14} /> : <PlayArrowIcon />
                }
                onClick={() => healthMutation.mutate()}
                disabled={healthMutation.isPending}
              >
                Run Check
              </Button>
            </Stack>
            {health ? (
              <Stack
                sx={{
                  gap: 1,
                }}
              >
                <Stack
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <IntegrationStatusDot
                    enabled={data.enabled}
                    configured={data.configured}
                    health={health}
                    hasHealthCheck={data.hasHealthCheck}
                    size={14}
                  />
                  <Typography
                    variant="body1"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {health.status === "up"
                      ? "Healthy"
                      : health.status === "down"
                        ? "Unhealthy"
                        : "Unconfigured"}
                  </Typography>
                </Stack>
                {health.responseTime != null && (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Response time: {health.responseTime}ms
                  </Typography>
                )}
                {health.error && (
                  <Alert severity="error" variant="outlined">
                    {health.error}
                  </Alert>
                )}
              </Stack>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                No health data available yet. Run a check to populate.
              </Typography>
            )}
          </CardContent>
        </Card>
      )}
      {data.hasHealthCheck && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Health History
            </Typography>
            <HealthHistoryChart integrationId={integrationId} />
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

/**
 * "DPA available" chip — a plain chip, or a link chip opening the DPA when a
 * `dpaUrl` is declared. The shared props live in one place; the two variants
 * exist only because MUI types the anchor (`component="a"`) chip differently.
 */
function DpaChip({ available, url }: { available?: boolean; url?: string }) {
  const shared = {
    label: "DPA available",
    size: "small" as const,
    color: (available ? "success" : "default") as "success" | "default",
    variant: "outlined" as const,
  };
  return url ? (
    <Chip
      {...shared}
      component="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      clickable
      icon={<OpenInNewIcon sx={{ fontSize: "0.85rem" }} />}
    />
  ) : (
    <Chip {...shared} />
  );
}

function DataSourcesTab({ data }: { data: IntegrationDetailData }) {
  const sources = data.manifest.dataSources;
  if (!sources?.length) {
    return (
      <Alert severity="info" variant="outlined">
        No data sources declared.
      </Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 1.5,
      }}
    >
      {sources.map((ds) => (
        <Card key={ds.name} variant="outlined">
          <CardContent>
            <Stack
              sx={{
                gap: 1,
              }}
            >
              <Stack
                direction="row"
                sx={{
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 1,
                }}
              >
                <Typography
                  variant="subtitle2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {ds.name}
                </Typography>
                <Link href={ds.url} target="_blank" rel="noopener noreferrer">
                  <Stack
                    direction="row"
                    sx={{
                      alignItems: "center",
                      gap: 0.5,
                    }}
                  >
                    <OpenInNewIcon fontSize="small" />
                    <Typography variant="body2">{ds.url}</Typography>
                  </Stack>
                </Link>
              </Stack>
              <MetaRow label="License" labelWidth={110} value={ds.license} />
              {ds.licenseUrl && (
                <Link
                  href={ds.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                >
                  License details
                </Link>
              )}
              {ds.commercialUse && (
                <MetaRow label="Commercial use" labelWidth={110} value={ds.commercialUse} />
              )}
              <MetaRow label="Provider country" labelWidth={110} value={ds.providerCountry} />
              {ds.endUserExposure && (
                <MetaRow label="End-user exposure" labelWidth={110} value={ds.endUserExposure} />
              )}
              <Stack
                direction="row"
                sx={{
                  gap: 1,
                  alignItems: "center",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    minWidth: 110,
                  }}
                >
                  Flags
                </Typography>
                <Stack
                  direction="row"
                  sx={{
                    gap: 0.5,
                  }}
                >
                  <Chip
                    label="Personal data"
                    size="small"
                    color={ds.personalData ? "warning" : "default"}
                    variant="outlined"
                  />
                  <Chip
                    label="Cookies"
                    size="small"
                    color={ds.cookies ? "warning" : "default"}
                    variant="outlined"
                  />
                  <DpaChip available={ds.dpaAvailable} url={ds.dpaUrl} />
                </Stack>
              </Stack>
              <Stack
                direction="row"
                sx={{
                  gap: 1,
                  alignItems: "center",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    minWidth: 110,
                  }}
                >
                  Privacy URL
                </Typography>
                {ds.providerPrivacyUrl.startsWith("http") ? (
                  <Link
                    href={ds.providerPrivacyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                    sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                  >
                    Privacy policy <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
                  </Link>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {ds.providerPrivacyUrl}
                  </Typography>
                )}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

const TABS = ["Overview", "Configuration", "Credentials", "Health", "Data Sources"];

interface IntegrationDetailProps {
  id: string;
}

export function IntegrationDetail({ id }: IntegrationDetailProps) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  const [tab, setTab] = useState(0);
  const showToast = useAdminToast();

  const { data, isLoading, isError } = useQuery<IntegrationDetailData>({
    queryKey: ["admin", "integrations", id],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load integration");
      return res.json();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      const action = enable ? "enable" : "disable";
      const res = await fetch(`${apiUrl}/api/admin/integrations/${id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to ${action} integration`);
      return res.json();
    },
    onSuccess: (_, enable) => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
      qc.invalidateQueries({ queryKey: ["admin", "integrations", id] });
      showToast(`Integration ${enable ? "enabled" : "disabled"}`);
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Operation failed", "error"),
  });

  const reloadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${id}/reload`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Reload failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", id] });
      showToast("Reload job queued — check Activity for status");
    },
    onError: () => showToast("Failed to queue reload job", "error"),
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 8,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return <Alert severity="error">Failed to load integration details</Alert>;
  }

  const isBusy = toggleMutation.isPending || reloadMutation.isPending;

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1.5,
        }}
      >
        <Stack
          sx={{
            gap: 1,
          }}
        >
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1.5,
            }}
          >
            <IntegrationStatusDot
              enabled={data.enabled}
              configured={data.configured}
              health={data.health}
              hasHealthCheck={data.hasHealthCheck}
              size={14}
            />
            <Typography
              variant="h5"
              sx={{
                fontWeight: 700,
              }}
            >
              {data.name}
            </Typography>
            <StatusBadge quality={data.quality} />
          </Stack>
          <Stack
            direction="row"
            sx={{
              gap: 0.5,
              flexWrap: "wrap",
            }}
          >
            {data.domains.map((d) => (
              <DomainChip key={d} domain={d} />
            ))}
          </Stack>
          {data.description && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {data.description}
            </Typography>
          )}
        </Stack>
        <Stack
          direction="row"
          sx={{
            gap: 1,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Button
            size="small"
            variant={data.enabled ? "outlined" : "contained"}
            color={data.enabled ? "error" : "success"}
            startIcon={isBusy ? <CircularProgress size={14} /> : <PowerSettingsNewIcon />}
            onClick={() => toggleMutation.mutate(!data.enabled)}
            disabled={isBusy}
          >
            {data.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={isBusy ? <CircularProgress size={14} /> : <RefreshIcon />}
            onClick={() => reloadMutation.mutate()}
            disabled={isBusy}
          >
            Reload
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<OpenInNewIcon />}
            component={NextLink}
            href="/admin/integrations"
          >
            Back to list
          </Button>
        </Stack>
      </Stack>
      <Divider />
      <Box>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
          variant="scrollable"
          scrollButtons="auto"
        >
          {TABS.map((label) => (
            <Tab key={label} label={label} />
          ))}
        </Tabs>

        {tab === 0 && <OverviewTab data={data} />}
        {tab === 1 && (
          <ConfigTab
            data={data}
            integrationId={id}
            onRefresh={() => qc.invalidateQueries({ queryKey: ["admin", "integrations", id] })}
          />
        )}
        {tab === 2 && <CredentialsTab data={data} integrationId={id} />}
        {tab === 3 && <HealthTab data={data} integrationId={id} apiUrl={apiUrl} />}
        {tab === 4 && <DataSourcesTab data={data} />}
      </Box>
    </Stack>
  );
}
