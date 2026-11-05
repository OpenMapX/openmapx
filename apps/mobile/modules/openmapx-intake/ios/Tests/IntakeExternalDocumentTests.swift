import Foundation
import Darwin
import XCTest
@testable import IntakeInbox

private final class TestScope: IntakeDocumentScope {
  var allowed = true
  private let lock = NSLock()
  private var starts = 0, stops = 0
  var acquired: (() -> Void)?
  func start(_ url: URL) -> Bool { lock.lock(); starts += 1; lock.unlock(); acquired?(); return allowed }
  func stop(_ url: URL) { lock.lock(); stops += 1; lock.unlock() }
  var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [starts, stops] }
}
private final class TestCoordinator: IntakeDocumentCoordinating {
  var hang = false, fail = false, replacement: URL?
  var entered: (() -> Void)?
  var before: (() throws -> Void)?
  var exited = false
  private(set) var cancels = 0
  func cancel() { cancels += 1 }
  func coordinate(_ url: URL, on queue: OperationQueue, accessor: @escaping (Result<URL, Error>) -> Void) {
    entered?()
    if hang { return }
    queue.addOperation {
      do { try self.before?(); accessor(self.fail ? .failure(IntakeFailure.unreadable) : .success(self.replacement ?? url)) }
      catch { accessor(.failure(error)) }
      self.exited = true
    }
  }
}
final class IntakeExternalDocumentTests: XCTestCase {
  var root: URL!, source: URL!, privateRoot: URL!, store: IntakeInbox!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    source = root.appendingPathComponent("route.gpx")
    try Data("<gpx>owned fixture</gpx>".utf8).write(to: source)
    privateRoot = root.appendingPathComponent("app")
    store = try IntakeInbox(root: privateRoot.appendingPathComponent("Inbox"), writer: "host")
  }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }
  @discardableResult private func run(_ scope: TestScope, _ coordinator: TestCoordinator, timeout: TimeInterval = 1) -> Result<IntakeEntry, Error> {
    let done = expectation(description: "capture finishes")
    var outcome: Result<IntakeEntry, Error>!
    let job = IntakeExternalDocument(url: source, store: store, privateRoots: [privateRoot], scope: scope, coordinator: coordinator, timeout: timeout)
    job.start { outcome = $0; done.fulfill() }
    wait(for: [done], timeout: 3)
    return outcome
  }
  func testPrivacyReasonsCoverUserSelectedMetadataAndDeadlineTimers() throws {
    let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    for name in ["PrivacyInfo.xcprivacy", "Share/PrivacyInfo.xcprivacy"] {
      let raw = try PropertyListSerialization.propertyList(from: Data(contentsOf: ios.appendingPathComponent(name)), format: nil) as? [String: Any]
      let categories = try XCTUnwrap(raw?["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
      let reasons = Dictionary(uniqueKeysWithValues: categories.map {
        ($0["NSPrivacyAccessedAPIType"] as? String ?? "", Set($0["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? []))
      })
      XCTAssertTrue(reasons["NSPrivacyAccessedAPICategoryFileTimestamp", default: []].isSuperset(of: ["C617.1", "3B52.1"]))
      XCTAssertEqual(reasons["NSPrivacyAccessedAPICategorySystemBootTime"], ["35F9.1"])
    }
  }
  func testBackgroundExpirationAndCompletionEndTheSameTaskOnlyOnce() {
    var expire: (() -> Void)?, ended: [Int] = [], cancellations = 0
    let lease = IntakeBackgroundLease(invalid: 0, begin: { expire = $0; return 7 }, end: { ended.append($0) })
    lease.begin { cancellations += 1 }; expire?(); lease.end(); expire?()
    XCTAssertEqual(cancellations, 1); XCTAssertEqual(ended, [7])
  }
  func testBackgroundExpirationBeforeBeginReturnsAndInvalidAssertionsAreSafe() {
    var ended: [Int] = [], cancellations = 0
    let early = IntakeBackgroundLease(invalid: 0, begin: { expire in expire(); return 7 }, end: { ended.append($0) })
    early.begin { cancellations += 1 }; early.end()
    let invalid = IntakeBackgroundLease(invalid: 0, begin: { _ in 0 }, end: { ended.append($0) })
    invalid.begin {}; invalid.end(); invalid.end()
    XCTAssertEqual(cancellations, 1); XCTAssertEqual(ended, [7])
  }
  func testCopyCommitsOnlyAfterAccessorExitsAndNeverChangesOriginal() throws {
    let scope = TestScope(), coordinator = TestCoordinator(), original = try Data(contentsOf: source)
    let item = try run(scope, coordinator).get()
    XCTAssertTrue(coordinator.exited)
    XCTAssertEqual(scope.counts, [1, 1])
    XCTAssertEqual(try Data(contentsOf: source), original)
    XCTAssertEqual(try store.read(item.id, offset: 0).data, original.base64EncodedString())
  }
  func testDeniedScopeNeverReadsOrReleasesAnUnacquiredScope() throws {
    let scope = TestScope(); scope.allowed = false
    XCTAssertThrowsError(try run(scope, TestCoordinator()).get())
    XCTAssertEqual(scope.counts, [1, 0]); XCTAssertTrue(try store.list().isEmpty)
  }
  func testScopeReleasedOnCoordinationAndSizeErrors() throws {
    let bad = TestCoordinator(); bad.fail = true
    let scope = TestScope(); XCTAssertThrowsError(try run(scope, bad).get()); XCTAssertEqual(scope.counts, [1, 1])
    try Data(repeating: 65, count: IntakePolicy.fileBytes + 1).write(to: source)
    let largeScope = TestScope()
    XCTAssertThrowsError(try run(largeScope, TestCoordinator()).get()) { XCTAssertEqual($0 as? IntakeFailure, .tooLarge) }
    XCTAssertEqual(largeScope.counts, [1, 1]); XCTAssertTrue(try store.list().isEmpty)
  }
  func testTimeoutCancelsAnUnresponsiveCoordinatorAndReleasesScope() throws {
    let scope = TestScope(), coordinator = TestCoordinator(); coordinator.hang = true
    XCTAssertThrowsError(try run(scope, coordinator, timeout: 0.05).get())
    XCTAssertEqual(scope.counts, [1, 1]); XCTAssertEqual(coordinator.cancels, 1)
    XCTAssertTrue(try store.list().isEmpty)
  }
  func testCancellationReleasesExactlyOnceAndFinishesExactlyOnce() throws {
    let scope = TestScope(), coordinator = TestCoordinator(); coordinator.hang = true
    let acquired = expectation(description: "scope acquired"), done = expectation(description: "cancelled")
    coordinator.entered = { acquired.fulfill() }
    let job = IntakeExternalDocument(url: source, store: store, privateRoots: [privateRoot], scope: scope, coordinator: coordinator)
    job.start { result in
      if case .success = result { XCTFail("cancelled job committed") }; done.fulfill()
    }
    wait(for: [acquired], timeout: 1); job.cancel(); job.cancel()
    wait(for: [done], timeout: 1)
    XCTAssertEqual(scope.counts, [1, 1]); XCTAssertEqual(coordinator.cancels, 1)
  }
  func testRejectsPrivateContainersAndCoordinatedURLReplacement() throws {
    let privateFile = privateRoot.appendingPathComponent("secret.gpx"); try Data("private".utf8).write(to: privateFile)
    source = privateFile; let scope = TestScope()
    XCTAssertThrowsError(try run(scope, TestCoordinator()).get()); XCTAssertEqual(scope.counts, [1, 1])
    source = root.appendingPathComponent("route.gpx")
    let coordinator = TestCoordinator(); coordinator.replacement = privateFile
    let replacementScope = TestScope(); XCTAssertThrowsError(try run(replacementScope, coordinator).get())
    XCTAssertEqual(replacementScope.counts, [1, 1]); XCTAssertTrue(try store.list().isEmpty)
  }
  func testRejectsSymlinksAndFIFOSwappedAfterCoordinationStartsWithoutBlocking() throws {
    for kind in ["symlink", "fifo"] {
      try? FileManager.default.removeItem(at: source)
      try Data("regular before coordination".utf8).write(to: source)
      let coordinator = TestCoordinator()
      coordinator.before = {
        try FileManager.default.removeItem(at: self.source)
        if kind == "symlink" {
          let target = self.root.appendingPathComponent("other.gpx"); try Data("other".utf8).write(to: target)
          try FileManager.default.createSymbolicLink(at: self.source, withDestinationURL: target)
        } else { XCTAssertEqual(mkfifo(self.source.path, 0o600), 0) }
      }
      let scope = TestScope(); XCTAssertThrowsError(try run(scope, coordinator).get()); XCTAssertEqual(scope.counts, [1, 1])
      XCTAssertTrue(coordinator.exited)
      XCTAssertTrue(try store.list().isEmpty)
    }
  }
}
