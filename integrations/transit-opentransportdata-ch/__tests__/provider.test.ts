import { encodeGtfsRtFeed } from "@openmapx/mobility-formats";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVICE_POINTS_PAGE =
  "https://data.opentransportdata.swiss/en/dataset/service-points-actual-date";
const TRAFFIC_POINTS_PAGE = "https://data.opentransportdata.swiss/en/dataset/traffic-point-v2";
const STOP_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/stop-point-v2";
const PLATFORM_PAGE = "https://data.opentransportdata.swiss/en/dataset/platform-v2";
const REFERENCE_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/reference-point-v2";
const CONTACT_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/contact-point-v2";
const TOILET_PAGE = "https://data.opentransportdata.swiss/en/dataset/toilet-v2";
const PARKING_LOT_PAGE = "https://data.opentransportdata.swiss/en/dataset/parking-lot-v2";
const RELATION_PAGE = "https://data.opentransportdata.swiss/en/dataset/relation-v2";
const SERVICE_POINTS_ZIP = "https://files.test/service-points.csv.zip";
const TRAFFIC_POINTS_CSV_URL = "https://files.test/traffic-points.csv";
const STOP_POINT_CSV_URL = "https://files.test/stop-point.csv";
const PLATFORM_CSV_URL = "https://files.test/platform.csv";
const REFERENCE_POINT_CSV_URL = "https://files.test/reference-point.csv";
const CONTACT_POINT_CSV_URL = "https://files.test/contact-point.csv";
const TOILET_CSV_URL = "https://files.test/toilet.csv";
const PARKING_LOT_CSV_URL = "https://files.test/parking-lot.csv";
const RELATION_CSV_URL = "https://files.test/relation.csv";
const GO_REALTIME_URL =
  "https://data.opentransportdata.swiss/dataset/27aba9bd-59ed-4d7c-bc71-a3813d1d1799/resource/83b8b8d0-e345-453b-857e-1192d48c4c64/download/go-realtime.csv";
const GO_SIRI_SX_URL =
  "https://data.opentransportdata.swiss/dataset/b3ac097b-ff72-4a1f-9d69-76e72962d769/resource/a8312f3a-18a6-4e92-9906-bbb623a24369/download/go-siri-sx.csv";
const OCCUPANCY_FORECAST_JSON_PERMALINK =
  "https://data.opentransportdata.swiss/en/dataset/occupancy-forecast-json-dataset/permalink";
const OJP_ENDPOINT = "https://api.opentransportdata.swiss/ojp20";
const OJP_FARE_ENDPOINT = "https://api.opentransportdata.swiss/ojpfare";
const GTFS_SA_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-sa";
const GTFS_RT_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-rt";
const SIRI_SX_ENDPOINT = "https://api.opentransportdata.swiss/la/siri-sx";
const SIRI_SX_UNPLANNED_ENDPOINT = "https://api.opentransportdata.swiss/la/siri-sx-unplanned";
const FORMATION_ENDPOINT = "https://api.opentransportdata.swiss/formation";

const SERVICE_POINTS_CSV = [
  "sloid;number;designationOfficial;designationLong;meansOfTransport;categories;businessOrganisation;businessOrganisationDescriptionDe;businessOrganisationAbbreviationDe;wgs84East;wgs84North;localityName;municipalityName;stopPointType;isoCountryCode;uicCountryCode;cantonName",
  "ch:1:sloid:7000;8507000;Bern;Bern;TRAIN,BUS;rail,bus;ch:1:sboid:100001;Swiss Federal Railways SBB;SBB;7.439136;46.948891;Bern;Bern;STATION;CH;85;Bern",
].join("\n");

const TRAFFIC_POINTS_CSV = [
  "sloid;parentSloidServicePoint;parentSloid;designation;designationOfficial;trafficPointElementType;wgs84East;wgs84North",
  "ch:1:sloid:7000:5:10;ch:1:sloid:7000;ch:1:sloid:7000:5;10;Bern;BOARDING_PLATFORM;7.4393;46.9490",
  "ch:1:sloid:7000:5:11;ch:1:sloid:7000;ch:1:sloid:7000:5;11;Bern;BOARDING_PLATFORM;7.4394;46.9491",
].join("\n");

const STOP_POINT_CSV = [
  "sloid;number;alternativeTransport;assistanceAvailability;audioTicketMachine;dynamicAudioSystem;dynamicOpticSystem;interoperable;ticketMachine;url;visualInfo;wheelchairTicketMachine",
  "ch:1:sloid:7000;8507000;;AVAILABLE;YES;YES;YES;YES;YES;https://station.example;YES;YES",
].join("\n");

