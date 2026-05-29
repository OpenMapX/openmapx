import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";

/**
 * Shared button shell for a result-list row (transit stops, category places,
 * data-source results). Renders a full-width left-aligned `<button>` with the
 * common reset + padding, an optional selected background, and a hover
 * background. Content (name, subtitle, extras) is passed as `children`.
 */
export function ResultListItem({
  onClick,
  onMouseEnter,
  onMouseLeave,
  selected,
  hoverBg,
  children,
}: {
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /**
   * Resting selected state. When provided, the resting background is
   * `selected ? hoverBg : "transparent"`. When omitted, no resting `bgcolor`
   * is set (the button's `background: "none"` applies), matching rows that
   * have no hover-tracking state.
   */
  selected?: boolean;
  /** Background color used on hover (and when `selected`). */
  hoverBg: string;
  children: React.ReactNode;
}) {
  const sx: SxProps<Theme> = {
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    cursor: "pointer",
    px: 2,
    py: 1.5,
    ...(selected !== undefined ? { bgcolor: selected ? hoverBg : "transparent" } : {}),
    "&:hover": { bgcolor: hoverBg },
  };

  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      sx={sx}
    >
      {children}
    </Box>
  );
}

/** Shared name line for a result-list row. */
export function ResultItemName({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.25 }}>
      {children}
    </Typography>
  );
}

/**
 * Renders result rows with a `<Divider sx={{ mx: 2 }} />` between consecutive
 * rows (matching the existing `{i > 0 && <Divider .../>}` pattern). Each item
 * is keyed by `getKey`.
 */
export function ResultList<T>({
  items,
  getKey,
  renderItem,
}: {
  items: T[];
  getKey: (item: T) => React.Key;
  renderItem: (item: T) => React.ReactNode;
}) {
  return (
    <>
      {items.map((item, i) => (
        <Box key={getKey(item)}>
          {i > 0 && <Divider sx={{ mx: 2 }} />}
          {renderItem(item)}
        </Box>
      ))}
    </>
  );
}
