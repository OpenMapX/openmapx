/**
 * The one place a semantic contribution becomes OSM tags.
 *
 * Everything here is pure and deterministic: preview and publish call the same
 * function, so what a person approves is exactly what is sent. The invariant is
 * enforced, not merely tested — after applying changes the result is compared
 * against the base, and any key outside the operation's computed ownership set
 * (or any structural difference) raises rather than being written.
 */
import {
  countCodePoints,
  OSM_MAX_TAG_CODE_POINTS,
  type OsmAddressField,
  type OsmContributionLocale,
  type OsmContributionPreview,
  type OsmEditableField,
  type OsmFieldChange,
  type OsmGeometry,
  type OsmPreviewWarning,
  type OsmScalarEditableField,
  type OsmSemanticDiff,
  type OsmTagDiff,
} from "@openmapx/core";
import {
  buildEditableFieldModel,
  type EditableFieldDescriptor,
  matchEditablePreset,
  type OsmEditorGeometry,
  previewCategoryTransition,
} from "@openmapx/presets";
import opening_hours from "opening_hours";
import { OsmContributionError, type OsmElement, type OsmWritableElement } from "./types.js";

const PHONE_ALLOWED = /^[0-9+()\-./;\s]+$/;
const EMAIL_ADDRESS = /^[^\s@;]+@[^\s@;.]+(\.[^\s@;.]+)+$/;

function invalid(message: string): never {
  throw new OsmContributionError("INVALID_CHANGE", 400, message);
}

function notEditable(message: string): never {
  throw new OsmContributionError("FIELD_NOT_EDITABLE", 400, message);
}

