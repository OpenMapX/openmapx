import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSiriStopMonitoringRequest,
  buildSiriVehicleMonitoringRequest,
  buildXmlDocument,
  decodeGtfsRtFeed,
  decodeGtfsRtFeedToObject,
  encodeGtfsRtFeed,
  type GbfsDiscoveryDocument,
  type GbfsV30Manifest,
  getGtfsRtAlerts,
  getGtfsRtTripUpdates,
  getGtfsRtVehiclePositions,
  getNetexParticipantRef,
  getNetexPublicationTimestamp,
  getSiriServiceRequest,
  getSiriServiceTimestamp,
  gtfsDateToIso,
  gtfsRtTimestampToIso,
  indexNetexElementsById,
  listGbfsFeeds,
  listGbfsManifestDatasetVersions,
  listNetexFrames,
  listNetexFramesByName,
  listNetexLines,
  listNetexQuays,
  listNetexScheduledStopPoints,
  listNetexStopPlaces,
  listSiriMonitoredStopVisits,
  listSiriSituationElements,
  listSiriVehicleActivities,
  mapGtfsRouteTypeToMode,
  parseCsvRecords,
  parseNetexDocument,
  parseSiriDocument,
  parseXmlDocument,
  resolveGbfsFeedUrl,
  resolveGbfsVehicleStatusFeedUrl,
  resolveNetexRef,
  streamCsvRecordsInBatches,
  xmlText,
} from "../index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("GTFS CSV", () => {
  it("parses quoted CSV records", () => {
    const rows = parseCsvRecords(
      '\uFEFFstop_id,stop_name,desc\n1,"Central, Station","platform ""A"""',
    );

    expect(rows).toEqual([
      {
        stop_id: "1",
        stop_name: "Central, Station",
        desc: 'platform "A"',
      },
    ]);
  });

  it("streams CSV records in batches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-mobility-formats-"));
    tempDirs.push(dir);

    const filePath = join(dir, "stops.txt");
    writeFileSync(filePath, "stop_id,stop_name\n1,One\n2,Two\n3,Three\n");

    const batches: Array<Array<Record<string, string>>> = [];
    for await (const batch of streamCsvRecordsInBatches(filePath, 2)) {
      batches.push(batch);
    }

    expect(batches).toEqual([
      [
        { stop_id: "1", stop_name: "One" },
        { stop_id: "2", stop_name: "Two" },
      ],
      [{ stop_id: "3", stop_name: "Three" }],
    ]);
  });
});

describe("GTFS helpers", () => {
  it("maps GTFS route types and dates", () => {
    expect(mapGtfsRouteTypeToMode(3)).toBe("bus");
    expect(mapGtfsRouteTypeToMode(109)).toBe("rail");
    expect(mapGtfsRouteTypeToMode(905)).toBe("tram");
    expect(gtfsDateToIso("20260421")).toBe("2026-04-21");
  });
});

describe("GBFS helpers", () => {
  it("resolves v2 feed URLs from language containers", () => {
    const discovery = {
      data: {
        en: {
          feeds: [
            { name: "station_information", url: "https://example.test/station_information.json" },
            { name: "free_bike_status", url: "https://example.test/free_bike_status.json" },
          ],
        },
      },
      last_updated: 0,
      ttl: 0,
      version: "2.3",
    } as GbfsDiscoveryDocument;

    expect(listGbfsFeeds(discovery)).toHaveLength(2);
    expect(resolveGbfsFeedUrl(discovery, "station_information")).toBe(
      "https://example.test/station_information.json",
    );
    expect(resolveGbfsVehicleStatusFeedUrl(discovery)).toBe(
      "https://example.test/free_bike_status.json",
    );
  });

  it("resolves v3 feed URLs directly", () => {
    const discovery = {
      data: {
        feeds: [
          { name: "vehicle_status", url: "https://example.test/vehicle_status.json" },
          { name: "vehicle_types", url: "https://example.test/vehicle_types.json" },
        ],
      },
      last_updated: "2026-04-21T10:00:00Z",
      ttl: 30,
      version: "3.0",
    } as GbfsDiscoveryDocument;

    expect(resolveGbfsFeedUrl(discovery, "vehicle_types")).toBe(
      "https://example.test/vehicle_types.json",
    );
    expect(resolveGbfsVehicleStatusFeedUrl(discovery)).toBe(
      "https://example.test/vehicle_status.json",
    );
  });

  it("lists GBFS v3 manifest dataset versions", () => {
    const manifest = {
      data: {
        datasets: [
          {
            system_id: "voioslo",
            versions: [
              { version: "2.3", url: "https://api.entur.io/mobility/v2/gbfs/v2/voioslo/gbfs" },
              { version: "3.0", url: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs" },
            ],
          },
          {
            system_id: "oslobysykkel",
            versions: [
              {
                version: "3.0",
                url: "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
              },
            ],
          },
        ],
      },
      last_updated: "2026-04-22T08:00:00Z",
      ttl: 3600,
      version: "3.0",
    } as GbfsV30Manifest;

    expect(listGbfsManifestDatasetVersions(manifest)).toEqual([
      {
        systemId: "voioslo",
        version: "2.3",
        url: "https://api.entur.io/mobility/v2/gbfs/v2/voioslo/gbfs",
      },
      {
        systemId: "voioslo",
        version: "3.0",
        url: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
      },
      {
        systemId: "oslobysykkel",
        version: "3.0",
        url: "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
      },
    ]);
  });
});

describe("GTFS-RT helpers", () => {
  it("encodes, decodes, and selects feed entity types", () => {
    const bytes = encodeGtfsRtFeed({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: 1_713_657_600,
      },
      entity: [
        {
          id: "trip-1",
          tripUpdate: {
            trip: { tripId: "trip-1", routeId: "route-1" },
          },
        },
        {
          id: "vehicle-1",
          vehicle: {
            trip: { tripId: "trip-1", routeId: "route-1" },
            position: { latitude: 52.52, longitude: 13.405 },
          },
        },
        {
          id: "alert-1",
          alert: {
            headerText: {
              translation: [{ text: "Detour" }],
            },
          },
        },
      ],
    });

    const decoded = decodeGtfsRtFeed(bytes);
    const object = decodeGtfsRtFeedToObject(bytes);

    expect(getGtfsRtTripUpdates(decoded)).toHaveLength(1);
    expect(getGtfsRtVehiclePositions(decoded)).toHaveLength(1);
    expect(getGtfsRtAlerts(decoded)).toHaveLength(1);
    expect(object.entity?.[0]?.tripUpdate?.trip?.tripId).toBe("trip-1");
    expect(gtfsRtTimestampToIso("1713657600")).toBe("2024-04-21T00:00:00.000Z");
  });
});

