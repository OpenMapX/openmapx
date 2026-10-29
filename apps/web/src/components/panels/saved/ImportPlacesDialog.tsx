"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import { useTheme } from "@mui/material/styles";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  type ImportPlacesInput,
  isSystemSavedList,
  useImportPlaces,
  useSavedLists,
  useSavedPlacesStore,
} from "@openmapx/core";
import {
  SAVED_PLACE_FIELDS,
  savedPlaceContributors,
} from "@openmapx/core/saved-place-contributors";
import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import type { ImportList, ImportPlace, ParsedImport } from "@/lib/savedPlacesImport/types";

interface ReviewList extends ImportList {
  id: string;
  included: boolean;
  target: string;
  includeApproximate: boolean;
}
interface ImportOutcome {
  id: string;
  name: string;
  listId?: string;
  imported: number;
  skippedDuplicates: number;
  failed: boolean;
}
const ready = (place: ImportPlace) => place.status === "exact" || place.status === "located";
function payloadPlaces(list: ReviewList): ImportPlacesInput["places"] {
  return list.places
    .filter((place) => ready(place) || (list.includeApproximate && place.status === "approximate"))
    .flatMap((place) =>
      place.lat !== undefined && place.lng !== undefined
        ? [
            {
              name: place.name,
              lat: place.lat,
              lng: place.lng,
              ...(place.address ? { address: place.address } : {}),
              ...(place.note ? { note: place.note } : {}),
              ...(place.fieldContributors === undefined
                ? {}
                : { fieldContributors: place.fieldContributors }),
            },
          ]
        : [],
    );
}

