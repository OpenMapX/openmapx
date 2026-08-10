import Foundation

/// Decision logic for navigation speech, deliberately free of AVFoundation and
/// ExpoModulesCore so it can be compiled and unit-tested on the host with
/// `swift test`. The module class is the only part that touches the platform.

/// Result codes shared with the JavaScript contract.
public enum SpeakOutcome: String {
  case spoken
  case skipped
  case failed
}

/// The locales this release speaks. Anything else is a failure rather than a
/// silent fallback: reading German guidance in an English voice is worse than
/// staying quiet and letting the scheduled alert cover it.
public enum SpeechLocale: String, CaseIterable {
  case en
  case de

  public var voiceIdentifier: String {
    switch self {
    case .en: return "en-US"
    case .de: return "de-DE"
    }
  }

  public static func parse(_ raw: String) -> SpeechLocale? {
    SpeechLocale(rawValue: raw.lowercased())
  }
}

/// Bounded, insertion-ordered set of cue identities already spoken in this
/// process.
///
/// Duplicate suppression exists because a delayed location batch can replay a
/// cue the engine already emitted. The bound matters just as much: an
/// unbounded set in a process that may live for a whole journey is a slow leak.
public struct CueLedger {
  public static let defaultCapacity = 256

  private var order: [String] = []
  private var seen: Set<String> = []
  private let capacity: Int

  public init(capacity: Int = CueLedger.defaultCapacity) {
    self.capacity = max(1, capacity)
  }

  public var count: Int { order.count }

  public func contains(_ cueId: String) -> Bool { seen.contains(cueId) }

  /// Returns `true` when the cue is new and was recorded, `false` when it was
  /// already present.
  @discardableResult
  public mutating func record(_ cueId: String) -> Bool {
    if seen.contains(cueId) { return false }
    seen.insert(cueId)
    order.append(cueId)
    if order.count > capacity {
      let evicted = order.removeFirst()
      seen.remove(evicted)
    }
    return true
  }

  public mutating func reset() {
    order.removeAll()
    seen.removeAll()
  }
}

/// Tracks whether the shared audio session should be active.
///
/// The session is activated immediately before an utterance and released as
/// soon as the queue drains, so music and podcasts are ducked for the length of
/// a prompt rather than the length of a journey.
public struct AudioSessionPolicy {
  public private(set) var pendingUtterances: Int = 0
  public private(set) var isActive: Bool = false
  public private(set) var isInterrupted: Bool = false

  public init() {}

  /// Whether the caller must activate the session before enqueuing.
  public mutating func willEnqueue() -> Bool {
    pendingUtterances += 1
    if isActive { return false }
    isActive = true
    return true
  }

  /// Whether the caller must deactivate the session after this utterance ended.
  public mutating func didFinishUtterance() -> Bool {
    pendingUtterances = max(0, pendingUtterances - 1)
    guard pendingUtterances == 0, isActive else { return false }
    isActive = false
    return true
  }

  /// Whether the caller must deactivate after an explicit stop.
  public mutating func didStop() -> Bool {
    pendingUtterances = 0
    guard isActive else { return false }
    isActive = false
    return true
  }

  /// A call or another priority source took the session. Speech is abandoned
  /// rather than queued: a prompt delivered minutes late is worse than none.
  public mutating func didBeginInterruption() {
    isInterrupted = true
    pendingUtterances = 0
    isActive = false
  }

  public mutating func didEndInterruption() {
    isInterrupted = false
  }

  /// Speech is refused outright while interrupted.
  public var acceptsSpeech: Bool { !isInterrupted }
}

/// Maps the contract's 0.5–2.0 multiplier onto the platform's own rate scale,
/// where the default is not the midpoint and the bounds are absolute.
public func speechRate(
  multiplier: Double?,
  defaultRate: Float,
  minimumRate: Float,
  maximumRate: Float
) -> Float {
  guard let multiplier, multiplier.isFinite else { return defaultRate }
  let clampedMultiplier = min(max(multiplier, 0.5), 2.0)
  let scaled = defaultRate * Float(clampedMultiplier)
  return min(max(scaled, minimumRate), maximumRate)
}

/// Validates a request before any platform call. Mirrors the JavaScript
/// boundary so a bug on either side fails the same way.
public func validateSpeechText(_ text: String) -> Bool {
  guard !text.isEmpty, text.utf16.count <= 512 else { return false }
  return !text.unicodeScalars.contains { scalar in
    // Control characters either read as noise or truncate the utterance.
    (scalar.value < 0x20 && scalar.value != 0x0A) || scalar.value == 0x7F
  }
}

public func validateCueId(_ cueId: String) -> Bool {
  !cueId.isEmpty && cueId.utf16.count <= 128
}
