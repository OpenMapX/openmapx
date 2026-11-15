"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Box from "@mui/material/Box";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { type ReactNode, useId, useState } from "react";
import Dialog from "@/components/ui/Dialog";

/**
 * Settings follow the native settings-list pattern: each row is a label with
 * its current value or explanation underneath, a switch where the setting is
 * on or off, and a picker dialog where it is one of several values.
 */

const ROW_SX = { px: 3, py: 1.25, alignItems: "center" } as const;
const SECONDARY_SX = { sx: { color: "text.secondary", fontSize: 14 } } as const;

/**
 * A titled group of settings, in the brand colour like a native preference
 * category. Rows run edge to edge; `inset` aligns the title with content that
 * sits inside the dialog's own padding instead, such as a form.
 */
export function Section({
  title,
  children,
  inset = false,
}: {
  title: string;
  children: ReactNode;
  inset?: boolean;
}) {
  return (
    <Box component="section" sx={{ pt: 1.5, pb: 0.5 }}>
      <Typography
        component="h3"
        sx={{ px: inset ? 0 : 3, pb: 0.5, fontSize: 14, fontWeight: 600, color: "primary.main" }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** An on/off setting: the whole row toggles, and the explanation sits under the label. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <ListItemButton
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      sx={ROW_SX}
    >
      <ListItemText
        primary={label}
        secondary={description}
        slotProps={{
          primary: { id: labelId },
          secondary: { ...SECONDARY_SX, id: descriptionId },
        }}
        sx={{ mr: 2 }}
      />
      {/* Decorative: the row is the control. */}
      <Switch edge="end" checked={checked} disabled={disabled} tabIndex={-1} aria-hidden />
    </ListItemButton>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/**
 * One of several values: the row shows the current one, and tapping it opens
 * a dialog of radio options that applies the choice as soon as it is made.
 */
export function ChoiceRow<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (next: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const current = choices.find((choice) => choice.value === value)?.label ?? value;
  return (
    <>
      <ListItemButton aria-haspopup="dialog" onClick={() => setOpen(true)} sx={ROW_SX}>
        <ListItemText primary={label} secondary={current} slotProps={{ secondary: SECONDARY_SX }} />
      </ListItemButton>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby={titleId}
        slotProps={{ paper: { sx: { borderRadius: "28px" } } }}
      >
        <DialogTitle id={titleId}>{label}</DialogTitle>
        <DialogContent sx={{ px: 2 }}>
          <RadioGroup
            aria-labelledby={titleId}
            value={value}
            onChange={(event) => {
              onChange(event.target.value as T);
              setOpen(false);
            }}
          >
            {choices.map((choice) => (
              <FormControlLabel
                key={choice.value}
                value={choice.value}
                control={<Radio />}
                label={choice.label}
                sx={{ mx: 0, py: 0.25 }}
              />
            ))}
          </RadioGroup>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A row that opens a further page of settings. */
export function LinkRow({
  label,
  description,
  onClick,
}: {
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <ListItemButton onClick={onClick} sx={ROW_SX}>
      <ListItemText
        primary={label}
        secondary={description}
        slotProps={{ secondary: SECONDARY_SX }}
      />
      <ChevronRightIcon sx={{ color: "text.secondary" }} />
    </ListItemButton>
  );
}

/** A row for a one-off action, such as playing a voice sample, with what it does underneath. */
export function ActionRow({
  label,
  description,
  onClick,
  disabled = false,
}: {
  label: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <ListItemButton
      onClick={onClick}
      disabled={disabled}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      sx={ROW_SX}
    >
      <ListItemText
        primary={label}
        secondary={description}
        slotProps={{
          primary: { id: labelId, sx: { color: "primary.main" } },
          secondary: { ...SECONDARY_SX, id: descriptionId },
        }}
      />
    </ListItemButton>
  );
}

/** A row that shows a value: a label with the value at its end. */
export function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ ...ROW_SX, display: "flex", gap: 2, py: 1 }}>
      <Typography sx={{ flex: 1, minWidth: 0 }}>{label}</Typography>
      <Typography sx={{ color: "text.secondary" }}>{value}</Typography>
    </Box>
  );
}
