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
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
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
import { ORCHESTRATOR_BY_DOMAIN } from "@openmapx/integration-framework";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { AttributionText } from "@/components/ui/AttributionText";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { AdminDisplayError, adminErrorText } from "@/lib/admin/adminRequestError";
import {
  hasVaultCredential,
  useIntegrationAdmin,
  useIntegrationReload,
} from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminTab } from "@/lib/admin/useAdminQueryState";
import { AdminJobLink } from "../activity/AdminJobLink";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { useConfigSourceLabel } from "../shared/configSourceLabel";
import { MetaRow } from "../shared/MetaRow";
import { useClientPagination } from "../shared/tableHooks";
import { ConfigSchemaForm } from "./ConfigSchemaForm";
import { CredentialSetupGuide } from "./CredentialSetupGuide";
import { DomainChip } from "./DomainChip";
import { HealthHistoryChart } from "./HealthHistoryChart";
import { IntegrationStatusDot } from "./IntegrationStatusDot";
import { declaresProviderOrder, ProviderOrderEditor } from "./ProviderOrderEditor";
import { RequiredServicesPanel } from "./RequiredServicesPanel";
import { SetCredentialDialog } from "./SetCredentialDialog";
import { StatusBadge } from "./StatusBadge";

type CredentialStatus = import("@openmapx/core/api-contracts").AdminIntegrationCredential;
type IntegrationDetailData = import("@openmapx/core/api-contracts").AdminIntegrationDetail;

const PROVIDER_ORDER_KEYS = ["providerOrder"] as const;

const SOURCE_COLOR: Record<string, "default" | "primary" | "secondary" | "success" | "info"> = {
  default: "default",
  database: "primary",
  vault: "info",
  "config.json": "secondary",
  env: "success",
};