const PLATFORM_CSV = [
  "sloid;levelAccessWheelchair;dynamicAudio;dynamicVisual;contrastingAreas;tactileSystems;vehicleAccess",
  "ch:1:sloid:7000:5:10;PLATFORM_ACCESS_WITHOUT_ASSISTANCE;YES;YES;YES;YES;PLATFORM_ACCESS_WITH_ASSISTANCE",
  "ch:1:sloid:7000:5:11;PLATFORM_ACCESS_WITH_ASSISTANCE;NO;YES;NO;NO;PLATFORM_ACCESS_WITH_ASSISTANCE",
].join("\n");

const REFERENCE_POINT_CSV = [
  "sloid;parentSloidServicePoint;designation;mainReferencePoint;referencePointType",
  "ch:1:sloid:7000:entrance;ch:1:sloid:7000;Main entrance;true;MAIN_STATION_ENTRANCE",
].join("\n");

const CONTACT_POINT_CSV = [
  "sloid;parentSloidServicePoint;type;designation;inductionLoop",
  "ch:1:sloid:7000:info;ch:1:sloid:7000;INFORMATION_DESK;Info desk;YES",
].join("\n");

const TOILET_CSV = [
  "sloid;parentSloidServicePoint;designation;wheelchairToilet",
  "ch:1:sloid:7000:toilet;ch:1:sloid:7000;Toilet;YES",
].join("\n");

const PARKING_LOT_CSV = [
  "sloid;parentSloidServicePoint;designation;additionalInformation",
  "ch:1:sloid:7000:parking;ch:1:sloid:7000;Park+Rail;22 / 1 Parkplätze",
].join("\n");

const RELATION_CSV = [
  "elementSloid;parentSloidServicePoint;stepFreeAccess",
  "ch:1:sloid:7000:parking;ch:1:sloid:7000;YES",
].join("\n");

const GO_REALTIME_CSV = [
  "sboid;descriptionEn;abbreviationEn;vdvBetreiberId;source;etAUS;ptREFAUS;complete;comment",
  "ch:1:sboid:100001;Swiss Federal Railways SBB;SBB;85:11:00;realtime;;;true;",
].join("\n");

const GO_SIRI_SX_CSV = [
  "sboid;descriptionEn;abbreviationEn;participantRef;sboidOwnerRef;vdvBetreiberId;comment",
  "ch:1:sboid:100001;Swiss Federal Railways SBB;SBB;SBBP;ch:1:sboid:100001;85:11:00;",
].join("\n");

const LOCATION_RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPLocationInformationDelivery>
        <PlaceResult>
          <Complete>true</Complete>
          <Place>
            <StopPlace>
              <StopPlaceRef>8507000</StopPlaceRef>
              <StopPlaceName><Text>Bern</Text></StopPlaceName>
              <TopographicPlaceRef>23000001:1</TopographicPlaceRef>
            </StopPlace>
            <Name><Text>Bern</Text></Name>
            <GeoPosition>
              <siri:Longitude>7.439136</siri:Longitude>
              <siri:Latitude>46.948891</siri:Latitude>
            </GeoPosition>
            <Mode><PtMode>rail</PtMode></Mode>
            <Mode><PtMode>bus</PtMode></Mode>
          </Place>
        </PlaceResult>
      </OJPLocationInformationDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

const STOP_EVENT_RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPStopEventDelivery>
        <StopEventResult>
          <StopEvent>
            <ThisCall>
              <CallAtStop>
                <siri:StopPointRef>ch:1:sloid:7000:5:10</siri:StopPointRef>
                <StopPointName><Text>Bern</Text></StopPointName>
                <PlannedQuay>10</PlannedQuay>
                <EstimatedQuay>10</EstimatedQuay>
                <Order>1</Order>
                <ServiceDeparture>
                  <TimetabledTime>2025-02-03T14:47:00Z</TimetabledTime>
                  <EstimatedTime>2025-02-03T14:48:00Z</EstimatedTime>
                  <Occupancy>standingAvailable</Occupancy>
                </ServiceDeparture>
              </CallAtStop>
            </ThisCall>
            <OnwardCall>
              <CallAtStop>
                <siri:StopPointRef>ch:1:sloid:7050:0:1</siri:StopPointRef>
                <StopPointName><Text>Münsingen</Text></StopPointName>
                <Order>2</Order>
                <ServiceArrival>
                  <TimetabledTime>2025-02-03T15:00:00Z</TimetabledTime>
                </ServiceArrival>
                <ServiceDeparture>
                  <TimetabledTime>2025-02-03T15:01:00Z</TimetabledTime>
                </ServiceDeparture>
              </CallAtStop>
            </OnwardCall>
            <OnwardCall>
              <CallAtStop>
                <siri:StopPointRef>ch:1:sloid:7100:3:4</siri:StopPointRef>
                <StopPointName><Text>Thun</Text></StopPointName>
                <PlannedQuay>3</PlannedQuay>
                <EstimatedQuay>3</EstimatedQuay>
                <Order>3</Order>
                <ServiceArrival>
                  <TimetabledTime>2025-02-03T15:15:00Z</TimetabledTime>
                  <EstimatedTime>2025-02-03T15:16:00Z</EstimatedTime>
                </ServiceArrival>
              </CallAtStop>
            </OnwardCall>
            <Service>
              <OperatingDayRef>2025-02-03</OperatingDayRef>
              <JourneyRef>ojp-92-12-_-j25-1-419-TA</JourneyRef>
              <siri:LineRef>ojp:91006:H</siri:LineRef>
              <OperatorRef>SBB</OperatorRef>
              <Mode><PtMode>rail</PtMode></Mode>
              <PublishedServiceName><Text>IC6</Text></PublishedServiceName>
              <DestinationText><Text>Thun</Text></DestinationText>
              <Occupancy>standingAvailable</Occupancy>
            </Service>
          </StopEvent>
        </StopEventResult>
      </OJPStopEventDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

