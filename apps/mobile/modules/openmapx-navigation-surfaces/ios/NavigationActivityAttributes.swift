import ActivityKit
import Foundation

struct NavigationActivityAttributes: ActivityAttributes {
  typealias ContentState = SurfacePayload
  let sessionId: String
  let scheme: String
  let locale: String
  var openURL: URL { URL(string: "\(scheme):///navigation/active")! }
  var endURL: URL {
    var components = URLComponents()
    components.scheme = scheme
    components.path = "/navigation/end"
    components.host = ""
    components.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
    return components.url!
  }
  var staleText: String { locale == "de" ? "Standort veraltet — OpenMapX öffnen" : "Location outdated — open OpenMapX" }
  var endText: String { locale == "de" ? "Beenden" : "End navigation" }
}
