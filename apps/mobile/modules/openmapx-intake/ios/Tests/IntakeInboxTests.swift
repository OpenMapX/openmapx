import Foundation
import XCTest
@testable import IntakeInbox
final class IntakeInboxTests: XCTestCase {
  var root: URL!
  override func setUpWithError() throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }
  func testRestartChunksAndExplicitCompletion() throws {
    let store = try IntakeInbox(root: root, writer: "host")
    let item = try store.putText("Berlin")
    let restored = try IntakeInbox(root: root, writer: "extension")
    XCTAssertEqual(try restored.list().first?.id, item.id)
    XCTAssertEqual(try restored.read(item.id, offset: 0).data, Data("Berlin".utf8).base64EncodedString())
    try restored.complete(item.id); try restored.complete(item.id)
    XCTAssertTrue(try restored.list().isEmpty)
    XCTAssertThrowsError(try restored.read("../private", offset: 0))
  }
  func testCapsTTLAndFullInboxErrors() throws {
    var time: Int64 = 1000
    let store = try IntakeInbox(root: root, writer: "host", now: { time })
    XCTAssertThrowsError(try store.putText(String(repeating: "a", count: 4097)))
    for _ in 0..<8 { _ = try store.putText("Berlin") }
    XCTAssertThrowsError(try store.putText("Paris"))
    for _ in 0..<3 { try store.recordError("inbox-full") }
    XCTAssertEqual(try store.list().count, 10)
    time += IntakePolicy.ttlMs
    XCTAssertTrue(try store.list().isEmpty)
  }
  func testDocumentAuthorityAndDeleteAfterCopy() throws {
    let inbox = root.appendingPathComponent("Documents/Inbox")
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    let file = inbox.appendingPathComponent("route.gpx")
    try Data("<gpx/>".utf8).write(to: file)
    let store = try IntakeInbox(root: root.appendingPathComponent("owned"), writer: "host")
    XCTAssertThrowsError(try store.captureDocument(file, osInbox: inbox, openInPlace: true))
    let outside = root.appendingPathComponent("private.gpx")
    try Data("private".utf8).write(to: outside)
    XCTAssertThrowsError(try store.captureDocument(outside, osInbox: inbox, openInPlace: false))
    let symlink = inbox.appendingPathComponent("link.gpx")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
    XCTAssertThrowsError(try store.captureDocument(symlink, osInbox: inbox, openInPlace: false))
    XCTAssertEqual(try store.captureDocument(file, osInbox: inbox, openInPlace: false).byteLength, 6)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
  }
  func testLiveOtherWriterStagingIsKept() throws {
    let store = try IntakeInbox(root: root, writer: "host", now: { 100000 })
    let stage = root.appendingPathComponent("staging/extension")
    try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
    let live = stage.appendingPathComponent("99000-\(UUID().uuidString)")
    let stale = stage.appendingPathComponent("1000-\(UUID().uuidString)")
    try Data().write(to: live); try Data().write(to: stale)
    _ = try store.list()
    XCTAssertTrue(FileManager.default.fileExists(atPath: live.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
  }
}

extension IntakeInboxTests {
  func testActualFileSizeAndMalformedMetadataAreRejected() throws {
    let store = try IntakeInbox(root: root.appendingPathComponent("owned"), writer: "host")
    let file = root.appendingPathComponent("large.gpx")
    try Data(repeating: 65, count: IntakePolicy.fileBytes + 1).write(to: file)
    XCTAssertThrowsError(try store.putFile(file, name: "large.gpx"))
    XCTAssertTrue(try store.list().isEmpty)
    let item = try store.putText("Berlin")
    let meta = root.appendingPathComponent("owned/\(item.id)/metadata.json")
    var raw = item.dictionary; raw["path"] = "/private/file"
    try JSONSerialization.data(withJSONObject: raw).write(to: meta)
    XCTAssertTrue(try store.list().isEmpty)
  }
  func testConcurrentWritersDoNotExceedQuota() throws {
    let group = DispatchGroup(), lock = NSLock()
    var successes = 0
    for i in 0..<16 {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        if let store = try? IntakeInbox(root: self.root, writer: i % 2 == 0 ? "host" : "extension"), (try? store.putText("Berlin")) != nil {
          lock.lock(); successes += 1; lock.unlock()
        }
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
    XCTAssertEqual(successes, 8)
    XCTAssertEqual(try IntakeInbox(root: root, writer: "host").list().count, 8)
  }
  func testChunksRequireAlignedOffsetsAndCancellationNeverCommits() throws {
    let store = try IntakeInbox(root: root.appendingPathComponent("owned"), writer: "host")
    let file = root.appendingPathComponent("route.gpx")
    try Data(repeating: 65, count: 50000).write(to: file)
    XCTAssertThrowsError(try store.putFile(file, name: "route.gpx", cancelled: { true }))
    XCTAssertTrue(try store.list().isEmpty)
    let item = try store.putFile(file, name: "route.gpx")
    XCTAssertEqual(try store.read(item.id, offset: 49152).byteLength, 848)
    XCTAssertTrue(try store.read(item.id, offset: 49152).eof)
    XCTAssertThrowsError(try store.read(item.id, offset: 1))
  }
}