const STOP_EVENT_RESPONSE_NO_OCCUPANCY_XML = STOP_EVENT_RESPONSE_XML.replace(
  "<Occupancy>standingAvailable</Occupancy>",
  "",
).replace("<Occupancy>standingAvailable</Occupancy>", "");

const TRIP_RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPTripDelivery>
        <TripResponseContext>
          <Places>
            <Place>
              <StopPoint>
                <siri:StopPointRef>ch:1:sloid:7000:5:10</siri:StopPointRef>
                <StopPointName><Text>Bern</Text></StopPointName>
                <ParentRef>8507000</ParentRef>
              </StopPoint>
              <Name><Text>Bern</Text></Name>
              <GeoPosition><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></GeoPosition>
            </Place>
            <Place>
              <StopPoint>
                <siri:StopPointRef>ch:1:sloid:7100:3:4</siri:StopPointRef>
                <StopPointName><Text>Thun</Text></StopPointName>
                <ParentRef>8507100</ParentRef>
              </StopPoint>
              <Name><Text>Thun</Text></Name>
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
            <Leg>
              <Id>1</Id>
              <Duration>PT3M</Duration>
              <ContinuousLeg>
                <LegStart>
                  <GeoPosition><siri:Longitude>7.4380</siri:Longitude><siri:Latitude>46.9480</siri:Latitude></GeoPosition>
                  <Name><Text>Origin</Text></Name>
                </LegStart>
                <LegEnd>
                  <siri:StopPointRef>ch:1:sloid:7000:5:10</siri:StopPointRef>
                  <Name><Text>Bern</Text></Name>
                </LegEnd>
                <LegProjection>
                  <Position><siri:Longitude>7.4380</siri:Longitude><siri:Latitude>46.9480</siri:Latitude></Position>
                  <Position><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></Position>
                </LegProjection>
                <Service><PersonalMode>foot</PersonalMode></Service>
                <Duration>PT3M</Duration>
                <Length>250</Length>
              </ContinuousLeg>
            </Leg>
            <Leg>
              <Id>2</Id>
              <Duration>PT28M</Duration>
              <TimedLeg>
                <LegBoard>
                  <siri:StopPointRef>ch:1:sloid:7000:5:10</siri:StopPointRef>
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
                <LegIntermediate>
                  <siri:StopPointRef>ch:1:sloid:7050:0:1</siri:StopPointRef>
                  <StopPointName><Text>Münsingen</Text></StopPointName>
                </LegIntermediate>
                <LegAlight>
                  <siri:StopPointRef>ch:1:sloid:7100:3:4</siri:StopPointRef>
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
                <Service>
                  <OperatingDayRef>2025-02-03</OperatingDayRef>
                  <JourneyRef>ojp-92-12-_-j25-1-419-TA</JourneyRef>
                  <siri:LineRef>ojp:91006:H</siri:LineRef>
                  <OperatorRef>SBB</OperatorRef>
                  <VehicleRef>TRAIN:1</VehicleRef>
                  <Mode><PtMode>rail</PtMode></Mode>
                  <PublishedServiceName><Text>IC6</Text></PublishedServiceName>
                  <DestinationText><Text>Thun</Text></DestinationText>
                  <Occupancy>standingAvailable</Occupancy>
                  <Attribute><UserText><Text>Bike spaces limited</Text></UserText></Attribute>
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

