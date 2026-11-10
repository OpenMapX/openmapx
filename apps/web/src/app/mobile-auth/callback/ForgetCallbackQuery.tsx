"use client";

import { useEffect } from "react";

/** Drops the callback code and state from the address bar and session history. */
export function ForgetCallbackQuery() {
  useEffect(() => {
    window.history.replaceState(null, "", "/mobile-auth/callback");
  }, []);
  return null;
}
