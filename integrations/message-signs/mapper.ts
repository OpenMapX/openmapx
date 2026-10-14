import {
  type Attribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  validObservedAt,
} from "@openmapx/core";
import { siteAttributions } from "@openmapx/integration-framework";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { MessageSign } from "@openmapx/mobility-core/message-sign";

type Row = [I18nToken, Translatable];

/** Whether the sign shows a message now. */
const showing = (sign: MessageSign): boolean =>
  sign.status === "in_service" && sign.pages.length > 0;

/**
 * The sign's state as the map shows it: a sign showing a message is
 * operational, a blank or failed one dims, anything else is unknown.
 */
function statusOf(sign: MessageSign): string {
  if (showing(sign)) return "operational";
  if (sign.status === "blank" || sign.status === "fault" || sign.status === "out_of_service") {
    return "non-operational";
  }
  return "unknown";
}

/** The marker variant: what the sign is doing, which the map colours. */
export function variantOf(sign: MessageSign): string {
  if (showing(sign)) return "showing";
  if (sign.status === "fault" || sign.status === "out_of_service") return "fault";
  if (sign.status === "blank") return "blank";
  return "unknown";
}

/** The message as one line, its pages divided by a slash, for the map's label. */
function messageLine(sign: MessageSign): string {
  return sign.pages.map((lines) => lines.join(" ")).join(" / ");
}

function summaryOf(sign: MessageSign): I18nToken {
  if (showing(sign)) return token("summary.message", { message: messageLine(sign) });
  if (sign.status === "blank") return token("summary.blank");
  if (sign.status === "fault" || sign.status === "out_of_service") return token("summary.fault");
  return token("summary.unknown");
}

/** A sign's title when its sources name it nothing. */
function fallbackNameOf(sign: MessageSign): { fallbackName?: I18nToken } {
  return sign.name ? {} : { fallbackName: token("fallbackName") };
}

/** The sign's credits; every credit comes from the providers. */
function signCredits(sign: MessageSign): Attribution[] | undefined {
  if (sign.attributions.length === 0) return undefined;
  return snapshotContributors(sign.attributions);
}

/**
 * One table per page of the message, its lines numbered top to bottom. The
 * first page carries the time the sign last changed, which the publisher's
 * terms require a shown report to state.
 */
function pageSections(sign: MessageSign): DataSourceDetailSection[] {
  const updatedAt = validObservedAt(sign.updatedAt);
  return sign.pages.map((lines, i) => ({
    title:
      sign.pages.length === 1
        ? token("section.message")
        : token("section.page", { n: i + 1, count: sign.pages.length }),
    type: "table",
    rows: lines.map((line, j): Row => [token("row.line", { n: j + 1 }), line]),
    sectionIcon: "warning",
    ...(i === 0 ? { caption: token("caption.shown") } : {}),
    ...(i === 0 && updatedAt ? { captionTimestamp: updatedAt } : {}),
  }));
}

/** What a sign without a message is doing, with when that was last stated. */
function stateSection(sign: MessageSign): DataSourceDetailSection {
  const updatedAt = validObservedAt(sign.updatedAt);
  const state =
    sign.status === "blank"
      ? "state.blank"
      : sign.status === "fault" || sign.status === "out_of_service"
        ? "state.fault"
        : "state.unknown";
  return {
    title: token("section.message"),
    type: "text",
    content: token(state),
    sectionIcon: "info",
    ...(updatedAt ? { caption: token("caption.updated"), captionTimestamp: updatedAt } : {}),
  };
}

function infoSection(sign: MessageSign): DataSourceDetailSection | null {
  const rows: Row[] = [];
  if (sign.road) rows.push([token("row.road"), sign.road]);
  if (sign.direction) rows.push([token("row.facing"), token(`compass.${sign.direction}`)]);
  if (sign.location) rows.push([token("row.location"), sign.location]);
  const provider = sign.operator?.name ?? sign.attributions[0]?.name;
  if (provider) rows.push([token("row.provider"), provider]);
  if (rows.length === 0) return null;
  return { title: sharedT.section.info, type: "table", rows, sectionIcon: "info" };
}

export function mapSignToResult(sign: MessageSign): DataSourceResult {
  const observedAt = validObservedAt(sign.updatedAt);
  const result: DataSourceResult = {
    id: sign.id,
    name: sign.name,
    ...fallbackNameOf(sign),
    coordinates: sign.coordinates,
    source: sign.sources[0] ?? "unknown",
    sources: [...sign.sources],
    contributors: siteAttributions([sign]),
    variant: variantOf(sign),
    status: statusOf(sign),
    summary: summaryOf(sign),
    operator: sign.operator?.name,
    ...(observedAt ? { observedAt } : {}),
  };
  const attributions = signCredits(sign);
  if (attributions) result.attributions = attributions;
  return result;
}

/**
 * The sign's detail: each page of the message it shows with its lines, or
 * what it is doing instead (blank, out of order), then the road, the
 * direction of the traffic it faces, its place and its provider.
 */
export function mapSignToDetail(sign: MessageSign): DataSourceDetail {
  const sections: DataSourceDetailSection[] = showing(sign)
    ? pageSections(sign)
    : [stateSection(sign)];
  const info = infoSection(sign);
  if (info) sections.push(info);
  const detail: DataSourceDetail = {
    id: sign.id,
    sources: [...sign.sources],
    contributors: siteAttributions([sign]),
    name: sign.name,
    ...fallbackNameOf(sign),
    coordinates: sign.coordinates,
    operator: sign.operator ? { name: sign.operator.name } : undefined,
    sections,
  };
  const attributions = signCredits(sign);
  if (attributions) detail.attributions = attributions;
  return detail;
}