const TRIP_INFO_RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPResponse>
    <siri:ServiceDelivery>
      <OJPTripInfoDelivery>
        <TripInfoResult>
          <Position><siri:Longitude>7.5000</siri:Longitude><siri:Latitude>46.8500</siri:Latitude></Position>
          <PreviousCall>
            <CallAtStop>
              <siri:StopPointRef>ch:1:sloid:7000:5:10</siri:StopPointRef>
              <StopPointName><Text>Bern</Text></StopPointName>
              <ServiceDeparture>
                <TimetabledTime>2025-02-03T14:47:00Z</TimetabledTime>
                <EstimatedTime>2025-02-03T14:48:00Z</EstimatedTime>
              </ServiceDeparture>
            </CallAtStop>
          </PreviousCall>
          <OnwardCall>
            <CallAtStop>
              <siri:StopPointRef>ch:1:sloid:7050:0:1</siri:StopPointRef>
              <StopPointName><Text>Münsingen</Text></StopPointName>
              <ServiceArrival>
                <TimetabledTime>2025-02-03T15:00:00Z</TimetabledTime>
              </ServiceArrival>
              <ServiceDeparture>
                <TimetabledTime>2025-02-03T15:01:00Z</TimetabledTime>
              </ServiceDeparture>
            </CallAtStop>
          </OnwardCall>
          <OnwardCall>
            <CallAtStop>
              <siri:StopPointRef>ch:1:sloid:7100:3:4</siri:StopPointRef>
              <StopPointName><Text>Thun</Text></StopPointName>
              <ServiceArrival>
                <TimetabledTime>2025-02-03T15:15:00Z</TimetabledTime>
                <EstimatedTime>2025-02-03T15:16:00Z</EstimatedTime>
              </ServiceArrival>
            </CallAtStop>
          </OnwardCall>
          <Service>
            <OperatingDayRef>2025-02-03</OperatingDayRef>
            <JourneyRef>ojp-92-12-_-j25-1-419-TA</JourneyRef>
            <siri:LineRef>ojp:91006:H</siri:LineRef>
            <OperatorRef>SBB</OperatorRef>
            <PublishedServiceName><Text>IC6</Text></PublishedServiceName>
            <DestinationText><Text>Thun</Text></DestinationText>
            <Occupancy>standingAvailable</Occupancy>
            <Attribute><UserText><Text>Bike spaces limited</Text></UserText></Attribute>
            <DatedTrainNumberRefGroup>
              <DatedTrainNumberRef>IC6-419</DatedTrainNumberRef>
              <OperatorRef>SBB</OperatorRef>
              <OperatingDayRef>2025-02-03</OperatingDayRef>
            </DatedTrainNumberRefGroup>
          </Service>
          <JourneyTrack>
            <TrackSection>
              <TrackSectionStart><siri:StopPointRef>8507000</siri:StopPointRef></TrackSectionStart>
              <TrackSectionEnd><siri:StopPointRef>8507100</siri:StopPointRef></TrackSectionEnd>
              <LinkProjection>
                <Position><siri:Longitude>7.4393</siri:Longitude><siri:Latitude>46.9490</siri:Latitude></Position>
                <Position><siri:Longitude>7.5000</siri:Longitude><siri:Latitude>46.8500</siri:Latitude></Position>
                <Position><siri:Longitude>7.6290</siri:Longitude><siri:Latitude>46.7580</siri:Latitude></Position>
              </LinkProjection>
              <Duration>PT28M</Duration>
            </TrackSection>
          </JourneyTrack>
        </TripInfoResult>
      </OJPTripInfoDelivery>
    </siri:ServiceDelivery>
  </OJPResponse>
</OJP>`;

const FARE_RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OJPFareDelivery xmlns="http://www.vdv.de/ojp">
  <FareResult>
    <ResultId>fare-1</ResultId>
    <TripFareResult>
      <FromTripLegIdRef>2</FromTripLegIdRef>
      <ToTripLegIdRef>2</ToTripLegIdRef>
      <FareProduct>
        <FareProductId>fp-1</FareProductId>
        <FareProductName>Point-to-point ticket</FareProductName>
        <FareAuthorityRef>NOVA</FareAuthorityRef>
        <FareAuthorityText>NOVA</FareAuthorityText>
        <Price>24.00</Price>
        <NetPrice>22.28</NetPrice>
        <Currency>CHF</Currency>
        <TravelClass>second</TravelClass>
      </FareProduct>
    </TripFareResult>
  </FareResult>
</OJPFareDelivery>`;

