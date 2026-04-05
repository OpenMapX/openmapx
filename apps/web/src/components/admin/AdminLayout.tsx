"use client";

import Box from "@mui/material/Box";
import { useCallback, useEffect, useState } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopBar, TOPBAR_HEIGHT } from "./AdminTopBar";
import { AdminToastProvider } from "./shared/AdminToast";

interface AdminUser {
  name: string;
  email: string;
  image?: string;
  role?: string;
}

interface AdminLayoutProps {
  children: React.ReactNode;
  user: AdminUser;
  selfHosted?: boolean;
}

export function AdminLayout({ children, user, selfHosted = false }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // On mobile, close the sidebar after mount (SSR has no viewport info)
  useEffect(() => {
    if (!window.matchMedia("(min-width:600px)").matches) setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  return (
    <AdminToastProvider>
      <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
        <AdminSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          selfHosted={selfHosted}
        />
        <Box
          component="main"
          sx={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          <AdminTopBar user={user} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
          <Box
            sx={{
              flexGrow: 1,
              mt: `${TOPBAR_HEIGHT}px`,
              p: 3,
              overflowY: "auto",
            }}
          >
            {children}
          </Box>
        </Box>
      </Box>
    </AdminToastProvider>
  );
}
