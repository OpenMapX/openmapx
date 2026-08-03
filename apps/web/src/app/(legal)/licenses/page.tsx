import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { sectionSlug } from "@openmapx/core/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell, type LegalSection } from "@/components/legal/LegalPageShell";
import { LicenseTextDialog } from "./LicenseTextDialog";
import { loadLicenseGroups } from "./loadNotices";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("openSourceLicenses")} — OpenMapX`,
    description: t("openSourceLicensesDescription"),
  };
}

export default async function LicensesPage() {
  const locale = await getLocale();
  const isGerman = locale === "de";
  const data = await loadLicenseGroups();

  const title = isGerman ? "Open-Source-Lizenzen" : "Open Source Licenses";
  const sections: LegalSection[] = [
    { id: sectionSlug(title), label: isGerman ? "Überblick" : "Overview" },
    ...data.groups.map((g) => ({ id: `group-${g.scope}`, label: g.label })),
  ];

  return (
    <LegalPageShell sections={sections}>
      <Typography
        id={sectionSlug(title)}
        variant="h4"
        component="h1"
        sx={{ fontWeight: 700, mb: 2 }}
      >
        {title}
      </Typography>
      <Typography
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        {isGerman
          ? "Diese Seite wird aus den installierten Paket-Metadaten erzeugt und listet die produktiven Open-Source-Abhängigkeiten der Webanwendung, der API, des Datenmanagers, der eingebauten Integrationen sowie installierter Community-Integrationen."
          : "This page is generated from installed package metadata and lists the production open-source dependencies used by the web app, the API, the data manager, built-in integrations, and installed community integrations."}
      </Typography>
      <Stack
        direction="row"
        sx={{
          gap: 1,
          mb: 4,
        }}
      >
        <Chip
          size="small"
          label={isGerman ? `${data.totalCount} Abhängigkeiten` : `${data.totalCount} dependencies`}
        />
        {data.generatedAt && (
          <Chip
            size="small"
            variant="outlined"
            label={
              isGerman
                ? `Erzeugt am ${formatDate(data.generatedAt, locale)}`
                : `Generated ${formatDate(data.generatedAt, locale)}`
            }
          />
        )}
      </Stack>
      {data.groups.length === 0 ? (
        <Typography
          sx={{
            color: "text.secondary",
          }}
        >
          {isGerman
            ? "Noch keine Lizenzdaten verfügbar. Stellen Sie sicher, dass der prebuild-Schritt der Web-App ausgeführt wurde."
            : "No license data is available yet. Make sure the web app's prebuild step has run."}
        </Typography>
      ) : (
        data.groups.map((group) => (
          <Box key={group.scope} sx={{ mb: 5 }}>
            <Typography
              id={`group-${group.scope}`}
              variant="h5"
              component="h2"
              sx={{ fontWeight: 600, mb: 1 }}
            >
              {group.label}
            </Typography>
            {group.description && (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  mb: 0.5,
                }}
              >
                {group.description}
              </Typography>
            )}
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2,
              }}
            >
              {isGerman ? `${group.notices.length} Pakete` : `${group.notices.length} packages`}
            </Typography>
            <TableContainer sx={{ overflowX: "auto" }}>
              <Table size="small" aria-label={group.label}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>{isGerman ? "Paket" : "Package"}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {isGerman ? "Version" : "Version"}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {isGerman ? "Lizenz" : "License"}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {isGerman ? "Projekt" : "Project"}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {isGerman ? "Lizenztext" : "License text"}
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {group.notices.map((notice) => (
                    <TableRow key={`${notice.name}@${notice.version}`}>
                      <TableCell>
                        <Box component="code" sx={{ fontSize: 13, wordBreak: "break-all" }}>
                          {notice.name}
                        </Box>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{notice.version}</TableCell>
                      <TableCell>
                        {notice.licenseUrl ? (
                          <Link href={notice.licenseUrl} target="_blank" rel="noopener noreferrer">
                            {notice.license}
                          </Link>
                        ) : (
                          notice.license
                        )}
                      </TableCell>
                      <TableCell>
                        {notice.projectUrl ? (
                          <Link
                            href={notice.projectUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{ fontSize: 13 }}
                          >
                            {isGerman ? "Projektseite" : "Project"}
                          </Link>
                        ) : (
                          <Typography
                            variant="body2"
                            sx={{
                              color: "text.disabled",
                            }}
                          >
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {notice.licenseText ? (
                          <LicenseTextDialog
                            packageName={notice.name}
                            version={notice.version}
                            license={notice.license}
                            text={notice.licenseText}
                            triggerLabel={isGerman ? "Anzeigen" : "View"}
                            dialogTitle={
                              isGerman
                                ? `Lizenz für ${notice.name}@${notice.version}`
                                : `License for ${notice.name}@${notice.version}`
                            }
                            closeLabel={isGerman ? "Schließen" : "Close"}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            sx={{
                              color: "text.disabled",
                            }}
                          >
                            —
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        ))
      )}
    </LegalPageShell>
  );
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
