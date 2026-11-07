import { SaxesParser } from "saxes";

export const SIRI_NS = "http://www.siri.org.uk/siri";
export const MAX_BYTES = 64 * 1024 * 1024;
export interface SiriCall {
  root: string;
  aa?: number;
  ad?: number;
  ea?: number;
  ed?: number;
  xa?: number;
  xd?: number;
  ap?: string;
  dp?: string;
  cancelled?: boolean;
  extra?: boolean;
}
export interface SiriJourney {
  serviceDate: string;
  trainNumber: string;
  lineName: string;
  recordedAt: string;
  complete: boolean;
  cancelled: boolean;
  extra?: boolean;
  calls: SiriCall[];
}
export interface SiriSnapshot {
  responseTimestamp: string;
  journeys: SiriJourney[];
}

export function stationRoot(id: string): string | undefined {
  return /^(de:\d{5}:\d+)(?::[A-Za-z0-9]+){0,2}$/.exec(id)?.[1];
}
const TIMES = {
  AimedArrivalTime: "aa",
  AimedDepartureTime: "ad",
  ExpectedArrivalTime: "ea",
  ExpectedDepartureTime: "ed",
  ActualArrivalTime: "xa",
  ActualDepartureTime: "xd",
} as const;
const FIELDS = new Set([
  ...Object.keys(TIMES),
  "StopPointRef",
  "ArrivalPlatformName",
  "DeparturePlatformName",
  "Cancellation",
  "ExtraCall",
  "ExtraJourney",
  "RecordedAtTime",
  "DataFrameRef",
  "TrainNumberRef",
  "PublishedLineName",
  "IsCompleteStopSequence",
  "ResponseTimestamp",
  "Status",
]);

/** Bounded SAX extraction: only compact journeys survive, never a DOM or the XML body. */
export async function parseSiriEt(
  stream: ReadableStream<Uint8Array>,
  now: number,
): Promise<SiriSnapshot> {
  const result: SiriSnapshot = { responseTimestamp: "", journeys: [] };
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let text = "",
    bytes = 0,
    journeyCount = 0,
    callCount = 0,
    trainRefs = 0;
  let invalidJourney = false;
  let journey: SiriJourney | undefined;
  let call: SiriCall | undefined;
  const fail = () => {
    throw new Error("Invalid or excessive SIRI ET delivery");
  };
  parser.on("doctype", fail);
  parser.on("error", fail);
  parser.on("opentag", (tag) => {
    path.push(tag.uri === SIRI_NS ? tag.local : "foreign");
    text = "";
    if (path.length === 1 && (tag.local !== "Siri" || tag.uri !== SIRI_NS)) fail();
    if (tag.uri !== SIRI_NS) return;
    if (tag.local === "ErrorCondition") fail();
    if (tag.local === "EstimatedVehicleJourney") {
      if (journey || ++journeyCount > 10_000) fail();
      journey = {
        serviceDate: "",
        trainNumber: "",
        lineName: "",
        recordedAt: "",
        complete: false,
        cancelled: false,
        calls: [],
      };
      trainRefs = 0;
      invalidJourney = false;
    }
    if (journey && ["RecordedCall", "EstimatedCall"].includes(tag.local)) {
      if (call || ++callCount > 150_000 || journey.calls.length >= 2_000) fail();
      call = { root: "" };
    }
    if (path.length > 32) fail();
  });
  const appendText = (value: string) => {
    if (!FIELDS.has(path.at(-1) ?? "")) return;
    text += value;
    if (text.length > 256) fail();
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => {
    const key = path.at(-1);
    const value = text.trim();
    if (key === "Status" && !["true", "1"].includes(value)) fail();
    if (key === "ResponseTimestamp" && path.at(-2) === "ServiceDelivery") {
      if (value.length > 64) fail();
      result.responseTimestamp = value;
    }
    if (journey) {
      if (
        key &&
        ["Cancellation", "ExtraCall", "ExtraJourney", "IsCompleteStopSequence"].includes(key) &&
        !["true", "false", "0", "1"].includes(value)
      )
        invalidJourney = true;
      if (call) {
        if (key && Object.hasOwn(TIMES, key)) {
          const ms = Date.parse(value);
          if (!Number.isFinite(ms) || value.length > 64) invalidJourney = true;
          else call[TIMES[key as keyof typeof TIMES]] = ms / 1000;
        }
        if (key === "StopPointRef") call.root = stationRoot(value) ?? "";
        if (key === "ArrivalPlatformName" || key === "DeparturePlatformName") {
          if (value.length > 64) fail();
          if (value) call[key === "ArrivalPlatformName" ? "ap" : "dp"] = value;
        }
        if (key === "Cancellation") call.cancelled = value === "true" || value === "1";
        if (key === "ExtraCall") call.extra = value === "true" || value === "1";
        if (key === "RecordedCall" || key === "EstimatedCall") {
          journey.calls.push(call);
          call = undefined;
        }
      } else {
        if (key === "RecordedAtTime" && path.at(-2) === "EstimatedVehicleJourney") {
          journey.recordedAt = value;
          if (value.length > 64) invalidJourney = true;
        }
        if (key === "DataFrameRef") journey.serviceDate = value;
        if (key === "TrainNumberRef" && path.includes("TrainNumbers")) {
          trainRefs++;
          journey.trainNumber = /^\d{1,6}$/.test(value) ? String(Number(value)) : "";
        }
        if (key === "PublishedLineName") journey.lineName = value;
        if (key === "IsCompleteStopSequence") journey.complete = value === "true" || value === "1";
        if (key === "Cancellation") journey.cancelled = value === "true" || value === "1";
        if (key === "ExtraJourney") journey.extra = value === "true" || value === "1";
        if (key === "EstimatedVehicleJourney") {
          const stamp = Date.parse(journey.recordedAt);
          if (
            !invalidJourney &&
            trainRefs === 1 &&
            journey.trainNumber &&
            Number.isFinite(stamp) &&
            stamp <= now + 120_000
          )
            result.journeys.push(journey);
          journey = undefined;
        }
      }
    }
    path.pop();
    text = "";
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) fail();
      // Yield between bounded pieces even if the upstream delivers a giant chunk.
      for (let i = 0; i < chunk.value.length; i += 65536) {
        parser.write(decoder.decode(chunk.value.subarray(i, i + 65536), { stream: true }));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    parser.write(decoder.decode()).close();
    const stamp = Date.parse(result.responseTimestamp);
    if (!Number.isFinite(stamp) || stamp > now + 120_000 || now - stamp > 30 * 60_000) fail();
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
