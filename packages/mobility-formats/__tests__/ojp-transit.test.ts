import { describe, expect, it } from "vitest";
import {
  buildOjpFareRequestXml,
  extractOjpTripRequestTrips,
  parseOjpFareResponse,
  parseOjpTripInfoResponse,
  parseOjpTripResponse,
} from "../index.js";

describe("OJP transit adapter", () => {
  it("parses richer trip legs, service metadata, geometry, and intermodal fields", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPTripDelivery>
        <TripResponseContext>
          <Places>
            <Place>
              <StopPoint>
                <siri:StopPointRef>STOP:1</siri:StopPointRef>
                <StopPointName><Text>Bern</Text></StopPointName>
              </StopPoint>
              <GeoPosition><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></GeoPosition>
            </Place>
            <Place>
              <StopPoint>
                <siri:StopPointRef>STOP:2</siri:StopPointRef>
                <StopPointName><Text>Thun</Text></StopPointName>
              </StopPoint>
              <GeoPosition><siri:Longitude>7.6290</siri:Longitude><siri:Latitude>46.7580</siri:Latitude></GeoPosition>
            </Place>
          </Places>
        </TripResponseContext>
        <TripResult>
          <Trip>
            <Id>trip-1</Id>
            <Distance>31250</Distance>
            <Duration>PT31M</Duration>
            <StartTime>2025-02-03T14:45:00Z</StartTime>
            <EndTime>2025-02-03T15:16:00Z</EndTime>
            <Transfers>1</Transfers>
            <Leg>
              <Id>transfer-1</Id>
              <TransferLeg>
                <LegStart>
                  <GeoPosition><siri:Longitude>7.4380</siri:Longitude><siri:Latitude>46.9480</siri:Latitude></GeoPosition>
                  <Name><Text>Bike hub</Text></Name>
                </LegStart>
                <LegEnd>
                  <siri:StopPointRef>STOP:1</siri:StopPointRef>
                  <Name><Text>Bern</Text></Name>
                </LegEnd>
                <Duration>PT4M</Duration>
                <Length>700</Length>
                <WalkDuration>PT3M</WalkDuration>
                <BufferTime>PT2M</BufferTime>
                <TransferType>interchange</TransferType>
                <TransferMode>cycle</TransferMode>
                <TimeWindowStart>2025-02-03T14:41:00Z</TimeWindowStart>
                <TimeWindowEnd>2025-02-03T14:45:00Z</TimeWindowEnd>
                <Attribute>
                  <Text><Text>Covered access</Text></Text>
                </Attribute>
                <Feasibility><Text>Bicycle ramp available</Text></Feasibility>
                <SituationFullRefs>
                  <SituationFullRef><SituationNumber>SX:bike</SituationNumber></SituationFullRef>
                </SituationFullRefs>
                <PathGuidance>
                  <TurnDescription><Text>Leave the station forecourt</Text></TurnDescription>
                </PathGuidance>
                <LegProjection>
                  <Position><siri:Longitude>7.4380</siri:Longitude><siri:Latitude>46.9480</siri:Latitude></Position>
                  <Position><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></Position>
                </LegProjection>
                <Service>
                  <PersonalMode>cycle</PersonalMode>
                </Service>
              </TransferLeg>
            </Leg>
            <Leg>
              <Id>timed-1</Id>
              <TimedLeg>
                <LegBoard>
                  <siri:StopPointRef>STOP:1</siri:StopPointRef>
                  <StopPointName><Text>Bern</Text></StopPointName>
                  <NameSuffix>Gleis 10</NameSuffix>
                  <ServiceDeparture>
                    <TimetabledTime>2025-02-03T14:47:00Z</TimetabledTime>
                    <EstimatedTime>2025-02-03T14:48:00Z</EstimatedTime>
                    <Occupancy>fewSeatsAvailable</Occupancy>
                    <DatedTrainNumberRefGroup>
                      <DatedTrainNumberRef>IC6-419</DatedTrainNumberRef>
                      <OperatorRef>SBB</OperatorRef>
                      <OperatingDayRef>2025-02-03</OperatingDayRef>
                    </DatedTrainNumberRefGroup>
                  </ServiceDeparture>
                  <Order>1</Order>
                </LegBoard>
                <LegIntermediates>
                  <siri:StopPointRef>STOP:mid</siri:StopPointRef>
                  <StopPointName><Text>Münsingen</Text></StopPointName>
                </LegIntermediates>
                <LegAlight>
                  <siri:StopPointRef>STOP:2</siri:StopPointRef>
                  <StopPointName><Text>Thun</Text></StopPointName>
                  <NameSuffix>Gleis 3</NameSuffix>
                  <ServiceArrival>
                    <TimetabledTime>2025-02-03T15:15:00Z</TimetabledTime>
                    <EstimatedTime>2025-02-03T15:16:00Z</EstimatedTime>
                  </ServiceArrival>
                  <Order>5</Order>
                </LegAlight>
                <LegProjection>
                  <Position><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></Position>
                  <Position><siri:Longitude>7.5000</siri:Longitude><siri:Latitude>46.8500</siri:Latitude></Position>
                  <Position><siri:Longitude>7.6290</siri:Longitude><siri:Latitude>46.7580</siri:Latitude></Position>
                </LegProjection>
                <SituationFullRefs>
                  <SituationFullRef><SituationNumber>SX:rail</SituationNumber></SituationFullRef>
                </SituationFullRefs>
                <Service>
                  <OperatingDayRef>2025-02-03</OperatingDayRef>
                  <JourneyRef>ojp-journey-1</JourneyRef>
                  <siri:LineRef>ojp:91006:H</siri:LineRef>
                  <OperatorRef>SBB</OperatorRef>
                  <OperatorRefs><OperatorRef>BLS</OperatorRef></OperatorRefs>
                  <VehicleRef>TRAIN:1</VehicleRef>
                  <Mode>
                    <PtMode>rail</PtMode>
                    <Name><Text>Rail</Text></Name>
                    <ShortName><Text>R</Text></ShortName>
                    <TrainSubmode>intercityRail</TrainSubmode>
                  </Mode>
                  <PublishedServiceName><Text>IC6</Text></PublishedServiceName>
                  <PublishedLineName><Text>InterCity 6</Text></PublishedLineName>
                  <DestinationText><Text>Thun</Text></DestinationText>
                  <DestinationStopPointRef>STOP:2</DestinationStopPointRef>
                  <OriginText><Text>Bern</Text></OriginText>
                  <OriginStopPointRef>STOP:1</OriginStopPointRef>
                  <RouteDescription><Text>via Belp</Text></RouteDescription>
                  <Via>
                    <StopPointRef>STOP:mid</StopPointRef>
                    <Text><Text>Münsingen</Text></Text>
                  </Via>
                  <ProductCategory>
                    <ProductCategoryRef>IC</ProductCategoryRef>
                    <Name><Text>InterCity</Text></Name>
                    <ShortName><Text>IC</Text></ShortName>
                  </ProductCategory>
                  <Occupancy>standingAvailable</Occupancy>
                  <Attribute>
                    <Text><Text>Bike spaces limited</Text></Text>
                    <UserText><Text>Reservation recommended</Text></UserText>
                    <Code>bike</Code>
                    <AccessFacility>wheelchairAccess</AccessFacility>
                  </Attribute>
                  <SituationFullRefs>
                    <SituationFullRef><SituationNumber>SX:rail</SituationNumber></SituationFullRef>
                  </SituationFullRefs>
                  <ServiceInfo>
                    <ServiceFeatureRef>wifi</ServiceFeatureRef>
                    <VehicleFeatureRef>quiet_zone</VehicleFeatureRef>
                  </ServiceInfo>
                  <DatedTrainNumberRefGroup>
                    <DatedTrainNumberRef>IC6-419</DatedTrainNumberRef>
                    <OperatorRef>SBB</OperatorRef>
                    <OperatingDayRef>2025-02-03</OperatingDayRef>
                  </DatedTrainNumberRefGroup>
                </Service>
              </TimedLeg>
            </Leg>
          </Trip>
        </TripResult>
      </OJPTripDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

    const result = parseOjpTripResponse(xml);
    const trip = result.trips[0];
    const transferLeg = trip?.legs[0];
    const timedLeg = trip?.legs[1];

    expect(trip?.distanceMeters).toBe(31_250);
    expect(transferLeg).toEqual(
      expect.objectContaining({
        bufferTimeSeconds: 120,
        feasibility: ["Bicycle ramp available"],
        guidanceTexts: ["Leave the station forecourt"],
        lengthMeters: 700,
        personalMode: "cycle",
        projectionCoordinates: [
          [7.438, 46.948],
          [7.4393, 46.949],
        ],
        situationIds: ["SX:bike"],
        transferMode: "cycle",
        transferType: "interchange",
        walkDurationSeconds: 180,
      }),
    );
    expect(timedLeg).toEqual(
      expect.objectContaining({
        boardCall: expect.objectContaining({
          departureOccupancy: "fewSeatsAvailable",
          departureFormationRefs: [
            {
              operatorRef: "SBB",
              operatingDayRef: "2025-02-03",
              trainNumber: "IC6-419",
            },
          ],
          nameSuffix: "Gleis 10",
        }),
        intermediateCalls: [
          expect.objectContaining({ name: "Münsingen", stopPointRef: "STOP:mid" }),
        ],
        projectionCoordinates: [
          [7.4393, 46.949],
          [7.5, 46.85],
          [7.629, 46.758],
        ],
        service: expect.objectContaining({
          attributes: ["Bike spaces limited", "Reservation recommended"],
          datedTrainNumberRefs: [
            {
              operatorRef: "SBB",
              operatingDayRef: "2025-02-03",
              trainNumber: "IC6-419",
            },
          ],
          modeName: "Rail",
          modeShortName: "R",
          occupancy: "standingAvailable",
          operatorRefs: ["BLS", "SBB"],
          productCategoryRef: "IC",
          routeDescription: "via Belp",
          serviceFeatureRefs: ["wifi"],
          situationIds: ["SX:rail"],
          submode: "intercityRail",
          vehicleFeatureRefs: ["quiet_zone"],
          viaStopPointRefs: ["STOP:mid"],
          viaTexts: ["Münsingen"],
        }),
      }),
    );
  });

  it("parses trip info calls and current position", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPTripInfoDelivery>
        <TripInfoResult>
          <Position><siri:Longitude>7.5</siri:Longitude><siri:Latitude>46.85</siri:Latitude></Position>
          <PreviousCall>
            <CallAtStop>
              <siri:StopPointRef>STOP:1</siri:StopPointRef>
              <StopPointName><Text>Bern</Text></StopPointName>
              <ServiceDeparture>
                <TimetabledTime>2025-02-03T14:47:00Z</TimetabledTime>
              </ServiceDeparture>
            </CallAtStop>
          </PreviousCall>
          <OnwardCall>
            <CallAtStop>
              <siri:StopPointRef>STOP:2</siri:StopPointRef>
              <StopPointName><Text>Thun</Text></StopPointName>
              <ServiceArrival>
                <TimetabledTime>2025-02-03T15:15:00Z</TimetabledTime>
              </ServiceArrival>
            </CallAtStop>
          </OnwardCall>
          <Service>
            <JourneyRef>ojp-journey-1</JourneyRef>
            <Occupancy>standingAvailable</Occupancy>
          </Service>
        </TripInfoResult>
      </OJPTripInfoDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

    expect(parseOjpTripInfoResponse(xml).tripInfo).toEqual(
      expect.objectContaining({
        onwardCalls: [expect.objectContaining({ name: "Thun", stopPointRef: "STOP:2" })],
        position: { latitude: 46.85, longitude: 7.5 },
        previousCalls: [expect.objectContaining({ name: "Bern", stopPointRef: "STOP:1" })],
        service: expect.objectContaining({
          journeyRef: "ojp-journey-1",
          occupancy: "standingAvailable",
        }),
      }),
    );
  });

  it("parses OJP fare deliveries", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OJPFareDelivery xmlns="http://www.vdv.de/ojp">
  <FareResult>
    <ResultId>fare-1</ResultId>
    <TripFareResult>
      <FromTripLegIdRef>timed-1</FromTripLegIdRef>
      <ToTripLegIdRef>timed-1</ToTripLegIdRef>
      <FareProduct>
        <FareProductId>fp-1</FareProductId>
        <FareProductName>Point-to-point ticket</FareProductName>
        <FareAuthorityRef>SBB</FareAuthorityRef>
        <FareAuthorityText>SwissPass</FareAuthorityText>
        <Price>19.50</Price>
        <NetPrice>18.04</NetPrice>
        <Currency>CHF</Currency>
        <TravelClass>2</TravelClass>
      </FareProduct>
    </TripFareResult>
  </FareResult>
</OJPFareDelivery>`;

    expect(parseOjpFareResponse(xml)).toEqual({
      fares: [
        {
          id: "fare-1",
          trips: [
            {
              fromLegId: "timed-1",
              products: [
                expect.objectContaining({
                  amount: 19.5,
                  netAmount: 18.04,
                  authorityName: "SwissPass",
                  authorityRef: "SBB",
                  currency: "CHF",
                  id: "fp-1",
                  name: "Point-to-point ticket",
                  travelClass: "2",
                }),
              ],
              toLegId: "timed-1",
            },
          ],
        },
      ],
    });
  });

  it("extracts trip nodes for OJP fare requests", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPTripDelivery>
        <TripResult>
          <Trip>
            <Id>trip-1</Id>
            <Leg>
              <LegId>2</LegId>
              <TimedLeg>
                <LegBoard>
                  <StopPointRef>STOP:1</StopPointRef>
                </LegBoard>
                <LegAlight>
                  <StopPointRef>STOP:2</StopPointRef>
                </LegAlight>
              </TimedLeg>
            </Leg>
          </Trip>
        </TripResult>
      </OJPTripDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

    const tripNodes = extractOjpTripRequestTrips(xml);
    expect(tripNodes).toHaveLength(1);

    const request = buildOjpFareRequestXml({
      fareAuthorityFilter: "ch:1:NOVA",
      trips: tripNodes,
    });

    expect(request).toContain("<OJPFareRequest>");
    expect(request).toContain("<TripFareRequest>");
    expect(request).toContain("<Id>trip-1</Id>");
    expect(request).toContain("<FareAuthorityFilter>ch:1:NOVA</FareAuthorityFilter>");
  });
});
