import { describe, expect, it } from "vitest";
import {
  buildNetexTransitGraph,
  listNetexCodes,
  listNetexElementsByName,
  listSiriDeliveryStatuses,
  listSiriMonitoredStopVisitRecords,
  listSiriSituations,
  listSiriVehicleActivityRecords,
  parseDatexParkingStatus,
  parseDatexParkingTable,
  resolveNetexJourneyPatternForServiceJourney,
  resolveNetexLineForServiceJourney,
  resolveNetexQuaysForScheduledStopPoint,
  resolveNetexRouteForServiceJourney,
  resolveNetexScheduledStopPointsForJourneyPattern,
  resolveNetexStopPlacesForScheduledStopPoint,
} from "../index.js";

describe("DATEX parking adapter", () => {
  it("parses parking tables and statuses across DATEX II wrapper variants", () => {
    const tableXml = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="GenericPublication" lang="en">
    <publicationTime>2026-04-21T10:22:00Z</publicationTime>
    <genericPublicationExtension>
      <parkingTablePublication>
        <parkingTable id="PT:1">
          <parkingRecord id="TRUCK:1">
            <parkingName>
              <values>
                <value lang="en">Truck Parking A</value>
                <value lang="nl">Vrachtwagen Parking A</value>
              </values>
            </parkingName>
            <parkingLocation>
              <pointByCoordinates>
                <pointCoordinates>
                  <latitude>52.1001</latitude>
                  <longitude>5.1002</longitude>
                </pointCoordinates>
              </pointByCoordinates>
            </parkingLocation>
            <tariffsAndPayment>
              <freeOfCharge>false</freeOfCharge>
            </tariffsAndPayment>
            <groupOfParkingSpaces>
              <parkingNumberOfSpaces>12</parkingNumberOfSpaces>
            </groupOfParkingSpaces>
            <groupOfParkingSpaces>
              <parkingNumberOfSpaces>8</parkingNumberOfSpaces>
            </groupOfParkingSpaces>
            <parkingEquipmentOrServiceFacility>
              <equipmentOrServiceFacilityType>electricChargingStation</equipmentOrServiceFacilityType>
            </parkingEquipmentOrServiceFacility>
          </parkingRecord>
        </parkingTable>
      </parkingTablePublication>
    </genericPublicationExtension>
  </payloadPublication>
</d2LogicalModel>`;

    const statusXml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns="http://datex2.eu/schema/3/messageContainer" xmlns:park="http://datex2.eu/schema/3/parking" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payload xsi:type="park:GenericPublication" lang="en" modelBaseVersion="3">
    <com:publicationTime>2026-04-21T10:30:00Z</com:publicationTime>
    <park:parkingRecordStatus>
      <park:parkingRecordReference id="TRUCK:1" />
      <park:parkingOccupancy>
        <park:parkingNumberOfVacantSpaces>4</park:parkingNumberOfVacantSpaces>
        <park:parkingNumberOfOccupiedSpaces>16</park:parkingNumberOfOccupiedSpaces>
        <park:parkingOccupancy>80</park:parkingOccupancy>
      </park:parkingOccupancy>
      <park:parkingSiteStatus>open</park:parkingSiteStatus>
      <park:parkingStatusOriginTime>2026-04-21T10:29:00Z</park:parkingStatusOriginTime>
    </park:parkingRecordStatus>
  </payload>
</messageContainer>`;

    const genericStatusXml = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="GenericPublication" lang="en">
    <publicationTime>2026-04-21T10:30:00Z</publicationTime>
    <genericPublicationName>ParkingStatusPublication</genericPublicationName>
    <genericPublicationExtension>
      <parkingStatusPublication>
        <parkingRecordStatus xsi:type="ParkingSiteStatus">
          <parkingRecordReference targetClass="ParkingRecord" id="TRUCK:1" version="1" />
          <parkingStatusOriginTime>2026-04-21T10:29:00Z</parkingStatusOriginTime>
          <parkingOccupancy>
            <parkingNumberOfVacantSpaces>4</parkingNumberOfVacantSpaces>
            <parkingNumberOfOccupiedSpaces>16</parkingNumberOfOccupiedSpaces>
            <parkingOccupancy>80</parkingOccupancy>
          </parkingOccupancy>
          <parkingSiteStatus>full</parkingSiteStatus>
        </parkingRecordStatus>
      </parkingStatusPublication>
    </genericPublicationExtension>
  </payloadPublication>
</d2LogicalModel>`;

    expect(parseDatexParkingTable(tableXml)).toEqual([
      {
        equipmentTypes: ["electricChargingStation"],
        freeOfCharge: false,
        id: "TRUCK:1",
        latitude: 52.1001,
        longitude: 5.1002,
        name: "Truck Parking A",
        totalSpaces: 20,
      },
    ]);
    expect(parseDatexParkingStatus(statusXml)).toEqual([
      {
        occupancyPercent: 80,
        occupiedSpaces: 16,
        originTime: "2026-04-21T10:29:00Z",
        recordId: "TRUCK:1",
        siteStatus: "open",
        vacantSpaces: 4,
      },
    ]);
    expect(parseDatexParkingStatus(genericStatusXml)).toEqual([
      {
        occupancyPercent: 80,
        occupiedSpaces: 16,
        originTime: "2026-04-21T10:29:00Z",
        recordId: "TRUCK:1",
        siteStatus: "full",
        vacantSpaces: 4,
      },
    ]);
  });
});

describe("SIRI transit adapter", () => {
  it("normalizes deliveries, realtime visits, and situations", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <ResponseTimestamp>2026-04-21T10:00:00Z</ResponseTimestamp>
    <VehicleMonitoringDelivery version="2.0">
      <ResponseTimestamp>2026-04-21T10:00:01Z</ResponseTimestamp>
      <RequestMessageRef>req-vm-1</RequestMessageRef>
      <Status>true</Status>
      <ValidUntil>2026-04-21T10:01:00Z</ValidUntil>
      <VehicleActivity>
        <RecordedAtTime>2026-04-21T10:00:05Z</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>L1</LineRef>
          <DirectionRef>outbound</DirectionRef>
          <FramedVehicleJourneyRef>
            <DataFrameRef>2026-04-21</DataFrameRef>
            <DatedVehicleJourneyRef>DVJ:1</DatedVehicleJourneyRef>
          </FramedVehicleJourneyRef>
          <VehicleRef>BUS:1</VehicleRef>
          <OperatorRef>OP:1</OperatorRef>
          <OriginRef>STOP:0</OriginRef>
          <DestinationRef>STOP:9</DestinationRef>
          <PublishedLineName xml:lang="en">Line 1</PublishedLineName>
          <PublishedLineName xml:lang="no">Linje 1</PublishedLineName>
          <OriginName xml:lang="en">Origin</OriginName>
          <DestinationName xml:lang="en">Destination</DestinationName>
          <OriginAimedDepartureTime>2026-04-21T09:55:00Z</OriginAimedDepartureTime>
          <Delay>PT2M</Delay>
          <VehicleLocation>
            <Longitude>10.7522</Longitude>
            <Latitude>59.9139</Latitude>
          </VehicleLocation>
          <Bearing>91.5</Bearing>
          <ProgressRate>normalProgress</ProgressRate>
          <ProgressStatus>inProgress</ProgressStatus>
          <MonitoredCall>
            <StopPointRef>STOP:1</StopPointRef>
            <StopPointName xml:lang="en">Central</StopPointName>
            <AimedArrivalTime>2026-04-21T10:03:00Z</AimedArrivalTime>
            <ExpectedArrivalTime>2026-04-21T10:05:00Z</ExpectedArrivalTime>
            <ArrivalPlatformName xml:lang="en">Platform 2</ArrivalPlatformName>
            <VisitNumber>1</VisitNumber>
          </MonitoredCall>
          <OnwardCalls>
            <OnwardCall>
              <StopPointRef>STOP:2</StopPointRef>
              <ExpectedArrivalTime>2026-04-21T10:10:00Z</ExpectedArrivalTime>
            </OnwardCall>
          </OnwardCalls>
        </MonitoredVehicleJourney>
      </VehicleActivity>
    </VehicleMonitoringDelivery>
    <StopMonitoringDelivery version="2.0">
      <ResponseTimestamp>2026-04-21T10:00:02Z</ResponseTimestamp>
      <RequestMessageRef>req-sm-1</RequestMessageRef>
      <Status>false</Status>
      <ErrorCondition>
        <OtherError>
          <ErrorText>downstream</ErrorText>
        </OtherError>
        <Description>Stop service degraded</Description>
      </ErrorCondition>
      <MonitoredStopVisit>
        <RecordedAtTime>2026-04-21T10:00:06Z</RecordedAtTime>
        <MonitoringRef>STOP:1</MonitoringRef>
        <MonitoredVehicleJourney>
          <LineRef>L1</LineRef>
          <VehicleRef>BUS:1</VehicleRef>
          <MonitoredCall>
            <StopPointRef>STOP:1</StopPointRef>
            <ExpectedDepartureTime>2026-04-21T10:06:00Z</ExpectedDepartureTime>
          </MonitoredCall>
        </MonitoredVehicleJourney>
      </MonitoredStopVisit>
    </StopMonitoringDelivery>
    <SituationExchangeDelivery version="2.0">
      <ResponseTimestamp>2026-04-21T10:00:03Z</ResponseTimestamp>
      <Status>true</Status>
      <Situations>
        <PtSituationElement>
          <SituationNumber>SX:1</SituationNumber>
          <ParticipantRef>ENTUR</ParticipantRef>
          <CreationTime>2026-04-21T09:50:00Z</CreationTime>
          <ReportType>incident</ReportType>
          <Progress>open</Progress>
          <Summary xml:lang="en">Track work</Summary>
          <Description xml:lang="en">Platform closed</Description>
          <Severity>severe</Severity>
          <PublicationWindows>
            <PublicationWindow>
              <StartTime>2026-04-21T09:45:00Z</StartTime>
              <EndTime>2026-04-21T18:15:00Z</EndTime>
            </PublicationWindow>
          </PublicationWindows>
          <ValidityPeriods>
            <ValidityPeriod>
              <StartTime>2026-04-21T09:00:00Z</StartTime>
              <EndTime>2026-04-21T18:00:00Z</EndTime>
            </ValidityPeriod>
          </ValidityPeriods>
          <Affects>
            <StopPoints>
              <AffectedStopPoint>
                <StopPointRef>STOP:1</StopPointRef>
              </AffectedStopPoint>
            </StopPoints>
            <Networks>
              <AffectedNetwork>
                <NetworkRef>NETWORK:1</NetworkRef>
                <AffectedLine>
                  <LineRef>L1</LineRef>
                </AffectedLine>
              </AffectedNetwork>
            </Networks>
            <Routes>
              <AffectedRoute>
                <RouteRef>ROUTE:1</RouteRef>
              </AffectedRoute>
            </Routes>
            <StopPlaces>
              <AffectedStopPlace>
                <StopPlaceRef>STOPPLACE:1</StopPlaceRef>
              </AffectedStopPlace>
            </StopPlaces>
            <Vehicles>
              <AffectedVehicle>
                <VehicleRef>BUS:1</VehicleRef>
              </AffectedVehicle>
            </Vehicles>
          </Affects>
          <Consequences>
            <Consequence>
              <Condition>delayed</Condition>
              <Effect>detour</Effect>
              <Severity>severe</Severity>
              <Advice xml:lang="en">Use replacement bus</Advice>
            </Consequence>
          </Consequences>
        </PtSituationElement>
      </Situations>
    </SituationExchangeDelivery>
  </ServiceDelivery>
</Siri>`;

    const deliveryStatuses = listSiriDeliveryStatuses(xml);
    const vehicleActivities = listSiriVehicleActivityRecords(xml);
    const stopVisits = listSiriMonitoredStopVisitRecords(xml);
    const situations = listSiriSituations(xml);

    expect(deliveryStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryName: "VehicleMonitoringDelivery",
          requestMessageRef: "req-vm-1",
          status: true,
        }),
        expect.objectContaining({
          deliveryName: "StopMonitoringDelivery",
          errorConditionType: "OtherError",
          errorDescription: "Stop service degraded",
          status: false,
        }),
      ]),
    );
    expect(vehicleActivities).toHaveLength(1);
    expect(vehicleActivities[0]?.journey.refs.datedVehicleJourneyRef).toBe("DVJ:1");
    expect(vehicleActivities[0]?.journey.lineName).toBe("Line 1");
    expect(vehicleActivities[0]?.journey.location).toEqual({
      latitude: 59.9139,
      longitude: 10.7522,
    });
    expect(vehicleActivities[0]?.journey.monitoredCall).toEqual(
      expect.objectContaining({
        arrivalPlatformName: "Platform 2",
        stopPointRef: "STOP:1",
        visitNumber: 1,
      }),
    );
    expect(vehicleActivities[0]?.journey.onwardCalls).toHaveLength(1);
    expect(stopVisits).toEqual([
      expect.objectContaining({
        monitoringRef: "STOP:1",
        journey: expect.objectContaining({
          refs: expect.objectContaining({ lineRef: "L1", vehicleRef: "BUS:1" }),
        }),
      }),
    ]);
    expect(situations).toEqual([
      expect.objectContaining({
        consequences: [
          expect.objectContaining({
            advice: "Use replacement bus",
            condition: "delayed",
            effect: "detour",
            severity: "severe",
          }),
        ],
        creationTime: "2026-04-21T09:50:00Z",
        lineRefs: ["L1"],
        networkRefs: ["NETWORK:1"],
        participantRef: "ENTUR",
        progress: "open",
        publicationWindows: [
          { endTime: "2026-04-21T18:15:00Z", startTime: "2026-04-21T09:45:00Z" },
        ],
        reportType: "incident",
        routeRefs: ["ROUTE:1"],
        severity: "severe",
        situationNumber: "SX:1",
        stopPlaceRefs: ["STOPPLACE:1"],
        stopPointRefs: ["STOP:1"],
        type: "PtSituationElement",
        validityPeriods: [{ endTime: "2026-04-21T18:00:00Z", startTime: "2026-04-21T09:00:00Z" }],
        vehicleRefs: ["BUS:1"],
      }),
    ]);
  });
});