const SIRI_SX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri">
  <ServiceDelivery>
    <SituationExchangeDelivery>
      <Situations>
        <PtSituationElement>
          <SituationNumber>sx-1</SituationNumber>
          <Summary><en>Track closure</en></Summary>
          <Description><en>Use platform 9 instead.</en></Description>
          <ValidityPeriods>
            <ValidityPeriod>
              <StartTime>2025-02-03T14:00:00Z</StartTime>
              <EndTime>2025-02-03T18:00:00Z</EndTime>
            </ValidityPeriod>
          </ValidityPeriods>
          <Consequences>
            <Consequence>
              <Effect>stopMoved</Effect>
              <Severity>severe</Severity>
              <Advice><en>Use platform 9 instead.</en></Advice>
            </Consequence>
          </Consequences>
          <Affects>
            <Networks>
              <AffectedNetwork>
                <AffectedLine>
                  <LineRef>IC6</LineRef>
                </AffectedLine>
              </AffectedNetwork>
            </Networks>
            <Operators>
              <AffectedOperator>
                <OperatorRef>SBB</OperatorRef>
              </AffectedOperator>
            </Operators>
            <StopPoints>
              <AffectedStopPoint>
                <StopPointRef>8507000</StopPointRef>
              </AffectedStopPoint>
            </StopPoints>
          </Affects>
        </PtSituationElement>
      </Situations>
    </SituationExchangeDelivery>
  </ServiceDelivery>