function empty(message: string): never {
  throw new OsmContributionError("EMPTY_CHANGE", 400, message);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

/** Shared shape rules for every free-text tag value. */
function normalizeText(raw: string, label: string): string {
  const value = raw.trim();
  if (value === "") invalid(`${label} must not be empty`);
  if (hasControlCharacters(value)) invalid(`${label} must not contain control characters`);
  if (countCodePoints(value) > OSM_MAX_TAG_CODE_POINTS) {
    invalid(`${label} must be at most ${OSM_MAX_TAG_CODE_POINTS} characters`);
  }
  return value;
}

function validateOpeningHours(raw: string): string {
  const value = normalizeText(raw, "Opening hours");
  try {
    // Syntax only. This asserts nothing about whether the schedule is correct.
    new opening_hours(value);
  } catch {
    invalid("Opening hours are not valid OpenStreetMap syntax");
  }
  return value;
}

function validatePhone(raw: string): string {
  const value = normalizeText(raw, "Phone");
  if (!PHONE_ALLOWED.test(value)) invalid("Phone may contain only digits and + ( ) - . / ;");
  if ((value.match(/\d/g) ?? []).length < 3) invalid("Phone must contain at least three digits");
  return value;
}

function validateEmail(raw: string): string {
  const value = normalizeText(raw, "Email");
  const addresses = value.split(";");
  if (addresses.length === 0) invalid("Email must contain an address");
  for (const address of addresses) {
    if (address !== address.trim() || address === "") invalid("Email list is malformed");
    if (!EMAIL_ADDRESS.test(address)) invalid("Email address is not valid");
  }
  return value;
}

function validateWebsite(raw: string): string {
  const value = normalizeText(raw, "Website");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("Website must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    invalid("Website must be an absolute http(s) URL");
  }
  if (url.username || url.password) invalid("Website must not contain credentials");
  // Deliberately return the visible trimmed input, not `url.toString()`:
  // silent canonicalization would publish something the person never saw.
  return value;
}

function validateScalar(
  field: OsmScalarEditableField,
  raw: string,
  descriptor: EditableFieldDescriptor,
): string {
  switch (field) {
    case "openingHours":
      return validateOpeningHours(raw);
    case "phone":
      return validatePhone(raw);
    case "email":
      return validateEmail(raw);
    case "website":
      return validateWebsite(raw);
    case "wheelchair": {
      const value = raw.trim();
      if (descriptor.kind !== "choice") invalid("Wheelchair access is not a choice field");
      if (!descriptor.options.some((option) => option.value === value)) {
        invalid("Wheelchair access must be one of the offered choices");
      }
      return value;
    }
    default:
      return normalizeText(raw, "Value");
  }
}

/** Convert the preset field model into the public, OSM-key-free contract. */
export function buildContextFields(
  tags: Readonly<Record<string, string>>,
  geometry: OsmGeometry,
  locale: OsmContributionLocale,
): OsmEditableField[] {
  const model = buildEditableFieldModel({
    tags,
    geometry: geometry === "unknown" ? "unknown" : (geometry as OsmEditorGeometry),
    lang: locale,
  });
  return model.fields.map((descriptor): OsmEditableField => {
    const base = {
      label: descriptor.label,
      enabled: descriptor.enabled,
      ...(descriptor.disabledReason ? { disabledReason: descriptor.disabledReason } : {}),
    };
    switch (descriptor.kind) {
      case "text":
        return {
          kind: "text",
          field: descriptor.field,
          currentValue: descriptor.currentValue,
          maxCodePoints: descriptor.maxCodePoints,
          ...base,
        };
      case "choice":
        return {
          kind: "choice",
          field: descriptor.field,
          currentValue: descriptor.currentValue,
          options: descriptor.options.map((option) => ({ ...option })),
          ...base,
        };
      case "category":
        return {
          kind: "category",
          field: "category",
          currentPresetId: descriptor.currentPresetId,
          currentPresetName: descriptor.currentPresetName,
          ...base,
        };
      default:
        return {
          kind: "address",
          field: "address",
          // Only the semantic component name crosses the boundary — never the
          // `addr:*` key the server owns.
          entries: descriptor.entries.map((entry) => ({
            key: entry.component,
            label: entry.label,
            currentValue: entry.currentValue,
          })),
          ...base,
        };
    }
  });
}

export interface ApplyOsmFieldChangesInput {
  baseElement: OsmElement;
  geometry: OsmGeometry;
  changes: readonly OsmFieldChange[];
  locale: OsmContributionLocale;
  /** Assigned by publish; preview may leave it at 0. */
  changesetId?: number;
}

export interface ApplyOsmFieldChangesResult {
  element: OsmWritableElement;
  preview: OsmContributionPreview;
}

function descriptorFor(
  fields: readonly EditableFieldDescriptor[],
  field: string,
): EditableFieldDescriptor {
  const descriptor = fields.find((entry) => entry.field === field);
  if (!descriptor) notEditable(`Field "${field}" is not offered for this element`);
  if (!descriptor.enabled) {
    notEditable(`Field "${field}" is not editable on this element`);
  }
  return descriptor;
}

function toWritable(
  base: OsmElement,
  tags: Record<string, string>,
  changesetId: number,
): OsmWritableElement {
  const common = { id: base.id, version: base.version, changeset: changesetId, tags };
  if (base.type === "node") {
    return {
      type: "node",
      ...common,
      lat: base.lat,
      lon: base.lon,
      ...(base.visible === undefined ? {} : { visible: base.visible }),
    };
  }
  if (base.type === "way") {
    return {
      type: "way",
      ...common,
      nodes: [...base.nodes],
      ...(base.visible === undefined ? {} : { visible: base.visible }),
    };
  }
  return {
    type: "relation",
    ...common,
    members: base.members.map((member) => ({ ...member })),
    ...(base.visible === undefined ? {} : { visible: base.visible }),
  };
}

/**
 * Apply semantic changes to a live element.
 *
 * Throws an `OsmContributionError` for anything that is not exactly one legal,
 * non-empty, non-conflicting edit of the curated fields.
 */
export function applyOsmFieldChanges(input: ApplyOsmFieldChangesInput): ApplyOsmFieldChangesResult {
  const { baseElement, changes, locale } = input;
  if (changes.length === 0) empty("A contribution must change at least one field");

  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.field)) invalid(`Duplicate change for field "${change.field}"`);
    seen.add(change.field);
  }

  const baseTags = baseElement.tags;
  const model = buildEditableFieldModel({
    tags: baseTags,
    geometry: input.geometry === "unknown" ? "unknown" : (input.geometry as OsmEditorGeometry),
    lang: locale,
  });

  const resultTags: Record<string, string> = { ...baseTags };
  const ownedKeys = new Set<string>();
  const semantic: OsmSemanticDiff[] = [];
  const warnings = new Set<OsmPreviewWarning>();

  for (const change of changes) {
    const descriptor = descriptorFor(model.fields, change.field);

    if (change.field === "category") {
      const transition = previewCategoryTransition({
        tags: baseTags,
        current: matchEditablePreset(baseTags, input.geometry as OsmEditorGeometry, locale),
        targetPresetId: change.presetId,
        geometry: input.geometry as OsmEditorGeometry,
        lang: locale,
      });
      if (transition.status !== "ok") {
        if (transition.reason === "CURRENT_NOT_EDITABLE") {
          notEditable("This element's category cannot be changed safely");
        }
        if (transition.reason === "NO_CHANGE") empty("The category is already that value");
        invalid("The chosen category is not a safe target for this element");
      }
      for (const key of transition.ownedKeys) ownedKeys.add(key);
      for (const entry of transition.remove) delete resultTags[entry.key];
      for (const entry of transition.replace) resultTags[entry.key] = entry.to;
      for (const entry of transition.add) resultTags[entry.key] = entry.value;
      semantic.push({
        field: "category",
        label: descriptor.label,
        action: "set",
        before: descriptor.kind === "category" ? descriptor.currentPresetName : null,
        after: transition.target.name,
      });
      warnings.add("CATEGORY_TRANSITION");
      warnings.add("REVIEW_RECOMMENDED");
      continue;
    }

    if (change.field === "address") {
      if (descriptor.kind !== "address") notEditable("Address is not editable on this element");
      for (const [component, operation] of Object.entries(change.value)) {
        if (!operation) continue;
        const entry = descriptor.entries.find((candidate) => candidate.component === component);
        if (!entry) {
          notEditable(
            `Address component "${component}" is not present on this element and cannot be added`,
          );
        }
        ownedKeys.add(entry.osmKey);
        if (operation.action === "remove") {
          if (resultTags[entry.osmKey] === undefined) {
            invalid(`Address component "${component}" has no value to remove`);
          }
          semantic.push({
            field: "address",
            label: entry.label,
            action: "remove",
            before: baseTags[entry.osmKey] ?? null,
            after: null,
          });
          delete resultTags[entry.osmKey];
          warnings.add("VALUE_REMOVED");
          continue;
        }
        const value = normalizeText(operation.value, entry.label);
        if (baseTags[entry.osmKey] === value) {
          empty(`Address component "${component}" is already that value`);
        }
        semantic.push({
          field: "address",
          label: entry.label,
          action: "set",
          before: baseTags[entry.osmKey] ?? null,
          after: value,
        });
        resultTags[entry.osmKey] = value;
      }
      continue;
    }

    const ownedKey = descriptor.ownedKeys[0];
    if (!ownedKey) notEditable(`Field "${change.field}" has no owned tag on this element`);
    ownedKeys.add(ownedKey);

    if (change.action === "remove") {
      if (resultTags[ownedKey] === undefined) {
        invalid(`Field "${change.field}" has no value to remove`);
      }
      semantic.push({
        field: change.field,
        label: descriptor.label,
        action: "remove",
        before: baseTags[ownedKey] ?? null,
        after: null,
      });
      delete resultTags[ownedKey];
      warnings.add("VALUE_REMOVED");
      continue;
    }

    const value = validateScalar(change.field, change.value, descriptor);
    if (baseTags[ownedKey] === value) empty(`Field "${change.field}" is already that value`);
    semantic.push({
      field: change.field,
      label: descriptor.label,
      action: "set",
      before: baseTags[ownedKey] ?? null,
      after: value,
    });
    resultTags[ownedKey] = value;
  }

  const tagDiff = diffTags(baseTags, resultTags);
  assertOnlyOwnedKeysChanged(baseTags, resultTags, ownedKeys);

  if (tagDiff.add.length + tagDiff.replace.length + tagDiff.remove.length === 0) {
    empty("The requested changes would not alter this element");
  }

  const element = toWritable(baseElement, resultTags, input.changesetId ?? 0);

  return {
    element,
    preview: {
      ref: { type: baseElement.type, id: baseElement.id },
      baseVersion: baseElement.version,
      changes: semantic,
      tagDiff,
      warnings: [...warnings].sort(),
      requiresReview: warnings.has("REVIEW_RECOMMENDED"),
    },
  };
}

