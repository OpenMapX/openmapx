import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hasIosOnDeviceGuard } from "./voiceCapturePolicy";

const root = dirname(
  createRequire(import.meta.url).resolve("expo-speech-recognition/package.json"),
);
const module = readFileSync(join(root, "ios/ExpoSpeechRecognitionModule.swift"), "utf8");
const recognizer = readFileSync(join(root, "ios/ExpoSpeechRecognizer.swift"), "utf8");
it("installed iOS recognizer fails closed before capture", () =>
  expect(hasIosOnDeviceGuard(module, recognizer)).toBe(true));
it.each([
  "recognizer.isAvailable",
  "recognizer.supportsOnDeviceRecognition",
  'error: "language-not-supported"',
  'sendErrorAndStop(error: "language-not-supported", message: "On-device recognition is unavailable for this locale.")\n              return',
  "(locale: String?)",
  "case .nilRecognizer, .recognizerIsUnavailable:",
])("rejects module regression %s", (fragment) => {
  expect(hasIosOnDeviceGuard(module.replace(fragment, "BROKEN"), recognizer)).toBe(false);
});
it.each([
  "recognizer.isAvailable",
  "recognizer.supportsOnDeviceRecognition",
  "errorHandler(RecognizerError.nilRecognizer)",
  "request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition",
])("rejects recognizer regression %s", (fragment) => {
  expect(hasIosOnDeviceGuard(module, recognizer.replace(fragment, "BROKEN"))).toBe(false);
});
