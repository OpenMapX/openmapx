"use client";

import { useState } from "react";

/**
 * True from the first render in which `open` is true, and from then on.
 *
 * Lets a rarely used dialog load on its first opening and then stay mounted,
 * so its close transition and in-dialog state behave as if it had always been
 * rendered. Uses React's "adjust state while rendering" pattern, so the
 * dialog renders in the same pass that opens it.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
