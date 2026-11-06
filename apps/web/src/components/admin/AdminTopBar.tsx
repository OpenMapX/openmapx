"use client";

import MapIcon from "@mui/icons-material/Map";
import MenuIcon from "@mui/icons-material/Menu";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import IconButton from "@mui/material/IconButton";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { getInitials, proxyImageUrl } from "@openmapx/core";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type AdminNavigationAccess,
  adminDestinationForPath,
  adminPrimaryNavigation,
  adminWorkspaceForPath,
} from "@/lib/admin/adminNavigation";
import { AdminDraftSummary } from "./AdminDraftSummary";
import { AdminSearch } from "./AdminSearch";
import { AdminJobTray } from "./activity/AdminJobTray";
import { SIDEBAR_WIDTH, TOPBAR_HEIGHT } from "./layoutConstants";

interface AdminTopBarProps {
  user: { id: string; name: string; email: string; image?: string; role?: string };
  selfHosted?: boolean | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}
function useBreadcrumbs(access: AdminNavigationAccess): { label: string; href: string }[] {
  const pathname = usePathname();
  const t = useTranslations("adminNavigation");
  const workspace = adminWorkspaceForPath(pathname);
  const topic = adminDestinationForPath(pathname);
  const primary = adminPrimaryNavigation(access).find((entry) => entry.workspace === workspace);
  const crumbs = [{ label: t("administration"), href: "/admin" }];
  if (primary && workspace !== "overview")
    crumbs.push({ label: t(`primary.${workspace}`), href: primary.href });
  if (topic && topic.href !== primary?.href)
    crumbs.push({ label: t(`destinations.${topic.id}.label`), href: topic.href });
  if (topic && pathname.startsWith(`${topic.href}/`)) {
    let label = pathname.slice(topic.href.length + 1);
    try {
      label = decodeURIComponent(label);
    } catch {
      label = "Detail";
    }
    crumbs.push({ label, href: pathname });
  }
  return crumbs;
}

export function AdminTopBar({ user, selfHosted, sidebarOpen, onToggleSidebar }: AdminTopBarProps) {
  const breadcrumbs = useBreadcrumbs({ role: user.role, selfHosted });
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        color: "text.primary",
        pt: "var(--omx-safe-top)",
        width: { md: sidebarOpen ? `calc(100% - ${SIDEBAR_WIDTH}px)` : "100%" },
        ml: { md: sidebarOpen ? `${SIDEBAR_WIDTH}px` : 0 },
        transition:
          "width 225ms cubic-bezier(0.4, 0, 0.6, 1) 0ms, margin 225ms cubic-bezier(0.4, 0, 0.6, 1) 0ms",
        zIndex: (theme) => theme.zIndex.drawer - 1,
      }}
    >
      <Toolbar sx={{ gap: 1, px: { xs: 1.5, sm: 2 }, minHeight: `${TOPBAR_HEIGHT}px !important` }}>
        <IconButton
          edge="start"
          onClick={onToggleSidebar}
          size="small"
          aria-label="Toggle navigation"
          aria-expanded={sidebarOpen}
        >
          <MenuIcon />
        </IconButton>

        <Breadcrumbs
          aria-label="Breadcrumb"
          maxItems={3}
          sx={{
            flex: 1,
            minWidth: 0,
            "& .MuiBreadcrumbs-ol": { flexWrap: "nowrap" },
          }}
        >
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return isLast ? (
              <Typography
                key={crumb.href}
                variant="body2"
                sx={{
                  color: "text.primary",
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: { xs: 110, sm: 260 },
                }}
              >
                {crumb.label}
              </Typography>
            ) : (
              <Typography
                key={crumb.href}
                variant="body2"
                component={Link}
                href={crumb.href}
                sx={{
                  color: "text.secondary",
                  textDecoration: "none",
                  "&:hover": { textDecoration: "underline" },
                }}
              >
                {crumb.label}
              </Typography>
            );
          })}
        </Breadcrumbs>

        {user.role === "admin" && (
          <>
            <AdminSearch role={user.role} selfHosted={selfHosted} actorId={user.id} />
            <AdminDraftSummary />
            <AdminJobTray />
          </>
        )}
        <Tooltip title="Back to Map">
          <IconButton
            component={Link}
            href="/"
            size="small"
            color="inherit"
            aria-label="Back to map"
          >
            <MapIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title={`${user.name} · ${user.email}`}>
          <Avatar
            src={avatarSrc}
            alt={user.name}
            sx={{
              display: { xs: "none", sm: "flex" },
              width: 32,
              height: 32,
              fontSize: 13,
              fontWeight: 500,
              bgcolor: "primary.main",
            }}
          >
            {!user.image && getInitials(user.name, user.email)}
          </Avatar>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
