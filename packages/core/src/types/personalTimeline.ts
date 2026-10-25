// Response types share their source of truth with the runtime boundary schemas.
export type {
  PersonalTimelineDayV1,
  PersonalTimelineErrorCode,
  PersonalTimelineJourneyV1,
  PersonalTimelineSummaryV1,
  PersonalTimelineVisitV1,
  PersonalTimelineWarning,
  TimelineConnectionMode,
  TimelineConnectionStatus,
  TimelineConnectionView,
} from "../schemas/personalTimeline";

export type ConnectPersonalTimelineRequest =
  | { mode: "external"; instanceUrl: string; apiKey: string; displayName?: string }
  | { mode: "managed"; apiKey: string };
