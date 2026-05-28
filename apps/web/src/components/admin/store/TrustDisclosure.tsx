"use client";

import CloudIcon from "@mui/icons-material/Cloud";
import CodeIcon from "@mui/icons-material/Code";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import StorageIcon from "@mui/icons-material/Storage";
import WidgetsIcon from "@mui/icons-material/Widgets";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export interface TrustProfile {
  frontendBundle: boolean;
  backendCode: boolean;
  externalNetwork: boolean;
  secretUsage: boolean;
  serviceRequirements: string[];
}

interface DisclosureRowProps {
  icon: React.ReactNode;
  label: string;
  value: boolean | string;
  detail?: string;
  risk?: "low" | "medium" | "high";
}

function DisclosureRow({ icon, label, value, detail, risk }: DisclosureRowProps) {
  const isBool = typeof value === "boolean";
  const isActive = isBool ? value : !!value;

  const color = isActive
    ? risk === "high"
      ? "error.main"
      : risk === "medium"
        ? "warning.main"
        : "text.primary"
    : "text.disabled";

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: "flex-start",
        gap: 1.5,
        py: 0.75,
      }}
    >
      <Box
        sx={{
          color,
          display: "flex",
          alignItems: "center",
          mt: 0.1,
          "& svg": { fontSize: "1.1rem" },
        }}
      >
        {icon}
      </Box>
      <Box
        sx={{
          flex: 1,
        }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Typography
            variant="body2"
            color={color}
            sx={{
              fontWeight: 500,
            }}
          >
            {label}
          </Typography>
          <Typography
            variant="caption"
            color={isActive ? color : "text.disabled"}
            sx={{
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {isBool ? (value ? "Yes" : "No") : value}
          </Typography>
        </Stack>
        {detail && isActive && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {detail}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

interface TrustDisclosureProps {
  trust: TrustProfile;
}

export function TrustDisclosure({ trust }: TrustDisclosureProps) {
  const highRiskCount = [trust.backendCode, trust.externalNetwork, trust.secretUsage].filter(
    Boolean,
  ).length;

  return (
    <Box>
      <Alert severity={highRiskCount >= 2 ? "warning" : "info"} sx={{ mb: 1.5 }} icon={false}>
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
          }}
        >
          Trust & Risk Disclosure
        </Typography>
        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 0.25,
          }}
        >
          Review what this integration does before installing. Community integrations are not
          audited by the OpenMapX team.
        </Typography>
      </Alert>
      <Box
        sx={{
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          px: 2,
          "& > :not(:last-child)": { borderBottom: "1px solid", borderColor: "divider" },
        }}
      >
        <DisclosureRow
          icon={<WidgetsIcon />}
          label="Frontend bundle"
          value={trust.frontendBundle}
          detail="Runs JavaScript in your browser from this integration."
          risk="medium"
        />
        <DisclosureRow
          icon={<CodeIcon />}
          label="Backend code execution"
          value={trust.backendCode}
          detail="Runs server-side code in the API process."
          risk="high"
        />
        <DisclosureRow
          icon={<CloudIcon />}
          label="External network access"
          value={trust.externalNetwork}
          detail="Makes outbound requests to third-party services."
          risk="medium"
        />
        <DisclosureRow
          icon={<LockOpenIcon />}
          label="Secret / credential usage"
          value={trust.secretUsage}
          detail="Requires API keys or tokens stored in the vault."
          risk="high"
        />
        <DisclosureRow
          icon={<StorageIcon />}
          label="Service requirements"
          value={trust.serviceRequirements.length > 0}
          detail={
            trust.serviceRequirements.length > 0
              ? `Requires: ${trust.serviceRequirements.join(", ")}`
              : undefined
          }
          risk="low"
        />
      </Box>
    </Box>
  );
}

export function inferTrustProfile(manifest: {
  frontendBundle?: boolean;
  backend?: boolean;
  infrastructure?: string[];
  configSchema?: Record<string, unknown>;
}): TrustProfile {
  const hasSecretFields = manifest.configSchema
    ? Object.values(
        ((manifest.configSchema as Record<string, unknown>).properties ??
          manifest.configSchema) as Record<string, Record<string, unknown>>,
      ).some((f) => f?.["x-openmapx-secret"] === true)
    : false;

  return {
    frontendBundle: manifest.frontendBundle ?? false,
    backendCode: manifest.backend ?? true,
    externalNetwork: hasSecretFields,
    secretUsage: hasSecretFields,
    serviceRequirements: manifest.infrastructure ?? [],
  };
}