function OverviewTab({ data }: { data: IntegrationDetailData }) {
  const t = useTranslations("adminIntegrations");
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
            {t("manifest")}
          </Typography>
          <Stack
            sx={{
              gap: 1,
            }}
          >
            <MetaRow
              label={t("id")}
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
            <MetaRow label={t("version")} labelWidth={110} value={data.version} />
            <MetaRow label={t("author")} labelWidth={110} value={data.author} />
            <MetaRow label={t("license")} labelWidth={110} value={data.license} />
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
                  {t("documentation")}
                </Typography>
                <Link
                  href={safeHref(data.documentation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                >
                  {t("openDocs")}
                  <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
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
                {t("domains")}
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
              {t("dependencies")}
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
                        ? t("loadedEnabled")
                        : t("loadedDisabled")
                      : t("dependencyMissing")}
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
              {t("infrastructureRequirements")}
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
                    {t("dataRequirement")}
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
                    {t("planetScale")}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("mayRequireLargeResources")}
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
  const t = useTranslations("adminIntegrations");
  const sourceLabel = useConfigSourceLabel();
  const entries = Object.entries(data.resolvedConfig);
  const { paged: pagedEntries, paginationProps: entriesPagination } = useClientPagination(entries);
  // Only an orchestrator that stores an order can take one; for the others a
  // saved order would be refused as an unknown setting.
  const orderedDomains = declaresProviderOrder(data.manifest.configSchema)
    ? Object.entries(ORCHESTRATOR_BY_DOMAIN).flatMap(([domain, owner]) =>
        owner === integrationId ? [domain] : [],
      )
    : [];
  // The editor owns the setting; the generic form must not offer it a second time.
  const editorKeys = orderedDomains.length > 0 ? PROVIDER_ORDER_KEYS : undefined;

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      {orderedDomains.map((domain) => (
        <Box key={domain} sx={{ maxWidth: 760 }}>
          <ProviderOrderEditor orchestratorId={integrationId} domain={domain} />
        </Box>
      ))}
      {/* Editable config form */}
      {data.manifest.configSchema && (
        <Box sx={{ maxWidth: 760 }}>
          <Box>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              {t("editConfiguration")}
            </Typography>
            <ConfigSchemaForm
              integrationId={integrationId}
              excludeKeys={editorKeys}
              schema={data.manifest.configSchema}
              resolvedConfig={data.resolvedConfig}
              ownership={data.ownership}
            />
          </Box>
        </Box>
      )}
      {/* Raw resolved config table */}
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary>{t("effectiveValuesAndSources")}</AccordionSummary>
        <AccordionDetails>
          {entries.length === 0 ? (
            <Alert severity="info" variant="outlined">
              {t("noConfigurationKeysFound")}
            </Alert>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("key")}</TableCell>
                    <TableCell>{t("value")}</TableCell>
                    <TableCell>{t("source")}</TableCell>
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
                          sx={{
                            color: value === "***" ? "text.disabled" : "text.primary",
                            fontFamily: "monospace",
                          }}
                        >
                          {typeof value === "object" ? JSON.stringify(value) : String(value)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={sourceLabel(source)}
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
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}

function CredentialSourceBadge({ source }: { source: CredentialStatus["source"] }) {
  const sourceLabel = useConfigSourceLabel();
  return (
    <Chip
      label={sourceLabel(source)}
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
  const t = useTranslations("adminIntegrations");
  const format = useAdminFormat();
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client, integrationId);
  const [dialogField, setDialogField] = useState<CredentialStatus | null>(null);
  const showToast = useAdminToast();

  const deleteMutation = useMutation({
    mutationKey: ["integration-credential-delete", admin.apiUrl, integrationId],
    retry: false,
    mutationFn: async (key: string) => {
      try {
        const result = await admin.deleteCredential(
          integrationId,
          key,
          data.configurationRevision ?? "",
        );
        void admin.refresh();
        if (owner.active)
          showToast(
            result.runtime === "applied"
              ? t("credentialKeyDeletedAndActive", { key })
              : t("credentialRemovalSavedProviderActivation"),
            result.runtime === "applied" ? "success" : "info",
          );
      } catch (err) {
        if (owner.active) showToast(t("failedToDeleteKey", { key }), "error");
        throw err;
      }
    },
  });

  const application =
    data.application &&
    data.application.desiredRevision === data.configurationRevision &&
    (data.application.runtime === "unknown" ||
      data.application.runtimeGenerationId === (data.runtime?.generationId ?? null))
      ? data.application
      : null;
  const secretCredentials = data.credentialStatus;
  const { paged: pagedSecrets, paginationProps: secretsPagination } =
    useClientPagination(secretCredentials);

  if (data.credentialStatus.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        {t("thisIntegrationHasNoExternal")}
      </Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {application && (
        <Alert
          severity={
            application.runtime === "applied"
              ? "success"
              : application.runtime === "failed"
                ? "warning"
                : "info"
          }
        >
          {application.runtime === "applied"
            ? t("theSavedCredentialChangeIs")
            : application.runtime === "failed"
              ? t("credentialSavedReloadFailed")
              : t("credentialChangeUnconfirmed")}
        </Alert>
      )}
      {!data.secretsConfigured && secretCredentials.length > 0 && (
        <Alert severity="warning" variant="outlined">
          {t.rich("vaultNotConfiguredSecrets", {
            variable: "OPENMAPX_SECRETS_KEY_FILE",
            command: "pnpm openmapx compose render",
            code: (chunks) => <code>{chunks}</code>,
          })}
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
              {t("secretCredentials")}
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("credential")}</TableCell>
                    <TableCell>{t("source")}</TableCell>
                    <TableCell>{t("vaultLastUpdated")}</TableCell>
                    <TableCell align="right">{t("actions")}</TableCell>
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
                                label={t("sharedSecret", {
                                  name: cred.sharedSecretName,
                                })}
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
                        {(cred.ownership?.writable === false ||
                          ["env", "config.json"].includes(cred.source)) && (
                          <Typography variant="caption" sx={{ display: "block" }}>
                            {cred.ownership?.envVar
                              ? t("hostControlledByVariable", { envVar: cred.ownership.envVar })
                              : t("hostControlledRemoveOverride")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {cred.updatedAt ? (
                          <Tooltip
                            title={
                              cred.updatedBy ? t("updatedBy", { updatedBy: cred.updatedBy }) : ""
                            }
                          >
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                              }}
                            >
                              {format.date(cred.updatedAt)}
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
                            disabled={
                              !data.secretsConfigured ||
                              !data.configurationRevision ||
                              cred.ownership?.writable === false ||
                              ["env", "config.json"].includes(cred.source)
                            }
                          >
                            {hasVaultCredential(cred) ? t("rotate") : t("set")}
                          </Button>
                          {hasVaultCredential(cred) && (
                            <Tooltip title={t("deleteFromVault")}>
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => deleteMutation.mutate(cred.key)}
                                disabled={
                                  deleteMutation.isPending ||
                                  !data.configurationRevision ||
                                  cred.ownership?.writable === false ||
                                  ["env", "config.json"].includes(cred.source)
                                }
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
          expectedRevision={data.configurationRevision}
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
  const t = useTranslations("adminIntegrations");
  const format = useAdminFormat();
  const admin = useIntegrationAdmin();
  const showToast = useAdminToast();

  const healthQuery = useQuery({ ...admin.queries.health(integrationId), enabled: false });
  const healthOwner = useMemo(
    () => ({ active: true, client: admin.client, integrationId }),
    [admin.client, integrationId],
  );
  useEffect(() => {
    healthOwner.active = true;
    return () => {
      healthOwner.active = false;
    };
  }, [healthOwner]);
  const healthMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      // Keep effects with the executing owner; mutation callbacks can be replaced mid-read.
      const owner = healthOwner;
      try {
        const result = await healthQuery.refetch({ throwOnError: true });
        // Cancellation may resolve with a previous cached success rather than rejecting.
        if (!owner.active) return;
        if (!result.data) throw new AdminDisplayError(t("healthCheckWasInterrupted"));
        void admin.refresh();
        showToast(t("healthCheckCompleted"));
      } catch (error) {
        if (owner.active) showToast(t("healthCheckFailed"), "error");
        throw error;
      }
    },
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
          {t("thisIntegrationDoesNotDeclare")}
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
                {t("latestHealthStatus")}
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
                {t("runCheck")}
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
                      ? t("healthy")
                      : health.status === "down"
                        ? t("unhealthy")
                        : t("unconfigured")}
                  </Typography>
                </Stack>
                {health.responseTime != null && (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("responseTime", { responseTime: format.duration(health.responseTime) })}
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
                {t("noHealthDataAvailableYet")}
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
              {t("healthHistory")}
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
  const t = useTranslations("adminIntegrations");
  const href = safeHref(url);
  const shared = {
    label: t("dpaAvailable"),
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
  const t = useTranslations("adminIntegrations");
  const href = safeHref(url);
  return href ? (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      variant="body2"
      sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
    >
      {t("privacyPolicy")}
      <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
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
  const t = useTranslations("adminIntegrations");
  const sources = data.manifest.dataSources;
  if (!sources?.length) {
    return (
      <Alert severity="info" variant="outlined">
        {t("noDataSourcesDeclared")}
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
                <MetaRow label={t("commercialUse")} labelWidth={110} value={ds.commercialUse} />
              )}
              <MetaRow label={t("providerCountry")} labelWidth={110} value={ds.providerCountry} />
              {ds.endUserExposure && (
                <MetaRow label={t("endUserExposure")} labelWidth={110} value={ds.endUserExposure} />
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
                  {t("flags")}
                </Typography>
                <Stack
                  direction="row"
                  sx={{
                    gap: 0.5,
                  }}
                >
                  <Chip
                    label={t("personalData")}
                    size="small"
                    color={ds.personalData ? "warning" : "default"}
                    variant="outlined"
                  />
                  <Chip
                    label={t("cookies")}
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
                  {t("privacyUrl")}
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

interface IntegrationDetailProps {
  id: string;
}

export function IntegrationDetail({ id }: IntegrationDetailProps) {
  const t = useTranslations("adminIntegrations");
  const tabs = [
    t("tabOverview"),
    t("tabConfiguration"),
    t("tabCredentials"),
    t("tabHealth"),
    t("tabDataSources"),
  ];
  const admin = useIntegrationAdmin();
  const [tab, setTab] = useAdminTab([
    "overview",
    "configuration",
    "credentials",
    "health",
    "sources",
  ]);
  const showToast = useAdminToast();

  const { data, isLoading, isError } = useQuery(admin.queries.detail(id));

  const owner = useAdminMutationOwner(admin.client, id);
  const toggleMutation = useMutation({
    mutationKey: ["integration-toggle", admin.apiUrl, id],
    retry: false,
    mutationFn: async (enable: boolean) => {
      try {
        await admin.toggle(id, enable);
        void admin.refresh();
        if (owner.active) showToast(enable ? t("integrationEnabled") : t("integrationDisabled"));
      } catch (err) {
        if (owner.active) showToast(adminErrorText(err, t("operationFailed")), "error");
        throw err;
      }
    },
  });

  const reloadMutation = useIntegrationReload(id);
  const [reloadJobId, setReloadJobId] = useState<string | null>(null);

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
    return <Alert severity="error">{t("failedToLoadIntegrationDetails")}</Alert>;
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
              component="h1"
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
              {data.enabled ? t("disable") : t("enable")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={isBusy ? <CircularProgress size={14} /> : <RefreshIcon />}
              onClick={() =>
                reloadMutation.mutate(undefined, {
                  onSuccess: (result) => {
                    if (!owner.active) return;
                    setReloadJobId(result.jobId);
                    showToast(t("reloadJobQueuedCheckActivity"), "info");
                  },
                  onError: () => {
                    if (owner.active) showToast(t("failedToQueueReloadJob"), "error");
                  },
                })
              }
              disabled={isBusy}
            >
              {t("reload")}
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
      {reloadJobId && <AdminJobLink id={reloadJobId} source="application" />}
      <Divider />
      <Box>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
          variant="scrollable"
          scrollButtons="auto"
        >
          {tabs.map((label, index) => (
            <Tab
              id={`integration-tab-${index}`}
              aria-controls={`integration-panel-${index}`}
              key={label}
              label={label}
            />
          ))}
        </Tabs>

        <div
          role="tabpanel"
          id={`integration-panel-${tab}`}
          aria-labelledby={`integration-tab-${tab}`}
        >
          {tab === 0 && <OverviewTab data={data} />}
          {tab === 1 && <ConfigTab data={data} integrationId={id} />}
          {tab === 2 && <CredentialsTab data={data} integrationId={id} />}
          {tab === 3 && <HealthTab data={data} integrationId={id} />}
          {tab === 4 && <DataSourcesTab data={data} />}
        </div>
      </Box>
    </Stack>
  );
}
