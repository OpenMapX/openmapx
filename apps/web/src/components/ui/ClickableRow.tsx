import ButtonBase, { type ButtonBaseProps } from "@mui/material/ButtonBase";

/**
 * A row or tile that does one thing when activated. It renders a native
 * button, so it is focusable, Enter and Space activate it, and assistive
 * technology announces it as a button. Keyboard focus shows a ring.
 *
 * A button cannot contain other interactive elements. Put trailing actions,
 * such as an overflow menu, beside the row in a flex container instead of
 * inside it; they then follow the row in the tab order.
 */
export function ClickableRow({ sx, focusRipple = true, ...props }: ButtonBaseProps) {
  return (
    <ButtonBase
      focusRipple={focusRipple}
      sx={[
        {
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          width: "100%",
          minWidth: 0,
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          borderRadius: 1,
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...props}
    />
  );
}
