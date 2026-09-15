import Box from "@mui/material/Box";
import type { Metadata } from "next";
import StatusDashboard from "./StatusDashboard";

export const metadata: Metadata = {
  title: "System Status — OpenMapX",
  robots: "noindex",
};

export default function StatusPage() {
  return (
    <Box sx={{ height: "100dvh", overflow: "auto", bgcolor: "background.default", px: 2, py: 4 }}>
      <StatusDashboard />
    </Box>
  );
}
