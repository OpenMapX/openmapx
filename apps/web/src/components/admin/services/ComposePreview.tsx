"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useComposePreview } from "@/hooks/useComposePreview";

export function ComposePreview() {
  const { data, isLoading, error } = useComposePreview();

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{(error as Error).message}</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        Generated docker-compose preview
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This is the docker-compose YAML that would be written to disk for the currently enabled
        services. It is regenerated on each request.
      </Typography>
      <Paper
        variant="outlined"
        sx={{ p: 2, maxHeight: "70vh", overflow: "auto", bgcolor: "grey.50" }}
      >
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data}
        </pre>
      </Paper>
    </Box>
  );
}
