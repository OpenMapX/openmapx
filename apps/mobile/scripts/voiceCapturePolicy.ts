/** Structural release gate for the pinned iOS recognizer's fail-closed path. */
export function hasIosOnDeviceGuard(module: string, recognizer: string): boolean {
  const start = module.slice(
    module.indexOf('Function("start")'),
    module.indexOf('Function("setCategoryIOS")'),
  );
  const capture = recognizer.slice(
    recognizer.indexOf("private func startRecognizer("),
    recognizer.indexOf("private func startRecognitionTask("),
  );
  return (
    /if options\.requiresOnDeviceRecognition\s*\{\s*guard let recognizer = SFSpeechRecognizer\(locale: Locale\(identifier: options\.lang\)\),\s*recognizer\.isAvailable, recognizer\.supportsOnDeviceRecognition\s*else\s*\{\s*sendErrorAndStop\(error: "language-not-supported",[^\n]+\n\s*return/.test(
      start,
    ) &&
    start.includes("case .nilRecognizer, .recognizerIsUnavailable:") &&
    start.indexOf("if options.requiresOnDeviceRecognition") <
      start.indexOf("try await ExpoSpeechRecognizer(") &&
    /if options\.requiresOnDeviceRecognition\s*\{\s*guard let recognizer, recognizer\.isAvailable, recognizer\.supportsOnDeviceRecognition else\s*\{\s*errorHandler\(RecognizerError.nilRecognizer\)\s*reset\(andEmitEnd: true\)\s*return/.test(
      capture,
    ) &&
    capture.indexOf("if options.requiresOnDeviceRecognition") <
      capture.indexOf("Self.prepareRequest(") &&
    /request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition/.test(recognizer) &&
    !/if recognizer.supportsOnDeviceRecognition/.test(recognizer) &&
    module.includes('Function("supportsOnDeviceRecognition") { (locale: String?) -> Bool in')
  );
}
