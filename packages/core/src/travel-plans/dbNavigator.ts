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
  const [, time, rest] = new RegExp(`^${prefix} ([0-2]\\d:[0-5]\\d) (.+)$`).exec(line) ?? [];
  if (time === undefined || rest === undefined || Number(time.slice(0, 2)) > 23) return null;
  const [, name, platform] = /^(.*?)(?:,\s*Gleis\s+(.+))?$/.exec(rest) ?? [];
  if (!name?.trim()) return null;
  return { time, name: name.trim(), platform };
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
    const [, headerOrigin, headerDestination] = /^(.+?)\s*→\s*(.+)$/.exec(lines[0] ?? "") ?? [];
    if (headerOrigin !== undefined) cursor++;
    const [, weekday, day, month, year] =
      /^(So|Mo|Di|Mi|Do|Fr|Sa)\. (\d{2})\.(\d{2})\.(\d{4})$/.exec(lines[cursor++] ?? "") ?? [];
    if (!weekday || !day || !month || !year) return invalid;
    let calendar = Date.UTC(Number(year), Number(month) - 1, Number(day));
    const isoDate = `${year}-${month}-${day}`;
    if (
      new Date(calendar).toISOString().slice(0, 10) !== isoDate ||
      dayNames[new Date(calendar).getUTCDay()] !== weekday
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
          lines[cursor] ?? "",
        )
      ) {
        cursor++;
        break;
      }
      const [, namedService, namedNumber, productService, productNumber] =
        servicePattern.exec(lines[cursor++] ?? "") ?? [];
      // The pattern's two alternatives each capture a name and a number.
      const serviceName = namedService ?? productService;
      const trainNumber = namedNumber ?? productNumber;
      if (serviceName === undefined || trainNumber === undefined || legs.length === 8)
        return invalid;
      let headsign: string | undefined;
      const headsignLine = lines[cursor];
      if (headsignLine?.startsWith("Nach ")) {
        headsign = headsignLine.slice(5);
        cursor++;
      }
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
        service: serviceName.trim(),
        trainNumber,
        headsign,
        departurePlatform: from.platform,
        arrivalPlatform: to.platform,
      });
    }
    const [firstLeg] = legs;
    if (
      !firstLeg ||
      cursor !== lines.length ||
      Date.parse(legs.at(-1)?.arrival ?? "") - Date.parse(firstLeg.departure) > 72 * 3600000
    )
      return invalid;
    const origin = firstLeg.from,
      destination = legs.at(-1)?.to ?? "";
    if (
      headerOrigin !== undefined &&
      (travelStationKey(headerOrigin) !== travelStationKey(origin) ||
        travelStationKey(headerDestination ?? "") !== travelStationKey(destination))
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
