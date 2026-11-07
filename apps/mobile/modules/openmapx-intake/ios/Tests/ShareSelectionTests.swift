import XCTest
@testable import IntakeInbox
final class ShareSelectionTests: XCTestCase {
  func testTextAndURLWithAnIrrelevantPreviewCombineIntoOneTextEntry() throws {
    let plan = try ShareSelection.select([["public.url"], ["public.plain-text"], ["public.vcard"]])
    XCTAssertEqual(plan, .text([0, 1]))
    XCTAssertEqual(try ShareSelection.text(["Station", "https://maps.example/short", "Station"]), "Station\nhttps://maps.example/short")
  }
  func testAllSuppliedNavigatorExamplesSurviveTheNativeTextPath() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { root.deleteLastPathComponent() }
    let fixture = root.appendingPathComponent("packages/core/src/travel-plans/__fixtures__/dbNavigator.json")
    let examples = try JSONDecoder().decode([String].self, from: Data(contentsOf: fixture))
    XCTAssertFalse(examples.isEmpty)
    for text in examples {
      XCTAssertEqual(try ShareSelection.text([text, text]), text)
      let link = String(text.split(whereSeparator: { $0.isWhitespace }).last!)
      XCTAssertEqual(try ShareSelection.text([link, text, link]), text)
    }
  }
  func testRepeatedLinesInsideOneTextValueArePreserved() throws {
    let text = "A → B\nFr. 06.11.2026\n\nRE9 (1)\nNach Siegen Hbf\nAb 21:00 A\nAn 22:00 C\n\nRE9 (2)\nNach Siegen Hbf\nAb 22:10 C\nAn 23:00 B"
    XCTAssertEqual(try ShareSelection.text([text, text]), text)
  }
  func testGeographicFileModeNeverSilentlyIgnoresOtherFiles() throws {
    XCTAssertEqual(try ShareSelection.select([["com.topografix.gpx"], ["public.geojson"]]), .files([.init(index: 0, type: "com.topografix.gpx"), .init(index: 1, type: "public.geojson")]))
    XCTAssertThrowsError(try ShareSelection.select([["com.topografix.gpx"], ["public.pdf"]]))
    XCTAssertThrowsError(try ShareSelection.select([["public.file-url", "public.plain-text"]]))
  }
  func testAnEmptyFirstProviderDoesNotRejectTheFollowingLocation() throws {
    XCTAssertEqual(try ShareSelection.text(["  "], allowEmpty: true), "")
    XCTAssertEqual(try ShareSelection.text(["  ", "Station", "https://maps.apple.com/?q=Station"]), "Station\nhttps://maps.apple.com/?q=Station")
    XCTAssertThrowsError(try ShareSelection.text(["  "]))
  }
  func testCombinedTextIsBoundedBeforeItCanBeCommitted() throws {
    XCTAssertThrowsError(try ShareSelection.text([String(repeating: "x", count: 3000), String(repeating: "y", count: 3000)]))
    XCTAssertThrowsError(try ShareSelection.select(Array(repeating: ["public.url"], count: 6)))
  }
}

#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
extension ShareSelectionTests {
  func testGeoJSONIdentifierIsDeclaredByApple() throws {
    if #available(macOS 15.0, *) {
      XCTAssertEqual(UTType.geoJSON.identifier, "public.geojson")
      XCTAssertEqual(UTType(filenameExtension: "geojson")?.identifier, "public.geojson")
    }
  }
}
#endif
