"use client";

import List from "@mui/material/List";
import ListSubheader from "@mui/material/ListSubheader";
import type { Command, CommandGroup } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { CommandPaletteRow } from "./CommandPaletteRow";

const GROUP_ORDER: CommandGroup[] = ["layers", "overlays", "panels", "categories", "actions"];
const MAX_PER_GROUP = 5;

/** Synthetic expand-row id (double-underscore so it can't collide with real ids). */
export const expandRowId = (group: CommandGroup) => `__expand-${group}__`;

interface BuildOptions {
  expandedGroups: ReadonlySet<CommandGroup>;
  onExpandGroup: (group: CommandGroup) => void;
  /** next-intl translator for the "Show {count} more" label. */
  t: (key: "expandMore", values: { count: number }) => string;
}

/**
 * Build the grouped/truncated command list used when no query is active.
 * Truncated groups get a synthetic "+N more" expand row appended; once the
 * caller marks a group as expanded, we render every command in it.
 */
export function buildDefaultCommandRows(commands: Command[], opts: BuildOptions): Command[] {
  const { expandedGroups, onExpandGroup, t } = opts;
  return GROUP_ORDER.flatMap((group) => {
    const all = commands.filter((c) => c.group === group);
    if (all.length <= MAX_PER_GROUP || expandedGroups.has(group)) return all;
    const visible = all.slice(0, MAX_PER_GROUP);
    const hidden = all.length - MAX_PER_GROUP;
    const expand: Command = {
      id: expandRowId(group),
      group,
      label: t("expandMore", { count: hidden }),
      iconKey: "expand",
      run: () => {
        onExpandGroup(group);
        return false;
      },
    };
    return [...visible, expand];
  });
}

interface Props {
  /** Default (grouped) rows when no query — pre-built by the parent so the
   * palette and the list share a single source of truth for keyboard nav. */
  defaultRows: Command[];
  selectedId: string | null;
  onRun: (command: Command, event: React.SyntheticEvent | KeyboardEvent) => void;
  /**
   * When provided (filtering active), used as the pre-ranked flat list.
   * When `null`/`undefined`, the list renders grouped from `defaultRows`.
   */
  rankedOverride?: Command[] | null;
  /** id forwarded to the underlying `<List role="listbox">` so the input's
   * `aria-controls` resolves to the actual listbox element. */
  listboxId?: string;
}

export function CommandPaletteList({
  defaultRows,
  selectedId,
  onRun,
  rankedOverride,
  listboxId,
}: Props) {
  const t = useTranslations("commandPalette");

  if (rankedOverride) {
    // Filtered flat list
    return (
      <List id={listboxId} role="listbox" aria-label={t("inputAriaLabel")} sx={{ py: 0 }}>
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
  return (
    <List id={listboxId} role="listbox" aria-label={t("inputAriaLabel")} sx={{ py: 0 }}>
      {GROUP_ORDER.map((group) => {
        const groupCommands = defaultRows.filter((c) => c.group === group);
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
