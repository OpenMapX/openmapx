"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import useMediaQuery from "@mui/material/useMediaQuery";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useAdminDraftAuthority, useBindAdminDraftOwner } from "@/lib/admin/AdminDraftProvider";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { adminDestinationForPath, adminWorkspaceForPath } from "@/lib/admin/adminNavigation";
import { useHydrated } from "@/lib/useHydrated";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopBar } from "./AdminTopBar";
import { TOPBAR_HEIGHT } from "./layoutConstants";
import { PlatformPreviewLifecycle } from "./settings/PlatformPreviewLifecycle";
import { AdminNavigationContext } from "./shared/AdminNavigationContext";
import { AdminPageHeader } from "./shared/AdminPageHeader";
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
  const pathname = usePathname();
  const workspace = adminWorkspaceForPath(pathname);
  const destination = adminDestinationForPath(pathname);
  const hostUnavailable = destination?.hostOnly && selfHosted === false;
  const t = useTranslations("adminNavigation");
  useBindAdminDraftOwner({ apiUrl, actorId: user.id, role: user.role ?? "admin" });
  const authority = useAdminDraftAuthority();
  const authorized =
    !authority.present ||
    (authority.owner?.apiUrl === apiUrl &&
      authority.owner?.actorId === user.id &&
      authority.owner?.role === (user.role ?? "admin"));
  const visibleRole = authorized ? (user.role ?? "admin") : "";
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
    <AdminNavigationContext.Provider value={{ role: visibleRole, selfHosted }}>
      <AdminThemeProvider>
        <AdminToastProvider>
          <AdminJobEffectsProvider enabled={authorized && user.role === "admin"}>
            <Box
              className="omx-admin"
              sx={{ display: "flex", height: "100dvh", bgcolor: "background.default" }}
            >
              <PlatformPreviewLifecycle apiUrl={apiUrl} actorId={user.id} />
              <AdminSidebar
                open={sidebarOpen}
                onClose={() => setMobileOpen(false)}
                selfHosted={selfHosted}
                role={visibleRole}
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
                  user={{ ...user, role: visibleRole }}
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
                            role={visibleRole}
                            selfHosted={selfHosted}
                          />
                        )}
                        <Box sx={{ flex: 1, width: "100%", minWidth: 0 }}>
                          {!authorized ? (
                            <Alert
                              severity="warning"
                              action={
                                <Button onClick={() => window.location.reload()}>
                                  {t("reload")}
                                </Button>
                              }
                            >
                              {t("authorityChanged")}
                            </Alert>
                          ) : hostUnavailable && destination ? (
                            <Stack sx={{ gap: 2, maxWidth: 800 }}>
                              <AdminPageHeader title={t(`destinations.${destination.id}.label`)} />
                              <Alert severity="info">{t("hostUnavailable")}</Alert>
                              <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
                                <Button component={Link} href="/admin/system/cache">
                                  {t("destinations.cache.label")}
                                </Button>
                                <Button
                                  component={Link}
                                  href="/admin/system/configuration-transfer"
                                >
                                  {t("destinations.configuration-transfer.label")}
                                </Button>
                              </Stack>
                            </Stack>
                          ) : (
                            children
                          )}
                        </Box>
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
    </AdminNavigationContext.Provider>
  );
}
