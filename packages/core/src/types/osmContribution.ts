/**
 * Display-side types for the OSM place-contribution flow.
 *
 * Every type here is inferred from the runtime schemas in
 * `../schemas/osmContribution` so the wire contract has exactly one source of
 * truth. Import types from here (or the package barrel) and the schemas when a
 * boundary needs to validate.
 */
export type {
  OsmAddressField,
  OsmAddressPatch,
  OsmAddressValueOperation,
  OsmCategorySearchQuery,
  OsmCategorySuggestion,
  OsmContributionCapabilities,
  OsmContributionContext,
  OsmContributionErrorBody,
  OsmContributionErrorCode,
  OsmContributionLocale,
  OsmContributionPreview,
  OsmContributionPreviewRequest,
  OsmContributionPublishRequest,
  OsmContributionPublishResult,
  OsmContributionScope,
  OsmEditableField,
  OsmEditableFieldName,
  OsmEditorGeometry,
  OsmElementRef,
  OsmElementType,
  OsmEvidence,
  OsmFieldChange,
  OsmFieldDisabledReason,
  OsmGeometry,
  OsmNoteRequest,
  OsmNoteResult,
  OsmPresetMatchStatus,
  OsmPreviewWarning,
  OsmPublicAccount,
  OsmScalarEditableField,
  OsmSemanticDiff,
  OsmTagDiff,
} from "../schemas/osmContribution";
