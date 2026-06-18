"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

interface FeedAttribution {
  country_code?: string;
  country_name?: string;
  human_name?: string;
  source?: string;
  spdx_license_identifier?: string;
  license_url?: string;
  publisher?: { name?: string; url?: string };
  operators?: string[];
}

interface TransitFeedAttributionProps {
  feeds: FeedAttribution[];
  labels: {
    heading: string;
    description: string;
    fallback: React.ReactNode;
    source: string;
    feedName: string;
    license: string;
    operators: string;
    feeds: string;
  };
}

export function TransitFeedAttribution({ feeds, labels }: TransitFeedAttributionProps) {
  if (feeds.length === 0) {
    return (
      <Box sx={{ mt: 2, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
          {labels.heading}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {labels.fallback}
        </Typography>
      </Box>
    );
  }

  const grouped = new Map<string, FeedAttribution[]>();
  for (const feed of feeds) {
    const country = feed.country_name ?? "Unknown";
    const existing = grouped.get(country) ?? [];
    existing.push(feed);
    grouped.set(country, existing);
  }

  const sortedCountries = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const totalCountries = sortedCountries.length;

  return (
    <Box sx={{ mt: 2, mb: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        {labels.heading}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        {labels.description
          .replace("{count}", String(feeds.length))
          .replace("{countries}", String(totalCountries))}
      </Typography>
      {sortedCountries.map(([country, countryFeeds]) => (
        <Accordion
          key={country}
          disableGutters
          elevation={0}
          sx={{ border: 1, borderColor: "divider", mb: 0.5 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40 }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {country}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                ml: 1,
              }}
            >
              ({countryFeeds.length} {labels.feeds})
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>{labels.feedName}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{labels.license}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{labels.operators}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {countryFeeds.map((feed) => (
                    <TableRow key={feed.human_name}>
                      <TableCell>
                        {feed.source ? (
                          <Link href={feed.source} target="_blank" rel="noopener noreferrer">
                            {feed.human_name}
                          </Link>
                        ) : (
                          feed.human_name
                        )}
                      </TableCell>
                      <TableCell>
                        {feed.license_url ? (
                          <Link href={feed.license_url} target="_blank" rel="noopener noreferrer">
                            {feed.spdx_license_identifier ?? "Unknown"}
                          </Link>
                        ) : (
                          (feed.spdx_license_identifier ?? "Unknown")
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{ maxWidth: 300 }}
                          noWrap
                          title={feed.operators?.join(", ")}
                        >
                          {feed.operators?.length
                            ? feed.operators.length <= 3
                              ? feed.operators.join(", ")
                              : `${feed.operators.slice(0, 3).join(", ")} +${feed.operators.length - 3}`
                            : "\u2014"}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}
