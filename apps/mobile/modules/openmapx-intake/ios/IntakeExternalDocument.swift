import Foundation

/// One owner for a platform background assertion, including expiry during begin.
final class IntakeBackgroundLease<Identifier: Equatable> {
  private let invalid: Identifier, beginTask: (@escaping () -> Void) -> Identifier, endTask: (Identifier) -> Void
  private let lock = NSLock()
  private var identifier: Identifier, ended = false
  init(invalid: Identifier, begin: @escaping (@escaping () -> Void) -> Identifier, end: @escaping (Identifier) -> Void) {
    self.invalid = invalid; identifier = invalid; beginTask = begin; endTask = end
  }
  func begin(expiration: @escaping () -> Void) {
    let id = beginTask { self.finish(expiration: expiration) }
    lock.lock(); let alreadyEnded = ended; if !alreadyEnded { identifier = id }; lock.unlock()
    if alreadyEnded && id != invalid { endTask(id) }
  }
  func end() { finish(expiration: nil) }
  private func finish(expiration: (() -> Void)?) {
    lock.lock(); guard !ended else { lock.unlock(); return }
    ended = true; let id = identifier; identifier = invalid; lock.unlock()
    expiration?(); if id != invalid { endTask(id) }
  }
}

protocol IntakeDocumentScope {
  func start(_ url: URL) -> Bool
  func stop(_ url: URL)
}
protocol IntakeDocumentCoordinating {
  func coordinate(_ url: URL, on queue: OperationQueue, accessor: @escaping (Result<URL, Error>) -> Void)
  func cancel()
}
private struct SystemDocumentScope: IntakeDocumentScope {
  func start(_ url: URL) -> Bool { url.startAccessingSecurityScopedResource() }
  func stop(_ url: URL) { url.stopAccessingSecurityScopedResource() }
}
private final class SystemDocumentCoordinator: IntakeDocumentCoordinating {
  private let coordinator = NSFileCoordinator()
  func coordinate(_ url: URL, on queue: OperationQueue, accessor: @escaping (Result<URL, Error>) -> Void) {
    let intent = NSFileAccessIntent.readingIntent(with: url, options: .withoutChanges)
    coordinator.coordinate(with: [intent], queue: queue) { error in
      if let error { accessor(.failure(error)) } else { accessor(.success(intent.url)) }
    }
  }
  func cancel() { coordinator.cancel() }
}
private final class DocumentScopeLease {
  private let lock = NSLock(), scope: IntakeDocumentScope, url: URL
  private var released = true
  init(scope: IntakeDocumentScope, url: URL) throws {
    self.scope = scope; self.url = url
    guard scope.start(url) else { throw IntakeFailure.unreadable }
    released = false
  }
  func release() {
    lock.lock(); let release = !released; released = true; lock.unlock()
    if release { scope.stop(url) }
  }
  deinit { release() }
}

/// Host-only OS URL intake. The external accessor only stages bytes; private
/// inbox coordination starts after it exits. The original is never mutated.
final class IntakeExternalDocument {
  private let url: URL, store: IntakeInbox, privateRoots: [String], scope: IntakeDocumentScope
  private let coordinator: IntakeDocumentCoordinating, queue = OperationQueue(), lock = NSLock()
  private let deadline: TimeInterval
  private var started = false, finished = false, cancelled = false
  private var completion: ((Result<IntakeEntry, Error>) -> Void)?
  private var lease: DocumentScopeLease?, cancelCoordination: (() -> Void)?, timer: DispatchSourceTimer?

