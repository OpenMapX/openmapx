import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { useTranslations } from "next-intl";

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const tCommon = useTranslations("common");
  return (
    <Alert
      severity="error"
      variant="outlined"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            {tCommon("retry")}
          </Button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}
