"use client";

import ActivityIcon from "@mui/icons-material/Assessment";
import ComposeIcon from "@mui/icons-material/Code";
import OverviewIcon from "@mui/icons-material/Dashboard";
import ServicesIcon from "@mui/icons-material/Dns";
import IntegrationsIcon from "@mui/icons-material/Extension";
import CatalogIcon from "@mui/icons-material/GridView";
import CacheIcon from "@mui/icons-material/LayersClear";
import PoiIcon from "@mui/icons-material/LocationOn";
import UsersIcon from "@mui/icons-material/People";
import BackupIcon from "@mui/icons-material/Restore";
import SettingsIcon from "@mui/icons-material/Settings";
import DataIcon from "@mui/icons-material/Storage";
import StoreIcon from "@mui/icons-material/Store";
import SystemUpdateIcon from "@mui/icons-material/SystemUpdateAlt";
import TransitIcon from "@mui/icons-material/Train";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TOPBAR_HEIGHT } from "./AdminTopBar";

export const SIDEBAR_WIDTH = 236;

const SERVICES_SUB_ITEMS = [
  {
    label: "Catalog",
    href: "/admin/services",
    icon: <CatalogIcon fontSize="small" />,
    exact: true,
  },
  {
    label: "Compose preview",
    href: "/admin/services/compose",
    icon: <ComposeIcon fontSize="small" />,
  },
  {
    label: "Data workflows",
    href: "/admin/services/data",
    icon: <DataIcon fontSize="small" />,
  },
  {
    label: "Backups",
    href: "/admin/services/backups",
    icon: <BackupIcon fontSize="small" />,
  },
] as const;

const BASE_NAV_ITEMS = [
  {
    label: "Overview",
    href: "/admin",
    icon: <OverviewIcon fontSize="small" />,
    exact: true,
    selfHostedOnly: false,
  },
  {
    label: "Users",
    href: "/admin/users",
    icon: <UsersIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Integrations",
    href: "/admin/integrations",
    icon: <IntegrationsIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Extensions",
    href: "/admin/extensions",
    icon: <StoreIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Services",
    href: "/admin/services",
    icon: <ServicesIcon fontSize="small" />,
    selfHostedOnly: true,
  },
  {
    label: "Transit",
    href: "/admin/transit",
    icon: <TransitIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "POI ingest",
    href: "/admin/poi-ingest",
    icon: <PoiIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Activity",
    href: "/admin/activity",
    icon: <ActivityIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Settings",
    href: "/admin/settings",
    icon: <SettingsIcon fontSize="small" />,
    selfHostedOnly: false,
  },
  {
    label: "Maintenance",
    href: "/admin/system",
    icon: <SystemUpdateIcon fontSize="small" />,
    selfHostedOnly: true,
  },
  {
    label: "Cache",
    href: "/admin/cache",
    icon: <CacheIcon fontSize="small" />,
    selfHostedOnly: false,
  },
] as const;

type NavItem = (typeof BASE_NAV_ITEMS)[number];

const NAV_GROUPS = [
  { label: "Manage", hrefs: ["/admin", "/admin/users"] },
  { label: "Platform", hrefs: ["/admin/integrations", "/admin/extensions"] },
  {
    label: "Operations",
    hrefs: [
      "/admin/services",
      "/admin/transit",
      "/admin/poi-ingest",
      "/admin/activity",
      "/admin/cache",
    ],
  },
  { label: "System", hrefs: ["/admin/settings", "/admin/system"] },
] as const;

interface AdminSidebarProps {
  open: boolean;
  onClose: () => void;
  selfHosted?: boolean;
}

function NavLink({
  item,
  active,
  sectionActive = false,
}: {
  item: NavItem;
  active: boolean;
  /**
   * True when this entry is the parent of an active sub-item but not itself
   * the deepest match. Renders as a muted "section header" (bold text, no
   * filled pill) so the active sub-item below stays the visual focus instead
   * of stacking two identical pills.
   */
  sectionActive?: boolean;
}) {
  // The leaf (Mui-selected) styling and the section-active styling are
  // mutually exclusive — `selected` flips MUI's filled background, which is
  // what we explicitly want to avoid for `sectionActive`.
  const showFilled = active && !sectionActive;
  return (
    <ListItem disablePadding>
      <ListItemButton
        component={Link}
        href={item.href}
        selected={showFilled}
        aria-current={showFilled ? "page" : undefined}
        sx={{
          minHeight: 38,
          borderRadius: 2,
          mx: 1,
          px: 1.25,
          color: "text.secondary",
          ...(sectionActive && {
            color: "primary.main",
            "& .MuiListItemIcon-root": { color: "primary.main" },
          }),
          "&.Mui-selected": {
            bgcolor: "action.selected",
            color: "primary.main",
            "& .MuiListItemIcon-root": { color: "inherit" },
            "&:hover": { bgcolor: "action.selected" },
          },
        }}
      >
        <ListItemIcon sx={{ minWidth: 34, color: "inherit" }}>{item.icon}</ListItemIcon>
        <ListItemText
          primary={item.label}
          slotProps={{
            primary: {
              sx: { fontSize: 14, fontWeight: active || sectionActive ? 600 : 400 },
            },
          }}
        />
      </ListItemButton>
    </ListItem>
  );
}