describe("NeTEx transit graph adapter", () => {
  it("builds a stop and journey graph with codes and ref resolution", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="1.0">
  <PublicationTimestamp>2026-04-21T10:00:00Z</PublicationTimestamp>
  <ParticipantRef>ENTUR</ParticipantRef>
  <dataObjects>
    <CompositeFrame id="CF:1" version="1">
      <frames>
        <SiteFrame id="SF:1" version="1">
          <stopPlaces>
            <StopPlace id="SP:1" version="1">
              <Name>Central Station</Name>
              <PublicCode>CEN</PublicCode>
              <keys>
                <KeyValue>
                  <Key>nsrStopPlaceId</Key>
                  <Value>NSR:StopPlace:1</Value>
                </KeyValue>
              </keys>
              <quays>
                <Quay id="Q:1" version="1">
                  <Name>Platform 1</Name>
                  <PublicCode>1</PublicCode>
                </Quay>
              </quays>
            </StopPlace>
          </stopPlaces>
        </SiteFrame>
        <ServiceFrame id="SV:1" version="1">
          <scheduledStopPoints>
            <ScheduledStopPoint id="SSP:1" version="1">
              <Name>Central Point</Name>
              <PrivateCode>STOP:1</PrivateCode>
            </ScheduledStopPoint>
          </scheduledStopPoints>
          <stopAssignments>
            <PassengerStopAssignment id="PSA:1" version="1">
              <Order>1</Order>
              <ScheduledStopPointRef ref="SSP:1" />
              <QuayRef ref="Q:1" />
            </PassengerStopAssignment>
          </stopAssignments>
          <lines>
            <Line id="L:1" version="1">
              <Name>Line 1</Name>
              <PublicCode>1</PublicCode>
              <TransportMode>bus</TransportMode>
              <OperatorRef ref="OP:1" />
            </Line>
          </lines>
          <routes>
            <Route id="R:1" version="1">
              <Name>Outbound</Name>
              <LineRef ref="L:1" />
              <pointsInSequence>
                <PointOnRoute id="POR:1">
                  <Order>1</Order>
                  <ScheduledStopPointRef ref="SSP:1" />
                </PointOnRoute>
              </pointsInSequence>
            </Route>
          </routes>
          <journeyPatterns>
            <JourneyPattern id="JP:1" version="1">
              <Name>Outbound Pattern</Name>
              <RouteRef ref="R:1" />
              <pointsInSequence>
                <StopPointInJourneyPattern id="SPJP:1">
                  <Order>1</Order>
                  <ScheduledStopPointRef ref="SSP:1" />
                  <ForBoarding>true</ForBoarding>
                  <ForAlighting>true</ForAlighting>
                </StopPointInJourneyPattern>
              </pointsInSequence>
            </JourneyPattern>
          </journeyPatterns>
          <serviceJourneys>
            <ServiceJourney id="SJ:1" version="1">
              <Name>Trip 1</Name>
              <LineRef ref="L:1" />
              <JourneyPatternRef ref="JP:1" />
              <passingTimes>
                <TimetabledPassingTime id="TPT:1">
                  <Order>1</Order>
                  <StopPointInJourneyPatternRef ref="SPJP:1" />
                  <ArrivalTime>08:00:00</ArrivalTime>
                  <DepartureTime>08:01:00</DepartureTime>
                </TimetabledPassingTime>
              </passingTimes>
            </ServiceJourney>
          </serviceJourneys>
        </ServiceFrame>
      </frames>
    </CompositeFrame>
  </dataObjects>
</PublicationDelivery>`;

    const stopPlace = listNetexElementsByName(xml, "StopPlace")[0];
    const graph = buildNetexTransitGraph(xml);

    expect(listNetexCodes(stopPlace)).toEqual(
      expect.arrayContaining([
        { type: "publicCode", value: "CEN" },
        { key: "nsrStopPlaceId", type: "keyValue", value: "NSR:StopPlace:1" },
      ]),
    );
    expect(graph.stopPlacesById["SP:1"]?.quayRefs).toEqual(["Q:1"]);
    expect(resolveNetexQuaysForScheduledStopPoint(graph, "SSP:1").map((quay) => quay.id)).toEqual([
      "Q:1",
    ]);
    expect(
      resolveNetexStopPlacesForScheduledStopPoint(graph, "SSP:1").map(
        (stopPlaceRecord) => stopPlaceRecord.id,
      ),
    ).toEqual(["SP:1"]);
    expect(resolveNetexJourneyPatternForServiceJourney(graph, "SJ:1")?.id).toBe("JP:1");
    expect(resolveNetexRouteForServiceJourney(graph, "SJ:1")?.id).toBe("R:1");
    expect(resolveNetexLineForServiceJourney(graph, "SJ:1")?.id).toBe("L:1");
    expect(
      resolveNetexScheduledStopPointsForJourneyPattern(graph, "JP:1").map(
        (stopPoint) => stopPoint.id,
      ),
    ).toEqual(["SSP:1"]);
  });
});
