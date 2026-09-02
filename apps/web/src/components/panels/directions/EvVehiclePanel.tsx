"use client";

import Autocomplete, { autocompleteClasses, createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Popper from "@mui/material/Popper";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import { styled } from "@mui/material/styles";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useDirectionsStore, useSettingsStore, useVehicles } from "@openmapx/core";
import { COMMON_EV_NETWORKS, listVehicles } from "@openmapx/ev-charge-planner";
import { useTranslations } from "next-intl";
import { forwardRef, type HTMLAttributes, type SyntheticEvent, useMemo, useState } from "react";
import { List, type ListImperativeAPI, type RowComponentProps, useListRef } from "react-window";
import { VehiclesDialog } from "@/components/settings/VehiclesDialog";
import { BRAND } from "@/integration-api/runtime/theme";
import { garageVehicleId } from "@/lib/buildEvDirectionsRequest";

const HOME_CURRENCIES = ["EUR", "USD", "GBP", "CHF"];

interface VehicleOption {
  id: string;
  label: string;
  /** Group heading the option sits under; garage vehicles share their own. */
  make: string;
}

const VEHICLE_OPTIONS = listVehicles();

// Deliberately uncapped. A limit truncates the *unfiltered* list too, and with
// 51 Audis alphabetically first, any screenful-sized cap makes the picker look
// like it only stocks Audi. Typing narrows it immediately, and the listbox is
// virtualized, so the full list costs a screenful of DOM either way.
const filterVehicleOptions = createFilterOptions<VehicleOption>();

/** Vertical padding MUI puts on the listbox; rows are absolutely positioned inside it. */
const LISTBOX_PADDING = 8;
const OPTION_ROW_HEIGHT = 36;
const GROUP_HEADER_HEIGHT = 38;
const MAX_VISIBLE_ROWS = 8;

/** A group heading, as handed to `renderGroup`. */
interface GroupRow {
  key: string | number;
  group: string;
  children?: React.ReactNode;
}

/** An option, as handed to `renderOption`: its DOM props plus the option itself. */
type OptionRow = [HTMLAttributes<HTMLLIElement> & { key?: string }, VehicleOption];

type ListboxRow = GroupRow | OptionRow;

function isGroupRow(row: ListboxRow): row is GroupRow {
  return !Array.isArray(row);
}

function rowHeight(row: ListboxRow): number {
  return isGroupRow(row) ? GROUP_HEADER_HEIGHT : OPTION_ROW_HEIGHT;
}

/**
 * One virtualized row: either a make heading or a vehicle. `noWrap` keeps every
 * option exactly one line tall, which is what lets the heights above be fixed.
 */
function VehicleRow({ index, rows, style }: RowComponentProps<{ rows: ListboxRow[] }>) {
  const row = rows[index];
  const rowStyle = { ...style, top: (Number(style.top) || 0) + LISTBOX_PADDING };
  if (isGroupRow(row)) {
    return (
      <ListSubheader component="div" style={rowStyle}>
        {row.group}
      </ListSubheader>
    );
  }
  const [{ key, ...optionProps }, option] = row;
  return (
    <Typography key={key} component="li" {...optionProps} noWrap style={rowStyle}>
      {option.label}
    </Typography>
  );
}

interface VehicleListboxProps extends HTMLAttributes<HTMLElement> {
  /** Forwarded to react-window so keyboard highlighting can scroll the window. */
  virtualListRef: React.RefObject<ListImperativeAPI | null>;
  /** Filled on every render with option id -> flat row index, for the same reason. */
  rowIndexById: Map<string, number>;
}

/**
 * Renders the 1091-entry option list through react-window so only a screenful
 * of rows is ever mounted. `renderGroup`/`renderOption` on the Autocomplete
 * below hand their arguments straight through instead of producing elements,
 * so `children` here is the raw group/option tree; flattening it gives the
 * virtualizer one array with headings and options interleaved.
 */
