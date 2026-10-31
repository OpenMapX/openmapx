"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
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
import { useEffect, useMemo, useRef, useState } from "react";

type Preview = Extract<
  Awaited<ReturnType<typeof sdk.postApiDataManagerTransitSyncPreflight>>,
  { status: 200 }
>["data"];
type Props = { apiUrl: string; onClose(): void; onQueued(jobId: string): void };
export function TransitSyncDialog(props: Props) {
  return <TransitSyncView key={props.apiUrl} {...props} />;
}
function TransitSyncView({ apiUrl, onClose, onQueued }: Props) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [manualCountries, setManualCountries] = useState("");
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
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
    onError: (e) => setError(sdk.adminErrorMessage(e, e.message)),
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
        throw Error("Preview the current country selection again");
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
    onError: (e) => setError(sdk.adminErrorMessage(e, e.message)),
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
      <DialogTitle>Review transit sync</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>
            Select the countries to synchronize. Capacity and input estimates come from your
            instance.
          </Typography>
          {profile.isPending && <Typography>Loading instance scope…</Typography>}
          {profile.error && (
            <Alert severity="error">
              {sdk.adminErrorMessage(profile.error, profile.error.message)}
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
              label="Country codes"
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
              helperText="Enter ISO country codes separated by commas"
            />
          )}
          {error && (
            <Alert severity="error">
              {error} Check Activity if an earlier submission may already be running.
            </Alert>
          )}
          {preview && (
            <>
              <Typography>
                Countries: {preview.countries.map((c) => c.toUpperCase()).join(", ")}
              </Typography>
              <Typography>
                {preview.result.estimate.feedCount} feeds · estimate:{" "}
                {preview.result.estimate.basis.replaceAll("-", " ")}
              </Typography>
              <Typography>
                Disk required: {Math.ceil(preview.result.estimate.requiredDiskBytes / 1024 ** 3)}{" "}
                GiB · available: {Math.floor(preview.result.capacity.freeDiskBytes / 1024 ** 3)} GiB
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
              {expired && (
                <Alert severity="warning">This preview expired. Refresh it before queuing.</Alert>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || !selected.length || !profile.data}
          onClick={() => inspect.mutate(selected)}
        >
          Preview sync
        </Button>
        <Button
          variant="contained"
          disabled={busy || !preview?.result.ok || expired}
          onClick={() => submit.mutate()}
        >
          Queue sync
        </Button>
      </DialogActions>
    </Dialog>
  );
}
