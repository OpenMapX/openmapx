import Foundation
import XCTest
@testable import NavigationSurfacePolicy
final class SurfacePayloadTests: XCTestCase {
  func payload(_ instruction: String = "Abbiegen") throws -> String {
    let dict: [String: Any] = ["version": 1, "sessionId": "A", "revision": 2, "kind": "ground", "status": "active", "title": "Navigation", "instruction": instruction, "detail": "1 km", "compactText": "200 m", "observedAtMs": 1000, "staleAtMs": 61000, "expiresAtMs": 100000, "locale": "de", "eventAtMs": NSNull()]
    return String(data: try JSONSerialization.data(withJSONObject: dict), encoding: .utf8)!
  }
  func testPayloadAndFences() throws {
    let p = try SurfacePayload.decode(payload())
    XCTAssertTrue(SurfacePolicy.accepts(owner: "A", revision: 1, incoming: p))
    XCTAssertFalse(SurfacePolicy.accepts(owner: "A", revision: 3, incoming: p))
    XCTAssertFalse(SurfacePolicy.canClear(owner: "B", expected: "A"))
  }
  func testOversizedAndControlTextRejected() throws {
    XCTAssertThrowsError(try SurfacePayload.decode(payload(String(repeating: "ä", count: 2000))))
    XCTAssertThrowsError(try SurfacePayload.decode(payload("secret\nvalue")))
  }
}
