import {
  type SharedTravelLeg,
  type TravelPlanAdapter,
  type TravelPlanParseResult,
  travelStationKey,
} from "./types";

const invalid: TravelPlanParseResult = { kind: "invalid-travel-plan", reason: "invalid" };
const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const servicePattern =
  /^(?:([A-Za-zÄÖÜäöü][A-Za-zÄÖÜäöü\d -]{0,30})\s*\((\d{1,8})\)|(ICE|IC|EC|NJ|EN|RJ|RJX|TGV|THA|ECE)\s+(\d{1,8}))$/;
function event(line: string, prefix: string) {
  const m = new RegExp(`^${prefix} ([0-2]\\d:[0-5]\\d) (.+)$`).exec(line);
  if (!m || Number(m[1].slice(0, 2)) > 23) return null;
  const station = /^(.*?)(?:,\s*Gleis\s+(.+))?$/.exec(m[2]);
  if (!station?.[1].trim()) return null;
  return { time: m[1], name: station[1].trim(), platform: station[2] };
}
export const dbNavigatorAdapter: TravelPlanAdapter = {
  parse(text) {
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/[\t\u00a0 ]+/g, " "))
      .filter(Boolean);
    const hasLink = /https:\/\/(?:www\.)?bahn\.de\/buchung\/start\?[^\s]*\bvbid=/i.test(text);
    const hasBlock = lines.some(
      (line, i) =>
        servicePattern.test(line) &&
        lines.slice(i + 1, i + 5).some((s) => /^Ab \d{2}:\d{2} /.test(s)) &&
        lines.slice(i + 1, i + 5).some((s) => /^An \d{2}:\d{2} /.test(s)),
    );
    if (!hasLink && !hasBlock) return { kind: "unrecognized" };
    if (!hasBlock) return { kind: "invalid-travel-plan", reason: "missing-text" };
    let cursor = 0;
    const header = /^(.+?)\s*→\s*(.+)$/.exec(lines[0]);
    if (header) cursor++;
    const date = /^(So|Mo|Di|Mi|Do|Fr|Sa)\. (\d{2})\.(\d{2})\.(\d{4})$/.exec(lines[cursor++] ?? "");
    if (!date) return invalid;
    let calendar = Date.UTC(Number(date[4]), Number(date[3]) - 1, Number(date[2]));
    const isoDate = `${date[4]}-${date[3]}-${date[2]}`;
    if (
      new Date(calendar).toISOString().slice(0, 10) !== isoDate ||
      dayNames[new Date(calendar).getUTCDay()] !== date[1]
    )
      return invalid;
    let previousTime = "00:00";
    const wall = (time: string) => {
      if (time < previousTime) calendar += 86400000;
      previousTime = time;
      return `${new Date(calendar).toISOString().slice(0, 10)}T${time}`;
    };
    const legs: SharedTravelLeg[] = [];
    while (cursor < lines.length) {
      if (
        /^Verbindung ansehen: https:\/\/(?:www\.)?bahn\.de\/buchung\/start\?[^\s]+$/.test(
          lines[cursor],
        )
      ) {
        cursor++;
        break;
      }
      const service = servicePattern.exec(lines[cursor++]);
      if (!service || legs.length === 8) return invalid;
      const headsign = lines[cursor]?.startsWith("Nach ") ? lines[cursor++].slice(5) : undefined;
      const from = event(lines[cursor++] ?? "", "Ab");
      const to = event(lines[cursor++] ?? "", "An");
      if (!from || !to) return invalid;
      const departure = wall(from.time),
        arrival = wall(to.time);
      if (
        arrival <= departure ||
        (legs.length && travelStationKey(legs.at(-1)?.to ?? "") !== travelStationKey(from.name))
      )
        return invalid;
      legs.push({
        from: from.name,
        to: to.name,
        departure,
        arrival,
        service: (service[1] ?? service[3]).trim(),
        trainNumber: service[2] ?? service[4],
        headsign,
        departurePlatform: from.platform,
        arrivalPlatform: to.platform,
      });
    }
    if (
      !legs.length ||
      cursor !== lines.length ||
      Date.parse(legs.at(-1)?.arrival ?? "") - Date.parse(legs[0].departure) > 72 * 3600000
    )
      return invalid;
    const origin = legs[0].from,
      destination = legs.at(-1)?.to ?? "";
    if (
      header &&
      (travelStationKey(header[1]) !== travelStationKey(origin) ||
        travelStationKey(header[2]) !== travelStationKey(destination))
    )
      return invalid;
    return {
      kind: "travel-plan",
      plan: {
        sourceId: "db-navigator",
        sourceLabel: "DB Navigator",
        origin,
        destination,
        timeZone: "Europe/Berlin",
        legs,
      },
    };
  },
};
