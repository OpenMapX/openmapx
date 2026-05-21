import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSiriStopMonitoringRequest,
  buildSiriVehicleMonitoringRequest,
  buildXmlDocument,
  DATEX_PUBLICATION_TYPES,
  decodeGtfsRtFeed,
  decodeGtfsRtFeedToObject,
  encodeGtfsRtFeed,
  type GbfsDiscoveryDocument,
  type GbfsV30Manifest,
  getDatexElementId,
  getDatexElementType,
  getDatexModelBaseVersion,
  getDatexPayloadPublicationType,
  getDatexPublicationCreatorCountry,
  getDatexPublicationCreatorNationalIdentifier,
  getDatexPublicationLanguage,
  getDatexPublicationTime,
  getDatexSupplierCountry,
  getDatexSupplierNationalIdentifier,
  getGtfsRtAlerts,
  getGtfsRtTripUpdates,
  getGtfsRtVehiclePositions,
  getNetexParticipantRef,
  getNetexPublicationTimestamp,
  getSiriServiceRequest,
  getSiriServiceTimestamp,
  gtfsDateToIso,
  gtfsRtTimestampToIso,
  indexDatexElementsById,
  indexNetexElementsById,
  isDatexPublicationType,
  listDatexElementsByName,
  listDatexMeasuredValues,
  listDatexMeasurementSiteRecords,
  listDatexMultilingualValues,
  listDatexParkingRecordStatuses,
  listDatexParkingRecords,
  listDatexSiteMeasurements,
  listDatexSituationRecords,
  listDatexSituations,
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
  parseDatexDocument,
  parseNetexDocument,
  parseSiriDocument,
  parseXmlDocument,
  resolveDatexMultilingualValue,
  resolveDatexRef,
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

