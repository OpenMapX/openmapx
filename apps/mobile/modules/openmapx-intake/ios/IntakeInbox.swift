import Foundation

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
  private func coordinated<T>(_ work: () throws -> T) throws -> T {
    Self.localLock.lock(); defer { Self.localLock.unlock() }
    var coordinationError: NSError?, outcome: Result<T, Error>?
    NSFileCoordinator().coordinate(writingItemAt: root, options: .forMerging, error: &coordinationError) { _ in outcome = Result { try work() } }
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
  func putFile(_ file: URL, name: String, cancelled: () -> Bool = { false }) throws -> IntakeEntry {
    guard file.isFileURL else { throw IntakeFailure.unsupported }
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard file.isFileURL, values.isRegularFile == true, values.isSymbolicLink != true, let stream = InputStream(url: file) else { throw IntakeFailure.unreadable }
    let display = IntakePolicy.name(name)
    return try copy(stream, kind: "file", name: display, format: IntakePolicy.format(display), limit: IntakePolicy.fileBytes, cancelled: cancelled)
  }
  private func copy(_ input: InputStream, kind: String, name: String, format: String?, limit: Int, cancelled: () -> Bool = { false }) throws -> IntakeEntry {
    let started = now(); let deadline = ProcessInfo.processInfo.systemUptime + 10
    let stage = root.appendingPathComponent("staging/\(writer)/\(started)-\(UUID().uuidString)")
    try fm.createDirectory(at: stage, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: stage) }
    let file = stage.appendingPathComponent("data"); guard fm.createFile(atPath: file.path, contents: nil) else { throw IntakeFailure.unreadable }
    let output = try FileHandle(forWritingTo: file); defer { try? output.close() }
    input.open(); defer { input.close() }
    var size = 0, buffer = [UInt8](repeating: 0, count: 8192)
    while true {
      guard !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
      let count = input.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw IntakeFailure.unreadable }; if count == 0 { break }
      size += count; guard size <= limit else { throw IntakeFailure.tooLarge }
      try output.write(contentsOf: Data(buffer.prefix(count)))
    }
    guard size > 0 else { throw IntakeFailure.invalidData }
    try output.synchronize()
    return try coordinated {
      guard !cancelled(), ProcessInfo.processInfo.systemUptime < deadline else { throw IntakeFailure.unreadable }
      let current = try entries().filter { $0.kind != "error" }
      guard current.count < IntakePolicy.contentItems, current.reduce(0, { $0 + $1.byteLength }) + size <= IntakePolicy.inboxBytes else { throw IntakeFailure.inboxFull }
      let item = IntakeEntry(id: UUID().uuidString.lowercased(), createdAtMs: now(), kind: kind, name: name, byteLength: size, format: format)
      try JSONEncoder().encode(item).write(to: stage.appendingPathComponent("metadata.json"), options: .atomic)
      try fm.moveItem(at: stage, to: directory(item.id)); return item
    }
  }
  func recordError(_ code: String) throws { try coordinated {
    let old = try entries().filter { $0.kind == "error" }
    for item in old.prefix(max(0, old.count - IntakePolicy.errorItems + 1)) { try? fm.removeItem(at: directory(item.id)) }
    let item = IntakeEntry(id: UUID().uuidString.lowercased(), createdAtMs: now(), kind: "error", name: "OpenMapX", byteLength: 0, errorCode: IntakeFailure(rawValue: code)?.rawValue ?? "unreadable")
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
  func captureDocument(_ file: URL, osInbox: URL, openInPlace: Bool) throws -> IntakeEntry {
    let canonical = IntakePolicy.canonical(file), inbox = IntakePolicy.canonical(osInbox)
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard !openInPlace, file.isFileURL, values.isRegularFile == true, values.isSymbolicLink != true,
      canonical.deletingLastPathComponent().path == inbox.path else { throw IntakeFailure.unsupported }
    defer { try? fm.removeItem(at: canonical) }
    return try putFile(canonical, name: file.lastPathComponent)
  }
}
