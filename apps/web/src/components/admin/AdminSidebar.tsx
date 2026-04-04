"use client";

import ActivityIcon from "@mui/icons-material/Assessment";
import OverviewIcon from "@mui/icons-material/Dashboard";
import ServicesIcon from "@mui/icons-material/Dns";
import IntegrationsIcon from "@mui/icons-material/Extension";
import StatusIcon from "@mui/icons-material/MonitorHeart";
import UsersIcon from "@mui/icons-material/People";
import SettingsIcon from "@mui/icons-material/Settings";
import StoreIcon from "@mui/icons-material/Store";
import Box from "@mui/material/Box";
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
] as const;

type NavItem = (typeof BASE_NAV_ITEMS)[number];

interface AdminSidebarProps {
  open: boolean;
  onClose: () => void;
  selfHosted?: boolean;
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <ListItem disablePadding>
      <ListItemButton
        component={Link}
        href={item.href}
        selected={active}
        sx={{
          borderRadius: 1,
          mx: 1,
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
          primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 600 : 400 }}
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

  const drawerContent = (
    <>
      <Toolbar sx={{ px: 2, minHeight: `${TOPBAR_HEIGHT}px !important` }}>
        <Typography variant="subtitle2" fontWeight={700} color="text.secondary" noWrap>
          OpenMapX Admin
        </Typography>
      </Toolbar>
      <Divider />
      <List dense sx={{ pt: 1, flex: 1 }}>
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item)} />
        ))}
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
