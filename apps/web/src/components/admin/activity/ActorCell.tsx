"use client";

import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";

interface Actor {
  id: string;
  name: string;
  email: string;
}

interface ActorCellProps {
  actorId: string | null;
  actor: Actor | null;
  fallbackLabel?: string;
}

/**
 * Render an actor (user) reference: name + email when the user row exists,
 * truncated id when only the id is known (e.g. user since deleted), or
 * a source-specific fallback label when the action came from automation or
 * another internal subsystem.
 */
export function ActorCell({ actorId, actor, fallbackLabel: fallback }: ActorCellProps) {
  const t = useTranslations("adminActivity");
  const fallbackLabel = fallback ?? t("system");
  if (!actorId) {
    return (
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontStyle: "italic",
        }}
      >
        {fallbackLabel}
      </Typography>
    );
  }

  if (actor) {
    return (
      <Tooltip title={actor.id}>
        <Stack>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {actor.name || actor.email}
          </Typography>
          {actor.name && (
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {actor.email}
            </Typography>
          )}
        </Stack>
      </Tooltip>
    );
  }

  // User row no longer exists — show truncated id with a hint.
  return (
    <Tooltip title={t("actoridUserNoLongerExists", { actorId })}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontFamily: "monospace",
        }}
      >
        {`${actorId.slice(0, 12)}…`}
      </Typography>
    </Tooltip>
  );
}