function diffTags(
  base: Readonly<Record<string, string>>,
  result: Readonly<Record<string, string>>,
): OsmTagDiff {
  const add: OsmTagDiff["add"] = [];
  const replace: OsmTagDiff["replace"] = [];
  const remove: OsmTagDiff["remove"] = [];
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(result)])].sort()) {
    const before = base[key];
    const after = result[key];
    if (before === after) continue;
    if (before === undefined && after !== undefined) add.push({ key, value: after });
    else if (before !== undefined && after === undefined) remove.push({ key, value: before });
    else if (before !== undefined && after !== undefined)
      replace.push({ key, from: before, to: after });
  }
  return { add, replace, remove };
}

/**
 * The enforced invariant: nothing outside the operation's ownership set may
 * differ. This is an error, not an expectation, so a future field cannot
 * quietly widen what an edit touches.
 */
function assertOnlyOwnedKeysChanged(
  base: Readonly<Record<string, string>>,
  result: Readonly<Record<string, string>>,
  ownedKeys: ReadonlySet<string>,
): void {
  for (const key of new Set([...Object.keys(base), ...Object.keys(result)])) {
    if (base[key] === result[key]) continue;
    if (!ownedKeys.has(key)) {
      throw new OsmContributionError(
        "INVALID_CHANGE",
        400,
        "The requested changes would modify data this editor does not own",
      );
    }
  }
}

export type { OsmAddressField };
