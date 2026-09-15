import Box from "@mui/material/Box";

export default function MapLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {children}
    </Box>
  );
}
