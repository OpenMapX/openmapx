import Foundation

enum IntakeFailure: String, Error { case unsupported, tooLarge = "too-large", tooMany = "too-many", inboxFull = "inbox-full", unreadable, expired, unavailable, invalidData = "invalid-data" }
enum IntakePolicy {
  static let fileBytes = 5 * 1024 * 1024, textBytes = 8192, textLength = 4096, chunkBytes = 24576
  static let inboxBytes = 20 * 1024 * 1024, contentItems = 8, errorItems = 2
  static let ttlMs: Int64 = 86400000, copyTimeoutMs: Int64 = 10000
  static func name(_ raw: String) -> String {
    let leaf = raw.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
    let clean = String(leaf.unicodeScalars.filter { $0.value >= 32 && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) })
    var result = ""
    for scalar in clean.unicodeScalars { if result.utf16.count + scalar.utf16.count > 128 { break }; result.unicodeScalars.append(scalar) }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  static func format(_ name: String) throws -> String {
    let ext = (name as NSString).pathExtension.lowercased()
    guard ["gpx", "geojson", "kml"].contains(ext) else { throw IntakeFailure.unsupported }; return ext
  }
  static func validID(_ id: String) -> Bool { UUID(uuidString: id) != nil && id.count == 36 }
  static func canonical(_ url: URL) -> URL { url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL }
}
