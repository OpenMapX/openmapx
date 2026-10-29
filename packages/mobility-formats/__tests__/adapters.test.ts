import { describe, expect, it } from "vitest";
import {
  listSiriDeliveryStatuses,
  listSiriMonitoredStopVisitRecords,
  listSiriSituations,
  listSiriVehicleActivityRecords,
} from "../index.js";

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
