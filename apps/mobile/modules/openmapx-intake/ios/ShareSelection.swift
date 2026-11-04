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
  static func text(_ values: [String]) throws -> String {
    guard values.allSatisfy({ $0.utf16.count <= IntakePolicy.textLength }) else { throw IntakeFailure.tooLarge }
    var labels: [String] = [], link: String?
    for line in values.flatMap({ $0.components(separatedBy: .newlines) }).map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
      if line.range(of: "^(https?://|geo:|[a-z][a-z0-9+.-]*://)", options: [.regularExpression, .caseInsensitive]) != nil { if link == nil { link = line } }
      else if !labels.contains(line) { labels.append(line) }
    }
    let combined = (labels + (link.map { [$0] } ?? [])).joined(separator: "\n")
    guard !combined.isEmpty else { throw IntakeFailure.unsupported }
    guard combined.utf16.count <= IntakePolicy.textLength, combined.utf8.count <= IntakePolicy.textBytes else { throw IntakeFailure.tooLarge }
    return combined
  }
}
