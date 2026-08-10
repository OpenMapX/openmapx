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
  }

  func testAnEvictedCueCanBeSpokenAgain() {
    var ledger = CueLedger(capacity: 2)
    ledger.record("a")
    ledger.record("b")
    ledger.record("c")
    XCTAssertTrue(ledger.record("a"))
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
    XCTAssertEqual(ledger.count, 1)
  }
}

final class AudioSessionPolicyTests: XCTestCase {
  func testActivatesOnlyForTheFirstQueuedUtterance() {
    var policy = AudioSessionPolicy()
    XCTAssertTrue(policy.willEnqueue())
    XCTAssertFalse(policy.willEnqueue())
    XCTAssertTrue(policy.isActive)
  }

  func testDeactivatesOnlyWhenTheQueueDrains() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    XCTAssertFalse(policy.didFinishUtterance())
    XCTAssertTrue(policy.didFinishUtterance())
    XCTAssertFalse(policy.isActive)
  }

  func testStopDeactivatesImmediatelyRegardlessOfQueueDepth() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    XCTAssertTrue(policy.didStop())
    XCTAssertEqual(policy.pendingUtterances, 0)
    XCTAssertFalse(policy.isActive)
  }

  func testStopOnAnIdlePolicyDoesNotRequestDeactivation() {
    var policy = AudioSessionPolicy()
    XCTAssertFalse(policy.didStop())
  }

  func testFinishingMoreUtterancesThanQueuedDoesNotUnderflow() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    XCTAssertTrue(policy.didFinishUtterance())
    XCTAssertFalse(policy.didFinishUtterance())
    XCTAssertEqual(policy.pendingUtterances, 0)
  }

  func testRefusesSpeechWhileInterrupted() {
    var policy = AudioSessionPolicy()
    policy.willEnqueue()
    policy.didBeginInterruption()
    XCTAssertFalse(policy.acceptsSpeech)
    XCTAssertFalse(policy.isActive)
    XCTAssertEqual(policy.pendingUtterances, 0)
  }

  func testAcceptsSpeechAgainAfterTheInterruptionEnds() {
    var policy = AudioSessionPolicy()
    policy.didBeginInterruption()
    policy.didEndInterruption()
    XCTAssertTrue(policy.acceptsSpeech)
    XCTAssertTrue(policy.willEnqueue())
  }
}

final class SpeechLocaleTests: XCTestCase {
  func testMapsSupportedLocalesToVoices() {
    XCTAssertEqual(SpeechLocale.parse("en")?.voiceIdentifier, "en-US")
    XCTAssertEqual(SpeechLocale.parse("de")?.voiceIdentifier, "de-DE")
  }

  func testIsCaseInsensitive() {
    XCTAssertEqual(SpeechLocale.parse("DE"), .de)
  }

  func testRejectsUnsupportedLocalesRatherThanFallingBack() {
    XCTAssertNil(SpeechLocale.parse("fr"))
    XCTAssertNil(SpeechLocale.parse("en-US"))
    XCTAssertNil(SpeechLocale.parse(""))
  }
}

final class SpeechRateTests: XCTestCase {
  private let defaultRate: Float = 0.5
  private let minimumRate: Float = 0.0
  private let maximumRate: Float = 1.0

  func testUsesThePlatformDefaultWhenNoMultiplierIsGiven() {
    XCTAssertEqual(
      speechRate(
        multiplier: nil, defaultRate: defaultRate,
        minimumRate: minimumRate, maximumRate: maximumRate),
      defaultRate)
  }

  func testScalesAroundThePlatformDefault() {
    XCTAssertEqual(
      speechRate(
        multiplier: 1.5, defaultRate: defaultRate,
        minimumRate: minimumRate, maximumRate: maximumRate),
      0.75, accuracy: 0.0001)
  }

  func testClampsToThePlatformMaximum() {
    XCTAssertEqual(
      speechRate(
        multiplier: 2.0, defaultRate: 0.8,
        minimumRate: minimumRate, maximumRate: maximumRate),
      maximumRate)
  }

  func testClampsAnOutOfContractMultiplierBeforeScaling() {
    XCTAssertEqual(
      speechRate(
        multiplier: 9.0, defaultRate: 0.2,
        minimumRate: minimumRate, maximumRate: maximumRate),
      0.4, accuracy: 0.0001)
  }

  func testFallsBackToTheDefaultForANonFiniteMultiplier() {
    XCTAssertEqual(
      speechRate(
        multiplier: .nan, defaultRate: defaultRate,
        minimumRate: minimumRate, maximumRate: maximumRate),
      defaultRate)
  }
}

final class SpeechValidationTests: XCTestCase {
  func testAcceptsOrdinaryGuidance() {
    XCTAssertTrue(validateSpeechText("In 200 metres, turn right onto Hauptstraße."))
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

  func testAllowsANewlineBetweenSentences() {
    XCTAssertTrue(validateSpeechText("Turn right.\nThen continue straight."))
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
