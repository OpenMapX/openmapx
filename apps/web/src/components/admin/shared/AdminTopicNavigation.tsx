"use client";
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type AdminNavigationAccess,
  type AdminWorkspace,
  adminDestinationForPath,
  adminDestinations,
} from "@/lib/admin/adminNavigation";

export function AdminTopicNavigation({
  workspace,
  role,
  selfHosted,
}: AdminNavigationAccess & { workspace: AdminWorkspace }) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("adminNavigation");
  const entries = adminDestinations({ role, selfHosted }).filter(
    (entry) => entry.workspace === workspace,
  );
  const active = adminDestinationForPath(pathname)?.id;
  if (entries.length < 2) return null;
  return (
    <Box
      component="nav"
      aria-label={t("topics", { workspace: t(`primary.${workspace}`) })}
      sx={{ width: { xs: "100%", lg: 184 }, flexShrink: 0 }}
    >
      <TextField
        select
        size="small"
        fullWidth
        label={t("topic")}
        value={entries.find((entry) => entry.id === active)?.href ?? entries[0].href}
        onChange={(event) => router.push(event.target.value)}
        sx={{ display: { lg: "none" }, mb: 1 }}
      >
        {entries.map((entry) => (
          <MenuItem key={entry.id} value={entry.href}>
            {t(`destinations.${entry.id}.label`)}
          </MenuItem>
        ))}
      </TextField>
      <List
        disablePadding
        sx={{ display: { xs: "none", lg: "block" }, position: "sticky", top: 0 }}
      >
        <Typography component="li" variant="overline" sx={{ px: 1.25, color: "text.secondary" }}>
          {t(`primary.${workspace}`)}
        </Typography>
        {entries.map((entry) => (
          <ListItemButton
            component={Link}
            key={entry.id}
            href={entry.href}
            selected={active === entry.id}
            aria-current={active === entry.id ? "page" : undefined}
            sx={{ borderRadius: 1.5, minHeight: 40, fontSize: 13, px: 1.25, mb: 0.25 }}
          >
            {t(`destinations.${entry.id}.label`)}
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
