#!/usr/bin/env ruby
# frozen_string_literal: true

# This file is deliberately a small, fixed collector. It receives one request
# on stdin and emits only the reviewed tar contract. It is mounted read-only by
# the managed app; it never accepts a model, SQL fragment, path or command.
require "json"
require "digest"
require "date"
require "logger"
require "rubygems/package"
require_relative "subject_export/schema"

# `docker exec` starts a new Ruby process; loading the Rails environment is
# therefore part of the fixed collector entrypoint. The syntax-only CI check
# does not execute this file, and the guarded require keeps local contract
# tests independent from the image.
begin
  # Rails/Dotenv initializers are allowed to log during boot, but stdout is a
  # binary tar transport once collection starts. Redirect Ruby's current
  # stdout to stderr for boot and restore it before parsing/streaming so
  # startup diagnostics can never corrupt the source part.
  boot_stdout = $stdout
  boot_stderr = $stderr
  boot_sink = File.open(File::NULL, "w")
  $stdout = boot_sink
  $stderr = boot_sink
  require "/var/app/config/environment" unless defined?(Rails)
rescue LoadError, StandardError
  # The normal run path below maps an unbootable application to the bounded
  # collector_failed outcome. Do not print the exception (it may contain
  # deployment paths or credentials).
ensure
  $stdout = boot_stdout if defined?(boot_stdout) && boot_stdout
  $stderr = boot_stderr if defined?(boot_stderr) && boot_stderr
  # Keep the sink open for the lifetime of this short-lived process. Some
  # framework objects retain the boot logger and attempt one final write during
  # shutdown; closing it here would emit `log writing failed` on stderr after
  # an otherwise successful tar stream.
end