const VehicleListbox = forwardRef<HTMLDivElement, VehicleListboxProps>(function VehicleListbox(
  { children, className, virtualListRef, rowIndexById, style: _style, ...other },
  ref,
) {
  const rows: ListboxRow[] = [];
  for (const child of children as unknown as ListboxRow[]) {
    rows.push(child);
    if (isGroupRow(child) && Array.isArray(child.children)) {
      rows.push(...(child.children as ListboxRow[]));
    }
  }

  rowIndexById.clear();
  rows.forEach((row, index) => {
    if (!isGroupRow(row)) rowIndexById.set(row[1].id, index);
  });

  const contentHeight = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  const height =
    Math.min(contentHeight, MAX_VISIBLE_ROWS * OPTION_ROW_HEIGHT) + 2 * LISTBOX_PADDING;

  return (
    <div ref={ref} {...other}>
      <List
        className={className}
        listRef={virtualListRef}
        rowCount={rows.length}
        rowHeight={(index) => rowHeight(rows[index])}
        rowComponent={VehicleRow}
        rowProps={{ rows }}
        // A numeric height keeps react-window off ResizeObserver entirely, so
        // rows render under jsdom as well as in the browser.
        style={{ height, width: "100%" }}
        overscanCount={5}
        tagName="ul"
      />
    </div>
  );
});

/** The listbox class lands on the inner scroller, so its box has to include the padding. */
const VehiclePopper = styled(Popper)({
  [`& .${autocompleteClasses.listbox}`]: {
    boxSizing: "border-box",
    "& ul": { padding: 0, margin: 0 },
  },
});

/**
 * EV trip inputs: vehicle + state-of-charge, network preferences,
 * cheaper-charging bias and home electricity price. Persisted
 * fields (`vehicleId`, `socTargetPct`, network prefs, `preferCheaper`, home
 * price/currency) live in the settings store like other user prefs;
 * `socStartPct`/`socArrivalMinPct` are transient (in-memory only) in the
 * directions store, since the current battery level changes every trip.
 */
