"use client";

import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import ReportOutlinedIcon from "@mui/icons-material/ReportOutlined";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import type {
  OsmContributionContext,
  OsmEditableField,
  OsmEditableFieldName,
  OsmFieldDisabledReason,
} from "@openmapx/core";
import { safeHref } from "@openmapx/core";
import { useTranslations } from "next-intl";

const DISABLED_REASON_KEY: Record<OsmFieldDisabledReason, string> = {
  ALIAS_CONFLICT: "disabledAliasConflict",
  NO_ADDRESS_ON_ELEMENT: "disabledNoAddress",
  GEOMETRY_UNKNOWN: "disabledGeometryUnknown",
  CATEGORY_AMBIGUOUS: "disabledCategoryAmbiguous",
  CATEGORY_UNSUPPORTED: "disabledCategoryUnsupported",
  LIFECYCLE_STATE: "disabledLifecycle",
  DIRECT_EDITING_DISABLED: "disabledDirectEditing",
  VALUE_TOO_LONG: "disabledValueTooLong",
};

/** The live current value, purely for orientation. Never an editor default. */
function currentValueOf(field: OsmEditableField): string | null {
  switch (field.kind) {
    case "text":
    case "choice":
      return field.currentValue;
    case "category":
      return field.currentPresetName;
    default:
      return (
        field.entries
          .map((entry) => entry.currentValue)
          .filter(Boolean)
          .join(", ") || null
      );
  }
}

interface Props {
  context: OsmContributionContext;
  selected: readonly OsmEditableFieldName[];
  onToggleField: (field: OsmEditableFieldName) => void;
  onOpenNote: () => void;
}

/**
 * Lists exactly the fields the server offered for this element, plus the safe
 * handoffs for everything the curated editor deliberately cannot express.
 */
export function OsmContributionChooser({ context, selected, onToggleField, onOpenNote }: Props) {
  const t = useTranslations("osmContributions");

  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        {t("chooserTitle")}
      </Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {t("chooserHint")}
      </Typography>

      <List disablePadding>
        {context.fields.map((field) => {
          const value = currentValueOf(field);
          const reason = field.disabledReason;
          return (
            <ListItemButton
              key={field.field}
              disabled={!field.enabled}
              selected={selected.includes(field.field)}
              onClick={() => onToggleField(field.field)}
              sx={{ minHeight: 44, borderRadius: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <EditOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={field.label}
                secondary={
                  reason
                    ? t(DISABLED_REASON_KEY[reason])
                    : t("chooserCurrent", { value: value ?? t("chooserEmptyValue") })
                }
              />
            </ListItemButton>
          );
        })}
      </List>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" gutterBottom>
        {t("chooserUnsupportedTitle")}
      </Typography>
      <List disablePadding>
        {/* Closure, relocation and anything unsupported are never direct edits:
            they need context this flow cannot safely collect. */}
        {[
          { key: "actionClosed", icon: <ReportOutlinedIcon fontSize="small" /> },
          { key: "actionMoved", icon: <PlaceOutlinedIcon fontSize="small" /> },
          { key: "actionMissingCategory", icon: <ReportOutlinedIcon fontSize="small" /> },
          { key: "actionSomethingElse", icon: <ReportOutlinedIcon fontSize="small" /> },
        ].map((action) => (
          <ListItemButton
            key={action.key}
            onClick={onOpenNote}
            sx={{ minHeight: 44, borderRadius: 1 }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>{action.icon}</ListItemIcon>
            <ListItemText primary={t(action.key)} secondary={t("actionNote")} />
          </ListItemButton>
        ))}
        <ListItemButton
          component="a"
          href={safeHref(context.advancedEditorUrl)}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ minHeight: 44, borderRadius: 1 }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("actionAdvanced")} />
        </ListItemButton>
      </List>
    </Box>
  );
}
