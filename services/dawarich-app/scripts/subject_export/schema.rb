# Frozen compatibility tuple for the audited managed-Dawarich collector.
module OpenMapxSubjectExport
  IMAGE = "freikin/dawarich:1.15.2".freeze
  IMAGE_DIGEST = "sha256:e58334ca56976feb4c885a8bd34b251ec2e3f45ffeabd4fd4371b5d2108fc70d".freeze
  UPSTREAM_COMMIT = "d81abc4fc467e119f542c56602c78488fbab86fb".freeze
  EXPECTED_SCHEMA_FINGERPRINT = "4ae830ea67dc4894d814d4e2e2d19cb92571c30f2df1df017417f671e26a1e09".freeze
  MAX_INPUT_BYTES = 16 * 1024
  MAX_ENTRY_BYTES = 256 * 1024 * 1024
  MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
  # This is the reviewed ownership surface for 1.15.2. It intentionally
  # contains the columns needed by the collector rather than permitting a
  # reflection-based `select *`; a missing column or ownership FK makes the
  # source unavailable until the tuple is audited again.
  REQUIRED_COLUMNS = {
    "User" => %w[id provider uid email created_at updated_at],
    "Area" => %w[id user_id name latitude longitude radius created_at updated_at],
    "Place" => %w[id user_id name latitude longitude created_at updated_at],
    "Tag" => %w[id user_id name created_at updated_at],
    "Tagging" => %w[id tag_id taggable_id taggable_type created_at updated_at],
    "Import" => %w[id user_id name created_at updated_at],
    "Export" => %w[id user_id name status created_at updated_at],
    "Trip" => %w[id user_id name started_at ended_at created_at updated_at],
    "Notification" => %w[id user_id title content created_at updated_at],
    "Point" => %w[id user_id timestamp lonlat created_at updated_at],
    "Visit" => %w[id user_id name started_at ended_at created_at updated_at],
    "Stat" => %w[id user_id year month distance created_at updated_at],
    "Track" => %w[id user_id start_at end_at original_path created_at updated_at],
    "TrackSegment" => %w[id track_id start_index end_index created_at updated_at],
    "Digest" => %w[id user_id year period_type created_at updated_at],
    "RawDataArchive" => %w[id user_id year month chunk_number created_at updated_at],
    "Flight" => %w[id user_id external_id flight_date created_at updated_at],
    "Note" => %w[id user_id body noted_at created_at updated_at],
    "Poster" => %w[id user_id name created_at updated_at],
    "SharedLink" => %w[id user_id name resource_type created_at updated_at],
    "Family" => %w[id creator_id name created_at updated_at],
    "FamilyMembership" => %w[id family_id user_id role created_at updated_at],
    "FamilyInvitation" => %w[id family_id invited_by_id email token status expires_at created_at updated_at],
    "FamilyLocationRequest" => %w[id family_id requester_id target_user_id status expires_at created_at updated_at],
    "PendingImport" => %w[id claimed_by_user_id original_filename origin expires_at created_at updated_at],
    "AchievementProgress" => %w[id user_id achievement_key state sharing_enabled sharing_uuid created_at updated_at],
    "AchievementUnlockEvent" => %w[id user_id key kind seen_at claim_token claimed_at created_at updated_at],
    "UserAchievement" => %w[id user_id achievement_key earned_at metadata created_at updated_at],
    "RouteVideo" => %w[id user_id name settings status expired_at created_at updated_at],
    "ServiceSetting" => %w[id user_id service provider active config credentials created_at updated_at],
    "TripSource" => %w[id user_id provider base_url status importing last_error last_synced_at selection_token api_key created_at updated_at],
    "PlannedDay" => %w[id trip_id date title notes position created_at updated_at],
    "PlannedDayNote" => %w[id planned_day_id body noted_at position created_at updated_at],
    "PlannedReservation" => %w[id trip_id planned_day_id reservation_type title location starts_at ends_at status notes created_at updated_at],
    "PlannedStop" => %w[id planned_day_id name address latitude longitude starts_at ends_at duration_minutes position category notes transport_mode created_at updated_at],
    "PlannedAccommodation" => %w[id trip_id name address latitude longitude starts_on ends_on check_in_at check_out_at notes created_at updated_at],
    "PlannedTraveller" => %w[id trip_id name owner created_at updated_at],
    "PlannedUnplannedPlace" => %w[id trip_id name address latitude longitude starts_at ends_at duration_minutes position category notes transport_mode created_at updated_at],
    "PointSource" => %w[id digest tracker_id topic ssid bssid connection trigger battery_status inrids in_regions created_at updated_at]
  }.freeze

  REQUIRED_FOREIGN_KEYS = {
    "Area" => %w[user_id], "Place" => %w[user_id], "Tag" => %w[user_id],
    "Import" => %w[user_id], "Export" => %w[user_id], "Trip" => %w[user_id],
    "Notification" => %w[user_id], "Point" => %w[user_id], "Visit" => %w[user_id],
    "Stat" => %w[user_id], "Track" => %w[user_id], "TrackSegment" => %w[track_id],
    "Digest" => %w[user_id], "RawDataArchive" => %w[user_id], "Flight" => %w[user_id],
    "Note" => %w[user_id], "Poster" => %w[user_id], "SharedLink" => %w[user_id],
    "Family" => %w[creator_id], "FamilyMembership" => %w[family_id user_id],
    "FamilyInvitation" => %w[family_id invited_by_id],
    "FamilyLocationRequest" => %w[family_id requester_id target_user_id],
    "AchievementProgress" => %w[user_id], "AchievementUnlockEvent" => %w[user_id],
    "UserAchievement" => %w[user_id], "RouteVideo" => %w[user_id],
    "ServiceSetting" => %w[user_id], "TripSource" => %w[user_id],
    "PlannedDay" => %w[trip_id], "PlannedDayNote" => %w[planned_day_id],
    "PlannedReservation" => %w[planned_day_id trip_id], "PlannedStop" => %w[planned_day_id],
    "PlannedAccommodation" => %w[trip_id], "PlannedTraveller" => %w[trip_id],
    "PlannedUnplannedPlace" => %w[trip_id]
  }.freeze

  # Generated from the reviewed 1.15.2 migration graph.  This inventory is
  # intentionally wider than the direct user-owned relations above: a
  # polymorphic attachment or a visit/point edge can make a record reachable
  # from a subject-owned row even when the FK does not point directly at
  # `users`.  Comparing the complete live graph, rather than checking only
  # required columns, makes an added relation fail closed before collection.
  EXPECTED_FOREIGN_KEYS = %w[
    achievement_progresses.user_id->users.id
    achievement_unlock_events.user_id->users.id
    active_storage_attachments.blob_id->active_storage_blobs.id
    active_storage_variant_records.blob_id->active_storage_blobs.id
    areas.user_id->users.id
    digests.user_id->users.id
    families.creator_id->users.id
    family_invitations.family_id->families.id
    family_invitations.invited_by_id->users.id
    family_location_requests.family_id->families.id
    family_location_requests.requester_id->users.id
    family_location_requests.target_user_id->users.id
    family_memberships.family_id->families.id
    family_memberships.user_id->users.id
    flights.user_id->users.id
    notes.user_id->users.id
    notifications.user_id->users.id
    pending_imports.claimed_by_user_id->users.id
    place_visits.place_id->places.id
    place_visits.visit_id->visits.id
    planned_accommodations.trip_id->trips.id
    planned_day_notes.planned_day_id->planned_days.id
    planned_days.trip_id->trips.id
    planned_reservations.planned_day_id->planned_days.id
    planned_reservations.trip_id->trips.id
    planned_stops.planned_day_id->planned_days.id
    planned_travellers.trip_id->trips.id
    planned_unplanned_places.trip_id->trips.id
    points.raw_data_archive_id->points_raw_data_archives.id
    points.track_id->tracks.id
    points.user_id->users.id
    points.visit_id->visits.id
    points_raw_data_archives.user_id->users.id
    posters.user_id->users.id
    route_videos.user_id->users.id
    service_settings.user_id->users.id
    shared_links.user_id->users.id
    stats.user_id->users.id
    taggings.tag_id->tags.id
    tags.user_id->users.id
    track_segments.track_id->tracks.id
    tracks.user_id->users.id
    trip_sources.user_id->users.id
    trips.trip_source_id->trip_sources.id
    trips.user_id->users.id
    user_achievements.user_id->users.id
    visits.area_id->areas.id
    visits.place_id->places.id
    visits.user_id->users.id
  ].freeze
  ENTRY_PATHS = {
    "source-manifest" => "dawarich/source-manifest.json",
    "account" => "dawarich/account.json",
    "settings" => "dawarich/settings.json",
    "areas" => "dawarich/areas.jsonl",
    "places" => "dawarich/places.jsonl",
    "tags" => "dawarich/tags.jsonl",
    "taggings" => "dawarich/taggings.jsonl",
    "imports" => "dawarich/imports.jsonl",
    "export-records" => "dawarich/export-records.jsonl",
    "trips" => "dawarich/trips.jsonl",
    "notifications" => "dawarich/notifications.jsonl",
    "points" => "dawarich/points.jsonl",
    "visits" => "dawarich/visits.jsonl",
    "stats" => "dawarich/stats.jsonl",
    "tracks" => "dawarich/tracks.jsonl",
    "track-segments" => "dawarich/track-segments.jsonl",
    "digests" => "dawarich/digests.jsonl",
    "raw-archives" => "dawarich/raw-archives.jsonl",
    "flights" => "dawarich/flights.jsonl",
    "notes" => "dawarich/notes.jsonl",
    "posters" => "dawarich/posters.jsonl",
    "shared-links" => "dawarich/shared-links.jsonl",
    "achievement-progress" => "dawarich/achievement-progress.jsonl",
    "achievement-unlock-events" => "dawarich/achievement-unlock-events.jsonl",
    "user-achievements" => "dawarich/user-achievements.jsonl",
    "route-videos" => "dawarich/route-videos.jsonl",
    "service-settings" => "dawarich/service-settings.jsonl",
    "trip-sources" => "dawarich/trip-sources.jsonl",
    "planned-days" => "dawarich/planned-days.jsonl",
    "planned-day-notes" => "dawarich/planned-day-notes.jsonl",
    "planned-reservations" => "dawarich/planned-reservations.jsonl",
    "planned-stops" => "dawarich/planned-stops.jsonl",
    "planned-accommodations" => "dawarich/planned-accommodations.jsonl",
    "planned-travellers" => "dawarich/planned-travellers.jsonl",
    "planned-unplanned-places" => "dawarich/planned-unplanned-places.jsonl",
    "attachments" => "dawarich/attachments.jsonl",
    "rich-text" => "dawarich/rich-text.jsonl",
    "family" => "dawarich/family.jsonl"
  }.freeze

  DYNAMIC_IMPORT_ID = /\Aimport-file-([a-f0-9]{64})\.([a-z0-9]{1,16})\z/.freeze
  DYNAMIC_RAW_ID = /\Araw-file-([a-f0-9]{64})\.([a-z0-9]{1,16})\z/.freeze
  DYNAMIC_ROUTE_VIDEO_ID = /\Aroute-video-file-([a-f0-9]{64})\.([a-z0-9]{1,16})\z/.freeze
  DYNAMIC_POINTS_ID = /\Apoints-(\d{4})-(0[1-9]|1[0-2])\z/.freeze

  # Dynamic members are intentionally resolved from a content-derived id. A
  # path supplied by a request or by a model is never accepted directly.
  def entry_path(id)
    return ENTRY_PATHS.fetch(id) if ENTRY_PATHS.key?(id)

    if (match = DYNAMIC_IMPORT_ID.match(id))
      return "dawarich/import-files/#{match[1]}.#{match[2]}"
    end
    if (match = DYNAMIC_RAW_ID.match(id))
      return "dawarich/raw-files/#{match[1]}.#{match[2]}"
    end
    if (match = DYNAMIC_ROUTE_VIDEO_ID.match(id))
      return "dawarich/route-video-files/#{match[1]}.#{match[2]}"
    end
    if (match = DYNAMIC_POINTS_ID.match(id))
      return "dawarich/points/#{match[1]}/#{match[2]}.jsonl"
    end

    fail "unregistered subject-export entry"
  end

  module_function :entry_path
end
