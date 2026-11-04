import ActivityKit
import SwiftUI
import WidgetKit

@main struct OpenMapXNavigationWidgets: WidgetBundle {
  var body: some Widget { NavigationLiveActivity() }
}
struct NavigationLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NavigationActivityAttributes.self) { context in
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Image(systemName: context.state.kind == "transit" ? "tram.fill" : "location.north.fill")
          Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
          Spacer()
          Link(context.attributes.endText, destination: context.attributes.endURL).font(.caption)
        }
        Text(context.isStale ? context.attributes.staleText : context.state.instruction)
          .font(.body).lineLimit(2).privacySensitive()
        if !context.isStale, let eventAt = context.state.eventAtMs {
          Text(Date(timeIntervalSince1970: eventAt / 1000), style: .timer).monospacedDigit().font(.subheadline).privacySensitive()
        }
        if !context.isStale && !context.state.detail.isEmpty {
          Text(context.state.detail).font(.subheadline).lineLimit(1).privacySensitive()
        }
      }
      .padding(14).widgetURL(context.attributes.openURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Image(systemName: "location.north.fill") }
        DynamicIslandExpandedRegion(.trailing) { Text(context.isStale ? "—" : context.state.compactText).lineLimit(1).privacySensitive() }
        DynamicIslandExpandedRegion(.center) { Text(context.state.title).font(.headline).lineLimit(1).privacySensitive() }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading) {
            Text(context.isStale ? context.attributes.staleText : context.state.instruction).lineLimit(2).privacySensitive()
            if !context.isStale { Text(context.state.detail).font(.caption).privacySensitive() }
            Link(context.attributes.endText, destination: context.attributes.endURL).font(.caption)
          }
        }
      } compactLeading: {
        Image(systemName: "location.north.fill")
      } compactTrailing: {
        Text(context.isStale ? "—" : context.state.compactText).lineLimit(1).privacySensitive()
      } minimal: {
        Image(systemName: context.isStale ? "location.slash" : "location.north.fill")
      }.widgetURL(context.attributes.openURL)
    }
  }
}