describe("XML helpers", () => {
  it("parses namespace-prefixed XML and builds XML declarations", () => {
    const parsed = parseXmlDocument(
      '<ns:Root xmlns:ns="urn:test"><ns:Child>Example</ns:Child></ns:Root>',
    );
    const built = buildXmlDocument(
      {
        Root: {
          Child: "Example",
        },
      },
      { xmlDeclaration: true },
    );

    expect(parsed.Root).toBeDefined();
    expect(xmlText((parsed.Root as Record<string, unknown>).Child)).toBe("Example");
    expect(built.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("SIRI helpers", () => {
  const vehicleMonitoringResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.0">
  <ServiceDelivery>
    <ResponseTimestamp>2004-12-17T09:30:47-05:00</ResponseTimestamp>
    <ProducerRef>NADER</ProducerRef>
    <VehicleMonitoringDelivery version="2.0">
      <ResponseTimestamp>2004-12-17T09:30:47-05:00</ResponseTimestamp>
      <VehicleActivity>
        <RecordedAtTime>2004-12-17T09:30:47-05:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>Line123</LineRef>
          <VehicleRef>VEH987654</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
      <VehicleActivity>
        <RecordedAtTime>2004-12-17T09:30:47-05:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>Line456</LineRef>
          <VehicleRef>VEH111111</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;

  const stopMonitoringResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <StopMonitoringDelivery version="2.0">
      <MonitoredStopVisit>
        <MonitoringRef>STOP:1</MonitoringRef>
      </MonitoredStopVisit>
    </StopMonitoringDelivery>
    <SituationExchangeDelivery version="2.0">
      <Situations>
        <PtSituationElement>
          <Summary>Track work</Summary>
        </PtSituationElement>
        <RoadSituationElement>
          <Summary>Road closure</Summary>
        </RoadSituationElement>
      </Situations>
    </SituationExchangeDelivery>
  </ServiceDelivery>
</Siri>`;

  it("parses service deliveries and extracts common payloads", () => {
    const parsed = parseSiriDocument(vehicleMonitoringResponse);
    const activities = listSiriVehicleActivities(parsed);

    expect(getSiriServiceTimestamp(parsed)).toBe("2004-12-17T09:30:47-05:00");
    expect(activities).toHaveLength(2);
    expect(
      xmlText(
        ((activities[0].MonitoredVehicleJourney ?? {}) as Record<string, unknown>).VehicleRef,
      ),
    ).toBe("VEH987654");
    expect(listSiriMonitoredStopVisits(stopMonitoringResponse)).toHaveLength(1);
    expect(listSiriSituationElements(stopMonitoringResponse)).toHaveLength(2);
  });

  it("builds reusable vehicle and stop monitoring requests", () => {
    const vehicleRequestXml = buildSiriVehicleMonitoringRequest({
      detailLevel: "basic",
      requestTimestamp: "2026-04-21T10:00:00Z",
      requestorRef: "openmapx",
      vehicleMonitoringRef: "VEH:42",
    });
    const stopRequestXml = buildSiriStopMonitoringRequest({
      maximumStopVisits: 3,
      monitoringRef: "STOP:1",
      requestTimestamp: "2026-04-21T10:05:00Z",
      requestorRef: "openmapx",
    });

    const vehicleRequest = getSiriServiceRequest(parseSiriDocument(vehicleRequestXml));
    const stopRequest = getSiriServiceRequest(parseSiriDocument(stopRequestXml));

    expect(vehicleRequestXml).toContain("<VehicleMonitoringRequest");
    expect(stopRequestXml).toContain("<StopMonitoringRequest");
    expect(
      xmlText(
        ((vehicleRequest?.VehicleMonitoringRequest ?? {}) as Record<string, unknown>)
          .VehicleMonitoringRef,
      ),
    ).toBe("VEH:42");
    expect(
      xmlText(
        ((stopRequest?.StopMonitoringRequest ?? {}) as Record<string, unknown>).MonitoringRef,
      ),
    ).toBe("STOP:1");
  });
});

describe("NeTEx helpers", () => {
  const scheduledStopPointsDocument = `<?xml version="1.0" encoding="UTF-8"?>
<PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="1.0">
  <PublicationTimestamp>2001-12-17T09:30:47.0Z</PublicationTimestamp>
  <ParticipantRef>SYS001</ParticipantRef>
  <dataObjects>
    <ServiceFrame version="any" id="SVF004">
      <scheduledStopPoints>
        <ScheduledStopPoint id="SSP0042A">
          <Name>Poste, St Jean</Name>
        </ScheduledStopPoint>
        <ScheduledStopPoint id="SNCF0047">
          <Name>Gare, St Jean</Name>
        </ScheduledStopPoint>
      </scheduledStopPoints>
    </ServiceFrame>
  </dataObjects>
</PublicationDelivery>`;

  const stopPlacesDocument = `<?xml version="1.0" encoding="UTF-8"?>
<PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="1.0">
  <PublicationTimestamp>2010-12-17T09:30:47.0Z</PublicationTimestamp>
  <ParticipantRef>SYS002</ParticipantRef>
  <dataObjects>
    <CompositeFrame id="CF:1" version="1.0">
      <frames>
        <SiteFrame id="SF:1" version="1.0">
          <stopPlaces>
            <StopPlace id="SP:1" version="1.0">
              <Name>Central Station</Name>
              <quays>
                <Quay id="Q:1" version="1.0">
                  <Name>Platform 1</Name>
                </Quay>
              </quays>
            </StopPlace>
          </stopPlaces>
        </SiteFrame>
        <ResourceFrame id="RF:1" version="1.0">
          <organisations>
            <Operator id="OP:1" version="1.0">
              <Name>OpenMapX Transit</Name>
            </Operator>
          </organisations>
        </ResourceFrame>
      </frames>
    </CompositeFrame>
  </dataObjects>
</PublicationDelivery>`;

  const lineDocument = `<?xml version="1.0" encoding="UTF-8"?>
<PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="1.0">
  <PublicationTimestamp>2010-12-17T09:30:47.0Z</PublicationTimestamp>
  <ParticipantRef>SYS003</ParticipantRef>
  <dataObjects>
    <CompositeFrame id="CF:2" version="1.0">
      <frames>
        <ServiceFrame id="SF:2" version="1.0">
          <lines>
            <Line id="LN:24" version="1.0">
              <Name>Line 24</Name>
            </Line>
            <Line id="LN:25" version="1.0">
              <Name>Line 25</Name>
            </Line>
          </lines>
        </ServiceFrame>
      </frames>
    </CompositeFrame>
  </dataObjects>
</PublicationDelivery>`;

  it("parses publication deliveries, frames, and entity indexes", () => {
    const scheduled = parseNetexDocument(scheduledStopPointsDocument);
    const stopPlaces = parseNetexDocument(stopPlacesDocument);
    const stopIndex = indexNetexElementsById(stopPlaces);

    expect(getNetexPublicationTimestamp(scheduled)).toBe("2001-12-17T09:30:47.0Z");
    expect(getNetexParticipantRef(scheduled)).toBe("SYS001");
    expect(listNetexFrames(scheduled)).toHaveLength(1);
    expect(listNetexScheduledStopPoints(scheduled)).toHaveLength(2);
    expect(listNetexFramesByName(stopPlaces, "SiteFrame")).toHaveLength(1);
    expect(listNetexStopPlaces(stopPlaces)).toHaveLength(1);
    expect(listNetexQuays(stopPlaces)).toHaveLength(1);
    expect(resolveNetexRef(stopIndex, "SP:1")).toBeDefined();
    expect(resolveNetexRef(stopIndex, "Q:1")).toBeDefined();
  });

  it("lists line entities across composite frames", () => {
    expect(listNetexLines(lineDocument)).toHaveLength(2);
  });
});
