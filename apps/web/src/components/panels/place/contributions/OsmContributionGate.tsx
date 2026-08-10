"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { OsmContributionCapabilities } from "@openmapx/core";
import { authClient, safeHref } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** The marker the OAuth callback carries back. Deliberately a boolean only. */
export const OSM_CONTRIBUTE_CALLBACK_PARAM = "osm-contribute";

export type OsmContributionIntent = "edit" | "note";

/**
 * The complete scope set an account-link request must carry.
 *
 * Better Auth 1.6.26's generic-OAuth *link* route uses
 * `body.scopes || configuredScopes`, so a supplied array **replaces** the
 * provider defaults rather than adding to them (unlike the sign-in route,
 * which concatenates). Passing only the missing scope would therefore drop
 * base identity — and drop a write scope the person already granted, since one
 * provider token is stored per account. So we always send base identity plus
 * the intended action plus any contribution scope already in effect.
 */
export function linkScopesFor(
  capabilities: Pick<OsmContributionCapabilities, "canWriteApi" | "canWriteNotes">,
  intent: OsmContributionIntent,
): string[] {
  const scopes = ["openid", "read_prefs"];
  if (capabilities.canWriteApi || intent === "edit") scopes.push("write_api");
  if (capabilities.canWriteNotes || intent === "note") scopes.push("write_notes");
  return [...new Set(scopes)];
}

/** Same-origin return URL carrying only a boolean reopen marker. */
export function callbackUrlFor(href: string): string {
  const url = new URL(href);
  url.searchParams.set(OSM_CONTRIBUTE_CALLBACK_PARAM, "1");
  return url.toString();
}

interface Props {
  intent: OsmContributionIntent;
  capabilities: OsmContributionCapabilities | undefined;
  isLoading: boolean;
  isError: boolean;
  /** True when the person has typed something that navigation would discard. */
  hasUnsentInput: boolean;
  onRetry: () => void;
}

/**
 * Explains, and resolves, why contributing is not possible yet. Every action
 * either calls Better Auth's own link method or follows a trusted URL the
 * server supplied — never one built here.
 */
export function OsmContributionGate({
  intent,
  capabilities,
  isLoading,
  isError,
  hasUnsentInput,
  onRetry,
}: Props) {
  const t = useTranslations("osmContributions");

  if (isLoading) {
    return (
      <Stack spacing={2} sx={{ py: 4, alignItems: "center" }}>
        <CircularProgress size={28} />
        <Typography variant="body2" color="text.secondary">
          {t("loading")}
        </Typography>
      </Stack>
    );
  }

  if (isError || !capabilities) {
    return (
      <Panel title={t("gateUnavailableTitle")} body={t("gateUnavailableBody")}>
        <Button variant="outlined" onClick={onRetry}>
          {t("reviewAction")}
        </Button>
      </Panel>
    );
  }

  const authorize = async () => {
    await authClient.oauth2.link({
      providerId: "openstreetmap",
      callbackURL: callbackUrlFor(window.location.href),
      scopes: linkScopesFor(capabilities, intent),
    });
  };

  if (!capabilities.linked) {
    return (
      <Panel title={t("gateLinkTitle")} body={t("gateLinkBody")}>
        {hasUnsentInput && <Alert severity="warning">{t("gateDiscardWarning")}</Alert>}
        <Button variant="contained" onClick={authorize} sx={{ minHeight: 44 }}>
          {t("gateLinkAction")}
        </Button>
      </Panel>
    );
  }

  // Only meaningful once OSM has actually described the account. Without a
  // usable token the server cannot know the terms/block state, and it reports
  // the conservative defaults — which would otherwise render a panel whose
  // action button has no URL to point at.
  const accountDescribed =
    capabilities.actions.contributorTermsUrl !== undefined ||
    capabilities.contributorTermsAgreed ||
    capabilities.canWriteApi ||
    capabilities.canWriteNotes;

  if (!accountDescribed) {
    return (
      <Panel title={t("gateScopeTitle")} body={t("gateScopeBody")}>
        {hasUnsentInput && <Alert severity="warning">{t("gateDiscardWarning")}</Alert>}
        <Button variant="contained" onClick={authorize} sx={{ minHeight: 44 }}>
          {t("gateScopeAction")}
        </Button>
      </Panel>
    );
  }

  if (capabilities.activeBlock) {
    const messagesHref = safeHref(capabilities.actions.accountMessagesUrl);
    return (
      <Panel title={t("gateBlockedTitle")} body={t("gateBlockedBody")}>
        {messagesHref && (
          <Button
            variant="contained"
            href={messagesHref}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ minHeight: 44 }}
          >
            {t("gateBlockedAction")}
          </Button>
        )}
      </Panel>
    );
  }

  if (!capabilities.contributorTermsAgreed) {
    const termsHref = safeHref(capabilities.actions.contributorTermsUrl);
    return (
      <Panel title={t("gateTermsTitle")} body={t("gateTermsBody")}>
        {termsHref && (
          <Button
            variant="contained"
            href={termsHref}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ minHeight: 44 }}
          >
            {t("gateTermsAction")}
          </Button>
        )}
      </Panel>
    );
  }

  const permitted = intent === "edit" ? capabilities.canWriteApi : capabilities.canWriteNotes;
  if (!permitted) {
    return (
      <Panel
        title={t("gateScopeTitle")}
        body={intent === "edit" ? t("gateScopeBody") : t("gateScopeNoteBody")}
      >
        {hasUnsentInput && <Alert severity="warning">{t("gateDiscardWarning")}</Alert>}
        <Button variant="contained" onClick={authorize} sx={{ minHeight: 44 }}>
          {t("gateScopeAction")}
        </Button>
      </Panel>
    );
  }

  if (intent === "edit" && !capabilities.directEditingEnabled) {
    return <Panel title={t("gateUnavailableTitle")} body={t("errorDirectEditingDisabled")} />;
  }

  return null;
}

function Panel({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <Stack spacing={2} sx={{ py: 2 }}>
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
      </Box>
      {children}
    </Stack>
  );
}
