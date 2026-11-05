import Foundation
import UIKit
import UniformTypeIdentifiers

private final class TransferState {
  private let lock = NSLock(); private var stopped = false
  var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
  func cancel() { lock.lock(); stopped = true; lock.unlock() }
}
/// Supported share-extension flow: save to the group, complete, then let the user open the app.
final class ShareViewController: UIViewController {
  private let de = Locale.preferredLanguages.first?.hasPrefix("de") == true
  private let label = UILabel(), add = UIButton(type: .system), done = UIButton(type: .system)
  private var transfers: [TransferState] = [], progress: [Progress] = []
  private var adding = false, completed = false
  private let heading = UILabel(), symbol = UIImageView()
  private let operation = TransferState()
  private var providers: [NSItemProvider] { (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] } }
  private func copy(_ en: String, _ de: String) -> String { self.de ? de : en }
  // Generated from packages/core/src/theme.ts; no separate native palette.
  private func color(_ key: String) -> UIColor {
    let theme = Bundle.main.object(forInfoDictionaryKey: "OpenMapXTheme") as? [String: [String: String]] ?? [:]
    return UIColor { traits in
      let hex = theme[traits.userInterfaceStyle == .dark ? "dark" : "light"]?[key] ?? ""
      guard let value = UInt32(hex.replacingOccurrences(of: "#", with: ""), radix: 16) else { return .label }
      return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }
  }
  private func text(_ value: String, style: UIFont.TextStyle, secondary: Bool = false) -> UILabel {
    let label = UILabel(); label.text = value; label.numberOfLines = 0
    label.font = .preferredFont(forTextStyle: style); label.adjustsFontForContentSizeCategory = true
    label.textColor = color(secondary ? "textSecondary" : "text"); return label
  }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = color("background"); view.tintColor = color("primary")
    preferredContentSize = CGSize(width: 420, height: 540)
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(scroll)
    let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
    ])
    let brand = text("OpenMapX", style: .headline); brand.textColor = color("primary")
    done.setTitle(copy("Cancel", "Abbrechen"), for: .normal); done.setTitleColor(color("textSecondary"), for: .normal)
    done.titleLabel?.font = .preferredFont(forTextStyle: .body); done.titleLabel?.adjustsFontForContentSizeCategory = true
    done.addTarget(self, action: #selector(finish), for: .touchUpInside)
    done.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    let top = UIStackView(arrangedSubviews: [brand, done]); top.axis = .horizontal; top.spacing = 16
    brand.setContentHuggingPriority(.defaultLow, for: .horizontal); done.setContentHuggingPriority(.required, for: .horizontal)
    stack.addArrangedSubview(top)
    symbol.image = UIImage(systemName: "square.and.arrow.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .medium))
    symbol.tintColor = color("primary"); symbol.contentMode = .left; symbol.heightAnchor.constraint(equalToConstant: 40).isActive = true
    symbol.isAccessibilityElement = false; stack.addArrangedSubview(symbol)
    heading.text = copy("Add to OpenMapX", "Zu OpenMapX hinzufügen"); heading.font = .preferredFont(forTextStyle: .title1)
    heading.adjustsFontForContentSizeCategory = true; heading.numberOfLines = 0; heading.textColor = color("text")
    heading.accessibilityTraits = .header; stack.addArrangedSubview(heading)
    label.numberOfLines = 0; label.font = .preferredFont(forTextStyle: .body); label.adjustsFontForContentSizeCategory = true
    label.textColor = color("textSecondary")
    label.text = copy("Save now. Open OpenMapX afterward to review and import.", "Jetzt hinzufügen. Danach in OpenMapX prüfen und importieren.")
    stack.addArrangedSubview(label)
    let rows = providers.map { provider in ShareSelection.supportedTypes.filter { provider.hasItemConformingToTypeIdentifier($0) } }
    let selection = try? ShareSelection.select(rows)
    let summary = UIStackView(); summary.axis = .vertical; summary.spacing = 6
    switch selection {
      case .files(let files):
        for file in files {
          let name = IntakePolicy.name(providers[file.index].suggestedName ?? copy("Geographic file", "Geodatei"))
          summary.addArrangedSubview(text(name, style: .headline))
        }
        summary.addArrangedSubview(text(files.map { $0.type == "com.topografix.gpx" ? "GPX" : $0.type == "public.geojson" ? "GeoJSON" : "KML" }.joined(separator: " · "), style: .subheadline, secondary: true))
      default:
        summary.addArrangedSubview(text(copy("Shared location", "Geteilter Ort"), style: .headline))
        summary.addArrangedSubview(text(copy("Address or map link", "Adresse oder Kartenlink"), style: .subheadline, secondary: true))
    }
    let card = UIView(); card.backgroundColor = color("surface")
    let radius = Bundle.main.object(forInfoDictionaryKey: "OpenMapXCornerRadius") as? CGFloat ?? 8
    card.layer.cornerRadius = radius; summary.translatesAutoresizingMaskIntoConstraints = false; card.addSubview(summary)
    NSLayoutConstraint.activate([summary.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16), summary.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16), summary.topAnchor.constraint(equalTo: card.topAnchor, constant: 16), summary.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)])
    stack.addArrangedSubview(card)
    var configuration = UIButton.Configuration.filled(); configuration.title = copy("Add to OpenMapX", "Zu OpenMapX hinzufügen")
    configuration.baseBackgroundColor = color("primary"); configuration.baseForegroundColor = color("onPrimary")
    configuration.background.cornerRadius = radius; configuration.cornerStyle = .fixed
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)
    add.configuration = configuration; add.titleLabel?.adjustsFontForContentSizeCategory = true
    add.addTarget(self, action: #selector(save), for: .touchUpInside); stack.addArrangedSubview(add)
    stack.addArrangedSubview(text(copy("Stays on your device for up to 24 hours. Nothing is added to saved places automatically.", "Bleibt bis zu 24 Stunden auf deinem Gerät. Gespeicherte Orte werden nicht automatisch ergänzt."), style: .footnote, secondary: true))
    add.isEnabled = selection != nil && !providers.isEmpty && providers.count <= 5
    if !add.isEnabled { label.text = copy("Share up to five GPX, GeoJSON or KML files, or one location.", "Bis zu fünf GPX-, GeoJSON- oder KML-Dateien oder einen Ort teilen.") }
  }
  private func showResult(_ success: Bool) {
    completed = true; add.isEnabled = true; add.configuration?.showsActivityIndicator = false
    add.configuration?.title = copy("Done", "Fertig")
    done.setTitle(copy("Close", "Schließen"), for: .normal)
    heading.text = success ? copy("Added to OpenMapX", "Zu OpenMapX hinzugefügt") : copy("Some items couldn't be added", "Einige Inhalte fehlen")
    symbol.image = UIImage(systemName: success ? "checkmark.circle" : "exclamationmark.triangle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .medium))
    symbol.tintColor = color(success ? "primary" : "error")
    label.text = success ? copy("Open OpenMapX to review your shared content.", "Öffne OpenMapX, um die geteilten Inhalte zu prüfen.") : copy("Open OpenMapX to review saved items and details.", "Öffne OpenMapX, um gespeicherte Inhalte und Hinweise zu prüfen.")
    UIAccessibility.post(notification: .announcement, argument: heading.text)
  }
  @objc private func finish() {
    operation.cancel()
    transfers.forEach { $0.cancel() }; progress.forEach { $0.cancel() }
    extensionContext?.completeRequest(returningItems: nil)
  }
  @objc private func save() {
    if completed { finish(); return }
    guard !adding else { return }; adding = true; add.isEnabled = false; add.configuration?.showsActivityIndicator = true
    label.text = copy("Adding…", "Wird hinzugefügt…")
    let items = providers
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      do {
        let store = try IntakeContainer.store(writer: "extension")
        let rows = items.map { provider in ShareSelection.supportedTypes.filter { provider.hasItemConformingToTypeIdentifier($0) } }
        let plan = try ShareSelection.select(rows)
        let selections: [(NSItemProvider, String)]
        switch plan {
          case .files(let files): selections = files.map { (items[$0.index], $0.type) }
          case .text(let indices): selections = indices.map { (items[$0], rows[$0].contains("public.url") ? "public.url" : "public.plain-text") }
        }
        var textValues: [String] = []
        for (provider, type) in selections {
          if operation.cancelled { return }
          let state = TransferState(), semaphore = DispatchSemaphore(value: 0)
          var failure: Error?
          DispatchQueue.main.sync { self.transfers.append(state) }
          let completed: (Error?) -> Void = { error in failure = error; semaphore.signal() }
          let transfer: Progress
          if type == UTType.plainText.identifier || type == UTType.url.identifier {
            transfer = Progress(totalUnitCount: 1)
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
              guard !(state.cancelled || self.operation.cancelled) else { completed(IntakeFailure.unreadable); return }
              do {
                if let error { throw error }
                if let url = item as? URL, url.isFileURL { throw IntakeFailure.unsupported }
                else if let url = item as? URL { textValues.append(url.absoluteString); _ = try ShareSelection.text(textValues, allowEmpty: true) }
                else if let text = item as? String { textValues.append(text); _ = try ShareSelection.text(textValues, allowEmpty: true) }
                else { throw IntakeFailure.unsupported }
                completed(nil)
              } catch { completed(error) }
            }
          } else {
            transfer = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
              do {
                guard !(state.cancelled || self.operation.cancelled), let url, error == nil else { throw IntakeFailure.unreadable }
                var name = provider.suggestedName ?? url.lastPathComponent
                if (name as NSString).pathExtension.isEmpty { name += type == "com.topografix.gpx" ? ".gpx" : type == "public.geojson" ? ".geojson" : ".kml" }
                _ = try store.putFile(url, name: name, cancelled: { state.cancelled || self.operation.cancelled }); completed(nil)
              } catch { completed(error) }
            }
          }
          DispatchQueue.main.sync { self.progress.append(transfer) }
          if semaphore.wait(timeout: .now() + 10) == .timedOut { state.cancel(); transfer.cancel(); throw IntakeFailure.unreadable }
          if let failure { throw failure }
        }
        if case .text = plan { _ = try store.putText(ShareSelection.text(textValues), cancelled: { self.operation.cancelled }) }
      } catch {
        if operation.cancelled { return }
        try? IntakeContainer.store(writer: "extension").recordError((error as? IntakeFailure)?.rawValue ?? "unreadable")
        DispatchQueue.main.async { self.showResult(false) }
        return
      }
      DispatchQueue.main.async { self.showResult(true) }
    }
  }
}
