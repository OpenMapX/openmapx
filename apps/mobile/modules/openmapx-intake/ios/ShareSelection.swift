import Foundation

enum ShareSelection: Equatable {
  struct File: Equatable { let index: Int; let type: String }
  case text([Int]), files([File])
  static let fileTypes = ["com.topografix.gpx", "public.geojson", "com.google.earth.kml"]
  static let textTypes = ["public.url", "public.plain-text"]
  static let supportedTypes = fileTypes + textTypes + ["public.file-url"]
  static func select(_ types: [[String]]) throws -> ShareSelection {
    guard !types.isEmpty, types.count <= 5 else { throw IntakeFailure.tooMany }
    let files = types.enumerated().compactMap { index, row in fileTypes.first(where: row.contains).map { File(index: index, type: $0) } }
    if !files.isEmpty {
      guard files.count == types.count else { throw IntakeFailure.unsupported }
      return .files(files)
    }
    let text = types.indices.filter { !types[$0].contains("public.file-url") && types[$0].contains(where: textTypes.contains) }
    guard !text.isEmpty else { throw IntakeFailure.unsupported }
    return .text(text)
  }
  static func text(_ values: [String], allowEmpty: Bool = false) throws -> String {
    guard values.allSatisfy({ $0.utf16.count <= IntakePolicy.textLength }) else { throw IntakeFailure.tooLarge }
    // Deduplicate attachment values, never structural lines within a travel plan.
    var texts: [String] = []
    for value in values {
      let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty && !texts.contains(text) { texts.append(text) }
    }
    func isLink(_ value: String) -> Bool {
      !value.contains("\n") && value.range(of: "^(https?://|geo:|[a-z][a-z0-9+.-]*://)", options: [.regularExpression, .caseInsensitive]) != nil
    }
    let content = texts.filter { !isLink($0) }
    let embeddedTokens = Set(content.flatMap { $0.split(whereSeparator: { $0.isWhitespace }).map(String.init) })
    let links = texts.filter { isLink($0) && !embeddedTokens.contains($0) }
    let combined = (content + links).joined(separator: "\n")
    guard allowEmpty || !combined.isEmpty else { throw IntakeFailure.unsupported }
    guard combined.utf16.count <= IntakePolicy.textLength, combined.utf8.count <= IntakePolicy.textBytes else { throw IntakeFailure.tooLarge }
    return combined
  }
}
