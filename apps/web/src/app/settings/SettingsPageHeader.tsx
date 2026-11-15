import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** A settings page's bar: back to the map and the page's own title. */
export async function SettingsPageHeader({ title }: { title: string }) {
  const t = await getTranslations("settings");
  return (
    <Box
      component="header"
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Container maxWidth="md" sx={{ py: 1.5, display: "flex", alignItems: "center", gap: 1.5 }}>
        <Link href="/" aria-label={t("back")} style={{ display: "inline-flex" }}>
          <IconButton size="small" component="span">
            <ArrowBackIcon />
          </IconButton>
        </Link>
        <Typography component="h1" variant="h6" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Container>
    </Box>
  );
}

/** The page's content column under its header. */
export function SettingsPageBody({ children }: { children: React.ReactNode }) {
  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      {children}
    </Container>
  );
}
