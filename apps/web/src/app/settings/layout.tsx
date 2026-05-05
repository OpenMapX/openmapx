import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("settings");
  return (
    <Box
      sx={{
        // Root body is h-dvh + overflow-hidden, so this layout owns its own
        // scroll container — otherwise long lists (offline areas) clip below
        // the viewport with no way to reach them.
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
        pt: "var(--omx-safe-top)",
        pb: "var(--omx-safe-bottom)",
      }}
    >
      <Box
        component="header"
        sx={{
          flexShrink: 0,
          bgcolor: "background.paper",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Container maxWidth="md" sx={{ py: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <Link href="/" aria-label={t("back")} style={{ display: "inline-flex" }}>
              <IconButton size="small" component="span">
                <ArrowBackIcon />
              </IconButton>
            </Link>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {t("title")}
            </Typography>
          </Stack>
        </Container>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Container maxWidth="md" sx={{ py: 3 }}>
          {children}
        </Container>
      </Box>
    </Box>
  );
}
