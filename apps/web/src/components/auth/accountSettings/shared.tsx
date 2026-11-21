import Typography from "@mui/material/Typography";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AccountMessage } from "../freshSignIn";

/** Sets the one status line the account dialog shows above its sections. */
export type SetAccountMessage = Dispatch<SetStateAction<AccountMessage | null>>;

export function AccountSectionTitle({
  children,
  danger,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <Typography
      variant="subtitle2"
      sx={{ fontWeight: 600, mb: 1.5, ...(danger ? { color: "error.main" } : {}) }}
    >
      {children}
    </Typography>
  );
}
