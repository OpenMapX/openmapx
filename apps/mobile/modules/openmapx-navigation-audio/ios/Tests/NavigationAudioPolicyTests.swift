import XCTest

@testable import NavigationAudioPolicy

final class CueLedgerTests: XCTestCase {
  func testRecordsANewCueOnce() {
    var ledger = CueLedger()
    XCTAssertTrue(ledger.record("session:ground:abc:turn-1"))
    XCTAssertFalse(ledger.record("session:ground:abc:turn-1"))
    XCTAssertEqual(ledger.count, 1)
  }

  func testDistinguishesCuesThatDifferOnlyBySuffix() {
    var ledger = CueLedger()
    XCTAssertTrue(ledger.record("session:ground:abc:turn-1"))
    XCTAssertTrue(ledger.record("session:ground:abc:turn-11"))
    XCTAssertEqual(ledger.count, 2)
  }

  func testEvictsTheOldestEntryBeyondCapacity() {
    var ledger = CueLedger(capacity: 3)
    for index in 0..<4 { ledger.record("cue-\(index)") }
    XCTAssertEqual(ledger.count, 3)
    XCTAssertFalse(ledger.contains("cue-0"))
    XCTAssertTrue(ledger.contains("cue-3"))
    XCTAssertTrue(ledger.record("cue-0"))
  }

  func testResetClearsEverything() {
    var ledger = CueLedger()
    ledger.record("a")
    ledger.reset()
    XCTAssertEqual(ledger.count, 0)
    XCTAssertTrue(ledger.record("a"))
  }

  func testCapacityIsNeverLessThanOne() {
    var ledger = CueLedger(capacity: 0)
    XCTAssertTrue(ledger.record("a"))
    XCTAssertTrue(ledger.record("b"))
    XCTAssertEqual(ledger.count, 1)
    XCTAssertFalse(ledger.contains("a"))
    XCTAssertTrue(ledger.contains("b"))
  }
}

final class AudioSessionPolicyTests: XCTestCase {
  func testActivatesForTheQueueLifetimeWithoutUnderflow() {
    var policy = AudioSessionPolicy()
    XCTAssertTrue(policy.willEnqueue())
    XCTAssertFalse(policy.willEnqueue())
    XCTAssertTrue(policy.isActive)
    XCTAssertFalse(policy.didFinishUtterance())
    XCTAssertTrue(policy.didFinishUtterance())
    XCTAssertFalse(policy.isActive)
    XCTAssertFalse(policy.didFinishUtterance())
    XCTAssertEqual(policy.pendingUtterances, 0)
  }

  func testStopDeactivatesImmediatelyRegardlessOfQueueDepth() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    XCTAssertTrue(policy.didStop())
    XCTAssertEqual(policy.pendingUtterances, 0)
    XCTAssertFalse(policy.isActive)
    XCTAssertFalse(policy.didStop())
  }

  func testRefusesSpeechWhileInterrupted() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    policy.didBeginInterruption()
    XCTAssertFalse(policy.acceptsSpeech)
    XCTAssertFalse(policy.isActive)
    XCTAssertEqual(policy.pendingUtterances, 0)
    policy.didEndInterruption()
    XCTAssertTrue(policy.acceptsSpeech)
    XCTAssertTrue(policy.willEnqueue())
  }

}

final class SpeechLocaleTests: XCTestCase {
  func testMapsSupportedLocalesToVoices() {
    XCTAssertEqual(SpeechLocale.parse("en")?.voiceIdentifier, "en-US")
    XCTAssertEqual(SpeechLocale.parse("de")?.voiceIdentifier, "de-DE")
    XCTAssertEqual(SpeechLocale.parse("DE")?.voiceIdentifier, "de-DE")
  }

  func testRejectsUnsupportedLocalesRatherThanFallingBack() {
    XCTAssertNil(SpeechLocale.parse("fr"))
    XCTAssertNil(SpeechLocale.parse("en-US"))
    XCTAssertNil(SpeechLocale.parse(""))
  }
}

final class SpeechRateTests: XCTestCase {
  private let minimumRate: Float = 0.0
  private let maximumRate: Float = 1.0

  func testMapsAndBoundsRatesAroundThePlatformDefault() {
    let cases: [(Double?, Float, Float)] = [
      (nil, 0.5, 0.5), (1.5, 0.5, 0.75), (2.0, 0.8, 1.0),
      (9.0, 0.2, 0.4), (0.1, 0.5, 0.25), (.nan, 0.5, 0.5), (.infinity, 0.5, 0.5),
    ]
    for (multiplier, platformDefault, expected) in cases {
      XCTAssertEqual(
        speechRate(multiplier: multiplier, defaultRate: platformDefault,
                   minimumRate: minimumRate, maximumRate: maximumRate),
        expected, accuracy: 0.0001)
    }
  }

}

final class SpeechValidationTests: XCTestCase {
  func testAcceptsOrdinaryGuidance() {
    XCTAssertTrue(validateSpeechText("In 200 metres, turn right onto Hauptstraße."))
    XCTAssertTrue(validateSpeechText("Turn right.\nThen continue straight."))
  }

  func testRejectsEmptyAndOversizedText() {
    XCTAssertFalse(validateSpeechText(""))
    XCTAssertFalse(validateSpeechText(String(repeating: "x", count: 513)))
    XCTAssertTrue(validateSpeechText(String(repeating: "x", count: 512)))
  }

  func testRejectsControlCharacters() {
    XCTAssertFalse(validateSpeechText("Turn\u{0}left"))
    XCTAssertFalse(validateSpeechText("Turn\u{1B}left"))
    XCTAssertFalse(validateSpeechText("Turn\u{7F}left"))
  }

  func testBoundsCueIdentifiers() {
    XCTAssertTrue(validateCueId("s:ground:abc:turn-1"))
    XCTAssertFalse(validateCueId(""))
    XCTAssertFalse(validateCueId(String(repeating: "c", count: 129)))
  }
}

final class SpeakOutcomeTests: XCTestCase {
  func testResultCodesMatchTheJavaScriptContract() {
    XCTAssertEqual(SpeakOutcome.spoken.rawValue, "spoken")
    XCTAssertEqual(SpeakOutcome.skipped.rawValue, "skipped")
    XCTAssertEqual(SpeakOutcome.failed.rawValue, "failed")
  }
}
