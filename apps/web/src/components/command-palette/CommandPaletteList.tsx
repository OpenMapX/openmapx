"use client";

import List from "@mui/material/List";
import ListSubheader from "@mui/material/ListSubheader";
import type { Command, CommandGroup } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { CommandPaletteRow } from "./CommandPaletteRow";

const GROUP_ORDER: CommandGroup[] = ["layers", "overlays", "panels", "categories", "actions"];
const MAX_PER_GROUP = 5;

export function getDefaultCommandPaletteRows(commands: Command[]): Command[] {
  return GROUP_ORDER.flatMap((group) =>
    commands.filter((command) => command.group === group).slice(0, MAX_PER_GROUP),
  );
}

interface Props {
  commands: Command[];
  query: string;
  selectedId: string | null;
  onRun: (command: Command, event: React.SyntheticEvent | KeyboardEvent) => void;
  /**
   * When provided (filtering active), used as the pre-ranked flat list.
   * When `null`/`undefined`, the list renders grouped from `commands`.
   */
  rankedOverride?: Command[] | null;
  /** id forwarded to the underlying `<List role="listbox">` so the input's
   * `aria-controls` resolves to the actual listbox element. */
  listboxId?: string;
}

export function CommandPaletteList({
  commands,
  query: _query,
  selectedId,
  onRun,
  rankedOverride,
  listboxId,
}: Props) {
  const t = useTranslations("commandPalette");

  if (rankedOverride) {
    // Filtered flat list
    return (
      <List id={listboxId} role="listbox" aria-label={t("placeholder")} sx={{ py: 0 }}>
        {rankedOverride.map((cmd) => (
          <CommandPaletteRow
            key={cmd.id}
            command={cmd}
            selected={cmd.id === selectedId}
            onRun={onRun}
            showGroupChip
          />
        ))}
      </List>
    );
  }

  // Grouped, no query
  const visibleCommands = getDefaultCommandPaletteRows(commands);
  return (
    <List id={listboxId} role="listbox" aria-label={t("placeholder")} sx={{ py: 0 }}>
      {GROUP_ORDER.map((group) => {
        const groupCommands = visibleCommands.filter((c) => c.group === group);
        if (groupCommands.length === 0) return null;
        const groupKey = `group${group.charAt(0).toUpperCase()}${group.slice(1)}`;
        return (
          <li key={group}>
            <ul style={{ padding: 0, margin: 0, listStyle: "none" }}>
              <ListSubheader
                disableSticky
                sx={{
                  bgcolor: "transparent",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  lineHeight: 2.5,
                  pl: 2,
                }}
              >
                {t(groupKey as never)}
              </ListSubheader>
              {groupCommands.map((cmd) => (
                <CommandPaletteRow
                  key={cmd.id}
                  command={cmd}
                  selected={cmd.id === selectedId}
                  onRun={onRun}
                />
              ))}
            </ul>
          </li>
        );
      })}
    </List>
  );
}
