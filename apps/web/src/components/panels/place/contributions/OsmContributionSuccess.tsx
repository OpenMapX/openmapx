"use client";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { OsmContributionPublishResult, OsmNoteResult } from "@openmapx/core";
import { safeHref } from "@openmapx/core";
import { useTranslations } from "next-intl";

function isNoteResult(
  result: OsmContributionPublishResult | OsmNoteResult,
): result is OsmNoteResult {
  return "noteId" in result;
}

interface Props {
  result: OsmContributionPublishResult | OsmNoteResult;
}

/**
 * The authoritative end of the interaction. It stays visible until the person
 * closes it — a place refetch that has not caught up upstream must never make
 * a published change look lost.
 */
export function OsmContributionSuccess({ result }: Props) {
  const t = useTranslations("osmContributions");
  const note = isNoteResult(result);

  return (
    <Stack spacing={2} sx={{ py: 2, alignItems: "flex-start" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <CheckCircleOutlineIcon color="success" />
        <Typography variant="subtitle1">
          {note ? t("successNoteTitle") : t("successEditTitle")}
        </Typography>
      </Stack>

      {note ? (
        <Button
          component="a"
          href={safeHref(result.noteUrl)}
          target="_blank"
          rel="noopener noreferrer"
          endIcon={<OpenInNewIcon />}
          sx={{ minHeight: 44 }}
        >
          {t("successNote")}
        </Button>
      ) : (
        <>
          <Button
            component="a"
            href={safeHref(result.changesetUrl)}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNewIcon />}
            sx={{ minHeight: 44 }}
          >
            {t("successChangeset")}
          </Button>
          <Button
            component="a"
            href={safeHref(result.elementUrl)}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNewIcon />}
            sx={{ minHeight: 44 }}
          >
            {t("successElement")}
          </Button>
        </>
      )}

      <Alert severity="info">{t("successLag")}</Alert>
    </Stack>
  );
}
