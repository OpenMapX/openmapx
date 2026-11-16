/**
 * Off-screen but readable by assistive technology. The sizes are explicit
 * strings because `sx` reads a bare `1` as 100%.
 */
export const VISUALLY_HIDDEN = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  width: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
} as const;
