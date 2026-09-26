import { describe, expect, it } from "vitest";
import type { PlacePhoto } from "../types/place";
import { isDisplayablePhoto } from "./commons-metadata";

describe("isDisplayablePhoto for legacy Commons entries", () => {
  it.each([
    {
      name: "audio File page with an ordinary thumbnail URL",
      photo: {
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Preview.jpg/800px-Preview.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Recorded_voice.ogg",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "video File page with an ordinary thumbnail URL",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Preview.jpg/800px-Preview.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "file-type icon without a File page",
      photo: {
        url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "audio OSM FilePath without a Commons page",
      photo: {
        url: "https://commons.wikimedia.org/wiki/Special:FilePath/De-Aachen.ogg?width=1200",
        source: "osm",
      },
      visible: false,
    },
    {
      name: "real JPEG File page",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Photo.jpg/800px-Photo.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
        source: "wikimedia",
      },
      visible: true,
    },
    {
      name: "real SVG File page",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Emblem.svg/500px-Emblem.svg.png",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Emblem.svg",
        source: "wikimedia",
      },
      visible: true,
    },
  ])("$name", ({ photo, visible }) => {
    expect(isDisplayablePhoto(photo as PlacePhoto)).toBe(visible);
  });
});
