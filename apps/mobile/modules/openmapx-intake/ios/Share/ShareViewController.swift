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
  private var adding = false
  private var providers: [NSItemProvider] { (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] } }
  private func copy(_ en: String, _ de: String) -> String { self.de ? de : en }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    title = copy("Add to OpenMapX", "Zu OpenMapX hinzufügen")
    label.numberOfLines = 0; label.textAlignment = .center; label.font = .preferredFont(forTextStyle: .body)
    label.text = copy("Add this location or geographic file to OpenMapX. Then open the app to review it.", "Diesen Ort oder diese Geodatei zu OpenMapX hinzufügen. Danach die App zur Prüfung öffnen.")
    add.setTitle(copy("Add to OpenMapX", "Zu OpenMapX hinzufügen"), for: .normal)
    add.addTarget(self, action: #selector(save), for: .touchUpInside)
    done.setTitle(copy("Cancel", "Abbrechen"), for: .normal); done.addTarget(self, action: #selector(finish), for: .touchUpInside)
    let heading = UILabel(); heading.text = "OpenMapX"; heading.font = .preferredFont(forTextStyle: .title1)
    let stack = UIStackView(arrangedSubviews: [heading, label, add, done]); stack.axis = .vertical; stack.spacing = 24; stack.alignment = .fill
    stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    add.isEnabled = !providers.isEmpty && providers.count <= 5
    if !add.isEnabled { label.text = copy("Share up to five GPX, GeoJSON or KML files, or one location.", "Bis zu fünf GPX-, GeoJSON- oder KML-Dateien oder einen Ort teilen.") }
  }
  @objc private func finish() {
    transfers.forEach { $0.cancel() }; progress.forEach { $0.cancel() }
    extensionContext?.completeRequest(returningItems: nil)
  }
  @objc private func save() {
    guard !adding else { return }; adding = true; add.isEnabled = false
    label.text = copy("Adding…", "Wird hinzugefügt…")
    let items = providers
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      do {
        let store = try IntakeContainer.store(writer: "extension")
        let types = ["com.topografix.gpx", "org.geojson", "com.google.earth.kml", UTType.url.identifier, UTType.plainText.identifier]
        // All providers must have a supported representation before saving the first one.
        let selections = try items.map { provider -> (NSItemProvider, String) in
          guard let type = types.first(where: { provider.hasItemConformingToTypeIdentifier($0) }) else { throw IntakeFailure.unsupported }
          if items.count > 1 && [UTType.url.identifier, UTType.plainText.identifier].contains(type) { throw IntakeFailure.unsupported }
          return (provider, type)
        }
        for (provider, type) in selections {
          let state = TransferState(), semaphore = DispatchSemaphore(value: 0)
          var failure: Error?
          DispatchQueue.main.sync { self.transfers.append(state) }
          let completed: (Error?) -> Void = { error in failure = error; semaphore.signal() }
          let transfer: Progress
          if type == UTType.plainText.identifier || type == UTType.url.identifier {
            transfer = Progress(totalUnitCount: 1)
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
              guard !state.cancelled else { completed(IntakeFailure.unreadable); return }
              do {
                if let error { throw error }
                if let url = item as? URL, url.isFileURL { _ = try store.putFile(url, name: provider.suggestedName ?? url.lastPathComponent, cancelled: { state.cancelled }) }
                else if let url = item as? URL { _ = try store.putText(url.absoluteString, cancelled: { state.cancelled }) }
                else if let text = item as? String { _ = try store.putText(text, cancelled: { state.cancelled }) }
                else { throw IntakeFailure.unsupported }
                completed(nil)
              } catch { completed(error) }
            }
          } else {
            transfer = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
              do {
                guard !state.cancelled, let url, error == nil else { throw IntakeFailure.unreadable }
                var name = provider.suggestedName ?? url.lastPathComponent
                if (name as NSString).pathExtension.isEmpty { name += type == "com.topografix.gpx" ? ".gpx" : type == "org.geojson" ? ".geojson" : ".kml" }
                _ = try store.putFile(url, name: name, cancelled: { state.cancelled }); completed(nil)
              } catch { completed(error) }
            }
          }
          DispatchQueue.main.sync { self.progress.append(transfer) }
          if semaphore.wait(timeout: .now() + 10) == .timedOut { state.cancel(); transfer.cancel(); throw IntakeFailure.unreadable }
          if let failure { throw failure }
        }
      } catch {
        try? IntakeContainer.store(writer: "extension").recordError((error as? IntakeFailure)?.rawValue ?? "unreadable")
        DispatchQueue.main.async { self.label.text = self.copy("Some items could not be added. Open OpenMapX to review saved items.", "Einige Inhalte konnten nicht hinzugefügt werden. Gespeicherte Inhalte in OpenMapX prüfen."); self.done.setTitle(self.copy("Done", "Fertig"), for: .normal) }
        return
      }
      DispatchQueue.main.async { self.label.text = self.copy("Added to OpenMapX. Open the app to view it.", "Zu OpenMapX hinzugefügt. Zum Ansehen die App öffnen."); self.done.setTitle(self.copy("Done", "Fertig"), for: .normal) }
    }
  }
}
