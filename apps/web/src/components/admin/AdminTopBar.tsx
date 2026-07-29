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
import { SIDEBAR_WIDTH } from "./AdminSidebar";

export const TOPBAR_HEIGHT = 56;

const SEGMENT_LABELS: Record<string, string> = {
  admin: "Admin",
  users: "Users",
  integrations: "Integrations",
  store: "Store",
  services: "Services",
  data: "Data",
  status: "Status",
  activity: "Activity",
  settings: "Settings",
  cache: "Cache",
  sources: "Sources",
};

function labelForSegment(seg: string): string {
  if (SEGMENT_LABELS[seg]) return SEGMENT_LABELS[seg];
  // UUID → "Detail"
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "Detail";
  // kebab-case slug (e.g. integration ID) → title case
  if (seg.includes("-"))
    return seg
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

interface AdminTopBarProps {
  user: { name: string; email: string; image?: string };
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

function useBreadcrumbs(): { label: string; href: string }[] {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((seg, i) => ({
    label: labelForSegment(seg),
    href: `/${segments.slice(0, i + 1).join("/")}`,
  }));
}

export function AdminTopBar({ user, sidebarOpen, onToggleSidebar }: AdminTopBarProps) {
  const breadcrumbs = useBreadcrumbs();
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
