"use client";
import ActivityIcon from "@mui/icons-material/Assessment";
import OverviewIcon from "@mui/icons-material/Dashboard";
import SystemIcon from "@mui/icons-material/Dns";
import IntegrationsIcon from "@mui/icons-material/Extension";
import UsersIcon from "@mui/icons-material/People";
import PrivacyIcon from "@mui/icons-material/PrivacyTip";
import SettingsIcon from "@mui/icons-material/Settings";
import DataIcon from "@mui/icons-material/Storage";
import ExtensionsIcon from "@mui/icons-material/Store";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type AdminWorkspace,
  adminPrimaryNavigation,
  adminWorkspaceForPath,
} from "@/lib/admin/adminNavigation";
import { SIDEBAR_WIDTH, TOPBAR_HEIGHT } from "./layoutConstants";

const ICONS: Record<AdminWorkspace, React.ElementType> = {
  overview: OverviewIcon,
  integrations: IntegrationsIcon,
  extensions: ExtensionsIcon,
  data: DataIcon,
  users: UsersIcon,
  privacy: PrivacyIcon,
  activity: ActivityIcon,
  settings: SettingsIcon,
  system: SystemIcon,
};
interface AdminSidebarProps {
  open: boolean;
  onClose: () => void;
  selfHosted?: boolean | null;
  role?: string;
}
export function AdminSidebar({
  open,
  onClose,
  selfHosted = null,
  role = "admin",
}: AdminSidebarProps) {
  const pathname = usePathname();
  const desktop = useMediaQuery("(min-width:900px)", { defaultMatches: true });
  const t = useTranslations("adminNavigation");
  const active = adminWorkspaceForPath(pathname);
  const onNavigate = (event: React.MouseEvent) => {
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !window.matchMedia("(min-width:900px)").matches
    )
      onClose();
  };
  const drawerContent = (
    <>
      <Toolbar sx={{ gap: 1.25, px: 2, minHeight: `${TOPBAR_HEIGHT}px !important` }}>
        <OverviewIcon color="primary" />
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 750 }}>
            OpenMapX
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("administration")}
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <List sx={{ p: 1, flex: 1, overflowY: "auto" }}>
        {adminPrimaryNavigation({ role, selfHosted }).map((entry) => {
          const Icon = ICONS[entry.workspace];
          return (
            <ListItemButton
              key={entry.id}
              component={Link}
              href={entry.href}
              onClick={onNavigate}
              selected={active === entry.workspace}
              aria-current={active === entry.workspace ? "page" : undefined}
              sx={{ minHeight: 42, borderRadius: 1.5, px: 1.25, mb: 0.25 }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 34,
                  color: active === entry.workspace ? "primary.main" : "text.secondary",
                }}
              >
                <Icon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={t(`primary.${entry.workspace}`)}
                slotProps={{
                  primary: {
                    sx: { fontSize: 14, fontWeight: active === entry.workspace ? 650 : 400 },
                  },
                }}
              />
            </ListItemButton>
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
        open={open && !desktop}
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
        open={open && desktop}
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
