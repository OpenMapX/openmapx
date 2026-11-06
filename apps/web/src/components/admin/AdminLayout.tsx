"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useBindAdminDraftOwner } from "@/lib/admin/AdminDraftProvider";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { adminWorkspaceForPath } from "@/lib/admin/adminNavigation";
import { useHydrated } from "@/lib/useHydrated";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopBar } from "./AdminTopBar";
import { TOPBAR_HEIGHT } from "./layoutConstants";
import { AdminThemeProvider } from "./shared/AdminThemeProvider";
import { AdminToastProvider } from "./shared/AdminToast";
import { AdminTopicNavigation } from "./shared/AdminTopicNavigation";
import { SystemMaintenanceProvider } from "./system/SystemMaintenance";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  image?: string;
  role?: string;
}

interface AdminLayoutProps {
  children: React.ReactNode;
  user: AdminUser;
  selfHosted?: boolean | null;
}

export function AdminLayout(props: AdminLayoutProps) {
  return (
    <SystemMaintenanceProvider>
      <AdminLayoutContent {...props} />
    </SystemMaintenanceProvider>
  );
}
function AdminLayoutContent({ children, user, selfHosted = false }: AdminLayoutProps) {
  const { apiUrl } = useEnv();
  const workspace = adminWorkspaceForPath(usePathname());
  useBindAdminDraftOwner({ apiUrl, actorId: user.id, role: user.role ?? "admin" });
  const hydrated = useHydrated();
  const desktop = useMediaQuery("(min-width:900px)", { defaultMatches: true });
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarOpen = desktop ? desktopOpen : mobileOpen;
  const toggleSidebar = useCallback(() => {
    if (desktop) setDesktopOpen((value) => !value);
    else setMobileOpen((value) => !value);
  }, [desktop]);

  return (
    <AdminThemeProvider>
      <AdminToastProvider>
        <AdminJobEffectsProvider enabled={user.role === "admin"}>
          <Box
            className="omx-admin"
            sx={{ display: "flex", height: "100dvh", bgcolor: "background.default" }}
          >
            <AdminSidebar
              open={sidebarOpen}
              onClose={() => setMobileOpen(false)}
              selfHosted={selfHosted}
              role={user.role}
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
              <AdminTopBar
                user={user}
                selfHosted={selfHosted}
                sidebarOpen={sidebarOpen}
                onToggleSidebar={toggleSidebar}
              />
              <Box
                sx={{
                  flexGrow: 1,
                  mt: `calc(${TOPBAR_HEIGHT}px + var(--omx-safe-top))`,
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
                  {hydrated ? (
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: { xs: "column", lg: "row" },
                        gap: { xs: 1, lg: 2.5 },
                        alignItems: "flex-start",
                      }}
                    >
                      {workspace && (
                        <AdminTopicNavigation
                          workspace={workspace}
                          role={user.role}
                          selfHosted={selfHosted}
                        />
                      )}
                      <Box sx={{ flex: 1, width: "100%", minWidth: 0 }}>{children}</Box>
                    </Box>
                  ) : (
                    <Box
                      role="status"
                      aria-label="Loading administration"
                      sx={{ display: "flex", justifyContent: "center", py: 6 }}
                    >
                      <CircularProgress size={24} />
                    </Box>
                  )}
                </Box>
              </Box>
            </Box>
          </Box>
        </AdminJobEffectsProvider>
      </AdminToastProvider>
    </AdminThemeProvider>
  );
}
