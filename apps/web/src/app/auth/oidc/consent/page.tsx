"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef, useState } from "react";

const STANDARD_SCOPES = ["openid", "profile", "email"] as const;
type StandardScope = (typeof STANDARD_SCOPES)[number];

interface PublicClientDetails {
  client_name?: string | null;
  client_uri?: string | null;
}

function safeClientOrigin(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.host;
  } catch {
    return null;
  }
}

function OidcConsentContent() {
  const t = useTranslations("auth.oidcProvider");
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id")?.trim() ?? "";
  const requestedScopes = [...new Set((searchParams.get("scope") ?? "").split(/\s+/))].filter(
    (scope): scope is StandardScope => STANDARD_SCOPES.includes(scope as StandardScope),
  );
  const [client, setClient] = useState<PublicClientDetails | null>(null);
  const [loading, setLoading] = useState(Boolean(clientId));
  const [error, setError] = useState(!clientId);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then(({ data, error: lookupError }) => {
        if (!active) return;
        if (lookupError || !data) {
          setError(true);
          return;
        }
        setClient(data);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId]);

  const submitConsent = async (accept: boolean) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error) {
        submittingRef.current = false;
        setSubmitting(false);
        setError(true);
      }
    } catch {
      submittingRef.current = false;
      setSubmitting(false);
      setError(true);
    }
  };

  const origin = safeClientOrigin(client?.client_uri);

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        p: 3,
        bgcolor: "background.default",
      }}
    >
      <Paper sx={{ width: "min(100%, 32rem)", p: 4, borderRadius: 3 }} elevation={2}>
        <Typography component="h1" variant="h5" sx={{ fontWeight: 650 }}>
          {t("consentTitle")}
        </Typography>

        {loading ? (
          <Box sx={{ display: "grid", placeItems: "center", py: 6 }}>
            <CircularProgress aria-label={t("loadingClient")} />
          </Box>
        ) : error || !client ? (
          <>
            <Alert severity="error" sx={{ my: 2 }}>
              {t("invalidClient")}
            </Alert>
            <Link href="/" sx={{ fontWeight: 600 }}>
              {t("backToOpenMapX")}
            </Link>
          </>
        ) : (
          <>
            <Typography variant="h6" sx={{ mt: 2 }}>
              {client.client_name || t("unknownClient")}
            </Typography>
            {origin && <Typography color="text.secondary">{origin}</Typography>}
            <Typography sx={{ mt: 2 }}>{t("consentBody")}</Typography>
            <List disablePadding sx={{ my: 1.5 }}>
              {requestedScopes.map((scope) => (
                <ListItem key={scope} disableGutters>
                  <ListItemText
                    primary={t(`scopes.${scope}`)}
                    secondary={t(`scopeDetails.${scope}`)}
                  />
                </ListItem>
              ))}
            </List>
            <Box sx={{ display: "flex", gap: 1.5, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button variant="outlined" disabled={submitting} onClick={() => submitConsent(false)}>
                {t("deny")}
              </Button>
              <Button variant="contained" disabled={submitting} onClick={() => submitConsent(true)}>
                {t("accept")}
              </Button>
            </Box>
          </>
        )}
      </Paper>
    </Box>
  );
}

function ConsentPageFallback() {
  const t = useTranslations("auth.oidcProvider");

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        bgcolor: "background.default",
      }}
    >
      <CircularProgress aria-label={t("loadingClient")} />
    </Box>
  );
}

export default function OidcConsentPage() {
  return (
    <Suspense fallback={<ConsentPageFallback />}>
      <OidcConsentContent />
    </Suspense>
  );
}
