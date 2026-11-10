"use client";

import { useAuthPromptStore } from "@/stores/authPromptStore";
import { AuthDialog } from "./AuthDialog";

/** The sign-in dialog requested through `useAuthPromptStore`. */
export function AuthPromptHost() {
  const open = useAuthPromptStore((state) => state.open);
  const close = useAuthPromptStore((state) => state.close);
  return <AuthDialog open={open} onClose={close} />;
}
