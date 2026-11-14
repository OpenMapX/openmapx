import useMediaQuery from "@mui/material/useMediaQuery";

/** A mouse or trackpad that can hover, as opposed to a touch screen. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

/** Whether the primary pointer is a mouse or trackpad. */
export function useFinePointer(): boolean {
  return useMediaQuery(FINE_POINTER_QUERY, { noSsr: true });
}
