import Alert, { type AlertProps } from "@mui/material/Alert";

export const COMPACT_ALERT_SX = {
  py: 0,
  "& .MuiAlert-action": {
    alignItems: "center",
    pt: 0,
  },
} as const;

export function CompactAlert({ sx, ...props }: AlertProps) {
  return <Alert {...props} sx={[COMPACT_ALERT_SX, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]} />;
}
