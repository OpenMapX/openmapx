import Foundation
import Darwin

struct IntakeEntry: Codable {
  let id: String, createdAtMs: Int64, kind: String, name: String, byteLength: Int
  var format: String? = nil, errorCode: String? = nil
  var dictionary: [String: Any] {
    var value: [String: Any] = ["id": id, "createdAtMs": createdAtMs, "kind": kind, "name": name, "byteLength": byteLength]
    if let format { value["format"] = format }; if let errorCode { value["errorCode"] = errorCode }; return value
  }
}
struct IntakeChunk {
  let id: String, offset: Int, data: String, byteLength: Int, eof: Bool
  var dictionary: [String: Any] { ["id": id, "offset": offset, "data": data, "byteLength": byteLength, "eof": eof] }
}
/// Immutable owned entries, coordinated across host + extension. External reads never hold the coordination lock.
final class IntakeInbox {
  private let root: URL, writer: String, now: () -> Int64
  private let fm = FileManager.default
  private static let localLock = NSRecursiveLock()
  init(root: URL, writer: String, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) throws {
    guard ["host", "extension"].contains(writer) else { throw IntakeFailure.unavailable }
    self.root = IntakePolicy.canonical(root); self.writer = writer; self.now = now
    try fm.createDirectory(at: self.root, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var ownedRoot = self.root; try ownedRoot.setResourceValues(values)
    #if os(iOS)
    try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: self.root.path)
    #endif
  }
  private func coordinated<T>(onCoordinator: ((NSFileCoordinator) -> Void)? = nil, _ work: () throws -> T) throws -> T {
    Self.localLock.lock(); defer { Self.localLock.unlock() }
    var coordinationError: NSError?, outcome: Result<T, Error>?
    let coordinator = NSFileCoordinator(); onCoordinator?(coordinator)
    coordinator.coordinate(writingItemAt: root, options: .forMerging, error: &coordinationError) { _ in outcome = Result { try work() } }
    if let coordinationError { throw coordinationError }
    guard let outcome else { throw IntakeFailure.unavailable }; return try outcome.get()
  }
  private func directory(_ id: String) throws -> URL {
    guard IntakePolicy.validID(id) else { throw IntakeFailure.unreadable }; return root.appendingPathComponent(id, isDirectory: true)
  }
  private func entries() throws -> [IntakeEntry] {
    var result: [IntakeEntry] = []
    for dir in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where IntakePolicy.validID(dir.lastPathComponent) {
      do {
        guard IntakePolicy.canonical(dir).path == dir.standardizedFileURL.path else { throw IntakeFailure.invalidData }
        let meta = dir.appendingPathComponent("metadata.json")
        let info = try meta.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true, (info.fileSize ?? 4097) <= 4096 else { throw IntakeFailure.invalidData }
        let data = try Data(contentsOf: meta)
        let entry = try JSONDecoder().decode(IntakeEntry.self, from: data)
        let allowed = Set(["id", "createdAtMs", "kind", "name", "byteLength"] + (entry.kind == "file" ? ["format"] : entry.kind == "error" ? ["errorCode"] : []))
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(raw.keys) == allowed,
          entry.id == dir.lastPathComponent, entry.createdAtMs >= 0, now() - entry.createdAtMs < IntakePolicy.ttlMs,
          entry.name == IntakePolicy.name(entry.name) else { throw IntakeFailure.expired }
        if entry.kind == "error" {
          guard entry.byteLength == 0, IntakeFailure(rawValue: entry.errorCode ?? "") != nil else { throw IntakeFailure.invalidData }
        } else {
          guard ["text", "file"].contains(entry.kind), entry.byteLength > 0,
            entry.byteLength <= (entry.kind == "text" ? IntakePolicy.textBytes : IntakePolicy.fileBytes) else { throw IntakeFailure.invalidData }
          let file = dir.appendingPathComponent("data")
          let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
          guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == entry.byteLength else { throw IntakeFailure.invalidData }
          if entry.kind == "file", try IntakePolicy.format(entry.name) != entry.format { throw IntakeFailure.invalidData }
        }
        result.append(entry)
      } catch { try? fm.removeItem(at: dir) }
    }
    for owner in ["host", "extension"] {
      let folder = root.appendingPathComponent("staging/\(owner)")
      for stage in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
        if let epoch = Int64(stage.lastPathComponent.components(separatedBy: "-")[0]), now() - epoch > IntakePolicy.copyTimeoutMs + 60000 { try? fm.removeItem(at: stage) }
      }
    }
    return result.sorted { $0.createdAtMs == $1.createdAtMs ? $0.id < $1.id : $0.createdAtMs < $1.createdAtMs }
  }
  func list() throws -> [IntakeEntry] { try coordinated { try entries() } }
  func putText(_ text: String, cancelled: () -> Bool = { false }) throws -> IntakeEntry {
    let bytes = Data(text.utf8)
    guard text.utf16.count <= IntakePolicy.textLength, bytes.count <= IntakePolicy.textBytes else { throw IntakeFailure.tooLarge }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw IntakeFailure.unsupported }
    return try copy(InputStream(data: bytes), kind: "text", name: "Shared location", format: nil, limit: IntakePolicy.textBytes, cancelled: cancelled)
  }
  /// A staging capability can only be created by this inbox; it owns cleanup.
  final class StagedEntry {
    fileprivate let owner: IntakeInbox, folder: URL, kind: String, name: String, format: String?, byteLength: Int
    fileprivate init(owner: IntakeInbox, folder: URL, kind: String, name: String, format: String?, byteLength: Int) {
      self.owner = owner; self.folder = folder; self.kind = kind; self.name = name; self.format = format; self.byteLength = byteLength
    }
    deinit { try? FileManager.default.removeItem(at: folder) }
  }
  func putFile(_ file: URL, name: String, deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 10,
    cancelled: () -> Bool = { false }, onCoordinator: ((NSFileCoordinator) -> Void)? = nil) throws -> IntakeEntry {
    let staged = try stageFile(file, name: name, deadline: deadline, cancelled: cancelled)
    return try commit(staged, deadline: deadline, cancelled: cancelled, onCoordinator: onCoordinator)
  }
  /// No inbox coordination is held while reading a foreign file. O_NONBLOCK
  /// prevents FIFO-open hangs; fstat checks the actual descriptor after open.
  func stageFile(_ file: URL, name: String, deadline: TimeInterval, cancelled: () -> Bool,
    validateOpened: ((URL) throws -> Void)? = nil) throws -> StagedEntry {
    guard file.isFileURL, !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
    let display = IntakePolicy.name(name), format = try IntakePolicy.format(display)
    let fd = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw IntakeFailure.unreadable }; defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size >= 0 else { throw IntakeFailure.unreadable }
    guard info.st_size <= IntakePolicy.fileBytes else { throw IntakeFailure.tooLarge }
    if let validateOpened {
      var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
      guard fcntl(fd, F_GETPATH, &path) == 0 else { throw IntakeFailure.unreadable }
      try validateOpened(URL(fileURLWithPath: String(cString: path)))
    }
    return try stage(kind: "file", name: display, format: format, limit: IntakePolicy.fileBytes, deadline: deadline, cancelled: cancelled) { buffer in
      let count = Darwin.read(fd, &buffer, buffer.count)
      guard count >= 0 else { throw IntakeFailure.unreadable }; return count
    }
  }
  private func copy(_ input: InputStream, kind: String, name: String, format: String?, limit: Int, cancelled: () -> Bool = { false }) throws -> IntakeEntry {
    let deadline = ProcessInfo.processInfo.systemUptime + 10
    input.open(); defer { input.close() }
    let staged = try stage(kind: kind, name: name, format: format, limit: limit, deadline: deadline, cancelled: cancelled) { buffer in
      let count = input.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else { throw IntakeFailure.unreadable }; return count
    }
    return try commit(staged, deadline: deadline, cancelled: cancelled)
  }
  private func stage(kind: String, name: String, format: String?, limit: Int, deadline: TimeInterval,
    cancelled: () -> Bool, read: (inout [UInt8]) throws -> Int) throws -> StagedEntry {
    let folder = root.appendingPathComponent("staging/\(writer)/\(now())-\(UUID().uuidString)")
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    var retained = false; defer { if !retained { try? fm.removeItem(at: folder) } }
    let file = folder.appendingPathComponent("data"); guard fm.createFile(atPath: file.path, contents: nil) else { throw IntakeFailure.unreadable }
    let output = try FileHandle(forWritingTo: file); defer { try? output.close() }
    var size = 0, buffer = [UInt8](repeating: 0, count: 8192)
    while true {
      guard !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
      let capacity = min(8192, limit - size + 1)
      if buffer.count != capacity { buffer = [UInt8](repeating: 0, count: capacity) }
      let count = try read(&buffer)
      if count == 0 { break }
      size += count; guard size <= limit else { throw IntakeFailure.tooLarge }
      try output.write(contentsOf: Data(buffer.prefix(count)))
    }
    guard size > 0 else { throw IntakeFailure.invalidData }
    try output.synchronize()
    let result = StagedEntry(owner: self, folder: folder, kind: kind, name: name, format: format, byteLength: size)
    retained = true; return result
  }
  /// Called after the external accessor has returned, never inside its lock.
  func commit(_ stage: StagedEntry, deadline: TimeInterval, cancelled: () -> Bool,
    onCoordinator: ((NSFileCoordinator) -> Void)? = nil) throws -> IntakeEntry {
    guard stage.owner === self, !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
    return try coordinated(onCoordinator: onCoordinator) {
      guard !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
      let current = try entries().filter { $0.kind != "error" }
      guard current.count < IntakePolicy.contentItems, current.reduce(0, { $0 + $1.byteLength }) + stage.byteLength <= IntakePolicy.inboxBytes else { throw IntakeFailure.inboxFull }
      let item = IntakeEntry(id: UUID().uuidString.lowercased(), createdAtMs: now(), kind: stage.kind, name: stage.name, byteLength: stage.byteLength, format: stage.format)
      try JSONEncoder().encode(item).write(to: stage.folder.appendingPathComponent("metadata.json"), options: .atomic)
      guard !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
      try fm.moveItem(at: stage.folder, to: directory(item.id)); return item
    }
  }
  func recordError(_ code: String, cancelled: () -> Bool = { false }, onCoordinator: ((NSFileCoordinator) -> Void)? = nil) throws { try coordinated(onCoordinator: onCoordinator) {
    guard !cancelled() else { throw IntakeFailure.unreadable }
    let old = try entries().filter { $0.kind == "error" }
    for item in old.prefix(max(0, old.count - IntakePolicy.errorItems + 1)) { try? fm.removeItem(at: directory(item.id)) }
    let item = IntakeEntry(id: UUID().uuidString.lowercased(), createdAtMs: now(), kind: "error", name: "OpenMapX", byteLength: 0, errorCode: IntakeFailure(rawValue: code)?.rawValue ?? "unreadable")
    guard !cancelled() else { throw IntakeFailure.unreadable }
    let dir = try directory(item.id); try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    try JSONEncoder().encode(item).write(to: dir.appendingPathComponent("metadata.json"), options: .atomic)
  } }
  func read(_ id: String, offset: Int) throws -> IntakeChunk { try coordinated {
    let dir = try directory(id)
    guard offset >= 0, offset % IntakePolicy.chunkBytes == 0 else { throw IntakeFailure.unreadable }
    guard let item = try entries().first(where: { $0.id == id && $0.kind != "error" }) else { throw IntakeFailure.expired }
    guard offset < item.byteLength else { throw IntakeFailure.unreadable }
    let handle = try FileHandle(forReadingFrom: dir.appendingPathComponent("data")); defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(offset))
    let count = min(IntakePolicy.chunkBytes, item.byteLength - offset)
    let data = try handle.read(upToCount: count) ?? Data()
    guard data.count == count else { throw IntakeFailure.unreadable }
    return IntakeChunk(id: id, offset: offset, data: data.base64EncodedString(), byteLength: count, eof: offset + count == item.byteLength)
  } }
  func complete(_ id: String) throws { try coordinated { let dir = try directory(id); if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) } } }
  func captureDocument(_ file: URL, osInbox: URL, openInPlace: Bool,
    deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 10, cancelled: () -> Bool = { false },
    onCoordinator: ((NSFileCoordinator) -> Void)? = nil) throws -> IntakeEntry {
    let canonical = IntakePolicy.canonical(file), inbox = IntakePolicy.canonical(osInbox)
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard !openInPlace, file.isFileURL, values.isRegularFile == true, values.isSymbolicLink != true,
      canonical.deletingLastPathComponent().path == inbox.path else { throw IntakeFailure.unsupported }
    // This is an OS-owned temporary copy, not the provider's original. Remove
    // it on rejection too so oversized/full-inbox imports cannot accumulate in
    // the app's backed-up Documents directory.
    defer { try? fm.removeItem(at: canonical) }
    return try putFile(canonical, name: file.lastPathComponent, deadline: deadline, cancelled: cancelled, onCoordinator: onCoordinator)
  }
}
