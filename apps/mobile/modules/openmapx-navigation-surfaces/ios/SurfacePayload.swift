import Foundation

public struct SurfacePayload: Codable, Hashable, Sendable {
  public let version: Int
  public let sessionId: String
  public let revision: Int64
  public let kind: String
  public let status: String
  public let title: String
  public let instruction: String
  public let detail: String
  public let compactText: String
  public let eventAtMs: Double?
  public let observedAtMs: Double
  public let staleAtMs: Double
  public let expiresAtMs: Double
  public let locale: String

  public static func decode(_ raw: String) throws -> SurfacePayload {
    let data = Data(raw.utf8)
    guard data.count <= 3000,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["version", "sessionId", "revision", "kind", "status", "title", "instruction", "detail", "compactText", "observedAtMs", "staleAtMs", "expiresAtMs", "locale", "eventAtMs"])
    else { throw SurfaceError.invalid }
    let p = try JSONDecoder().decode(Self.self, from: data)
    guard p.version == 1, p.sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
      p.revision >= 0, ["ground", "transit"].contains(p.kind), ["active", "waiting", "stale", "arrived"].contains(p.status),
      ["en", "de"].contains(p.locale), p.observedAtMs.isFinite, p.observedAtMs >= 0,
      (p.eventAtMs == nil || (p.eventAtMs!.isFinite && p.eventAtMs! > 0)), p.staleAtMs.isFinite, p.expiresAtMs.isFinite, p.staleAtMs <= p.expiresAtMs,
      [p.title, p.instruction, p.detail, p.compactText].allSatisfy({ $0.utf16.count <= 160 && $0.unicodeScalars.allSatisfy { $0.value >= 32 } }),
      try JSONEncoder().encode(p).count <= 3000
    else { throw SurfaceError.invalid }
    return p
  }
}
public enum SurfaceError: Error { case invalid }
public enum SurfacePolicy {
  public static func accepts(owner: String?, revision: Int64, incoming: SurfacePayload) -> Bool {
    owner != incoming.sessionId || incoming.revision >= revision
  }
  public static func canClear(owner: String?, expected: String?) -> Bool { expected == nil || owner == expected }
}