module OpenMapxSubjectExport
  module_function

  class CollectorError < StandardError
    attr_reader :code

    def initialize(code)
      @code = code
      super(code)
    end
  end

  SAFE_FIELDS = {
    "User" => %w[id uid provider email first_name last_name created_at updated_at active_until plan status theme],
    "Area" => %w[id name latitude longitude radius created_at updated_at],
    "Place" => %w[id name city country latitude longitude source note geodata created_at updated_at],
    "Tag" => %w[id name color icon privacy_radius_meters created_at updated_at],
    "Tagging" => %w[id tag_id taggable_id taggable_type created_at updated_at],
    "Import" => %w[id name source status demo points_count raw_points processed doubles created_at updated_at processing_started_at],
    "Export" => %w[id name file_type file_format status start_at end_at created_at updated_at processing_started_at],
    "Trip" => %w[id name started_at ended_at distance path visited_countries demo created_at updated_at last_recalculated_at],
    "Notification" => %w[id title content kind read_at created_at updated_at],
    "Point" => %w[id lon lat altitude altitude_decimal accuracy battery battery_status city connection country country_name course course_accuracy external_track_id geodata mode motion_data recorded_at timestamp tracker_id trigger velocity vertical_accuracy visit_id track_id import_id anomaly reverse_geocoded_at created_at updated_at],
    "Visit" => %w[id name started_at ended_at duration confidence confidence_breakdown status area_id place_id demo created_at updated_at],
    "Stat" => %w[id year month distance daily_distance h3_hex_ids toponyms created_at updated_at],
    "Track" => %w[id start_at end_at distance duration avg_speed dominant_mode elevation_gain elevation_loss elevation_max elevation_min tracker_id demo original_path created_at updated_at],
    "TrackSegment" => %w[id track_id start_index end_index distance duration avg_speed max_speed confidence corrected_at source transportation_mode created_at updated_at],
    "Digest" => %w[id year month period_type distance sent_at all_time_stats first_time_visits monthly_distances time_spent_by_location toponyms travel_patterns year_over_year created_at updated_at],
    "RawDataArchive" => %w[id year month chunk_number point_count point_ids_checksum archived_at verified_at metadata created_at updated_at],
    "Flight" => %w[id external_id flight_date date_precision flight_number departure_time arrival_time from_code from_name from_lat from_lon to_code to_name to_lat to_lon airline_iata airline_name aircraft_name aircraft_reg distance_km seat seat_class note created_at updated_at],
    "Note" => %w[id title body noted_at latitude longitude attachable_id attachable_type created_at updated_at],
    "Poster" => %w[id name status created_at updated_at],
    "SharedLink" => %w[id name resource_id resource_type expires_at revoked_at last_accessed_at view_count created_at updated_at],
    "RichText" => %w[id name record_type record_id created_at updated_at],
    "FamilyMembership" => %w[id family_id user_id role created_at updated_at],
    "Family" => %w[id name creator_id created_at updated_at],
    "FamilyInvitation" => %w[id family_id invited_by_id status expires_at created_at updated_at],
    "FamilyLocationRequest" => %w[id family_id requester_id target_user_id status suggested_duration responded_at expires_at created_at updated_at],
    # Claim tickets are bearer credentials used to resume an import. They are
    # intentionally omitted even though the schema contract still checks that
    # the column exists.
    "PendingImport" => %w[id claimed_at claimed_by_user_id origin original_filename source_hint expires_at created_at updated_at],
    "AchievementProgress" => %w[id achievement_key state sharing_enabled created_at updated_at],
    "AchievementUnlockEvent" => %w[id key kind seen_at claimed_at created_at updated_at],
    "UserAchievement" => %w[id achievement_key earned_at metadata created_at updated_at],
    "RouteVideo" => %w[id name settings status expired_at created_at updated_at],
    "ServiceSetting" => %w[id service provider active config created_at updated_at],
    "TripSource" => %w[id provider base_url status importing last_error last_synced_at created_at updated_at],
    "PlannedDay" => %w[id trip_id date title notes position created_at updated_at],
    "PlannedDayNote" => %w[id planned_day_id body noted_at position created_at updated_at],
    "PlannedReservation" => %w[id trip_id planned_day_id reservation_type title location starts_at ends_at status notes created_at updated_at],
    "PlannedStop" => %w[id planned_day_id name address latitude longitude starts_at ends_at duration_minutes position category notes transport_mode created_at updated_at],
    "PlannedAccommodation" => %w[id trip_id name address latitude longitude starts_on ends_on check_in_at check_out_at notes created_at updated_at],
    "PlannedTraveller" => %w[id trip_id name owner created_at updated_at],
    "PlannedUnplannedPlace" => %w[id trip_id name address latitude longitude starts_at ends_at duration_minutes position category notes transport_mode created_at updated_at]
  }.freeze

  MODEL_ENTRIES = {
    "areas" => "Area", "places" => "Place", "tags" => "Tag", "taggings" => "Tagging",
    "imports" => "Import", "export-records" => "Export", "trips" => "Trip",
    "notifications" => "Notification", "points" => "Point", "visits" => "Visit",
    "stats" => "Stat", "tracks" => "Track", "track-segments" => "TrackSegment",
    "digests" => "Digest", "raw-archives" => "RawDataArchive", "flights" => "Flight",
    "notes" => "Note", "posters" => "Poster", "shared-links" => "SharedLink",
    "achievement-progress" => "AchievementProgress",
    "achievement-unlock-events" => "AchievementUnlockEvent",
    "user-achievements" => "UserAchievement", "route-videos" => "RouteVideo",
    "service-settings" => "ServiceSetting", "trip-sources" => "TripSource",
    "planned-days" => "PlannedDay", "planned-day-notes" => "PlannedDayNote",
    "planned-reservations" => "PlannedReservation", "planned-stops" => "PlannedStop",
    "planned-accommodations" => "PlannedAccommodation",
    "planned-travellers" => "PlannedTraveller",
    "planned-unplanned-places" => "PlannedUnplannedPlace",
    "family" => "Family"
  }.freeze

  RELATION_FINGERPRINT_VERSION = "dawarich-relations-v2"
  MAX_RECORDS_PER_ENTRY = 10_000_000
  MAX_SOURCE_ENTRIES = 256
  MAX_FAMILY_ROWS = 100_000
  MAX_NESTING = 8
  SECRET_KEY = /(password|token|secret|api[_-]?key|credential|private|otp|bearer|cookie|authorization|encrypted|assertion|signature)/i.freeze
  # Archive containers are excluded: a subject export must never smuggle a
  # nested archive or executable payload into the passive artifact.
  SAFE_EXTENSIONS = %w[bin csv fit gpx json jsonl jpg jpeg kml mp4 pdf png tcx txt].freeze
  SAFE_SETTING_KEYS = %w[
    fog_of_war_meters fog_of_war_threshold fog_of_war_mode meters_between_routes
    preferred_map_layer speed_colored_routes points_rendering_mode minutes_between_routes
    time_threshold_minutes merge_threshold_minutes live_map_enabled route_opacity route_color
    track_color maps visits_suggestions_enabled enabled_map_layers maps_maplibre_style
    maps_maplibre_custom_theme globe_projection transportation_thresholds
    transportation_expert_thresholds transportation_expert_mode min_minutes_spent_in_city
    max_gap_minutes_in_city gps_filtering_enabled gps_accuracy_threshold timezone
    visit_radius_meters visit_min_points visit_min_duration_minutes visit_density_fill_enabled
    stay_max_gap_minutes point_dragging_enabled news_emails_enabled show_supporter_badge
  ].freeze

  def fail_code(code)
    STDERR.write("openmapx_subject_export:#{code}\n")
    raise CollectorError, code
  end

  def silence_framework_logging!
    return unless defined?(Rails)

    logger = Logger.new(File::NULL)
    Rails.logger = logger if Rails.respond_to?(:logger=)
    ActiveRecord::Base.logger = logger if defined?(ActiveRecord::Base)
  rescue StandardError
    # Logging setup must never reveal framework errors or alter the bounded
    # collector outcome. The normal route still discards child stderr.
  end

  def parse_request
    # `IO#eof?` is not a non-blocking check for a pipe: after `gets` it may
    # still report false until another read reaches the writer's close. Read a
    # bounded remainder explicitly so the caller can provide exactly one line
    # while oversized or trailing input is rejected deterministically.
    line = STDIN.gets(MAX_INPUT_BYTES + 1)
    fail_code("schema_mismatch") if line.nil? || line.bytesize > MAX_INPUT_BYTES
    remainder = STDIN.read(MAX_INPUT_BYTES + 1) || ""
    fail_code("schema_mismatch") unless remainder.empty?
    value = JSON.parse(line)
    keys = value.is_a?(Hash) ? value.keys.map(&:to_s).sort : []
    expected = %w[cutoff expectedDawarichUserId openmapxSubjectId requestId rights version]
    fail_code("schema_mismatch") unless keys == expected
    fail_code("schema_mismatch") unless value["version"] == 1 && value["requestId"].to_s.match?(/\A[0-9a-f-]{36}\z/i)
    fail_code("schema_mismatch") unless value["openmapxSubjectId"].to_s.match?(/\A[^\x00-\x1f\x7f\r\n]{1,256}\z/)
    begin
      DateTime.iso8601(value["cutoff"].to_s)
    rescue ArgumentError
      fail_code("schema_mismatch")
    end
    fail_code("schema_mismatch") unless value["rights"].is_a?(Array) && value["rights"].uniq.sort == value["rights"].sort && value["rights"].all? { |v| %w[access portability].include?(v) }
    value
  rescue JSON::ParserError
    fail_code("schema_mismatch")
  end

  def normalize_value(value, depth = 0, key = nil)
    fail_code("limit_exceeded") if depth > MAX_NESTING
    return "[redacted]" if key && key.to_s.match?(SECRET_KEY)
    case value
    when NilClass, TrueClass, FalseClass, Numeric
      value
    when Time, DateTime
      value.to_time.utc.iso8601(3)
    when Date
      value.iso8601
    when String, Symbol
      value.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "�")[0, 64 * 1024]
    when Array
      value.first(10_000).map { |item| normalize_value(item, depth + 1) }
    when Hash
      fail_code("limit_exceeded") if value.length > 256
      value.each_with_object({}) do |(child_key, child_value), output|
        normalized_key = child_key.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "�")[0, 128]
        output[normalized_key] = normalize_value(child_value, depth + 1, normalized_key)
      end
    else
      if value.respond_to?(:x) && value.respond_to?(:y)
        [value.x.to_f, value.y.to_f]
      elsif value.respond_to?(:coordinates)
        normalize_value(value.coordinates, depth + 1)
      else
        value.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "�")[0, 16 * 1024]
      end
    end
  end

  def attributes(record, model_name)
    allowed = SAFE_FIELDS.fetch(model_name, %w[id created_at updated_at])
    allowed.each_with_object({}) do |field, output|
      next unless record.respond_to?(field)

      begin
        output[field] = normalize_value(record.public_send(field), 0, field)
      rescue ActiveModel::MissingAttributeError, NoMethodError
        next
      end
    end
  end

  def model_for(model_name)
    constant = {
      "Digest" => "Users::Digest",
      "RawDataArchive" => "Points::RawDataArchive",
      "FamilyMembership" => "Family::Membership",
      "FamilyInvitation" => "Family::Invitation",
      "FamilyLocationRequest" => "Family::LocationRequest",
      "RichText" => "ActionText::RichText",
      "AchievementProgress" => "Achievements::Progress",
      "AchievementUnlockEvent" => "Achievements::UnlockEvent"
    }.fetch(model_name, model_name)
    model = constant.split("::").reduce(Object) { |scope, part| scope.const_get(part, false) }
    return nil unless model.respond_to?(:where) && model.respond_to?(:column_names)

    model
  rescue NameError
    nil
  end

  def relation_foreign_key(model)
    columns = model.column_names.map(&:to_s)
    return :user_id if columns.include?("user_id")
    return :owner_id if columns.include?("owner_id")

    nil
  end

  def relation_scope(entry_id, model, user, cutoff)
    relation = case entry_id
    when "taggings"
      # A tagging has no user_id. Restrict it to subject-owned tags and places
      # explicitly; never infer ownership from a free-text taggable type.
      place_ids = model_for("Place")&.where(user_id: user.id)&.select(:id)
      tag_ids = model_for("Tag")&.where(user_id: user.id)&.select(:id)
      model.where(tag_id: tag_ids).or(model.where(taggable_type: "Place", taggable_id: place_ids))
    when "track-segments"
      track_ids = model_for("Track")&.where(user_id: user.id)&.select(:id)
      model.where(track_id: track_ids)
    when "planned-days", "planned-reservations", "planned-accommodations", "planned-travellers", "planned-unplanned-places"
      trip_ids = model_for("Trip")&.where(user_id: user.id)&.select(:id)
      model.where(trip_id: trip_ids)
    when "planned-day-notes", "planned-stops"
      trip_ids = model_for("Trip")&.where(user_id: user.id)&.select(:id)
      day_ids = model_for("PlannedDay")&.where(trip_id: trip_ids)&.select(:id)
      model.where(planned_day_id: day_ids)
    when "family-memberships"
      model.where(user_id: user.id)
    else
      foreign_key = relation_foreign_key(model)
      return nil unless foreign_key

      model.where(foreign_key => user.id)
    end
    return nil unless relation
    columns = model.column_names.map(&:to_s)
    relation = relation.where(created_at: ..cutoff) if columns.include?("created_at")
    relation = relation.where(timestamp: ..cutoff.to_i) if entry_id == "points" && columns.include?("timestamp")
    relation = relation.order(:id) if columns.include?("id") && relation.respond_to?(:order)
    relation
  end

  def validate_schema!(user)
    user_columns = User.column_names.map(&:to_s)
    fail_code("unsupported_schema") unless %w[id provider uid].all? { |column| user_columns.include?(column) }

    # Validate the reviewed ownership/role inventory before opening any
    # relation. This is deliberately fail-closed: a migration that removes an
    # FK, renames a timestamp or adds a new relation cannot be represented as
    # a successful empty export.
    REQUIRED_COLUMNS.each do |model_name, required_columns|
      model = model_for(model_name)
      fail_code("unsupported_schema") unless model
      columns = model.column_names.map(&:to_s)
      fail_code("unsupported_schema") unless required_columns.all? { |column| columns.include?(column) }
      required_fks = REQUIRED_FOREIGN_KEYS.fetch(model_name, [])
      fail_code("unsupported_schema") unless required_fks.all? { |column| columns.include?(column) }
    end

    # Column presence alone cannot detect a newly introduced relation or a
    # changed ownership edge.  Compare the complete database FK graph against
    # the generated inventory for this exact image before opening any source
    # relation.  Constraint names are deliberately ignored; table/column/
    # target identity is the reviewed compatibility surface.
    connection = if defined?(ActiveRecord::Base)
                   ActiveRecord::Base.connection
                 elsif user.class.respond_to?(:connection)
                   user.class.connection
                 end
    fail_code("unsupported_schema") unless connection
    observed_foreign_keys = connection.tables.flat_map do |table|
      connection.foreign_keys(table).map do |foreign_key|
        column = Array(foreign_key.options[:column]).map(&:to_s).join(",")
        primary_key = Array(foreign_key.options[:primary_key] || "id").map(&:to_s).join(",")
        "#{foreign_key.from_table}.#{column}->#{foreign_key.to_table}.#{primary_key}"
      end
    end.sort
    fail_code("unsupported_schema") unless observed_foreign_keys == EXPECTED_FOREIGN_KEYS.sort

    fingerprint_rows = REQUIRED_COLUMNS.map do |model_name, _required_columns|
      model = model_for(model_name)
      next { "entry" => model_name, "model" => model_name, "available" => false } unless model

      columns = model.column_names.map(&:to_s).sort
      foreign_key = REQUIRED_FOREIGN_KEYS.fetch(model_name, []).join(",")
      # A known relation that exists in this pinned release must expose an
      # ownership FK. If a migration changes that shape, do not silently emit
      # an empty export and call it complete.
      { "entry" => model_name, "model" => model_name, "columns" => columns, "foreignKey" => foreign_key.empty? ? nil : foreign_key }
    end
    fingerprint = Digest::SHA256.hexdigest(JSON.generate({ "version" => RELATION_FINGERPRINT_VERSION, "user" => user.class.column_names.map(&:to_s).sort, "relations" => fingerprint_rows }))
    fail_code("unsupported_schema") unless fingerprint == EXPECTED_SCHEMA_FINGERPRINT
    [fingerprint, fingerprint_rows]
  rescue CollectorError
    raise
  rescue NoMethodError, StandardError
    fail_code("unsupported_schema")
  end

  def each_relation_record(model, foreign_key, user, cutoff, entry_id: nil, &block)
    relation = relation_scope(entry_id, model, user, cutoff)
    return unless relation
    # The query is fixed and uses a bound ActiveRecord value; it is never
    # assembled from request data. This prevents post-receipt rows entering the
    # snapshot when a collector is run against a live managed instance.
    if relation.respond_to?(:find_each)
      relation.find_each(batch_size: 1_000) { |record| block.call(record) }
    else
      relation.each { |record| block.call(record) }
    end
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def serialized_row(record, model_name)
    data = attributes(record, model_name)
    if model_name == "RichText" && record.respond_to?(:body)
      # Action Text stores HTML. Export a bounded, inert text projection rather
      # than a blob of markup that could be mistaken for executable content.
      text = record.body.to_s.gsub(/<!--.*?-->/m, " ").gsub(/<[^>]*>/, " ").gsub(/\s+/, " ").strip
      data["bodyText"] = normalize_value(text)
      data["redactionCodes"] = ["dawarich-rich-text-markup-stripped"]
    end
    JSON.generate(data) + "\n"
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def relation_descriptor(entry_id, model_name, user, cutoff, scope: nil, portability: nil)
    model = model_for(model_name)
    return nil unless model

    foreign_key = relation_foreign_key(model)
    return nil unless foreign_key || scope
    each = lambda do |&block|
      if scope
        relation = scope
        relation = relation.where(created_at: ..cutoff) if model.column_names.map(&:to_s).include?("created_at")
        relation = relation.order(:id) if model.column_names.map(&:to_s).include?("id") && relation.respond_to?(:order)
        relation.find_each(batch_size: 1_000, &block)
      else
        each_relation_record(model, foreign_key, user, cutoff, entry_id: entry_id, &block)
      end
    end

    digest = Digest::SHA256.new
    bytes = 0
    records = 0
    each.call do |record|
      records += 1
      fail_code("limit_exceeded") if records > MAX_RECORDS_PER_ENTRY
      line = serialized_row(record, model_name)
      bytes += line.bytesize
      fail_code("limit_exceeded") if bytes > MAX_ENTRY_BYTES
      digest.update(line)
    end
    expected_digest = digest.hexdigest
    {
      id: entry_id,
      bytes: bytes,
      records: records,
      sha256: expected_digest,
      article15: true,
      portability: portability.nil? ? (%w[places points raw-archives imports flights notes route-videos planned-days planned-day-notes planned-reservations planned-stops planned-accommodations planned-travellers planned-unplanned-places].include?(entry_id) || entry_id.start_with?("points-")) : portability,
      redaction_codes: entry_id == "notes" ? ["dawarich-rights-of-others-review"] : [],
      write: lambda do |io|
        actual_digest = Digest::SHA256.new
        actual_bytes = 0
        actual_records = 0
        each.call do |record|
          line = serialized_row(record, model_name)
          actual_records += 1
          actual_bytes += line.bytesize
          fail_code("limit_exceeded") if actual_records > MAX_RECORDS_PER_ENTRY || actual_bytes > MAX_ENTRY_BYTES
          actual_digest.update(line)
          write_all(io, line)
        end
        fail_code("collector_failed") unless actual_records == records && actual_bytes == bytes && actual_digest.hexdigest == expected_digest
      end
    }
  end

  def callback_descriptor(entry_id, portability: false, redaction_codes: [], each_row:)
    digest = Digest::SHA256.new
    bytes = 0
    records = 0
    each_row.call do |row|
      records += 1
      fail_code("limit_exceeded") if records > MAX_RECORDS_PER_ENTRY
      line = JSON.generate(normalize_value(row)) + "\n"
      bytes += line.bytesize
      fail_code("limit_exceeded") if bytes > MAX_ENTRY_BYTES
      digest.update(line)
    end
    expected_digest = digest.hexdigest
    {
      id: entry_id,
      bytes: bytes,
      records: records,
      sha256: expected_digest,
      article15: true,
      portability: portability,
      redaction_codes: redaction_codes,
      write: lambda do |io|
        actual_digest = Digest::SHA256.new
        actual_bytes = 0
        actual_records = 0
        each_row.call do |row|
          line = JSON.generate(normalize_value(row)) + "\n"
          actual_records += 1
          actual_bytes += line.bytesize
          fail_code("limit_exceeded") if actual_records > MAX_RECORDS_PER_ENTRY || actual_bytes > MAX_ENTRY_BYTES
          actual_digest.update(line)
          write_all(io, line)
        end
        fail_code("collector_failed") unless actual_records == records && actual_bytes == bytes && actual_digest.hexdigest == expected_digest
      end
    }
  end

  def point_months(user, cutoff)
    model = model_for("Point")
    return [] unless model

    months = {}
    each_relation_record(model, :user_id, user, cutoff, entry_id: "points") do |record|
      timestamp = record.respond_to?(:timestamp) ? record.timestamp.to_i : 0
      next if timestamp <= 0

      instant = Time.at(timestamp).utc
      months[format("%04d-%02d", instant.year, instant.month)] = true
    end
    months.keys.sort
  end

  def point_descriptors(user, cutoff)
    model = model_for("Point")
    return [] unless model

    base = relation_scope("points", model, user, cutoff)
    return [] unless base

    point_months(user, cutoff).filter_map do |month|
      year, month_number = month.split("-").map(&:to_i)
      start_at = Time.utc(year, month_number, 1).to_i
      next_month = Date.new(year, month_number, 1) >> 1
      end_at = Time.utc(next_month.year, next_month.month, 1).to_i
      relation_descriptor(
        "points-#{month}",
        "Point",
        user,
        cutoff,
        scope: base.where(timestamp: start_at...end_at),
        portability: true
      )
    end
  end

  def rich_text_descriptor(user, cutoff)
    model = model_for("RichText")
    trips = model_for("Trip")
    return nil unless model && trips

    trip_ids = trips.where(user_id: user.id).select(:id)
    scope = model.where(record_type: "Trip", record_id: trip_ids)
    scope = scope.where(created_at: ..cutoff) if model.column_names.map(&:to_s).include?("created_at")
    relation_descriptor("rich-text", "RichText", user, cutoff, scope: scope, portability: false)
  end

  def safe_extension(filename, content_type)
    extension = File.extname(filename.to_s).delete_prefix(".").downcase
    return extension if SAFE_EXTENSIONS.include?(extension)

    type_extension = {
      "application/json" => "json", "application/jsonl" => "jsonl", "text/csv" => "csv",
      "application/gpx+xml" => "gpx", "application/pdf" => "pdf", "image/jpeg" => "jpg",
      "image/png" => "png", "text/plain" => "txt", "video/mp4" => "mp4"
    }[content_type.to_s]
    type_extension || "bin"
  end

  def attachment_digest_and_size(blob)
    expected_size = Integer(blob.byte_size)
    fail_code("limit_exceeded") if expected_size.negative? || expected_size > MAX_ENTRY_BYTES
    digest = Digest::SHA256.new
    actual_size = 0
    blob.download do |chunk|
      value = chunk.to_s.b
      actual_size += value.bytesize
      fail_code("limit_exceeded") if actual_size > MAX_ENTRY_BYTES
      digest.update(value)
    end
    fail_code("collector_failed") unless actual_size == expected_size
    [actual_size, digest.hexdigest]
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def attachment_descriptor(attachment, kind)
    blob = attachment.blob
    return nil unless blob

    bytes, sha256 = attachment_digest_and_size(blob)
    extension = safe_extension(blob.filename.to_s, blob.content_type)
    opaque = Digest::SHA256.hexdigest("openmapx/dawarich/attachment/v1\0#{kind}\0#{attachment.id}\0#{blob.id}")
    id = "#{kind}-file-#{opaque}.#{extension}"
    {
      id: id,
      bytes: bytes,
      records: nil,
      sha256: sha256,
      article15: true,
      portability: true,
      redaction_codes: [],
      write: lambda do |io|
        actual_size = 0
        actual_digest = Digest::SHA256.new
        blob.download do |chunk|
          value = chunk.to_s.b
          actual_size += value.bytesize
          actual_digest.update(value)
          write_all(io, value)
        end
        fail_code("collector_failed") unless actual_size == bytes && actual_digest.hexdigest == sha256
      end
    }
  end

  def attachments_projection(user, cutoff)
    attachment_model = model_for("ActiveStorage::Attachment")
    blob_model = model_for("ActiveStorage::Blob")
    return [nil, []] unless attachment_model && blob_model

    targets = [
      ["Import", model_for("Import"), :user_id, "import"],
      ["PendingImport", model_for("PendingImport"), :claimed_by_user_id, "import"],
      ["Points::RawDataArchive", model_for("RawDataArchive"), :user_id, "raw"],
      ["RouteVideo", model_for("RouteVideo"), :user_id, "route-video"]
    ]
    metadata = []
    binaries = []
    seen = 0
    targets.each do |record_type, model, owner_column, kind|
      next unless model

      owner_ids = model.where(owner_column => user.id).select(:id)
      attachments = attachment_model.where(record_type: record_type, record_id: owner_ids)
                                      .where(created_at: ..cutoff).order(:id)
      attachments.find_each(batch_size: 100) do |attachment|
        seen += 1
        fail_code("limit_exceeded") if seen > 64
        blob = attachment.blob
        next unless blob
        descriptor = attachment_descriptor(attachment, kind)
        next unless descriptor
        metadata << {
          "id" => attachment.id,
          "recordType" => record_type,
          "recordIdDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/record/v1\0#{record_type}\0#{attachment.record_id}"),
          "name" => attachment.name,
          "filename" => normalize_value(blob.filename.to_s),
          "contentType" => normalize_value(blob.content_type.to_s),
          "bytes" => descriptor[:bytes],
          "fileEntryId" => descriptor[:id],
          "portable" => true
        }
        binaries << descriptor
      end
    end
    # Export/Poster attachments are generated/derived files. Their metadata is
    # represented by the corresponding record, but their bytes are deliberately
    # excluded from this source part.
    %w[Export Poster].each do |record_type|
      model = model_for(record_type)
      next unless model
      owner_ids = model.where(user_id: user.id).select(:id)
      attachment_model.where(record_type: record_type, record_id: owner_ids)
                      .where(created_at: ..cutoff).order(:id).find_each do |attachment|
        blob = attachment.blob
        metadata << {
          "id" => attachment.id,
          "recordType" => record_type,
          "recordIdDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/record/v1\0#{record_type}\0#{attachment.record_id}"),
          "name" => attachment.name,
          "filename" => blob ? normalize_value(blob.filename.to_s) : nil,
          "contentType" => blob ? normalize_value(blob.content_type.to_s) : nil,
          "bytes" => blob ? Integer(blob.byte_size) : 0,
          "fileEntryId" => nil,
          "portable" => false,
          "redactionCodes" => ["derived_duplicate_unsafe_archive"]
        }
      end
    end
    content = metadata.sort_by { |row| row["id"].to_s }.map { |row| JSON.generate(row) + "\n" }.join
    descriptor = static_entry(
      "attachments",
      content,
      portability: binaries.any?,
      records: metadata.length,
      redaction_codes: ["derived_duplicate_unsafe_archive"]
    )
    [descriptor, binaries]
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def family_descriptor(user, cutoff)
    membership_model = model_for("FamilyMembership")
    family_model = model_for("Family")
    invitation_model = model_for("FamilyInvitation")
    request_model = model_for("FamilyLocationRequest")
    return static_entry("family", "", portability: false, redaction_codes: ["dawarich-family-not-available"]) unless membership_model && family_model

    memberships = membership_model.where(user_id: user.id).where(created_at: ..cutoff).order(:id).limit(MAX_FAMILY_ROWS + 1).to_a
    fail_code("limit_exceeded") if memberships.length > MAX_FAMILY_ROWS
    family_ids = memberships.map(&:family_id).compact.uniq
    family_scope = family_ids.any? ? family_model.where(id: family_ids).or(family_model.where(creator_id: user.id)) : family_model.where(creator_id: user.id)
    families = family_scope.where(created_at: ..cutoff).order(:id).limit(MAX_FAMILY_ROWS + 1).to_a
    fail_code("limit_exceeded") if families.length > MAX_FAMILY_ROWS
    family_ids = (family_ids + families.map(&:id)).compact.uniq
    rows = families.map do |family|
      membership = memberships.find { |candidate| candidate.family_id == family.id }
      {
        "kind" => "family",
        "idDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/family/v1\0#{family.id}"),
        "name" => normalize_value(family.name),
        "role" => membership ? normalize_value(membership.role) : (family.creator_id.to_i == user.id.to_i ? "creator" : nil),
        "createdAt" => normalize_value(family.created_at),
        "updatedAt" => normalize_value(family.updated_at)
      }
    end
    fail_code("limit_exceeded") if rows.length > MAX_FAMILY_ROWS
    memberships.each do |membership|
      rows << {
        "kind" => "membership",
        "idDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/membership/v1\0#{membership.id}"),
        "familyIdDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/family/v1\0#{membership.family_id}"),
        "role" => normalize_value(membership.role),
        "createdAt" => normalize_value(membership.created_at),
        "updatedAt" => normalize_value(membership.updated_at)
      }
      fail_code("limit_exceeded") if rows.length > MAX_FAMILY_ROWS
    end
    if invitation_model
      invitation_scope = family_ids.any? ? invitation_model.where(family_id: family_ids).or(invitation_model.where(invited_by_id: user.id)) : invitation_model.where(invited_by_id: user.id)
      invitation_scope.where(created_at: ..cutoff).order(:id).find_each do |invitation|
        rows << {
          "kind" => "invitation",
          "idDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/invitation/v1\0#{invitation.id}"),
          "familyIdDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/family/v1\0#{invitation.family_id}"),
          "status" => normalize_value(invitation.status),
          "expiresAt" => normalize_value(invitation.expires_at),
          "invitedBySubject" => invitation.invited_by_id.to_i == user.id.to_i,
          "emailMatchesSubject" => invitation.respond_to?(:email) && invitation.email.to_s.casecmp?(user.email.to_s),
          "createdAt" => normalize_value(invitation.created_at),
          "updatedAt" => normalize_value(invitation.updated_at),
          "redactionCodes" => ["dawarich-family-other-member-redacted"]
        }
        fail_code("limit_exceeded") if rows.length > MAX_FAMILY_ROWS
      end
    end
    if request_model
      request_scope = if family_ids.any?
                        request_model.where(family_id: family_ids)
                                     .or(request_model.where(requester_id: user.id))
                                     .or(request_model.where(target_user_id: user.id))
                      else
                        request_model.where(requester_id: user.id).or(request_model.where(target_user_id: user.id))
                      end
      request_scope.where(created_at: ..cutoff).order(:id).find_each do |request|
        rows << {
          "kind" => "location-request",
          "idDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/location-request/v1\0#{request.id}"),
          "familyIdDigest" => Digest::SHA256.hexdigest("openmapx/dawarich/family/v1\0#{request.family_id}"),
          "role" => request.requester_id.to_i == user.id.to_i ? "requester" : "target",
          "status" => normalize_value(request.status),
          "suggestedDuration" => normalize_value(request.suggested_duration),
          "respondedAt" => normalize_value(request.responded_at),
          "expiresAt" => normalize_value(request.expires_at),
          "createdAt" => normalize_value(request.created_at),
          "updatedAt" => normalize_value(request.updated_at),
          "redactionCodes" => ["dawarich-family-other-member-redacted"]
        }
        fail_code("limit_exceeded") if rows.length > MAX_FAMILY_ROWS
      end
    end
    lines = rows.sort_by { |row| [row["kind"].to_s, row["idDigest"].to_s] }.map { |row| JSON.generate(row) + "\n" }
    static_entry("family", lines.join, portability: false, records: rows.length, redaction_codes: ["dawarich-family-other-member-redacted"])
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def settings_payload(user)
    raw = if user.respond_to?(:safe_settings) && user.safe_settings.respond_to?(:settings)
            user.safe_settings.settings
          elsif user.respond_to?(:settings)
            user.settings
          else
            {}
          end
    raw = {} unless raw.is_a?(Hash)
    normalized_raw = raw.each_with_object({}) do |(raw_key, raw_value), output|
      key = raw_key.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "�")[0, 128]
      output[key] = raw_value
    end
    values = {}
    redacted = []
    fail_code("limit_exceeded") if normalized_raw.length > 256
    normalized_raw.keys.sort.each do |key|
      if SAFE_SETTING_KEYS.include?(key)
        values[key] = normalize_value(normalized_raw[key], 0, key)
      else
        redacted << key
      end
    end
    {
      "values" => values,
      "redactedKeys" => redacted.first(256),
      "redactionCodes" => ["dawarich-settings-secrets-redacted"]
    }
  rescue CollectorError
    raise
  rescue StandardError
    fail_code("collector_failed")
  end

  def write_all(io, value)
    offset = 0
    while offset < value.bytesize
      written = io.write(value.byteslice(offset, value.bytesize - offset))
      fail_code("collector_failed") unless written.is_a?(Integer) && written.positive?
      offset += written
    end
  end

  def static_entry(id, content, article15: true, portability: false, records: nil, redaction_codes: [])
    bytes = content.b
    fail_code("limit_exceeded") if bytes.bytesize > MAX_ENTRY_BYTES
    {
      id: id,
      content: bytes,
      bytes: bytes.bytesize,
      records: records,
      sha256: Digest::SHA256.hexdigest(bytes),
      article15: article15,
      portability: portability,
      redaction_codes: redaction_codes,
      write: ->(io) { write_all(io, bytes) }
    }
  end

  def tar(entries)
    total = entries.sum { |item| item[:bytes] }
    fail_code("limit_exceeded") if total > MAX_TOTAL_BYTES
    # Write the tar directly to the authenticated stdout pipe. Keeping a
    # StringIO here would create a second multi-gigabyte plaintext copy before
    # the ops-agent can apply its output bound.
    STDOUT.binmode
    STDOUT.sync = true
    Gem::Package::TarWriter.new(STDOUT) do |writer|
      entries.each do |item|
        writer.add_file_simple(entry_path(item[:id]), 0o600, item[:bytes]) do |file|
          item[:write].call(file)
        end
      end
    end
  end

  def run
    request = parse_request
    fail_code("collector_failed") unless defined?(User)
    silence_framework_logging!
    transaction = Object.const_defined?("ApplicationRecord") ? ApplicationRecord : (defined?(ActiveRecord::Base) ? ActiveRecord::Base : nil)
    runner = proc do
      users = User.where(provider: "openid_connect", uid: request["openmapxSubjectId"]).limit(2).to_a
      fail_code("not_found") if users.empty?
      fail_code("ambiguous_identity") unless users.length == 1
      user = users.first
      expected = request["expectedDawarichUserId"]
      fail_code("identity_mismatch") if expected && user.id.to_i != expected.to_i
      cutoff = DateTime.iso8601(request["cutoff"]).to_time
      schema_fingerprint, schema_relations = validate_schema!(user)

      source_entries = []
      account = {
        "id" => user.id,
        "provider" => user.respond_to?(:provider) ? user.provider : "openid_connect",
        "uid" => user.respond_to?(:uid) ? user.uid : request["openmapxSubjectId"],
        "email" => user.respond_to?(:email) ? user.email : nil,
        "firstName" => user.respond_to?(:first_name) ? user.first_name : nil,
        "lastName" => user.respond_to?(:last_name) ? user.last_name : nil,
        "created_at" => user.respond_to?(:created_at) ? user.created_at : nil,
        "updated_at" => user.respond_to?(:updated_at) ? user.updated_at : nil,
        "redactionCodes" => ["dawarich-authentication-secrets-redacted"]
      }
      source_entries << static_entry("account", JSON.generate(normalize_value(account)), portability: false, redaction_codes: ["dawarich-authentication-secrets-redacted"])

      source_entries << static_entry("settings", JSON.generate(settings_payload(user)), redaction_codes: ["dawarich-settings-secrets-redacted"])

      MODEL_ENTRIES.each do |id, model_name|
        next if %w[family points].include?(id)
        model = model_for(model_name)
        next unless model
        scope = relation_scope(id, model, user, cutoff)
        descriptor = relation_descriptor(id, model_name, user, cutoff, scope: scope)
        source_entries << descriptor if descriptor
      end
      # Points are split by UTC month so a recipient can process a large
      # history incrementally and the API never needs to buffer the full set.
      source_entries.concat(point_descriptors(user, cutoff))
      rich_text = rich_text_descriptor(user, cutoff)
      source_entries << rich_text if rich_text
      attachment_metadata, attachment_files = attachments_projection(user, cutoff)
      source_entries << attachment_metadata if attachment_metadata
      source_entries.concat(attachment_files)
      source_entries << family_descriptor(user, cutoff)

      # Pending imports are temporary but still subject data. Merge them into
      # the regular imports member so the protocol remains a fixed namespace.
      pending_model = model_for("PendingImport")
      if pending_model
        pending_scope = pending_model.where(claimed_by_user_id: user.id).where(created_at: ..cutoff).order(:id)
        import_model = model_for("Import")
        import_scope = relation_scope("imports", import_model, user, cutoff) if import_model
        rows = lambda do |&yield_row|
          import_scope&.find_each(batch_size: 1_000) { |record| yield_row.call({ "recordType" => "import", **attributes(record, "Import") }) }
          pending_scope.find_each(batch_size: 1_000) { |record| yield_row.call({ "recordType" => "pending-import", **attributes(record, "PendingImport") }) }
        end
        source_entries.delete_if { |entry| entry[:id] == "imports" }
        source_entries << callback_descriptor("imports", portability: true, each_row: rows)
      end

      digest = Digest::SHA256.hexdigest(request["openmapxSubjectId"])
      manifest_entries = source_entries.map do |item|
        { "id" => item[:id], "bytes" => item[:bytes], "sha256" => item[:sha256], "records" => item[:records], "article15" => item[:article15], "portability" => item[:portability], "redactionCodes" => item[:redaction_codes] }
      end
      manifest = {
        "version" => 1,
        "image" => IMAGE,
        "imageDigest" => IMAGE_DIGEST,
        "upstreamCommit" => UPSTREAM_COMMIT,
        "collectorContract" => "openmapx-subject-export-v1",
        "subjectUserIdDigest" => digest,
        "cutoff" => request["cutoff"],
        "snapshotAt" => Time.now.utc.iso8601(3),
        "schemaFingerprint" => schema_fingerprint,
        "schemaRelations" => schema_relations,
        "entries" => manifest_entries,
        "warnings" => ["derived_duplicate_unsafe_archive", "family-and-third-party-review-required"]
      }
      manifest_entry = static_entry("source-manifest", JSON.generate(normalize_value(manifest)), article15: true, portability: false)
      fail_code("limit_exceeded") if source_entries.length + 1 > MAX_SOURCE_ENTRIES
      fail_code("limit_exceeded") if source_entries.sum { |item| item[:bytes] } + manifest_entry[:bytes] > MAX_TOTAL_BYTES
      # The manifest is last so its declarations are complete before it is
      # written. The API parser accepts only the fixed paths and validates all
      # previous members before incorporating the source part.
      tar(source_entries + [manifest_entry])
    end
    if transaction && transaction.respond_to?(:transaction)
      transaction.transaction do
        transaction.connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        runner.call
      end
    else
      runner.call
    end
  rescue CollectorError => error
    # The code has already been written in fail_code; preserve the small
    # process-level failure expected by the ops endpoint.
    exit(1) if error.code
  rescue StandardError
    STDERR.write("openmapx_subject_export:collector_failed\n")
    exit(1)
  end
end

OpenMapxSubjectExport.run
