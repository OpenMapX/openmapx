"use client";

import ActivityIcon from "@mui/icons-material/Assessment";
import ComposeIcon from "@mui/icons-material/Code";
import OverviewIcon from "@mui/icons-material/Dashboard";
import ServicesIcon from "@mui/icons-material/Dns";
import IntegrationsIcon from "@mui/icons-material/Extension";
import CatalogIcon from "@mui/icons-material/GridView";
import CacheIcon from "@mui/icons-material/LayersClear";
import PoiIcon from "@mui/icons-material/LocationOn";
import StatusIcon from "@mui/icons-material/MonitorHeart";
import UsersIcon from "@mui/icons-material/People";
import BackupIcon from "@mui/icons-material/Restore";
import SettingsIcon from "@mui/icons-material/Settings";
import ReposIcon from "@mui/icons-material/Source";
import DataIcon from "@mui/icons-material/Storage";
import StoreIcon from "@mui/icons-material/Store";
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

export const SIDEBAR_WIDTH = 220;

const SERVICES_SUB_ITEMS = [
  {
    label: "Catalog",
    href: "/admin/services",
    icon: <CatalogIcon fontSize="small" />,
    exact: true,
  },
  { label: "Repositories", href: "/admin/services/repos", icon: <ReposIcon fontSize="small" /> },
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
    label: "Store",
    href: "/admin/store",
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
    label: "Status",
    href: "/admin/status",
    icon: <StatusIcon fontSize="small" />,
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
    label: "Cache",
    href: "/admin/cache",
    icon: <CacheIcon fontSize="small" />,
    selfHostedOnly: false,
  },
] as const;

type NavItem = (typeof BASE_NAV_ITEMS)[number];

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
        sx={{
          borderRadius: 1,
          mx: 1,
          ...(sectionActive && {
            color: "primary.main",
            "& .MuiListItemIcon-root": { color: "primary.main" },
          }),
          "&.Mui-selected": {
            bgcolor: "primary.main",
            color: "primary.contrastText",
            "& .MuiListItemIcon-root": { color: "inherit" },
            "&:hover": { bgcolor: "primary.dark" },
          },
        }}
      >
        <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
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
        sx={{
          borderRadius: 1,
          mx: 1,
          pl: 4,
          "&.Mui-selected": {
            bgcolor: "primary.main",
            color: "primary.contrastText",
            "& .MuiListItemIcon-root": { color: "inherit" },
            "&:hover": { bgcolor: "primary.dark" },
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
      <Toolbar sx={{ px: 2, minHeight: `${TOPBAR_HEIGHT}px !important` }}>
        <Typography
          variant="subtitle2"
          noWrap
          sx={{
            fontWeight: 700,
            color: "text.secondary",
          }}
        >
          OpenMapX Admin
        </Typography>
      </Toolbar>
      <Divider />
      <List dense sx={{ pt: 1, flex: 1 }}>
        {navItems.map((item) => {
          const hasActiveChild =
            item.href === "/admin/services" && selfHosted && SERVICES_SUB_ITEMS.some(isSubActive);
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
      </List>
    </>
  );

  return (
    <Box
      component="nav"
      sx={{
        width: { sm: open ? SIDEBAR_WIDTH : 0 },
        flexShrink: { sm: 0 },
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
          display: { xs: "block", sm: "none" },
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
          display: { xs: "none", sm: "block" },
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
