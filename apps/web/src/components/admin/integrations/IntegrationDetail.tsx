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
import { buildLicensingHtml, safeHref } from "@openmapx/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AttributionText } from "@/components/ui/AttributionText";
import {
  hasVaultCredential,
  useIntegrationAdmin,
  useIntegrationReload,
} from "@/lib/admin/integrationAdmin";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { MetaRow } from "../shared/MetaRow";
import { useClientPagination } from "../shared/tableHooks";
import { ConfigSchemaForm } from "./ConfigSchemaForm";
import { CredentialSetupGuide } from "./CredentialSetupGuide";
import { DomainChip } from "./DomainChip";
import { HealthHistoryChart } from "./HealthHistoryChart";
import { IntegrationStatusDot } from "./IntegrationStatusDot";
import { RequiredServicesPanel } from "./RequiredServicesPanel";
import { SetCredentialDialog } from "./SetCredentialDialog";
import { StatusBadge } from "./StatusBadge";

type CredentialStatus = import("@openmapx/core/api-contracts").AdminIntegrationCredential;
type IntegrationDetailData = import("@openmapx/core/api-contracts").AdminIntegrationDetail;

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
                  href={safeHref(data.documentation)}
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
}: {
  data: IntegrationDetailData;
  integrationId: string;
}) {
  const entries = Object.entries(data.resolvedConfig);
  const { paged: pagedEntries, paginationProps: entriesPagination } = useClientPagination(entries);

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
            <Alert severity="info" variant="outlined">
              No configuration keys found.
            </Alert>
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
                  {pagedEntries.map(([key, { value, source }]) => (
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
                          {typeof value === "object" ? JSON.stringify(value) : String(value)}
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
          <AdminTablePagination {...entriesPagination} />
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
            />
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function CredentialSourceBadge({ source }: { source: CredentialStatus["source"] }) {
  return (
    <Chip
      label={source}
      icon={source === "vault" ? <LockIcon /> : undefined}
      size="small"
      color={source === "missing" ? "error" : SOURCE_COLOR[source]}
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
  const admin = useIntegrationAdmin();
  const [dialogField, setDialogField] = useState<CredentialStatus | null>(null);
  const showToast = useAdminToast();

  const deleteMutation = useMutation({
    retry: false,
    mutationFn: (key: string) => admin.deleteCredential(integrationId, key),
    onSuccess: (_, key) => {
      void admin.refresh();
      showToast(`Credential "${key}" deleted`);
    },
    onError: (_, key) => showToast(`Failed to delete "${key}"`, "error"),
  });

  const secretCredentials = data.credentialStatus;
  const { paged: pagedSecrets, paginationProps: secretsPagination } =
    useClientPagination(secretCredentials);

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
                    <TableCell>Vault Last Updated</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pagedSecrets.map((cred) => (
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
                            {hasVaultCredential(cred) ? "Rotate" : "Set"}
                          </Button>
                          {hasVaultCredential(cred) && (
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
            <AdminTablePagination {...secretsPagination} />
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
}: {
  data: IntegrationDetailData;
  integrationId: string;
}) {
  const admin = useIntegrationAdmin();
  const showToast = useAdminToast();

  const healthQuery = useQuery({ ...admin.queries.health(integrationId), enabled: false });
  const healthMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await healthQuery.refetch({ throwOnError: true });
      if (!result.data) throw new Error("Health check was interrupted");
      return result.data;
    },
    onSuccess: () => {
      void admin.refresh();
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
              <Alert severity="info" variant="outlined">
                No health data available yet. Run a check to populate.
              </Alert>
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
  const href = safeHref(url);
  const shared = {
    label: "DPA available",
    size: "small" as const,
    color: (available ? "success" : "default") as "success" | "default",
    variant: "outlined" as const,
  };
  return href ? (
    <Chip
      {...shared}
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      clickable
      icon={<OpenInNewIcon sx={{ fontSize: "0.85rem" }} />}
    />
  ) : (
    <Chip {...shared} />
  );
}

function ProviderPrivacyLink({ url }: { url: string }) {
  const href = safeHref(url);
  return href ? (
    <Link
      href={href}
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
      {url}
    </Typography>
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
                <Link href={safeHref(ds.url)} target="_blank" rel="noopener noreferrer">
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
              <AttributionText
                html={buildLicensingHtml(ds.licensing, { includeSoftware: true, fullNames: true })}
              />
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
                <ProviderPrivacyLink url={ds.providerPrivacyUrl} />
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
  const admin = useIntegrationAdmin();
  const [tab, setTab] = useState(0);
  const showToast = useAdminToast();

  const { data, isLoading, isError } = useQuery(admin.queries.detail(id));

  const toggleMutation = useMutation({
    retry: false,
    mutationFn: (enable: boolean) => admin.toggle(id, enable),
    onSuccess: (_, enable) => {
      void admin.refresh();
      showToast(`Integration ${enable ? "enabled" : "disabled"}`);
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Operation failed", "error"),
  });

  const reloadMutation = useIntegrationReload(id);

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
      <Stack sx={{ gap: 1 }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 1.5,
          }}
        >
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1.5,
              flexWrap: "wrap",
              minWidth: 0,
              flexGrow: 1,
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
            <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
              {data.domains.map((d) => (
                <DomainChip key={d} domain={d} />
              ))}
            </Stack>
          </Stack>
          <Stack
            direction="row"
            sx={{
              gap: 1,
              flexWrap: "wrap",
              alignItems: "center",
              flexShrink: 0,
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
              onClick={() =>
                reloadMutation.mutate(undefined, {
                  onSuccess: () =>
                    showToast("Reload job queued — check Activity for status", "info"),
                  onError: () => showToast("Failed to queue reload job", "error"),
                })
              }
              disabled={isBusy}
            >
              Reload
            </Button>
          </Stack>
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
        {tab === 1 && <ConfigTab data={data} integrationId={id} />}
        {tab === 2 && <CredentialsTab data={data} integrationId={id} />}
        {tab === 3 && <HealthTab data={data} integrationId={id} />}
        {tab === 4 && <DataSourcesTab data={data} />}
      </Box>
    </Stack>
  );
}