describe("DATEX II helpers", () => {
  const v3SituationDocument = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/3/d2Payload" xmlns:com="http://datex2.eu/schema/3/common" xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <exchange>
    <supplierIdentification>
      <country>DE</country>
      <nationalIdentifier>OPENMAPX-NODE</nationalIdentifier>
    </supplierIdentification>
  </exchange>
  <payload xsi:type="sit:SituationPublication" lang="de" modelBaseVersion="3">
    <com:publicationTime>2026-04-21T10:00:00Z</com:publicationTime>
    <com:publicationCreator>
      <com:country>DE</com:country>
      <com:nationalIdentifier>OPENMAPX</com:nationalIdentifier>
    </com:publicationCreator>
    <sit:situation id="SIT:1">
      <sit:overallSeverity>medium</sit:overallSeverity>
      <sit:situationRecord xsi:type="sit:Roadworks" id="REC:1" version="2">
        <sit:situationRecordCreationTime>2026-04-21T09:55:00Z</sit:situationRecordCreationTime>
      </sit:situationRecord>
    </sit:situation>
  </payload>
</d2LogicalModel>`;

  const v2MeasuredDataDocument = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="MeasuredDataPublication" lang="en">
    <publicationTime>2026-04-21T10:15:00Z</publicationTime>
    <publicationCreator>
      <country>DE</country>
      <nationalIdentifier>SENSOR-HUB</nationalIdentifier>
    </publicationCreator>
    <siteMeasurements id="SM:1">
      <measurementSiteReference id="MS:1"/>
      <measuredValue index="1">
        <basicData xsi:type="TrafficFlow">
          <vehicleFlow>120</vehicleFlow>
        </basicData>
      </measuredValue>
    </siteMeasurements>
  </payloadPublication>
</d2LogicalModel>`;

  const v2MeasurementSiteTableDocument = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="MeasurementSiteTablePublication" lang="en">
    <publicationTime>2026-04-21T10:20:00Z</publicationTime>
    <publicationCreator>
      <country>DE</country>
      <nationalIdentifier>SENSOR-HUB</nationalIdentifier>
    </publicationCreator>
    <measurementSiteTable id="MST:1">
      <measurementSiteRecord id="MS:1" version="1">
        <measurementSiteName>Mainline Sensor</measurementSiteName>
      </measurementSiteRecord>
    </measurementSiteTable>
  </payloadPublication>
</d2LogicalModel>`;

  const v2GenericParkingTableDocument = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="GenericPublication" lang="en">
    <publicationTime>2026-04-21T10:22:00Z</publicationTime>
    <publicationCreator>
      <country>NL</country>
      <nationalIdentifier>NDW</nationalIdentifier>
    </publicationCreator>
    <genericPublicationExtension>
      <parkingTablePublication>
        <parkingTable id="PT:V2">
          <parkingRecord id="PR:V2">
            <parkingName>
              <values>
                <value lang="en">Truck Parking A</value>
              </values>
            </parkingName>
          </parkingRecord>
        </parkingTable>
      </parkingTablePublication>
    </genericPublicationExtension>
  </payloadPublication>
</d2LogicalModel>`;

  const v3ParkingDocument = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/3/d2Payload" xmlns:com="http://datex2.eu/schema/3/common" xmlns:park="http://datex2.eu/schema/3/parking" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payload xsi:type="park:ParkingTablePublication" lang="en" modelBaseVersion="3">
    <com:publicationTime>2026-04-21T10:25:00Z</com:publicationTime>
    <com:publicationCreator>
      <com:country>DE</com:country>
      <com:nationalIdentifier>PARKING-HUB</com:nationalIdentifier>
    </com:publicationCreator>
    <park:parkingTable id="PT:1">
      <park:parkingRecord id="PR:1">
        <park:parkingName>
          <com:values>
            <com:value lang="en">Central Garage</com:value>
            <com:value lang="de">Zentrum Parkhaus</com:value>
          </com:values>
        </park:parkingName>
      </park:parkingRecord>
    </park:parkingTable>
  </payload>
</d2LogicalModel>`;

  const v3ParkingStatusMessageContainerDocument = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns="http://datex2.eu/schema/3/messageContainer" xmlns:park="http://datex2.eu/schema/3/parking" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payload xsi:type="park:GenericPublication" lang="en" modelBaseVersion="3">
    <com:publicationTime>2026-04-21T10:30:00Z</com:publicationTime>
    <park:parkingRecordStatus>
      <park:parkingRecordReference id="PR:1" />
      <park:parkingSiteStatus>open</park:parkingSiteStatus>
      <park:parkingStatusOriginTime>2026-04-21T10:29:00Z</park:parkingStatusOriginTime>
    </park:parkingRecordStatus>
  </payload>
</messageContainer>`;

  it("parses v3 situation publications and shared metadata", () => {
    const parsed = parseDatexDocument(v3SituationDocument);
    const index = indexDatexElementsById(parsed);
    const situationRecord = listDatexSituationRecords(parsed)[0] as Record<string, unknown>;

    expect(getDatexModelBaseVersion(parsed)).toBe("3");
    expect(getDatexPayloadPublicationType(parsed)).toBe(DATEX_PUBLICATION_TYPES.situation);
    expect(getDatexPublicationLanguage(parsed)).toBe("de");
    expect(getDatexPublicationTime(parsed)).toBe("2026-04-21T10:00:00Z");
    expect(getDatexSupplierCountry(parsed)).toBe("DE");
    expect(getDatexSupplierNationalIdentifier(parsed)).toBe("OPENMAPX-NODE");
    expect(getDatexPublicationCreatorCountry(parsed)).toBe("DE");
    expect(getDatexPublicationCreatorNationalIdentifier(parsed)).toBe("OPENMAPX");
    expect(listDatexSituations(parsed)).toHaveLength(1);
    expect(listDatexSituationRecords(parsed)).toHaveLength(1);
    expect(getDatexElementType(situationRecord)).toBe("Roadworks");
    expect(listDatexElementsByName(parsed, "situationRecord")).toHaveLength(1);
    expect(resolveDatexRef(index, "SIT:1")).toBeDefined();
    expect(resolveDatexRef(index, "REC:1")).toBeDefined();
  });

  it("parses measured data, measurement sites, and parking publications across versions", () => {
    const measuredValue = listDatexMeasuredValues(v2MeasuredDataDocument)[0] as Record<
      string,
      unknown
    >;
    const siteMeasurement = listDatexSiteMeasurements(v2MeasuredDataDocument)[0];
    const measurementSiteIndex = indexDatexElementsById(v2MeasurementSiteTableDocument, [
      "measurementSiteRecord",
    ]);
    const parkingRecord = listDatexParkingRecords(v3ParkingDocument)[0] as Record<string, unknown>;

    expect(
      isDatexPublicationType(v2MeasuredDataDocument, DATEX_PUBLICATION_TYPES.measuredData),
    ).toBe(true);
    expect(listDatexSiteMeasurements(v2MeasuredDataDocument)).toHaveLength(1);
    expect(listDatexMeasuredValues(v2MeasuredDataDocument)).toHaveLength(1);
    expect(getDatexElementId(siteMeasurement)).toBe("SM:1");
    expect(getDatexElementType(measuredValue.basicData)).toBe("TrafficFlow");
    expect(
      isDatexPublicationType(
        v2MeasurementSiteTableDocument,
        DATEX_PUBLICATION_TYPES.measurementSiteTable,
      ),
    ).toBe(true);
    expect(listDatexMeasurementSiteRecords(v2MeasurementSiteTableDocument)).toHaveLength(1);
    expect(resolveDatexRef(measurementSiteIndex, "MS:1")).toBeDefined();
    expect(
      isDatexPublicationType(v2GenericParkingTableDocument, DATEX_PUBLICATION_TYPES.generic),
    ).toBe(true);
    expect(listDatexParkingRecords(v2GenericParkingTableDocument)).toHaveLength(1);
    expect(isDatexPublicationType(v3ParkingDocument, DATEX_PUBLICATION_TYPES.parkingTable)).toBe(
      true,
    );
    expect(listDatexParkingRecords(v3ParkingDocument)).toHaveLength(1);
    expect(listDatexMultilingualValues(parkingRecord.parkingName)).toEqual([
      { language: "en", value: "Central Garage" },
      { language: "de", value: "Zentrum Parkhaus" },
    ]);
    expect(resolveDatexMultilingualValue(parkingRecord.parkingName, ["de-DE"])).toBe(
      "Zentrum Parkhaus",
    );
  });

  it("parses parking record statuses from message-container payloads", () => {
    const status = listDatexParkingRecordStatuses(
      v3ParkingStatusMessageContainerDocument,
    )[0] as Record<string, unknown>;

    expect(listDatexParkingRecordStatuses(v3ParkingStatusMessageContainerDocument)).toHaveLength(1);
    expect(getDatexPayloadPublicationType(v3ParkingStatusMessageContainerDocument)).toBe(
      DATEX_PUBLICATION_TYPES.generic,
    );
    expect(getDatexPublicationTime(v3ParkingStatusMessageContainerDocument)).toBe(
      "2026-04-21T10:30:00Z",
    );
    expect((status.parkingRecordReference as Record<string, unknown>)?.["@_id"]).toBe("PR:1");
  });
});