export function EvVehiclePanel() {
  const t = useTranslations("directions.ev");
  const tVehicles = useTranslations("vehicles");

  const evSocStartPct = useDirectionsStore((s) => s.evSocStartPct);
  const setEvSocStartPct = useDirectionsStore((s) => s.setEvSocStartPct);
  const evSocArrivalMinPct = useDirectionsStore((s) => s.evSocArrivalMinPct);
  const setEvSocArrivalMinPct = useDirectionsStore((s) => s.setEvSocArrivalMinPct);

  const evVehicleId = useSettingsStore((s) => s.evVehicleId);
  const setEvVehicleId = useSettingsStore((s) => s.setEvVehicleId);
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const setEvSocTargetPct = useSettingsStore((s) => s.setEvSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const setEvPreferredNetworks = useSettingsStore((s) => s.setEvPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const setEvAvoidedNetworks = useSettingsStore((s) => s.setEvAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const setEvExclusiveNetworks = useSettingsStore((s) => s.setEvExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const setEvPreferCheaper = useSettingsStore((s) => s.setEvPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const setEvHomePricePerKwh = useSettingsStore((s) => s.setEvHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);
  const setEvHomeCurrency = useSettingsStore((s) => s.setEvHomeCurrency);
  const { data: garageVehicles } = useVehicles();
  const [garageOpen, setGarageOpen] = useState(false);

  // Garage entries have no manufacturer, so they form their own leading group:
  // `groupBy` only chunks consecutive options, it never reorders them.
  const options = useMemo<VehicleOption[]>(
    () => [
      ...(garageVehicles ?? [])
        .filter((vehicle) => vehicle.ev !== null)
        .map((vehicle) => ({
          id: garageVehicleId(vehicle.id),
          label: vehicle.name,
          make: tVehicles("myVehicles"),
        })),
      ...VEHICLE_OPTIONS,
    ],
    [garageVehicles, tVehicles],
  );

  // Virtualization means the highlighted option may not be mounted, so MUI's own
  // scroll-into-view cannot reach it; scroll the window by row index instead.
  const virtualListRef = useListRef(null);
  const rowIndexById = useMemo(() => new Map<string, number>(), []);
  const scrollToHighlighted = (_event: SyntheticEvent, option: VehicleOption | null) => {
    const index = option ? rowIndexById.get(option.id) : undefined;
    if (index !== undefined) virtualListRef.current?.scrollToRow({ index, align: "auto" });
  };

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Autocomplete
        size="small"
        options={options}
        filterOptions={filterVehicleOptions}
        getOptionLabel={(o) => o.label}
        // Keyed by id, not by the default label key: the id is the stable
        // identity even if two dataset entries ever share a display name again.
        getOptionKey={(o) => o.id}
        isOptionEqualToValue={(o, v) => o.id === v.id}
        groupBy={(o) => o.make}
        value={options.find((o) => o.id === evVehicleId) ?? null}
        onChange={(_event, option) => setEvVehicleId(option?.id ?? null)}
        onHighlightChange={scrollToHighlighted}
        // Wrapping from the last option back to the first would jump the virtual
        // window a thousand rows; MUI's own virtualization guidance disables it.
        disableListWrap
        // Both render props hand their arguments back untouched — the listbox
        // component builds the actual rows once it has flattened them.
        renderGroup={(params) => params as unknown as React.ReactNode}
        renderOption={(props, option) => [props, option] as unknown as React.ReactNode}
        slots={{ popper: VehiclePopper }}
        slotProps={{
          listbox: {
            component: VehicleListbox,
            virtualListRef,
            rowIndexById,
          } as never,
        }}
        renderInput={(params) => (
          <TextField {...params} label={t("vehicle")} variant="outlined" size="small" />
        )}
      />

      <Box sx={{ display: "flex", gap: 1.5 }}>
        <TextField
          size="small"
          type="number"
          label={t("batteryStart")}
          value={evSocStartPct}
          onChange={(e) => setEvSocStartPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
        <TextField
          size="small"
          type="number"
          label={t("socTarget")}
          value={evSocTargetPct}
          onChange={(e) => setEvSocTargetPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
        <TextField
          size="small"
          type="number"
          label={t("socArrivalMin")}
          value={evSocArrivalMinPct}
          onChange={(e) => setEvSocArrivalMinPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
      </Box>

      <Button size="small" onClick={() => setGarageOpen(true)}>
        {tVehicles("add")}
      </Button>
      <VehiclesDialog open={garageOpen} onClose={() => setGarageOpen(false)} />

      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={COMMON_EV_NETWORKS}
        value={evPreferredNetworks}
        onChange={(_event, newValue) => setEvPreferredNetworks(newValue as string[])}
        renderInput={(params) => (
          <TextField {...params} label={t("preferredNetworks")} variant="outlined" size="small" />
        )}
      />

      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={COMMON_EV_NETWORKS}
        value={evAvoidedNetworks}
        onChange={(_event, newValue) => setEvAvoidedNetworks(newValue as string[])}
        renderInput={(params) => (
          <TextField {...params} label={t("avoidedNetworks")} variant="outlined" size="small" />
        )}
      />

      <FormControlLabel
        control={
          <Checkbox
            checked={evExclusiveNetworks}
            disabled={evPreferredNetworks.length === 0}
            onChange={(e) => setEvExclusiveNetworks(e.target.checked)}
            sx={{ color: BRAND, "&.Mui-checked": { color: BRAND } }}
          />
        }
        label={t("exclusiveNetworks")}
      />

      <FormControlLabel
        control={
          <Switch
            checked={evPreferCheaper}
            onChange={(e) => setEvPreferCheaper(e.target.checked)}
            sx={{ "& .MuiSwitch-switchBase.Mui-checked": { color: BRAND } }}
          />
        }
        label={t("preferCheaper")}
      />

      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
        <TextField
          size="small"
          type="number"
          label={t("homePrice")}
          value={evHomePricePerKwh ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setEvHomePricePerKwh(v === "" ? null : Math.max(0, Number(v)));
          }}
          helperText={t("homePriceHint")}
          slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
          fullWidth
        />
        <FormControl size="small" sx={{ minWidth: 90 }}>
          <InputLabel id="ev-home-currency-label">{t("currency")}</InputLabel>
          <Select
            labelId="ev-home-currency-label"
            label={t("currency")}
            value={evHomeCurrency}
            onChange={(e) => setEvHomeCurrency(e.target.value)}
          >
            {HOME_CURRENCIES.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
}

function clampPct(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(100, Math.max(0, v));
}
