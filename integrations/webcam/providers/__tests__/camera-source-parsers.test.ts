import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNswCameras } from "../au-nsw-webcam.js";
import { parseOntarioCameras } from "../ca-ontario.js";
import { bboxOverlaps } from "../camera-source.js";
import { parseDgtCameras } from "../es-dgt-webcam.js";
import { fiDigitrafficWebcam, parseDigitrafficCameras } from "../fi-digitraffic-webcam.js";
import { parseHongKongCameras } from "../hk-transport.js";
import { parseIcelandCameras } from "../is-road-administration.js";
import { parseNpraCameras } from "../no-npra.js";
import { parseTrafikverketCameras } from "../se-trafikverket.js";
import { parseTdxCameras } from "../tw-tdx-webcam.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("camera-source coverage", () => {
  it("detects overlapping and disjoint bounding boxes", () => {
    const finland = { west: 19, south: 59, east: 32, north: 71 };
    expect(bboxOverlaps(finland, { west: 24, south: 60, east: 25, north: 61 })).toBe(true);
    expect(bboxOverlaps(finland, { west: -1, south: 50, east: 1, north: 51 })).toBe(false);
  });
});

describe("public camera-source parsers", () => {
  it("uses Digitraffic's required client header without the rejected User-Agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ features: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fiDigitrafficWebcam.fetchAll();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tie.digitraffic.fi/api/weathercam/v1/stations",
      expect.objectContaining({
        headers: { "Digitraffic-User": "OpenMapX/1.0" },
      }),
    );
  });

  it("parses Finland Digitraffic GeoJSON", () => {
    expect(
      parseDigitrafficCameras({
        features: [
          {
            id: "C01503",
            geometry: { coordinates: [23.99616, 60.05374, 0] },
            properties: {
              id: "C01503",
              name: "kt51_Inkoo",
              dataUpdatedTime: "2026-07-29T03:25:36Z",
              presets: [{ id: "C0150301", inCollection: true }],
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "fi-digitraffic-webcam:C01503",
        coordinates: [23.99616, 60.05374],
        thumbnailUrl: "https://weathercam.digitraffic.fi/C0150301.jpg?thumbnail=true",
      }),
    ]);
  });

  it("parses Iceland Road Administration JSON", () => {
    expect(
      parseIcelandCameras([
        {
          Maelist_nr: 7001,
          Myndavel: "Hellisheiði",
          Vegheiti: "Hringvegur",
          Skyring: "Hellisheiði séð til vesturs",
          Slod: "https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg",
          Breidd: 64.018296,
          Lengd: -21.342636,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "is-road-administration:7001",
        name: "Hellisheiði",
        coordinates: [-21.342636, 64.018296],
        road: "Hringvegur",
      }),
    ]);
  });

  it("parses Spain DGT DATEX II XML", () => {
    const xml = `
      <d2:payload xmlns:d2="urn:d2" xmlns:ns2="urn:device" xmlns:loc="urn:location" xmlns:fse="urn:ext">
        <ns2:device id="176130">
          <ns2:typeOfDevice>camera</ns2:typeOfDevice>
          <ns2:lastUpdateOfDeviceInformation>2025-10-28T14:19:42+01:00</ns2:lastUpdateOfDeviceInformation>
          <ns2:pointLocation>
            <loc:supplementaryPositionalDescription><loc:roadInformation>
              <loc:roadDestination>BURGOS</loc:roadDestination><loc:roadName>A-62</loc:roadName>
            </loc:roadInformation></loc:supplementaryPositionalDescription>
            <loc:tpegPointLocation><loc:point><loc:pointCoordinates>
              <loc:latitude>42.2624</loc:latitude><loc:longitude>-3.9403</loc:longitude>
            </loc:pointCoordinates></loc:point></loc:tpegPointLocation>
          </ns2:pointLocation>
          <fse:deviceUrl>https://etraffic.dgt.es/camarasEtraffic/176130.jpg</fse:deviceUrl>
        </ns2:device>
      </d2:payload>`;

    expect(parseDgtCameras(xml)).toEqual([
      expect.objectContaining({
        id: "es-dgt-webcam:176130",
        name: "A-62 → BURGOS",
        coordinates: [-3.9403, 42.2624],
        road: "A-62",
        direction: "BURGOS",
      }),
    ]);
  });

  it("parses Ontario 511 camera views", () => {
    expect(
      parseOntarioCameras([
        {
          Id: 1,
          Roadway: "QEW",
          Direction: "Unknown",
          Latitude: 42.9142736713825,
          Longitude: -78.9580061508579,
          Location: "QEW West of Thompson Road",
          Views: [
            {
              Url: "https://511on.ca/map/Cctv/1",
              Status: "Enabled",
              Description: "Toronto Bound",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "ca-ontario:1",
        road: "QEW",
        direction: "Toronto Bound",
        thumbnailUrl: "https://511on.ca/map/Cctv/1",
      }),
    ]);
  });

  it("parses Hong Kong's double-BOM UTF-16 TSV", () => {
    const text =
      "\uFEFF\uFEFFkey\tregion\tdistrict\tdescription\teasting\tnorthing\tlatitude\tlongitude\turl\r\n" +
      "H429F\tHong Kong Island\tSouthern\tAberdeen Praya Road [H429F]\t833549\t812187\t22.24845\t114.1505\thttps://tdcctv.data.one.gov.hk/H429F.JPG\r\n";
    const bytes = Buffer.from(text, "utf16le");

    expect(
      parseHongKongCameras(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    ).toEqual([
      expect.objectContaining({
        id: "hk-transport:H429F",
        coordinates: [114.1505, 22.24845],
        thumbnailUrl: "https://tdcctv.data.one.gov.hk/H429F.JPG",
      }),
    ]);
  });
});

describe("credentialed camera-source parsers", () => {
  it("parses Trafikverket Camera v1 geometry and numeric direction", () => {
    expect(
      parseTrafikverketCameras({
        RESPONSE: {
          RESULT: [
            {
              Camera: [
                {
                  Id: "SE-1",
                  Active: true,
                  Name: "E4 Stockholm",
                  Location: "Stockholm",
                  Geometry: { WGS84: "POINT (18.0686 59.3293)" },
                  PhotoUrl: "https://api.trafikinfo.trafikverket.se/v2/Images/test.Jpeg",
                  Direction: 90,
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        id: "se-trafikverket:SE-1",
        coordinates: [18.0686, 59.3293],
        direction: "90°",
      }),
    ]);
  });

  it("parses NPRA's cctvCameraMetadataRecord DATEX structure", () => {
    const xml = `
      <messageContainer xmlns="urn:common" xmlns:cctv="urn:cctv" xmlns:loc="urn:location">
        <cctv:cctvCameraMetadataRecord id="3000063_1">
          <cctv:cctvCameraIdentification>3000063_1</cctv:cctvCameraIdentification>
          <cctv:cctvCameraRecordVersionTime>2025-09-10T10:52:23+02:00</cctv:cctvCameraRecordVersionTime>
          <cctv:cctvCameraSiteLocalDescription><values><value lang="nob">Langesi</value></values></cctv:cctvCameraSiteLocalDescription>
          <cctv:cctvCameraOrientationDescription>Svelgen</cctv:cctvCameraOrientationDescription>
          <cctv:cctvCameraLocation>
            <loc:supplementaryPositionalDescription><loc:roadInformation><loc:roadNumber>F614</loc:roadNumber></loc:roadInformation></loc:supplementaryPositionalDescription>
            <loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>61.832706</loc:latitude><loc:longitude>5.459189</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates>
          </cctv:cctvCameraLocation>
          <cctv:cctvStillImageService><cctv:stillImageUrl><urlLinkAddress>https://kamera.atlas.vegvesen.no/api/images/3000063_1</urlLinkAddress></cctv:stillImageUrl></cctv:cctvStillImageService>
        </cctv:cctvCameraMetadataRecord>
      </messageContainer>`;

    expect(parseNpraCameras(xml)).toEqual([
      expect.objectContaining({
        id: "no-npra:3000063_1",
        name: "Langesi",
        coordinates: [5.459189, 61.832706],
        road: "F614",
        direction: "Svelgen",
      }),
    ]);
  });

  it("parses the documented Live Traffic NSW GeoJSON fields", () => {
    expect(
      parseNswCameras({
        features: [
          {
            id: "d2e11",
            geometry: { coordinates: [151.13159, -33.78199] },
            properties: {
              region: "SYD_NORTH",
              title: "M2 (Ryde)",
              view: "M2 at Lane Cove Road",
              direction: "W",
              href: "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/m2_ryde.jpeg",
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "au-nsw-webcam:d2e11",
        name: "M2 (Ryde)",
        direction: "W",
        thumbnailUrl:
          "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/m2_ryde.jpeg",
      }),
    ]);
  });

  it("parses TDX wrapper records into distinct freeway and highway IDs", () => {
    const camera = {
      CCTVID: "N1-S-0-M",
      VideoStreamURL: "https://stream.example/camera.m3u8",
      VideoImageURL: "https://cctvn01.freeway.gov.tw/camera.jpg",
      PositionLon: 121.734906,
      PositionLat: 25.122043,
      SurveillanceDescription: "National Freeway 1",
      RoadName: "國道一號",
      RoadDirection: "S",
    };

    expect(parseTdxCameras([camera], "freeway")).toEqual([
      expect.objectContaining({
        id: "tw-tdx-webcam:freeway:N1-S-0-M",
        coordinates: [121.734906, 25.122043],
        thumbnailUrl: "https://cctvn01.freeway.gov.tw/camera.jpg",
        streamUrl: "https://stream.example/camera.m3u8",
        road: "國道一號",
      }),
    ]);
  });
});
