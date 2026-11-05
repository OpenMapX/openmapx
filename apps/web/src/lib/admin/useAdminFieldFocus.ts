"use client";
import { useEffect } from "react";
/** Public field IDs only; never changes form values or starts an operation. */
export function useAdminFieldFocus(key: string | undefined, ready: boolean) {
  useEffect(() => {
    if (!ready || !key) return;
    const timer = setTimeout(() => {
      const field = document.getElementById(`setting-${key}`);
      field?.scrollIntoView?.({ block: "center" });
      const input = field?.matches("input,textarea,button,[role=combobox]")
        ? field
        : field?.querySelector<HTMLElement>("input,textarea,button,[role=combobox]");
      input?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [key, ready]);
}