export function ImportPlacesDialog({
  files,
  targetListId,
  onClose,
}: {
  files: readonly File[];
  targetListId?: string;
  onClose: () => void;
}) {
  const t = useTranslations("saved");
  const common = useTranslations("common");
  const lang = useLocale();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const { data: savedLists } = useSavedLists();
  const mutation = useImportPlaces();
  const selectList = useSavedPlacesStore((state) => state.selectList);
  const [phase, setPhase] = useState<"parsing" | "locating" | "review" | "importing" | "done">(
    "parsing",
  );
  const [progress, setProgress] = useState({ done: 0, total: files.length });
  const [lists, setLists] = useState<ReviewList[]>([]);
  const [errors, setErrors] = useState<ParsedImport["errors"]>([]);
  const [skippedLists, setSkippedLists] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  // Capture the initial target catalogue; refetches while importing must not restart parsing.
  const [initialLists] = useState(savedLists || []);
  useEffect(() => {
    const controller = new AbortController();
    const onProgress = (done: number, total: number) => {
      if (!controller.signal.aborted) setProgress({ done, total });
    };
    async function prepare() {
      try {
        const { parseImportFiles } = await import("@/lib/savedPlacesImport");
        controller.signal.throwIfAborted();
        const parsed = await parseImportFiles(files, {
          signal: controller.signal,
          onProgress,
          droppedPin: t("importDroppedPin"),
          tagsLabel: t("importTags"),
        });
        controller.signal.throwIfAborted();
        setErrors(parsed.errors);
        setSkippedLists(parsed.skippedLists);
        setPhase("locating");
        const { resolveImportPlaces } = await import("@/lib/savedPlacesImport/resolve");
        controller.signal.throwIfAborted();
        const resolved = await resolveImportPlaces(parsed.lists, {
          lang,
          signal: controller.signal,
          onProgress,
        });
        controller.signal.throwIfAborted();
        setLists(
          resolved.map((list) => ({
            ...list,
            id: crypto.randomUUID(),
            included: true,
            includeApproximate: false,
            target:
              targetListId ||
              initialLists.find(
                (existing) => isSystemSavedList(existing.name) && existing.name === list.systemList,
              )?.id ||
              "",
          })),
        );
        setPhase("review");
      } catch {
        if (controller.signal.aborted) return;
        setErrors([{ file: files.map((file) => file.name).join(", "), code: "malformed" }]);
        setPhase("review");
      }
    }
    void prepare();
    return () => controller.abort();
  }, [files, initialLists, lang, t, targetListId]);
  const attributions = useMemo(
    () =>
      contributorsForRecords(
        lists
          .filter((list) => list.included)
          .flatMap((list) =>
            payloadPlaces(list).map((place) => ({
              contributors: savedPlaceContributors(
                place.fieldContributors,
                SAVED_PLACE_FIELDS.filter((field) => field !== "address" || Boolean(place.address)),
              ),
            })),
          ),
      ),
    [lists],
  );
  const update = (index: number, patch: Partial<ReviewList>) =>
    setLists((previous) => previous.map((list, i) => (i === index ? { ...list, ...patch } : list)));
  const eligible = lists.filter((list) => list.included && payloadPlaces(list).length > 0);
  const invalidName = eligible.some(
    (list) =>
      !list.target &&
      (!list.name.trim() || list.name.trim().startsWith("$") || list.name.length > 200),
  );
  const displayName = (name: string) => (isSystemSavedList(name) ? t(name.slice(1)) : name);
  async function runImport() {
    setPhase("importing");
    const total = eligible.reduce((count, list) => count + payloadPlaces(list).length, 0);
    setProgress({ done: 0, total });
    let done = 0;
    const results: ImportOutcome[] = [];
    for (const list of eligible) {
      const places = payloadPlaces(list);
      const outcome: ImportOutcome = {
        id: list.id,
        name: list.name,
        imported: 0,
        skippedDuplicates: 0,
        failed: false,
      };
      let target: ImportPlacesInput["target"] = list.target
        ? { listId: list.target }
        : { name: list.name.trim() };
      try {
        for (let offset = 0; offset < places.length; offset += 2000) {
          const chunk = places.slice(offset, offset + 2000);
          const response = await mutation.mutateAsync({ target, places: chunk });
          target = { listId: response.listId };
          outcome.listId = response.listId;
          outcome.name = response.name;
          outcome.imported += response.imported;
          outcome.skippedDuplicates += response.skippedDuplicates;
          done += chunk.length;
          setProgress({ done, total });
        }
      } catch {
        outcome.failed = true;
      }
      results.push(outcome);
    }
    setOutcomes(results);
    setPhase("done");
  }
  const working = phase === "parsing" || phase === "locating" || phase === "importing";
  const finish = () => {
    const first = outcomes.find((outcome) => outcome.listId)?.listId;
    if (first) selectList(first);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={phase === "importing" ? undefined : phase === "done" ? finish : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="import-places-title"
    >
      <DialogTitle id="import-places-title">{t("importPlaces")}</DialogTitle>
      <DialogContent dividers>
        {working && (
          <Box role="status" aria-live="polite" sx={{ py: 3 }}>
            <Typography sx={{ mb: 2 }}>
              {t(
                phase === "parsing"
                  ? "importParsing"
                  : phase === "locating"
                    ? "importLocating"
                    : "importSaving",
                progress,
              )}
            </Typography>
            <LinearProgress
              variant={progress.total ? "determinate" : "indeterminate"}
              value={progress.total ? (100 * progress.done) / progress.total : undefined}
            />
          </Box>
        )}
        {phase === "review" &&
          errors.map((error) => (
            <Alert
              key={`${error.file}-${error.code}`}
              severity="warning"
              sx={{ mb: 2, overflowWrap: "anywhere" }}
            >
              {error.file}: {t(`importError_${error.code}`)}
            </Alert>
          ))}
        {phase === "review" && (
          <>
            {skippedLists.length > 0 && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 2, overflowWrap: "anywhere" }}
              >
                {t("importSkippedLists", {
                  count: skippedLists.length,
                  names: skippedLists.join(", "),
                })}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t("importLookupInfo")}
            </Typography>
            {lists.map((list, index) => {
              const readyCount = list.places.filter(ready).length;
              const approximate = list.places.filter(
                (place) => place.status === "approximate",
              ).length;
              const missing = list.places.filter(
                (place) => place.status === "unresolved" || place.status === "needsLookup",
              );
              return (
                <Box
                  key={list.id}
                  sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2, mb: 2 }}
                >
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={list.included}
                        onChange={(_, checked) => update(index, { included: checked })}
                      />
                    }
                    label={list.source}
                    sx={{ "& .MuiFormControlLabel-label": { overflowWrap: "anywhere" } }}
                  />
                  <Box sx={{ display: "grid", gap: 2, mt: 1 }}>
                    <TextField
                      label={t("importListName")}
                      value={list.name}
                      disabled={!list.included}
                      onChange={(event) => update(index, { name: event.target.value })}
                      slotProps={{ htmlInput: { maxLength: 200 } }}
                      error={
                        !list.target && (!list.name.trim() || list.name.trim().startsWith("$"))
                      }
                    />
                    <TextField
                      select
                      label={t("importTarget")}
                      slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
                      value={list.target}
                      disabled={!list.included}
                      onChange={(event) => update(index, { target: event.target.value })}
                    >
                      <MenuItem value="">{t("importNewList")}</MenuItem>
                      {(savedLists || []).map((existing) => (
                        <MenuItem key={existing.id} value={existing.id}>
                          {displayName(existing.name)}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Typography variant="body2">
                      {t("importReady", { count: readyCount })}
                    </Typography>
                    {approximate > 0 && (
                      <Box>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={list.includeApproximate}
                              disabled={!list.included}
                              onChange={(_, checked) =>
                                update(index, { includeApproximate: checked })
                              }
                            />
                          }
                          label={t("importApproximate", { count: approximate })}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {t("importApproximateInfo")}
                        </Typography>
                      </Box>
                    )}
                    {missing.length > 0 && (
                      <Accordion disableGutters elevation={0}>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                          {t("importNotFound", { count: missing.length })}
                        </AccordionSummary>
                        <AccordionDetails>
                          <Box component="ul" sx={{ m: 0, pl: 2, listStyleType: "disc" }}>
                            {[...new Set(missing.map((place) => place.name))].map((name) => (
                              <li key={name}>{name}</li>
                            ))}
                          </Box>
                        </AccordionDetails>
                      </Accordion>
                    )}
                  </Box>
                </Box>
              );
            })}
            {attributions.length > 0 && (
              <AttributionStrip attributions={attributions} variant="plain" />
            )}
          </>
        )}
        {phase === "done" &&
          outcomes.map((outcome) => (
            <Box key={outcome.id} sx={{ mb: 2 }}>
              <Typography sx={{ fontWeight: 500 }}>{displayName(outcome.name)}</Typography>
              <Typography>
                {t("importResult", {
                  count: outcome.imported,
                  duplicates: outcome.skippedDuplicates,
                })}
              </Typography>
              {outcome.failed && <Alert severity="error">{t("importFailed")}</Alert>}
            </Box>
          ))}
      </DialogContent>
      <DialogActions>
        {phase === "done" ? (
          <Button onClick={finish} variant="contained">
            {common("done")}
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={phase === "importing"}>
              {common("cancel")}
            </Button>
            {phase === "review" && (
              <Button
                onClick={() => void runImport()}
                variant="contained"
                disabled={!eligible.length || invalidName}
              >
                {t("import")}
              </Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