type SubItem = (typeof SERVICES_SUB_ITEMS)[number];

function SubNavLink({ item, active }: { item: SubItem; active: boolean }) {
  return (
    <ListItem disablePadding>
      <ListItemButton
        component={Link}
        href={item.href}
        selected={active}
        aria-current={active ? "page" : undefined}
        sx={{
          minHeight: 34,
          borderRadius: 2,
          mx: 1,
          pl: 4.75,
          color: "text.secondary",
          "&.Mui-selected": {
            bgcolor: "action.selected",
            color: "primary.main",
            "& .MuiListItemIcon-root": { color: "inherit" },
            "&:hover": { bgcolor: "action.selected" },
          },
        }}
      >
        <ListItemIcon sx={{ minWidth: 30 }}>{item.icon}</ListItemIcon>
        <ListItemText
          primary={item.label}
          slotProps={{ primary: { sx: { fontSize: 13, fontWeight: active ? 600 : 400 } } }}
        />
      </ListItemButton>
    </ListItem>
  );
}

export function AdminSidebar({ open, onClose, selfHosted = false }: AdminSidebarProps) {
  const pathname = usePathname();

  const navItems = BASE_NAV_ITEMS.filter((item) => !item.selfHostedOnly || selfHosted);

  const isActive = (item: NavItem) => {
    if ("exact" in item && item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  };

  const isSubActive = (item: SubItem) => {
    if ("exact" in item && item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  };

  const servicesExpanded = selfHosted && pathname.startsWith("/admin/services");

  const drawerContent = (
    <>
      <Toolbar sx={{ gap: 1.25, px: 2, minHeight: `${TOPBAR_HEIGHT}px !important` }}>
        <Box
          sx={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 2,
            bgcolor: "primary.main",
            color: "primary.contrastText",
          }}
        >
          <OverviewIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 750, lineHeight: 1.2 }}>
            OpenMapX
          </Typography>
          <Typography variant="caption" noWrap sx={{ color: "text.secondary", lineHeight: 1.2 }}>
            Administration
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <List dense sx={{ py: 1, flex: 1, overflowY: "auto" }}>
        {NAV_GROUPS.map((group) => {
          const groupItems = navItems.filter((item) =>
            (group.hrefs as readonly string[]).includes(item.href),
          );
          if (groupItems.length === 0) return null;
          return (
            <Box key={group.label} sx={{ mb: 0.75 }}>
              <Typography
                component="div"
                variant="caption"
                sx={{
                  px: 2.25,
                  pt: 1,
                  pb: 0.5,
                  color: "text.disabled",
                  fontSize: "0.6875rem",
                  fontWeight: 750,
                  letterSpacing: "0.075em",
                  textTransform: "uppercase",
                }}
              >
                {group.label}
              </Typography>
              {groupItems.map((item) => {
                const hasActiveChild =
                  item.href === "/admin/services" &&
                  selfHosted &&
                  SERVICES_SUB_ITEMS.some(isSubActive);
                return (
                  <Box key={item.href}>
                    <NavLink item={item} active={isActive(item)} sectionActive={hasActiveChild} />
                    {item.href === "/admin/services" && selfHosted && (
                      <Collapse in={servicesExpanded} timeout="auto" unmountOnExit>
                        <List dense disablePadding>
                          {SERVICES_SUB_ITEMS.map((sub) => (
                            <SubNavLink key={sub.href} item={sub} active={isSubActive(sub)} />
                          ))}
                        </List>
                      </Collapse>
                    )}
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </List>
    </>
  );

  return (
    <Box
      component="nav"
      sx={{
        width: { md: open ? SIDEBAR_WIDTH : 0 },
        flexShrink: { md: 0 },
        transition: "width 225ms cubic-bezier(0.4, 0, 0.6, 1) 0ms",
      }}
    >
      {/* Mobile drawer */}
      <Drawer
        variant="temporary"
        open={open}
        onClose={onClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "block", md: "none" },
          "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH, boxSizing: "border-box" },
        }}
      >
        {drawerContent}
      </Drawer>
      {/* Desktop permanent drawer */}
      <Drawer
        variant="persistent"
        open={open}
        sx={{
          display: { xs: "none", md: "block" },
          "& .MuiDrawer-paper": {
            width: SIDEBAR_WIDTH,
            boxSizing: "border-box",
            bgcolor: "background.paper",
            borderRight: "1px solid",
            borderColor: "divider",
          },
        }}
      >
        {drawerContent}
      </Drawer>
    </Box>
  );
}
