"use client";

import Box from "@mui/material/Box";
import { useCallback, useEffect, useState } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopBar, TOPBAR_HEIGHT } from "./AdminTopBar";
import { AdminThemeProvider } from "./shared/AdminThemeProvider";
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

  // Keep the navigation modal below the desktop breakpoint. SSR has no
  // viewport information, so reconcile the initial state after mount.
  useEffect(() => {
    if (!window.matchMedia("(min-width:900px)").matches) setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  return (
    <AdminThemeProvider>
      <AdminToastProvider>
        <Box
          className="omx-admin"
          sx={{ display: "flex", height: "100dvh", bgcolor: "background.default" }}
        >
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
                overflowY: "auto",
              }}
            >
              <Box
                sx={{
                  width: "100%",
                  maxWidth: 1536,
                  mx: "auto",
                  px: { xs: 1.5, sm: 2, lg: 3 },
                  py: { xs: 2, lg: 2.5 },
                }}
              >
                {children}
              </Box>
            </Box>
          </Box>
        </Box>
      </AdminToastProvider>
    </AdminThemeProvider>
  );
}
