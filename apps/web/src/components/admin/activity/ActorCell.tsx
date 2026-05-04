"use client";

import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

interface Actor {
  id: string;
  name: string;
  email: string;
}

interface ActorCellProps {
  actorId: string | null;
  actor: Actor | null;
}

/**
 * Render an actor (user) reference: name + email when the user row exists,
 * truncated id when only the id is known (e.g. user since deleted), or
 * "system" / "loopback" when the action came from the API itself or a
 * loopback CLI request.
 */
export function ActorCell({ actorId, actor }: ActorCellProps) {
  if (!actorId) {
    return (
      <Typography variant="caption" color="text.secondary" fontStyle="italic">
        system
      </Typography>
    );
  }

  if (actor) {
    return (
      <Tooltip title={actor.id}>
        <Stack>
          <Typography variant="body2" fontWeight={500}>
            {actor.name || actor.email}
          </Typography>
          {actor.name && (
            <Typography variant="caption" color="text.secondary">
              {actor.email}
            </Typography>
          )}
        </Stack>
      </Tooltip>
    );
  }

  // User row no longer exists — show truncated id with a hint.
  return (
    <Tooltip title={`${actorId} (user no longer exists)`}>
      <Typography variant="caption" color="text.secondary" fontFamily="monospace">
        {`${actorId.slice(0, 12)}…`}
      </Typography>
    </Tooltip>
  );
}
