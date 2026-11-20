"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";

type Preview = Extract<
  Awaited<ReturnType<typeof sdk.postApiDataManagerTransitSyncPreflight>>,
  { status: 200 }
>["data"];
type Props = { apiUrl: string; onClose(): void; onQueued(jobId: string): void };
export function TransitSyncDialog(props: Props) {
  return <TransitSyncView key={props.apiUrl} {...props} />;
}
function TransitSyncView({ apiUrl, onClose, onQueued }: Props) {
  const t = useTranslations("adminServices");
  const format = useAdminFormat();
  const tCommon = useTranslations("common");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [manualCountries, setManualCountries] = useState("");
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  const profile = useQuery({
    queryKey: ["admin", "transit", apiUrl, "profile"],
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(await sdk.getApiDataManagerTransitProfile({ client, signal })),
  });
  const [selection, setSelection] = useState<string[] | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [expired, setExpired] = useState(false),
    [error, setError] = useState<string | null>(null);
  const selected = [...new Set(selection ?? profile.data?.policy.countries ?? [])].sort(),
    selectionKey = JSON.stringify(selected),
    current = useRef(selectionKey),
    key = useRef<string | null>(null);
  current.current = selectionKey;
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const change = (countries: string[]) => {
    setSelection(countries);
    setPreview(null);
    setExpired(false);
    setError(null);
    key.current = null;
  };
  const inspect = useMutation({
    retry: false,
    mutationFn: async (countries: string[]) => ({
      selectionKey: JSON.stringify(countries),
      value: sdk.unwrapAdminResponse(
        await sdk.postApiDataManagerTransitSyncPreflight({ countries }, { client }),
      ),
    }),
    onSuccess: ({ selectionKey, value }) => {
      if (!alive.current || current.current !== selectionKey) return;
      setPreview(value);
      setExpired(false);
      setError(null);
      key.current = null;
    },
    onError: (e) => setError(adminErrorText(e, t("serviceRequestFailed"))),
  });
  const submit = useMutation({
    retry: false,
    mutationFn: async () => {
      if (
        !preview ||
        expired ||
        Date.parse(preview.expiresAt) <= Date.now() ||
        !preview.result.ok ||
        JSON.stringify(preview.countries) !== current.current
      )
        throw Error(t("previewTheCurrentCountrySelection"));
      key.current ??= crypto.randomUUID();
      return sdk.unwrapAdminResponse(
        await sdk.postApiDataManagerTransitSync(
          {
            countries: preview.countries,
            preflightId: preview.preflightId,
            fingerprint: preview.fingerprint,
            idempotencyKey: key.current,
          },
          { client },
        ),
      );
    },
    onSuccess: ({ jobId }) => {
      if (alive.current) onQueued(jobId);
    },
    onError: (e) => setError(adminErrorText(e, t("serviceRequestFailed"))),
  });
  const busy = inspect.isPending || submit.isPending;
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>{t("reviewTransitSync")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>{t("selectTheCountriesToSynchronize")}</Typography>
          {profile.isPending && <Typography>{t("loadingInstanceScope")}</Typography>}
          {profile.error && (
            <Alert severity="error">
              {adminErrorText(profile.error, t("serviceRequestFailed"))}
            </Alert>
          )}
          <Stack direction="row" sx={{ flexWrap: "wrap" }}>
            {profile.data?.policy.countries.map((country) => (
              <FormControlLabel
                key={country}
                label={country.toUpperCase()}
                control={
                  <Checkbox
                    disabled={busy}
                    checked={selected.includes(country)}
                    onChange={(_event, checked) =>
                      change(
                        checked ? [...selected, country] : selected.filter((c) => c !== country),
                      )
                    }
                  />
                }
              />
            ))}
          </Stack>
          {profile.data?.policy.profile === "planet" && (
            <TextField
              label={t("countryCodes")}
              value={manualCountries}
              disabled={busy}
              onChange={(event) => {
                setManualCountries(event.target.value);
                change(
                  event.target.value
                    .toLowerCase()
                    .split(/[\s,]+/)
                    .filter(Boolean),
                );
              }}
              helperText={t("enterIsoCountryCodesSeparated")}
            />
          )}
          {error && <Alert severity="error">{t("errorCheckActivityIfAn", { error })}</Alert>}
          {preview && (
            <>
              <Typography>
                {t("countries", {
                  countries: preview.countries.map((c) => c.toUpperCase()).join(", "),
                })}
              </Typography>
              <Typography>
                {t("feedEstimate", {
                  feedCount: preview.result.estimate.feedCount,
                  basis: preview.result.estimate.basis.replaceAll("-", "_"),
                })}
              </Typography>
              <Typography>
                {t("diskEstimate", {
                  required: format.bytes(preview.result.estimate.requiredDiskBytes),
                  available: format.bytes(preview.result.capacity.freeDiskBytes),
                })}
              </Typography>
              {preview.result.blockers.map((reason) => (
                <Alert key={reason} severity="error">
                  {reason}
                </Alert>
              ))}
              {preview.result.warnings.map((reason) => (
                <Alert key={reason} severity="warning">
                  {reason}
                </Alert>
              ))}
              {expired && <Alert severity="warning">{t("thisPreviewExpiredRefreshIt")}</Alert>}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button
          disabled={busy || !selected.length || !profile.data}
          onClick={() => inspect.mutate(selected)}
        >
          {t("previewSync")}
        </Button>
        <Button
          variant="contained"
          disabled={busy || !preview?.result.ok || expired}
          onClick={() => submit.mutate()}
        >
          {t("queueSync")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