</Siri>`;

const FORMATION_RESPONSE = {
  lastUpdate: "2025-02-03T14:40:00Z",
  journeyMetaInformation: {
    operationDate: "2025-02-03",
  },
  trainMetaInformation: {
    trainNumber: "419",
  },
  formationsAtScheduledStops: [
    {
      formationShort: {
        formationShortString: "A-B",
      },
      scheduledStop: {
        stopPoint: {
          designationOfficial: "Bern",
          uic: "8507000",
        },
        stopTime: "2025-02-03T14:47:00Z",
        track: "10",
      },
    },
  ],
  formations: [
    {
      metaInformation: {
        length: 400,
        numberSeats: 520,
        numberVehicles: 2,
      },
      formationVehicles: [
        {
          vehicleMetaInformation: {
            id: "veh-1",
            length: 200,
            order: 1,
            vehicleNumber: "5001",
            vehicleTypeAbbreviation: "IC2000",
            vehicleTypeDesignation: "Coach",
          },
          vehicleProperties: {
            climated: true,
            lowFloor: false,
            numberBicycleHooks: 4,
            numberFirstClassSeats: 80,
            numberSecondClassSeats: 180,
            numberWheelchairPlaces: 2,
            toilet: true,
          },
          formationVehicleStops: [
            {
              sector: "A",
            },
          ],
        },
      ],
    },
  ],
};

const OCCUPANCY_FORECAST_JSON = {
  operatorRef: "11",
  opDate: "2025-02-03",
  lastUpdated: "2025-02-01T10:00:00+01:00",
  timeToLive: 86400,
  version: "0.9",
  trains: [
    {
      trainNumber: "419",
      journeyRef: "ojp-92-12-_-j25-1-419-TA",
      lineRef: "ojp:91006:H",
      sections: [
        {
          departureDayShift: 0,
          departureStationId: "8507000",
          departureStationName: "Bern",
          departureTime: "15:47:00",
          destinationStationId: "8507100",
          destinationStationName: "Thun",
          expectedDepartureOccupancies: [
            {
              fareClass: "secondClass",
              occupancyLevel: "fewSeatsAvailable",
            },
          ],
        },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === SERVICE_POINTS_PAGE) {
      return new Response(`<a href="${SERVICE_POINTS_ZIP}">download</a>`, { status: 200 });
    }
    if (url === TRAFFIC_POINTS_PAGE) {
      return new Response(`<a href="${TRAFFIC_POINTS_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === STOP_POINT_PAGE) {
      return new Response(`<a href="${STOP_POINT_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === PLATFORM_PAGE) {
      return new Response(`<a href="${PLATFORM_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === REFERENCE_POINT_PAGE) {
      return new Response(`<a href="${REFERENCE_POINT_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === CONTACT_POINT_PAGE) {
      return new Response(`<a href="${CONTACT_POINT_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === TOILET_PAGE) {
      return new Response(`<a href="${TOILET_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === PARKING_LOT_PAGE) {
      return new Response(`<a href="${PARKING_LOT_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === RELATION_PAGE) {
      return new Response(`<a href="${RELATION_CSV_URL}">download</a>`, { status: 200 });
    }
    if (url === SERVICE_POINTS_ZIP) {
      return new Response(zipSync({ "service-points.csv": strToU8(SERVICE_POINTS_CSV) }), {
        status: 200,
      });
    }
    if (url === TRAFFIC_POINTS_CSV_URL) return new Response(TRAFFIC_POINTS_CSV, { status: 200 });
    if (url === STOP_POINT_CSV_URL) return new Response(STOP_POINT_CSV, { status: 200 });
    if (url === PLATFORM_CSV_URL) return new Response(PLATFORM_CSV, { status: 200 });
    if (url === REFERENCE_POINT_CSV_URL) return new Response(REFERENCE_POINT_CSV, { status: 200 });
    if (url === CONTACT_POINT_CSV_URL) return new Response(CONTACT_POINT_CSV, { status: 200 });
    if (url === TOILET_CSV_URL) return new Response(TOILET_CSV, { status: 200 });
    if (url === PARKING_LOT_CSV_URL) return new Response(PARKING_LOT_CSV, { status: 200 });
    if (url === RELATION_CSV_URL) return new Response(RELATION_CSV, { status: 200 });
    if (url === GO_REALTIME_URL) return new Response(GO_REALTIME_CSV, { status: 200 });
    if (url === GO_SIRI_SX_URL) return new Response(GO_SIRI_SX_CSV, { status: 200 });
    if (url === OCCUPANCY_FORECAST_JSON_PERMALINK) {
      return new Response(
        zipSync({
          "2025-02-03/operator-11.json": strToU8(JSON.stringify(OCCUPANCY_FORECAST_JSON)),
        }),
        { status: 200 },
      );
    }
    if (url === OJP_ENDPOINT) {
      const body = String(init?.body ?? "");
      if (body.includes("OJPLocationInformationRequest")) {
        return new Response(LOCATION_RESPONSE_XML, { status: 200 });
      }
      if (body.includes("OJPStopEventRequest")) {
        return new Response(STOP_EVENT_RESPONSE_XML, { status: 200 });
      }
      if (body.includes("OJPTripRequest")) {
        return new Response(TRIP_RESPONSE_XML, { status: 200 });
      }
      if (body.includes("OJPTripInfoRequest")) {
        return new Response(TRIP_INFO_RESPONSE_XML, { status: 200 });
      }
    }
    if (url === OJP_FARE_ENDPOINT) {
      const body = String(init?.body ?? "");
      if (body.includes("OJPFareRequest") && body.includes("TripFareRequest")) {
        return new Response(FARE_RESPONSE_XML, { status: 200 });
      }
    }
    if (url === GTFS_SA_ENDPOINT) {
      const bytes = encodeGtfsRtFeed({
        header: { gtfsRealtimeVersion: "2.0", timestamp: 1_739_846_400 },
        entity: [
          {
            id: "alert-1",
            alert: {
              activePeriod: [{ start: 1_739_846_400 }],
              descriptionText: {
                translation: [{ text: "Lift outage at Bern station" }],
              },
              headerText: {
                translation: [{ text: "Accessibility disruption" }],
              },
              informedEntity: [{ stopId: "ch:1:sloid:7000" }],
              severityLevel: 3,
            },
          },
        ],
      });
      return new Response(bytes, { status: 200 });
    }
    if (url === GTFS_RT_ENDPOINT) {
      const bytes = encodeGtfsRtFeed({
        header: { gtfsRealtimeVersion: "2.0", timestamp: 1_739_846_400 },
        entity: [
          {
            id: "trip-update-1",
            tripUpdate: {
              trip: {
                routeId: "IC6",
                scheduleRelationship: 0,
                startDate: "20250203",
                tripId: "gtfs-trip-1",
              },
              stopTimeUpdate: [
                {
                  departure: { delay: 120, scheduleRelationship: 1 },
                  stopId: "ch:1:sloid:7000:5:10",
                  stopSequence: 1,
                  scheduleRelationship: 1,
                },
              ],
              timestamp: 1_739_846_520,
            },
          },
        ],
      });
      return new Response(bytes, { status: 200 });
    }
    if (url === SIRI_SX_ENDPOINT || url === SIRI_SX_UNPLANNED_ENDPOINT) {
      return new Response(SIRI_SX_XML, { status: 200 });
    }
    if (
      url ===
      `${FORMATION_ENDPOINT}/v2/formations_full?evu=SBBP&operationDate=2025-02-03&trainNumber=419`
    ) {
      return Response.json(FORMATION_RESPONSE);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadProvider() {
  vi.resetModules();
  const provider = await import("../provider.js");
  provider.setOpenTransportDataChConfig({
    apiKey: "test-key",
    formationEndpoint: FORMATION_ENDPOINT,
    gtfsRtEndpoint: GTFS_RT_ENDPOINT,
    gtfsSaEndpoint: GTFS_SA_ENDPOINT,
    ojpEndpoint: OJP_ENDPOINT,
    ojpFareEndpoint: OJP_FARE_ENDPOINT,
    requestLanguage: "de",
    requestorRef: "OpenMapX-Tests",
    siriSxEndpoint: SIRI_SX_ENDPOINT,
    siriSxUnplannedEndpoint: SIRI_SX_UNPLANNED_ENDPOINT,
  });
  return provider;
}

describe("transit-opentransportdata-ch provider", () => {
  it("maps OJP stop search results and preserves DIDOK and SLOID ids", async () => {
    const provider = await loadProvider();

    const stops = await provider.searchByName("Bern", 5);

    expect(stops).toEqual([
      expect.objectContaining({
        id: "otdch:8507000",
        codes: [
          { namespace: "uic", value: "8507000" },
          { namespace: "ifopt", value: "ch:1:sloid:7000" },
        ],
        ids: {
          didok: "8507000",
          otdch: "8507000",
          sloid: "ch:1:sloid:7000",
        },
        lat: 46.948891,
        lng: 7.439136,
        modes: ["rail", "bus"],
        name: "Bern",
        primaryScheme: "didok",
        provider: "otdch",
      }),
    ]);
  });

  it("applies Swiss GTFS-RT stop-board overlays and business-organisation metadata", async () => {
    const provider = await loadProvider();

    const departures = await provider.getDepartures("otdch:8507000", 30);

    expect(departures).toEqual([
      expect.objectContaining({
        canceled: true,
        delaySeconds: 60,
        headsign: "Thun",
        serviceInfo: expect.objectContaining({
          canceled: true,
          operatorAbbreviation: "SBB",
          operatorName: "Swiss Federal Railways SBB",
          operatorOrganisationNumber: "11",
          operatorParticipantRef: "SBBP",
        }),
        tripId: "otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA",
      }),
    ]);
  });

  it("builds Swiss stop infrastructure from master data and accessibility datasets", async () => {
    const provider = await loadProvider();

    const infrastructure = await provider.getStopInfrastructure("otdch:8507000");

    expect(infrastructure).toEqual(
      expect.objectContaining({
        canonicalStop: expect.objectContaining({
          id: "otdch:ch:1:sloid:7000",
          level: "parent_stop",
          name: "Bern",
        }),
        childStops: expect.arrayContaining([
          expect.objectContaining({
            id: "otdch:ch:1:sloid:7000:5",
            level: "child_stop",
          }),
        ]),
        parking: expect.arrayContaining([
          expect.objectContaining({
            id: "otdch:ch:1:sloid:7000:parking",
            name: "Park+Rail",
          }),
        ]),
        platforms: expect.arrayContaining([
          expect.objectContaining({
            id: "otdch:ch:1:sloid:7000:5:10",
            publicCode: "10",
          }),
        ]),
        stationIntelligence: expect.objectContaining({
          complexity: "regional_hub",
          hasParking: true,
        }),
      }),
    );
    expect(infrastructure?.accessibility).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Step-free access", available: true }),
        expect.objectContaining({ label: "Wheelchair-accessible toilet", available: true }),
      ]),
    );
  });

  it("maps OJP trip results and resolves TripInfo geometry from the encoded journey id", async () => {
    const provider = await loadProvider();

    const plan = await provider.planTrip({
      from: { lat: 46.948, lng: 7.438 },
      to: { lat: 46.758, lng: 7.629 },
      departureTime: "2025-02-03T14:45:00Z",
    });

    expect(plan?.itineraries).toHaveLength(1);
    expect(plan?.itineraries[0]?.distanceMeters).toBe(31_250);
    expect(plan?.itineraries[0]?.fare).toEqual(
      expect.objectContaining({
        results: [
          {
            fromLegId: "2",
            products: [
              expect.objectContaining({
                amount: 24,
                authorityName: "NOVA",
                authorityRef: "NOVA",
                currency: "CHF",
                id: "fp-1",
                netAmount: 22.28,
                travelClass: "second",
              }),
            ],
            toLegId: "2",
          },
        ],
        source: "ojpfare",
      }),
    );
    expect(plan?.itineraries[0].walkDistance).toBe(250);
    expect(plan?.itineraries[0].legs[1]).toEqual(
      expect.objectContaining({
        alightNameSuffix: "Gleis 3",
        boardNameSuffix: "Gleis 10",
        effectiveFareLegIndex: 0,
        fareTransferIndex: 0,
        formation: [
          {
            operatorRef: "SBB",
            operatingDayRef: "2025-02-03",
            trainNumber: "IC6-419",
          },
        ],
        occupancy: "medium",
        route: expect.objectContaining({ shortName: "IC6" }),
        routeId: "otdch:ojp:91006:H",
        serviceInfo: expect.objectContaining({
          journeyRef: "ojp-92-12-_-j25-1-419-TA",
          occupancy: "medium",
          occupancyRaw: "standingAvailable",
          vehicleRef: "TRAIN:1",
        }),
        tripId: "otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA",
      }),
    );
    expect(plan?.itineraries[0].legs[0]?.effectiveFareLegIndex).toBeUndefined();
    expect(plan?.itineraries[0].legs[0]?.fareTransferIndex).toBeUndefined();

    const geometry = await provider.getLegGeometry(
      "otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA",
      "otdch:ch:1:sloid:7000:5:10",
      "otdch:ch:1:sloid:7100:3:4",
    );

    expect(geometry).toEqual({
      type: "LineString",
      coordinates: [
        [7.4393, 46.949],
        [7.5, 46.85],
        [7.629, 46.758],
      ],
    });

    const journey = await provider.getVehicleJourney("otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA");

    expect(journey).toEqual(
      expect.objectContaining({
        formation: [
          {
            operatorRef: "SBB",
            operatingDayRef: "2025-02-03",
            trainNumber: "IC6-419",
          },
        ],
        formationDetails: expect.objectContaining({
          operatorCode: "SBBP",
          seats: 520,
          shortFormation: "A-B",
          source: "opentransportdata.swiss/formation",
          trainNumber: "419",
          vehicleCount: 2,
          vehicles: [
            expect.objectContaining({
              bikeSpaces: 4,
              hasAirConditioning: true,
              hasToilet: true,
              seatsFirstClass: 80,
              seatsSecondClass: 180,
              typeCode: "IC2000",
              wheelchairSpaces: 2,
            }),
          ],
        }),
        id: "otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA",
        name: "IC6",
        occupancy: "medium",
        remarks: [{ text: "Bike spaces limited", type: "info" }],
        serviceInfo: expect.objectContaining({
          occupancy: "medium",
          occupancyRaw: "standingAvailable",
          operatorAbbreviation: "SBB",
          operatorName: "Swiss Federal Railways SBB",
          operatorOrganisationNumber: "11",
          operatorParticipantRef: "SBBP",
        }),
        stops: [
          expect.objectContaining({ name: "Bern", stopId: "otdch:ch:1:sloid:7000:5:10" }),
          expect.objectContaining({ name: "Münsingen", stopId: "otdch:ch:1:sloid:7050:0:1" }),
          expect.objectContaining({ name: "Thun", stopId: "otdch:ch:1:sloid:7100:3:4" }),
        ],
      }),
    );
  });

  it("maps GTFS-SA alerts and matches Swiss stop alerts across DIDOK/SLOID forms", async () => {
    const provider = await loadProvider();

    const alerts = await provider.getStopAlerts("otdch:8507000");

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          affectedStopIds: expect.arrayContaining(["otdch:8507000", "otdch:ch:1:sloid:7000"]),
          severity: "warning",
          title: "Accessibility disruption",
        }),
      ]),
    );
  });

  it("fills missing Swiss occupancy from the daily forecast dataset", async () => {
    const provider = await loadProvider();
    const defaultImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === OJP_ENDPOINT && String(init?.body ?? "").includes("OJPStopEventRequest")) {
        return new Response(STOP_EVENT_RESPONSE_NO_OCCUPANCY_XML, { status: 200 });
      }
      if (!defaultImpl) {
        throw new Error(`Unexpected request without default mock: ${url}`);
      }
      return defaultImpl(input, init);
    });

    const departures = await provider.getDepartures("otdch:8507000", 30);

    expect(departures).toEqual([
      expect.objectContaining({
        occupancy: "high",
        serviceInfo: expect.objectContaining({
          occupancy: "high",
          occupancyRaw: "fewSeatsAvailable",
          occupancySource: "opentransportdata.swiss/occupancy-forecast",
        }),
      }),
    ]);
  });

  it("exposes Swiss route detail endpoints from observed OJP departures", async () => {
    const provider = await loadProvider();

    const routes = await provider.getRoutesForStop("otdch:8507000");

    expect(routes).toEqual([
      expect.objectContaining({
        id: "otdch:ojp:91006:H",
        longName: "Thun",
        mode: "rail",
        operatorName: "Swiss Federal Railways SBB",
        shortName: "IC6",
      }),
    ]);

    expect(await provider.getRoute("otdch:ojp:91006:H")).toEqual(
      expect.objectContaining({
        id: "otdch:ojp:91006:H",
        longName: "Thun",
        mode: "rail",
        operatorName: "Swiss Federal Railways SBB",
        shortName: "IC6",
      }),
    );

    expect(await provider.getRouteStops("otdch:ojp:91006:H")).toEqual([
      expect.objectContaining({
        id: "otdch:ch:1:sloid:7000:5:10",
        name: "Bern",
        platformCode: "10",
        sequence: 1,
      }),
      expect.objectContaining({
        id: "otdch:ch:1:sloid:7050:0:1",
        name: "Münsingen",
        sequence: 2,
      }),
      expect.objectContaining({
        id: "otdch:ch:1:sloid:7100:3:4",
        name: "Thun",
        platformCode: "3",
        sequence: 3,
      }),
    ]);
  });

  it("merges Swiss SIRI-SX situations into route alerts", async () => {
    const provider = await loadProvider();

    await provider.getRoutesForStop("otdch:8507000");
    const alerts = await provider.getRouteAlerts("otdch:ojp:91006:H");

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          affectedStopIds: expect.arrayContaining(["otdch:8507000"]),
          severity: "critical",
          title: "Track closure",
        }),
      ]),
    );
  });
});
