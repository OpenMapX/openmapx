import Box from "@mui/material/Box";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        // Root body is h-dvh + overflow-hidden, so this layout owns its own
        // scroll container — otherwise long lists (offline areas) clip below
        // the viewport with no way to reach them.
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
        pt: "var(--omx-safe-top)",
        pb: "var(--omx-safe-bottom)",
      }}
    >
      {/* Each page brings its own header (SettingsPageHeader), which sticks
          to the top of this scroll container. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</Box>
    </Box>
  );
}