  init(url: URL, store: IntakeInbox, privateRoots: [URL], scope: IntakeDocumentScope? = nil,
    coordinator: IntakeDocumentCoordinating? = nil, timeout: TimeInterval = 10) {
    self.url = url; self.store = store
    self.privateRoots = privateRoots.map { Self.normalized(IntakePolicy.canonical($0).path) }
    self.scope = scope ?? SystemDocumentScope(); self.coordinator = coordinator ?? SystemDocumentCoordinator()
    self.deadline = ProcessInfo.processInfo.systemUptime + timeout
    queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .userInitiated
  }
  private var stopped: Bool {
    lock.lock(); defer { lock.unlock() }
    return finished || cancelled || ProcessInfo.processInfo.systemUptime >= deadline
  }
  func start(_ completion: @escaping (Result<IntakeEntry, Error>) -> Void) {
    lock.lock()
    guard !started else { lock.unlock(); return }; started = true
    guard !finished else { lock.unlock(); completion(.failure(IntakeFailure.unreadable)); return }
    self.completion = completion; lock.unlock()
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
    timer.schedule(deadline: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime))
    timer.setEventHandler { [weak self] in self?.cancel() }; timer.resume()
    lock.lock(); if finished { lock.unlock(); timer.cancel() } else { self.timer = timer; lock.unlock() }
    queue.addOperation { self.begin() }
  }
  func cancel() { finish(.failure(IntakeFailure.unreadable), cancelling: true) }
  private func setCancellation(_ action: (() -> Void)?) {
    lock.lock(); let cancel = finished || cancelled; if !cancel { cancelCoordination = action }; lock.unlock()
    if cancel { action?() }
  }
  private static func normalized(_ path: String) -> String {
    path.hasPrefix("/private/var/") ? String(path.dropFirst(8)) : path
  }
  private func validate(_ file: URL) throws {
    guard file.isFileURL else { throw IntakeFailure.unsupported }
    let canonical = Self.normalized(IntakePolicy.canonical(file).path)
    let path = file.standardizedFileURL.path
    // /var is Apple's system alias, not a user-supplied symlink exception.
    let normalized = Self.normalized(path)
    guard canonical == normalized, !privateRoots.contains(where: { canonical == $0 || canonical.hasPrefix($0 + "/") }) else { throw IntakeFailure.unsupported }
  }
  private func begin() {
    do {
      guard !stopped, url.isFileURL else { throw IntakeFailure.unreadable }
      _ = try IntakePolicy.format(IntakePolicy.name(url.lastPathComponent))
      // Acquire on the worker, on the original URL object forwarded by Expo.
      let ownedLease = try DocumentScopeLease(scope: scope, url: url)
      lock.lock()
      if finished { lock.unlock(); ownedLease.release(); return }
      lease = ownedLease; lock.unlock()
      try validate(url)
      setCancellation { [coordinator] in coordinator.cancel() }
      guard !stopped else { throw IntakeFailure.unreadable }
      coordinator.coordinate(url, on: queue) { result in
        let staged = Result {
          let coordinatedURL = try result.get()
          guard !self.stopped else { throw IntakeFailure.unreadable }
          try self.validate(coordinatedURL)
          return try self.store.stageFile(coordinatedURL, name: self.url.lastPathComponent,
            deadline: self.deadline, cancelled: { self.stopped }, validateOpened: self.validate)
        }
        // The serial queue cannot execute this until the accessor has exited.
        self.queue.addOperation {
          ownedLease.release()
          self.setCancellation(nil)
          let committed = Result {
            guard !self.stopped else { throw IntakeFailure.unreadable }
            return try self.store.commit(try staged.get(), deadline: self.deadline,
              cancelled: { self.stopped }, onCoordinator: { coordinator in
                self.setCancellation { coordinator.cancel() }
              })
          }
          self.finish(committed)
        }
      }
    } catch { finish(.failure(error)) }
  }
  private func finish(_ result: Result<IntakeEntry, Error>, cancelling: Bool = false) {
    lock.lock()
    guard !finished else { lock.unlock(); return }
    finished = true; cancelled = cancelling
    let completion = self.completion, lease = self.lease, timer = self.timer
    let cancel = cancelling ? cancelCoordination : nil
    self.completion = nil; self.lease = nil; self.timer = nil; cancelCoordination = nil
    lock.unlock()
    timer?.cancel(); cancel?(); lease?.release(); completion?(result)
  }
}
