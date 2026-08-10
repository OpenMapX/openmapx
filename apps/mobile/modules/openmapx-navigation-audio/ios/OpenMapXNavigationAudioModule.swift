import AVFoundation
import ExpoModulesCore

/// The iOS half of the navigation audio module.
///
/// Everything that can be decided without the platform lives in
/// `NavigationAudioPolicy.swift` and is unit-tested there. This file is the thin
/// part: an `AVSpeechSynthesizer`, an `AVAudioSession` configured for voice
/// prompts, and the interruption handling that keeps guidance from talking over
/// a phone call.
public final class OpenMapXNavigationAudioModule: Module {
  private let synthesizer = AVSpeechSynthesizer()
  private lazy var delegate = SpeechDelegate(module: self)

  private var ledger = CueLedger()
  private var sessionPolicy = AudioSessionPolicy()
  private var lastResultCode: String?
  private var didConfigureDelegate = false

  public func definition() -> ModuleDefinition {
    Name("OpenMapXNavigationAudio")

    OnCreate {
      NotificationCenter.default.addObserver(
        self.delegate,
        selector: #selector(SpeechDelegate.handleInterruption(_:)),
        name: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance()
      )
    }

    OnDestroy {
      NotificationCenter.default.removeObserver(self.delegate)
    }

    // `AVSpeechSynthesizer` must be driven from the main thread.
    AsyncFunction("speak") { (request: SpeakRequestRecord) -> String in
      self.speak(request)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopSpeaking()
    }.runOnQueue(.main)

    AsyncFunction("getStatus") { () -> [String: Any?] in
      [
        "initialized": true,
        "speaking": self.synthesizer.isSpeaking,
        "localeAvailable": SpeechLocale.allCases.allSatisfy {
          AVSpeechSynthesisVoice(language: $0.voiceIdentifier) != nil
        },
        "lastResultCode": self.lastResultCode
      ]
    }.runOnQueue(.main)
  }

  private func speak(_ request: SpeakRequestRecord) -> String {
    guard validateCueId(request.cueId), validateSpeechText(request.text) else {
      return finish(.failed)
    }
    guard let locale = SpeechLocale.parse(request.locale) else { return finish(.failed) }
    guard sessionPolicy.acceptsSpeech else { return finish(.skipped) }
    // A replayed cue is silently accepted as already handled, never repeated.
    guard ledger.record(request.cueId) else { return finish(.skipped) }
    guard let voice = AVSpeechSynthesisVoice(language: locale.voiceIdentifier) else {
      return finish(.failed)
    }

    if !didConfigureDelegate {
      synthesizer.delegate = delegate
      didConfigureDelegate = true
    }

    if sessionPolicy.willEnqueue() {
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
          .playback,
          mode: .voicePrompt,
          options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
        )
        try session.setActive(true, options: [])
      } catch {
        _ = sessionPolicy.didStop()
        return finish(.failed)
      }
    }

    let utterance = AVSpeechUtterance(string: request.text)
    utterance.voice = voice
    utterance.rate = speechRate(
      multiplier: request.rate,
      defaultRate: AVSpeechUtteranceDefaultSpeechRate,
      minimumRate: AVSpeechUtteranceMinimumSpeechRate,
      maximumRate: AVSpeechUtteranceMaximumSpeechRate
    )
    synthesizer.speak(utterance)
    return finish(.spoken)
  }

  private func stopSpeaking() {
    synthesizer.stopSpeaking(at: .immediate)
    if sessionPolicy.didStop() { deactivateSession() }
  }

  fileprivate func utteranceDidEnd() {
    if sessionPolicy.didFinishUtterance() { deactivateSession() }
  }

  fileprivate func interruptionBegan() {
    synthesizer.stopSpeaking(at: .immediate)
    sessionPolicy.didBeginInterruption()
    deactivateSession()
  }

  fileprivate func interruptionEnded() {
    sessionPolicy.didEndInterruption()
  }

  private func deactivateSession() {
    // Telling other apps the session is free is what makes music resume
    // promptly instead of staying ducked for the rest of the journey.
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: [.notifyOthersOnDeactivation]
    )
  }

  private func finish(_ outcome: SpeakOutcome) -> String {
    lastResultCode = outcome.rawValue
    return outcome.rawValue
  }
}

/// Expo record for the bounded speak contract. Unknown keys are dropped by the
/// Records machinery, so nothing beyond these four fields can reach native code.
struct SpeakRequestRecord: Record {
  @Field var cueId: String = ""
  @Field var text: String = ""
  @Field var locale: String = "en"
  @Field var rate: Double?
}

/// Kept separate from the module so `NotificationCenter` and the synthesizer
/// hold a reference to an object whose lifetime the module controls.
private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  private weak var module: OpenMapXNavigationAudioModule?

  init(module: OpenMapXNavigationAudioModule) {
    self.module = module
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    module?.utteranceDidEnd()
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    module?.utteranceDidEnd()
  }

  @objc func handleInterruption(_ notification: Notification) {
    guard
      let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    switch type {
    case .began: module?.interruptionBegan()
    case .ended: module?.interruptionEnded()
    @unknown default: break
    }
  }
}
