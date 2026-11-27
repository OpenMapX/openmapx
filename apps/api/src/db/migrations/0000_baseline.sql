CREATE SCHEMA "data_manager";
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_action_receipt" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"target_user_id" text,
	"action" text NOT NULL,
	"intent_digest" text NOT NULL,
	"result" jsonb,
	"mail_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_action_receipt_action_check" CHECK ("account_action_receipt"."action" in ('create', 'invitation', 'email_verification', 'password_reset', 'verify', 'password', 'role'))
);
--> statement-breakpoint
CREATE TABLE "account_admin_guard" (
	"id" integer PRIMARY KEY NOT NULL,
	"active_count" integer NOT NULL,
	CONSTRAINT "account_admin_guard_singleton_check" CHECK ("account_admin_guard"."id"=1),
	CONSTRAINT "account_admin_guard_active_count_check" CHECK ("account_admin_guard"."active_count">=0)
);
--> statement-breakpoint
CREATE TABLE "account_mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_key" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"ciphertext" text,
	"iv" text,
	"tag" text,
	"key_version" integer,
	"attempt_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mail_outbox_status_check" CHECK ("account_mail_outbox"."status" in ('queued','sending','sent','failed','unknown')),
	CONSTRAINT "account_mail_outbox_kind_check" CHECK ("account_mail_outbox"."kind" in ('email_verification', 'password_reset', 'password_setup')),
	CONSTRAINT "account_mail_outbox_sealed_check" CHECK (("account_mail_outbox"."ciphertext" is null and "account_mail_outbox"."iv" is null and "account_mail_outbox"."tag" is null and "account_mail_outbox"."key_version" is null) or ("account_mail_outbox"."ciphertext" is not null and "account_mail_outbox"."iv" is not null and "account_mail_outbox"."tag" is not null and "account_mail_outbox"."key_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "admin_action_reauthentication" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_user_id" text NOT NULL,
	"starting_session_id" text NOT NULL,
	"purpose" text NOT NULL,
	"target_id" text NOT NULL,
	"intent_fingerprint" text,
	"nonce_digest" text NOT NULL,
	"request_key" text,
	"auth_policy_revision" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_session_id" text,
	"completed_method" text,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_action_reauthentication_status_check" CHECK ("admin_action_reauthentication"."status" in ('pending','completed','consumed','superseded','expired')),
	CONSTRAINT "admin_action_reauthentication_purpose_check" CHECK ("admin_action_reauthentication"."purpose" in ('user.email.verify', 'user.password.set', 'user.password_reset.send', 'user.invitation.send', 'credential.export', 'credential.import', 'transit.credential.update', 'platform.domain.apply', 'privacy.export')),
	CONSTRAINT "admin_action_reauthentication_completed_method_check" CHECK ("admin_action_reauthentication"."completed_method" in ('password','password_totp','password_recovery','passkey','federated'))
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_user_id" text,
	"target_id" text,
	"target_type" text,
	"target_user_id" text,
	"action" text NOT NULL,
	"details" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_action_check" CHECK ("admin_audit_log"."action" in ('ambient_places.build', 'ambient_places.discard', 'ambient_places.enabled.set', 'ambient_places.resume', 'ambient_places.rollback', 'attention.acknowledge', 'auth.policy.apply', 'backup.create', 'backup.delete', 'backup.prune', 'backup.restore', 'cache.clear', 'compose.render', 'configuration.migration.apply', 'credential.export', 'credential.import', 'credential.import.preview', 'data.operation.run', 'data_manager.job.cancel', 'dawarich.oidc_secret.rotate', 'dawarich.provision', 'extension.catalog.refresh', 'extension.install', 'extension.remove', 'extension.source.add', 'extension.source.remove', 'extension.update', 'integration.binding.remove', 'integration.binding.set', 'integration.config.update', 'integration.credential.delete', 'integration.credential.set', 'integration.disable', 'integration.enable', 'integration.reload', 'integration.reload_all', 'job.cancel', 'platform.configuration.save', 'provider.reset', 'release.clear', 'safe_mode.leave', 'service.apply', 'service.build', 'service.config.update', 'service.credential.delete', 'service.credential.set', 'service.health.check', 'service.image.pull', 'service.log.read', 'service.restart', 'service.selection.update', 'service.start', 'service.stop', 'service.update', 'setting.test_email.send', 'setting.update', 'standalone.install', 'standalone.preview', 'standalone.remove', 'system.diagnostics.collect', 'system.update', 'system.update.check', 'timeline.connect', 'timeline.disconnect', 'timeline.switch', 'timeline.test', 'transit.catalog.activate', 'transit.catalog.cancel', 'transit.catalog.propose', 'transit.catalog.validate', 'transit.credential.update', 'transit.lock.bump', 'transit.source.add', 'transit.source.disable', 'transit.source.enable', 'transit.source.remove', 'user.ban', 'user.create', 'user.delete', 'user.email.verify', 'user.email_verification.send', 'user.impersonate', 'user.invitation.send', 'user.password.reset', 'user.password.set', 'user.password_reset.send', 'user.role.change', 'user.session.revoke', 'user.session.revoke_all', 'user.unban')),
	CONSTRAINT "admin_audit_log_target_type_check" CHECK ("admin_audit_log"."target_type" in ('ambient_places', 'auth_policy', 'backup', 'cache', 'configuration', 'configuration_migration', 'credential_transfer', 'data_manager_job', 'data_operation', 'extension', 'integration', 'job', 'personal_timeline_connection', 'platform', 'provider', 'release', 'service', 'setting', 'system', 'transit', 'transit_credential', 'transit_source', 'user'))
);
--> statement-breakpoint
CREATE TABLE "admin_job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"protocol" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"progress" integer,
	"log_events" integer DEFAULT 0 NOT NULL,
	"log_bytes" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "admin_job_status_check" CHECK ("admin_job"."status" IN ('queued', 'running', 'cancel_pending', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "admin_job_type_check" CHECK ("admin_job"."type" IN ('artifact.export', 'artifact.import', 'artifact.validate', 'backup.operation.run', 'backup.prune', 'compose.render', 'compose.start', 'configuration.apply', 'configuration.migration.apply', 'configuration.migration.preview', 'credential.import', 'data.operation.run', 'extension.disable', 'extension.enable', 'extension.install', 'extension.purge', 'extension.remove', 'integration.binding.apply', 'integration.reload', 'platform.apply', 'release.clear', 'service.apply', 'service.batch.run', 'service.core.restart', 'service.image.pull', 'service.restart', 'service.start', 'service.stop', 'standalone.install', 'standalone.preview', 'standalone.remove', 'system.diagnostics.collect', 'system.update'))
);
--> statement-breakpoint
CREATE TABLE "admin_job_log" (
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stream" text DEFAULT 'stdout' NOT NULL,
	"line" text NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_job_log_pkey" PRIMARY KEY("job_id","seq"),
	CONSTRAINT "admin_job_log_stream_check" CHECK ("admin_job_log"."stream" in ('stdout','stderr'))
);
--> statement-breakpoint
CREATE TABLE "app_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"level" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attention_item" (
	"key" text PRIMARY KEY NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"action" jsonb,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clearance" text DEFAULT 'condition' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"occurrence_ref" text,
	CONSTRAINT "attention_item_severity_check" CHECK ("attention_item"."severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "attention_item_clearance_check" CHECK ("attention_item"."clearance" in ('condition', 'acknowledge'))
);
--> statement-breakpoint
CREATE TABLE "attention_notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attention_key" text NOT NULL,
	"occurrence" text NOT NULL,
	"channel" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attention_notification_channel_check" CHECK ("attention_notification"."channel" in ('email', 'webhook')),
	CONSTRAINT "attention_notification_severity_check" CHECK ("attention_notification"."severity" in ('warning', 'critical')),
	CONSTRAINT "attention_notification_status_check" CHECK ("attention_notification"."status" in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "attention_observation" (
	"key" text PRIMARY KEY NOT NULL,
	"bad_count" integer DEFAULT 0 NOT NULL,
	"good_count" integer DEFAULT 0 NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"data" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_policy_application" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"intent_digest" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_policy_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" text NOT NULL,
	"activated_by_user_id" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_policy_state_singleton_check" CHECK ("auth_policy_state"."id"=1)
);
--> statement-breakpoint
CREATE TABLE "capability_binding" (
	"integration_id" text NOT NULL,
	"capability" text NOT NULL,
	"service_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_extension_id" text,
	CONSTRAINT "capability_binding_pkey" PRIMARY KEY("integration_id","capability")
);
--> statement-breakpoint
CREATE TABLE "configuration_migration_preview" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configuration_migration_preview_bounds_check" CHECK ("configuration_migration_preview"."kind" in ('migration','credentials') and "configuration_migration_preview"."intent_fingerprint" ~ '^[a-f0-9]{64}$' and octet_length("configuration_migration_preview"."ciphertext") <= 1572864 and length("configuration_migration_preview"."iv") = 16 and length("configuration_migration_preview"."tag") = 24 and "configuration_migration_preview"."expires_at" > "configuration_migration_preview"."created_at" and "configuration_migration_preview"."expires_at" <= "configuration_migration_preview"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "data_disclosure_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_role" text NOT NULL,
	"recipient_country" text,
	"recipient_privacy_url" text,
	"integration_id" text,
	"operation_code" text NOT NULL,
	"category_code" text NOT NULL,
	"purpose_code" text NOT NULL,
	"legal_basis_code" text NOT NULL,
	"transfer_safeguard_code" text,
	"external_reference_digest" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_disclosure_event_code_check" CHECK ("data_disclosure_event"."recipient_id" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."operation_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."category_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."purpose_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."legal_basis_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$')
);
--> statement-breakpoint
CREATE TABLE "data_manager"."configuration_fence" (
	"maintenance_id" uuid PRIMARY KEY NOT NULL,
	"fence_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"plan_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "configuration_fence_fence_id_key" UNIQUE("fence_id"),
	CONSTRAINT "configuration_fence_operation_key_key" UNIQUE("operation_key"),
	CONSTRAINT "configuration_fence_status_check" CHECK (("data_manager"."configuration_fence"."status" = 'prepared' AND "data_manager"."configuration_fence"."outcome" IS NULL AND "data_manager"."configuration_fence"."settled_at" IS NULL) OR ("data_manager"."configuration_fence"."status" = 'settled' AND "data_manager"."configuration_fence"."outcome" IN ('applied','unused','contained') AND "data_manager"."configuration_fence"."settled_at" IS NOT NULL) OR ("data_manager"."configuration_fence"."status" = 'refused' AND "data_manager"."configuration_fence"."outcome" IS NULL AND "data_manager"."configuration_fence"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."feed_state" (
	"region" text NOT NULL,
	"name" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_imported_at" timestamp with time zone,
	"hash" text,
	"validation_status" text,
	"validation_message" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "feed_state_pkey" PRIMARY KEY("region","name"),
	CONSTRAINT "feed_state_status_check" CHECK ("data_manager"."feed_state"."status" IN ('active','stale','failed','unknown')),
	CONSTRAINT "feed_state_validation_status_check" CHECK ("data_manager"."feed_state"."validation_status" IN ('ok','warning','error'))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by_user_id" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"operation_key" text NOT NULL,
	"operation_fingerprint" text NOT NULL,
	"execution_fingerprint" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"requested_deadline_at" timestamp with time zone,
	"execution_parent" jsonb,
	"execution_input" jsonb NOT NULL,
	"execution_state" jsonb NOT NULL,
	"execution_ref" jsonb NOT NULL,
	"execution_agent_operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_admission" jsonb,
	"execution_progress" jsonb,
	"execution_completion" jsonb,
	"released_at" timestamp with time zone,
	"ownership_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_operation_key_key" UNIQUE("operation_key"),
	CONSTRAINT "job_status_check" CHECK ("data_manager"."job"."status" IN ('queued','running','cancel_pending','succeeded','failed','cancelled','partially_succeeded','interrupted')),
	CONSTRAINT "job_trigger_check" CHECK ("data_manager"."job"."trigger" IN ('api','agent','cli','cron','bootstrap')),
	CONSTRAINT "job_triggered_by_user_id_check" CHECK ("data_manager"."job"."triggered_by_user_id" IS NULL OR "data_manager"."job"."trigger" = 'api'),
	CONSTRAINT "job_execution_bounds_check" CHECK ("data_manager"."job"."ownership_version" >= 0 AND ("data_manager"."job"."execution_progress" IS NULL OR octet_length("data_manager"."job"."execution_progress"::text) <= 524288)),
	CONSTRAINT "job_execution_row_check" CHECK (("data_manager"."job"."execution_admission" IS NULL) = ("data_manager"."job"."execution_progress" IS NULL) AND ("data_manager"."job"."execution_admission" IS NOT NULL OR "data_manager"."job"."finished_at" IS NOT NULL) AND ("data_manager"."job"."execution_completion" IS NULL OR "data_manager"."job"."execution_admission" IS NOT NULL) AND ("data_manager"."job"."released_at" IS NULL OR "data_manager"."job"."finished_at" IS NOT NULL)),
	CONSTRAINT "job_execution_shape_check" CHECK ("data_manager"."job"."operation_key" ~ '^opk1_[A-Za-z0-9_-]{16,64}$' AND "data_manager"."job"."operation_fingerprint" ~ '^[a-f0-9]{64}$' AND "data_manager"."job"."execution_fingerprint" ~ '^[a-f0-9]{64}$' AND "data_manager"."job"."deadline_at" > "data_manager"."job"."admitted_at")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."job_stage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"message" text,
	"error" jsonb,
	"artifacts" jsonb,
	CONSTRAINT "job_stage_stage_check" CHECK ("data_manager"."job_stage"."stage" IN ('prepare','filter','preflight','compile-gbfs','fetch','fetch-operator','validate','gen-motis-config','assemble-staging','stage-proxy','motis-import','motis-health','gen-full-config','gen-attribution','promote','gc','mirror')),
	CONSTRAINT "job_stage_status_check" CHECK ("data_manager"."job_stage"."status" IN ('succeeded','partially_succeeded','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_artifact_reference" (
	"principal" text NOT NULL,
	"package_id" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"retained_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_artifact_reference_pkey" PRIMARY KEY("principal","package_id")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"package_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"manifest" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "offline_package_job_status_check" CHECK ("data_manager"."offline_package_job"."status" IN ('preparing','ready-to-download','failed','expired'))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_job_owner" (
	"job_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_job_owner_pkey" PRIMARY KEY("job_id","principal")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."overture_release" (
	"region" text NOT NULL,
	"release" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "overture_release_pkey" PRIMARY KEY("region"),
	CONSTRAINT "overture_release_status_check" CHECK ("data_manager"."overture_release"."status" IN ('imported','links_pending'))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"user_id" text,
	"actor_user_id" text,
	"actor_session_id" text,
	"locator_ciphertext" text,
	"locator_iv" text,
	"locator_tag" text,
	"locator_key_version" integer,
	"locator_type" text DEFAULT 'user_id' NOT NULL,
	"account_state" text DEFAULT 'current' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preservation_at" timestamp with time zone,
	"snapshot_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL,
	"extension" jsonb,
	"identity_method" text,
	"identity_verified_at" timestamp with time zone,
	"refusal_code" text,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_kind_check" CHECK ("data_subject_request"."kind" in ('access', 'portability', 'access_and_portability')),
	CONSTRAINT "data_subject_request_channel_check" CHECK ("data_subject_request"."channel" in ('self_service', 'email', 'post', 'representative', 'internal')),
	CONSTRAINT "data_subject_request_status_check" CHECK ("data_subject_request"."status" in ('open', 'in_progress', 'waiting_on_requester', 'completed', 'refused')),
	CONSTRAINT "data_subject_request_locator_ciphertext_check" CHECK (("data_subject_request"."locator_ciphertext" is null and "data_subject_request"."locator_iv" is null and "data_subject_request"."locator_tag" is null and "data_subject_request"."locator_key_version" is null) or ("data_subject_request"."locator_ciphertext" is not null and "data_subject_request"."locator_iv" is not null and "data_subject_request"."locator_tag" is not null and "data_subject_request"."locator_key_version" is not null)),
	CONSTRAINT "data_subject_request_version_check" CHECK ("data_subject_request"."version" > 0),
	CONSTRAINT "data_subject_request_locator_type_check" CHECK ("data_subject_request"."locator_type" in ('user_id', 'email', 'erasure_reference', 'other_reference')),
	CONSTRAINT "data_subject_request_account_state_check" CHECK ("data_subject_request"."account_state" in ('current', 'inaccessible', 'deleted', 'unknown')),
	CONSTRAINT "data_subject_request_identity_check" CHECK (("data_subject_request"."identity_method" is null and "data_subject_request"."identity_verified_at" is null) or ("data_subject_request"."identity_method" in ('account_session', 'manual') and "data_subject_request"."identity_verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_event_payload_version_check" CHECK ("data_subject_request_event"."payload_version" > 0),
	CONSTRAINT "data_subject_request_event_event_type_check" CHECK ("data_subject_request_event"."event_type" in ('received', 'status_changed', 'identity_verified', 'task_resolved', 'extended', 'export_started', 'export_delivered', 'export_failed', 'export_incomplete')),
	CONSTRAINT "data_subject_request_event_actor_kind_check" CHECK ("data_subject_request_event"."actor_kind" in ('subject', 'admin', 'system'))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"recipient_user_id" text,
	"template" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"occurrence_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_notification_template_check" CHECK ("data_subject_request_notification"."template" in ('acknowledgement', 'waiting_on_requester', 'extension', 'completed', 'refused', 'admin_new_request', 'admin_deadline')),
	CONSTRAINT "data_subject_request_notification_channel_check" CHECK ("data_subject_request_notification"."channel" in ('email')),
	CONSTRAINT "data_subject_request_notification_status_check" CHECK ("data_subject_request_notification"."status" in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled')),
	CONSTRAINT "data_subject_request_notification_attempts_check" CHECK ("data_subject_request_notification"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_preservation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"source_cutoff_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"status" text DEFAULT 'held' NOT NULL,
	"outcome_code" text,
	CONSTRAINT "data_subject_request_preservation_status_check" CHECK ("data_subject_request_preservation"."status" in ('held', 'source_capture_pending', 'action_required', 'captured', 'released'))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"public_code" text,
	"resolution_code" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_task_status_check" CHECK ("data_subject_request_task"."status" in ('open', 'resolved')),
	CONSTRAINT "data_subject_request_task_source_check" CHECK ("data_subject_request_task"."source" in ('openmapx-db', 'redis', 'managed-service', 'operator', 'extension'))
);
--> statement-breakpoint
CREATE TABLE "extension_advisory_ack" (
	"extension_id" text NOT NULL,
	"advisory_key" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_advisory_ack_pkey" PRIMARY KEY("extension_id","advisory_key"),
	CONSTRAINT "extension_advisory_ack_advisory_key_check" CHECK ("extension_advisory_ack"."advisory_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "extension_catalog_source" (
	"url" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_migration" (
	"integration_id" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_migration_pkey" PRIMARY KEY("integration_id","name"),
	CONSTRAINT "extension_migration_name_check" CHECK ("extension_migration"."name" ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*\.sql$'),
	CONSTRAINT "extension_migration_sha256_check" CHECK ("extension_migration"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "extension_name_claim" (
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"extension_id" text NOT NULL,
	"source" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_name_claim_pkey" PRIMARY KEY("kind","name"),
	CONSTRAINT "extension_name_claim_kind_check" CHECK ("extension_name_claim"."kind" in ('service', 'integration', 'database-role', 'database-schema'))
);
--> statement-breakpoint
CREATE TABLE "extension_revocation_snapshot" (
	"id" integer PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "extension_revocation_snapshot_singleton_check" CHECK ("extension_revocation_snapshot"."id" = 1),
	CONSTRAINT "extension_revocation_snapshot_snapshot_check" CHECK (coalesce(jsonb_typeof("extension_revocation_snapshot"."snapshot"->'removed') = 'array' and jsonb_typeof("extension_revocation_snapshot"."snapshot"->'critical') = 'array', false))
);
--> statement-breakpoint
CREATE TABLE "extension_setting" (
	"extension_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"ciphertext" text,
	"iv" text,
	"tag" text,
	"key_version" integer,
	"targets" jsonb NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_setting_pkey" PRIMARY KEY("extension_id","key"),
	CONSTRAINT "extension_setting_key_check" CHECK ("extension_setting"."key" ~ '^[a-z][a-z0-9]*([A-Z][a-z0-9]+)*$' and char_length("extension_setting"."key") <= 64),
	CONSTRAINT "extension_setting_value_check" CHECK (("extension_setting"."value" is not null and "extension_setting"."ciphertext" is null and "extension_setting"."iv" is null and "extension_setting"."tag" is null and "extension_setting"."key_version" is null) or ("extension_setting"."value" is null and "extension_setting"."ciphertext" is not null and "extension_setting"."iv" is not null and "extension_setting"."tag" is not null and "extension_setting"."key_version" is not null)),
	CONSTRAINT "extension_setting_targets_check" CHECK (jsonb_typeof("extension_setting"."targets") = 'array'),
	CONSTRAINT "extension_setting_generated_check" CHECK (not "extension_setting"."generated" or "extension_setting"."ciphertext" is not null)
);
--> statement-breakpoint
CREATE TABLE "health_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "health_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" text NOT NULL,
	"status" text NOT NULL,
	"response_time" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_history_status_check" CHECK ("health_history"."status" in ('healthy','degraded','unhealthy','error'))
);
--> statement-breakpoint
CREATE TABLE "installed_extension" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_url" text,
	"source_trust" text DEFAULT 'community' NOT NULL,
	"installation_kind" text DEFAULT 'catalog' NOT NULL,
	"provenance" jsonb,
	"last_operation_id" text,
	"installed_version" text NOT NULL,
	"manifest" jsonb,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by_user_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"approved_grants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "installed_extension_source_trust_check" CHECK ("installed_extension"."source_trust" in ('built-in','verified','community')),
	CONSTRAINT "installed_extension_installation_kind_check" CHECK ("installed_extension"."installation_kind" in ('catalog','standalone')),
	CONSTRAINT "installed_extension_standalone_provenance_check" CHECK ("installed_extension"."installation_kind" <> 'standalone' or coalesce(("installed_extension"."source_trust" = 'community' and "installed_extension"."id" ~ '^local-[0-9a-f-]{36}$' and jsonb_typeof("installed_extension"."provenance") = 'object' and "installed_extension"."provenance"->>'kind' in ('artifact','source','uploaded-artifact') and "installed_extension"."provenance"->>'contentDigest' ~ '^[a-f0-9]{64}$'),false))
);
--> statement-breakpoint
CREATE TABLE "installed_extension_component" (
	"extension_id" text NOT NULL,
	"kind" text NOT NULL,
	"component_id" text NOT NULL,
	"resolved_commit" text,
	"image_digest" text,
	CONSTRAINT "installed_extension_component_pkey" PRIMARY KEY("extension_id","kind","component_id"),
	CONSTRAINT "installed_extension_component_kind_check" CHECK ("installed_extension_component"."kind" in ('integration','service')),
	CONSTRAINT "installed_extension_component_resolved_commit_check" CHECK ("installed_extension_component"."resolved_commit" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "installed_extension_component_image_digest_check" CHECK ("installed_extension_component"."image_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "installed_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"repository" text,
	"installed_version" text NOT NULL,
	"source_type" text DEFAULT 'registry' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by_user_id" text,
	"last_transaction_id" text,
	CONSTRAINT "installed_integration_source_type_check" CHECK ("installed_integration"."source_type" in ('registry','artifact','source','uploaded-artifact'))
);
--> statement-breakpoint
CREATE TABLE "integration_config" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_extension_id" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "integration_config_schema_version_check" CHECK ("integration_config"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integration_secret" (
	"integration_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"owner_extension_id" text,
	CONSTRAINT "integration_secret_pkey" PRIMARY KEY("integration_id","key")
);
--> statement-breakpoint
CREATE TABLE "integration_subject_handler" (
	"integration_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_task_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"integration_id" text NOT NULL,
	"task_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "integration_task_run_status_check" CHECK ("integration_task_run"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "integration_task_run_finished_at_check" CHECK (("integration_task_run"."status" = 'running') = ("integration_task_run"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "labeled_place" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"icon" text,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	"field_contributors" jsonb,
	"field_contributors_version" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labeled_place_user_id_label_key" UNIQUE("user_id","label"),
	CONSTRAINT "labeled_place_place_id_check" CHECK ("labeled_place"."place_id" ~ '^[a-z][a-z0-9-]*:.+' and split_part("labeled_place"."place_id", ':', 1) not in ('style-poi', 'saved', 'label', 'coordinate')),
	CONSTRAINT "labeled_place_lat_check" CHECK ("labeled_place"."lat" between -90 and 90),
	CONSTRAINT "labeled_place_lng_check" CHECK ("labeled_place"."lng" between -180 and 180),
	CONSTRAINT "labeled_place_field_contributors_version_check" CHECK (("labeled_place"."field_contributors" is null) = ("labeled_place"."field_contributors_version" is null) and ("labeled_place"."field_contributors_version" is null or "labeled_place"."field_contributors_version" = 1))
);
--> statement-breakpoint
CREATE TABLE "mangrove_keypair" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"passphrase_ciphertext" text,
	"recipients_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mangrove_keypair_wrap" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"wrap_type" text NOT NULL,
	"label" text NOT NULL,
	"identity_string" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mangrove_keypair_wrap_wrap_type_check" CHECK ("mangrove_keypair_wrap"."wrap_type" in ('passphrase','webauthn'))
);
--> statement-breakpoint
CREATE TABLE "mobile_auth_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"callback_code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"token_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "mobile_auth_handoff_callback_code_hash_key" UNIQUE("callback_code_hash"),
	CONSTRAINT "mobile_auth_handoff_purpose_check" CHECK ("mobile_auth_handoff"."purpose" in ('sign-in','link-provider','add-passkey'))
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}',
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "parked_location" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"vehicle_id" uuid,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"address" text,
	"note" text,
	"expires_at" timestamp with time zone,
	"source" text NOT NULL,
	"accuracy_meters" double precision,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parked_location_user_id_vehicle_id_key" UNIQUE NULLS NOT DISTINCT("user_id","vehicle_id"),
	CONSTRAINT "parked_location_source_check" CHECK ("parked_location"."source" in ('device','manual','arrival')),
	CONSTRAINT "parked_location_lat_check" CHECK ("parked_location"."lat" between -90 and 90),
	CONSTRAINT "parked_location_lng_check" CHECK ("parked_location"."lng" between -180 and 180)
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "personal_timeline_connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"public_origin" text NOT NULL,
	"display_name" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_iv" text NOT NULL,
	"api_key_tag" text NOT NULL,
	"api_key_key_version" integer NOT NULL,
	"upstream_user_id" text,
	"upstream_email" text,
	"upstream_time_zone" text NOT NULL,
	"distance_unit" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_timeline_connection_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "personal_timeline_connection_mode_check" CHECK ("personal_timeline_connection"."mode" in ('external','managed')),
	CONSTRAINT "personal_timeline_connection_status_check" CHECK ("personal_timeline_connection"."status" in ('connected','degraded','invalid'))
);
--> statement-breakpoint
CREATE TABLE "personal_vehicle" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"powertrain" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"preset_id" text,
	"ev" jsonb,
	"ev_version" smallint,
	"fuel_consumption_l_per_100km" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_vehicle_user_id_name_key" UNIQUE("user_id","name"),
	CONSTRAINT "personal_vehicle_kind_check" CHECK ("personal_vehicle"."kind" in ('car','motorcycle','bicycle')),
	CONSTRAINT "personal_vehicle_powertrain_check" CHECK ("personal_vehicle"."powertrain" in ('electric','plugin_hybrid','hybrid','petrol','diesel','other')),
	CONSTRAINT "personal_vehicle_ev_version_check" CHECK (("personal_vehicle"."ev" is null) = ("personal_vehicle"."ev_version" is null) and ("personal_vehicle"."ev_version" is null or "personal_vehicle"."ev_version" = 1))
);
--> statement-breakpoint
CREATE TABLE "platform_configuration_preview" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"auth_policy_revision" text NOT NULL,
	"source_revision" uuid NOT NULL,
	"expected_current_revision_id" text,
	"preview" jsonb NOT NULL,
	"consumed_by_job_id" uuid,
	"consumed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_configuration_preview_bounds_check" CHECK (length("platform_configuration_preview"."operation_key") between 1 and 128 and "platform_configuration_preview"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."preview_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."auth_policy_revision" ~ '^[a-f0-9]{64}$' and octet_length("platform_configuration_preview"."preview"::text) <= 131072 and jsonb_typeof("platform_configuration_preview"."preview") = 'object' and "platform_configuration_preview"."expires_at" > "platform_configuration_preview"."created_at" and "platform_configuration_preview"."expires_at" <= "platform_configuration_preview"."created_at" + interval '10 minutes' and (("platform_configuration_preview"."consumed_at" is null) = ("platform_configuration_preview"."consumed_by_job_id" is null)) and ("platform_configuration_preview"."retired_at" is null or ("platform_configuration_preview"."consumed_at" is not null and "platform_configuration_preview"."retired_at" >= "platform_configuration_preview"."consumed_at")))
);
--> statement-breakpoint
CREATE TABLE "saved_list" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"is_private" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_list_user_id_name_key" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "saved_place" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"list_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	"field_contributors" jsonb,
	"field_contributors_version" smallint,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_place_place_id_check" CHECK ("saved_place"."place_id" ~ '^[a-z][a-z0-9-]*:.+' and split_part("saved_place"."place_id", ':', 1) not in ('style-poi', 'saved', 'label', 'coordinate')),
	CONSTRAINT "saved_place_lat_check" CHECK ("saved_place"."lat" between -90 and 90),
	CONSTRAINT "saved_place_lng_check" CHECK ("saved_place"."lng" between -180 and 180),
	CONSTRAINT "saved_place_field_contributors_version_check" CHECK (("saved_place"."field_contributors" is null) = ("saved_place"."field_contributors_version" is null) and ("saved_place"."field_contributors_version" is null or "saved_place"."field_contributors_version" = 1))
);
--> statement-breakpoint
CREATE TABLE "service_config" (
	"service_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_extension_id" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "service_config_schema_version_check" CHECK ("service_config"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "service_repository" (
	"hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"last_sha" text NOT NULL,
	"pinned_ref" text,
	"last_transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_repository_url_key" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "service_secret" (
	"service_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"owner_extension_id" text,
	CONSTRAINT "service_secret_pkey" PRIMARY KEY("service_id","key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "session_auth_assurance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"method" text NOT NULL,
	"origin_independent_password_login" boolean DEFAULT false NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_auth_assurance_method_check" CHECK ("session_auth_assurance"."method" in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated'))
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"mode" text NOT NULL,
	"label" text NOT NULL,
	"snapshot" jsonb,
	"snapshot_version" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "share_link_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "share_link_target_type_check" CHECK ("share_link"."target_type" in ('list','route')),
	CONSTRAINT "share_link_mode_check" CHECK ("share_link"."mode" in ('live','snapshot')),
	CONSTRAINT "share_link_route_shape_check" CHECK ("share_link"."target_type" <> 'route' or ("share_link"."target_id" is null and "share_link"."mode" = 'snapshot')),
	CONSTRAINT "share_link_list_target_check" CHECK ("share_link"."target_type" <> 'list' or "share_link"."target_id" is not null),
	CONSTRAINT "share_link_snapshot_check" CHECK (("share_link"."mode" = 'snapshot') = ("share_link"."snapshot" is not null)),
	CONSTRAINT "share_link_snapshot_version_check" CHECK (("share_link"."snapshot" is null) = ("share_link"."snapshot_version" is null) and ("share_link"."snapshot_version" is null or "share_link"."snapshot_version" = 1))
);
--> statement-breakpoint
CREATE TABLE "subject_erasure_pending" (
	"integration_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "subject_erasure_pending_pkey" PRIMARY KEY("integration_id","subject_user_id"),
	CONSTRAINT "subject_erasure_pending_attempts_check" CHECK ("subject_erasure_pending"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "system_secret" (
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "system_secret_pkey" PRIMARY KEY("key"),
	CONSTRAINT "system_secret_key_check" CHECK ("system_secret"."key" in ('emaillabs.appKey','emaillabs.secretKey','lettermint.apiToken','smtp.password','maptiler.apiKey'))
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "system_setting_key_check" CHECK ("system_setting"."key" in ('auth.emailVerificationRequired','auth.sessionDurationHours','auth.twoFaEnabled','auth.passwordMinLength','email.fromAddress','emaillabs.smtpAccount','smtp.host','smtp.port','smtp.user','smtp.security','basemap.provider','dataUse.allowNonCommercial','dataUse.allowGreyArea','extensions.catalogSource','extensions.revocationCheck','extensions.remoteDisable','extensions.prereleaseOptIn','legal.controller.name','legal.controller.street','legal.controller.postalCode','legal.controller.city','legal.controller.country','legal.controller.email','legal.controller.phone','legal.dataRequestEmail','legal.hosting.provider','legal.hosting.locations','legal.supervisoryAuthority.name','legal.supervisoryAuthority.url','legal.deploymentJurisdiction','legal.privacySources','retention.serverLogDays','retention.privacyCaseDays','retention.auditLogDays','retention.adminJobDays','platform.configuration'))
);
--> statement-breakpoint
CREATE TABLE "transit_credential_preview" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"authorization_ciphertext" text,
	"authorization_iv" text,
	"authorization_tag" text,
	"authorization_key_version" integer,
	"candidate_id" uuid,
	"credentials_revision" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transit_credential_preview_bounds_check" CHECK (octet_length("transit_credential_preview"."ciphertext") <= 1500000 and length("transit_credential_preview"."intent_fingerprint") = 64 and length("transit_credential_preview"."iv") = 16 and length("transit_credential_preview"."tag") = 24),
	CONSTRAINT "transit_credential_preview_authorization_check" CHECK (("transit_credential_preview"."authorization_ciphertext" is null and "transit_credential_preview"."authorization_iv" is null and "transit_credential_preview"."authorization_tag" is null and "transit_credential_preview"."authorization_key_version" is null) or ("transit_credential_preview"."authorization_ciphertext" is not null and "transit_credential_preview"."authorization_iv" is not null and "transit_credential_preview"."authorization_tag" is not null and "transit_credential_preview"."authorization_key_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"normalized_email" text,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_normalized_email_unique" UNIQUE("normalized_email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_application_receipt" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"integration_id" text NOT NULL,
	"capability" text NOT NULL,
	"service_id" text,
	"candidate_id" uuid NOT NULL,
	"intent_digest" text NOT NULL,
	"saved_binding_revision" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_binding_revision" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_request_key_fkey" FOREIGN KEY ("request_key") REFERENCES "public"."account_action_receipt"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_action_reauthentication" ADD CONSTRAINT "admin_action_reauthentication_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job" ADD CONSTRAINT "admin_job_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job_log" ADD CONSTRAINT "admin_job_log_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."admin_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_policy_application" ADD CONSTRAINT "auth_policy_application_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_policy_state" ADD CONSTRAINT "auth_policy_state_activated_by_user_id_fkey" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_migration_preview" ADD CONSTRAINT "configuration_migration_preview_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_disclosure_event" ADD CONSTRAINT "data_disclosure_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_manager"."job_stage" ADD CONSTRAINT "job_stage_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "data_manager"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_manager"."offline_package_job_owner" ADD CONSTRAINT "offline_package_job_owner_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "data_manager"."offline_package_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_session_id_fkey" FOREIGN KEY ("actor_session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_event" ADD CONSTRAINT "data_subject_request_event_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_event" ADD CONSTRAINT "data_subject_request_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_preservation" ADD CONSTRAINT "data_subject_request_preservation_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD CONSTRAINT "data_subject_request_task_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_advisory_ack" ADD CONSTRAINT "extension_advisory_ack_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."installed_extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extension" ADD CONSTRAINT "installed_extension_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extension_component" ADD CONSTRAINT "installed_extension_component_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."installed_extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_integration" ADD CONSTRAINT "installed_integration_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secret" ADD CONSTRAINT "integration_secret_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labeled_place" ADD CONSTRAINT "labeled_place_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair" ADD CONSTRAINT "mangrove_keypair_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair_wrap" ADD CONSTRAINT "mangrove_keypair_wrap_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."mangrove_keypair"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD CONSTRAINT "mobile_auth_handoff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "public"."personal_vehicle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_timeline_connection" ADD CONSTRAINT "personal_timeline_connection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_vehicle" ADD CONSTRAINT "personal_vehicle_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration_preview" ADD CONSTRAINT "platform_configuration_preview_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_list" ADD CONSTRAINT "saved_list_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_place" ADD CONSTRAINT "saved_place_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."saved_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_secret" ADD CONSTRAINT "service_secret_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_secret" ADD CONSTRAINT "system_secret_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transit_credential_preview" ADD CONSTRAINT "transit_credential_preview_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_application_receipt" ADD CONSTRAINT "integration_application_receipt_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_action_receipt_actor_user_id_created_at_idx" ON "account_action_receipt" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_action_receipt_target_user_id_created_at_idx" ON "account_action_receipt" USING btree ("target_user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_action_receipt_created_at_idx" ON "account_action_receipt" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mail_outbox_request_key_kind_key" ON "account_mail_outbox" USING btree ("request_key","kind");--> statement-breakpoint
CREATE INDEX "account_mail_outbox_status_created_at_idx" ON "account_mail_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "account_mail_outbox_user_id_idx" ON "account_mail_outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_action_reauthentication_actor_user_id_expires_at_idx" ON "admin_action_reauthentication" USING btree ("actor_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "admin_action_reauthentication_expires_at_idx" ON "admin_action_reauthentication" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_action_reauthentication_actor_user_id_request_key_key" ON "admin_action_reauthentication" USING btree ("actor_user_id","request_key");--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_user_id_idx" ON "admin_audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_user_id_idx" ON "admin_audit_log" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_job_type_idx" ON "admin_job" USING btree ("type") WHERE "admin_job"."status" IN ('queued', 'running', 'cancel_pending');--> statement-breakpoint
CREATE INDEX "admin_job_created_by_user_id_idx" ON "admin_job" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "admin_job_created_at_idx" ON "admin_job" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_job_active_system_maintenance_key" ON "admin_job" USING btree ((true)) WHERE "admin_job"."type" IN ('system.update', 'system.diagnostics.collect') AND "admin_job"."status" IN ('queued', 'running', 'cancel_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "admin_job_log_job_id_source_event_id_key" ON "admin_job_log" USING btree ("job_id","source_event_id") WHERE "admin_job_log"."source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "app_log_created_at_idx" ON "app_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attention_notification_attention_key_occurrence_channel_key" ON "attention_notification" USING btree ("attention_key","occurrence","channel");--> statement-breakpoint
CREATE INDEX "attention_notification_status_due_at_idx" ON "attention_notification" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "auth_policy_application_actor_user_id_idx" ON "auth_policy_application" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "auth_policy_application_created_at_idx" ON "auth_policy_application" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_policy_state_activated_by_user_id_idx" ON "auth_policy_state" USING btree ("activated_by_user_id");--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_actor_user_id_kind_idx" ON "configuration_migration_preview" USING btree ("actor_user_id","kind");--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_expires_at_idx" ON "configuration_migration_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_user_id_occurred_at_idx" ON "data_disclosure_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_recipient_id_occurred_at_idx" ON "data_disclosure_event" USING btree ("recipient_id","occurred_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_occurred_at_idx" ON "data_disclosure_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_disclosure_event_idempotency_key_key" ON "data_disclosure_event" USING btree ("idempotency_key") WHERE "data_disclosure_event"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_fence_status_prepared_key" ON "data_manager"."configuration_fence" USING btree ("status") WHERE "data_manager"."configuration_fence"."status" = 'prepared';--> statement-breakpoint
CREATE INDEX "job_finished_at_idx" ON "data_manager"."job" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "job_operation_key_idx" ON "data_manager"."job" USING btree ("operation_key") WHERE "data_manager"."job"."execution_admission" IS NULL AND "data_manager"."job"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "job_kind_admitted_at_idx" ON "data_manager"."job" USING btree ("kind","admitted_at");--> statement-breakpoint
CREATE INDEX "job_admitted_at_idx" ON "data_manager"."job" USING btree ("admitted_at") WHERE "data_manager"."job"."finished_at" IS NULL OR ("data_manager"."job"."execution_admission" IS NOT NULL AND "data_manager"."job"."released_at" IS NULL);--> statement-breakpoint
CREATE INDEX "job_idempotency_key_idx" ON "data_manager"."job" USING btree ("idempotency_key") WHERE "data_manager"."job"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_triggered_by_user_id_idx" ON "data_manager"."job" USING btree ("triggered_by_user_id");--> statement-breakpoint
CREATE INDEX "job_stage_job_id_idx" ON "data_manager"."job_stage" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "offline_package_artifact_reference_package_id_idx" ON "data_manager"."offline_package_artifact_reference" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "offline_package_artifact_reference_principal_retained_at_idx" ON "data_manager"."offline_package_artifact_reference" USING btree ("principal","retained_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_package_job_request_key_live_key" ON "data_manager"."offline_package_job" USING btree ("request_key") WHERE "data_manager"."offline_package_job"."status" IN ('preparing', 'ready-to-download');--> statement-breakpoint
CREATE INDEX "offline_package_job_status_created_at_idx" ON "data_manager"."offline_package_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "offline_package_job_package_id_idx" ON "data_manager"."offline_package_job" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "offline_package_job_owner_principal_idx" ON "data_manager"."offline_package_job_owner" USING btree ("principal");--> statement-breakpoint
CREATE INDEX "data_subject_request_user_id_status_idx" ON "data_subject_request" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "data_subject_request_status_due_at_idx" ON "data_subject_request" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_actor_user_id_idx" ON "data_subject_request" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_actor_session_id_idx" ON "data_subject_request" USING btree ("actor_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_user_id_kind_active_key" ON "data_subject_request" USING btree ("user_id","kind") WHERE "data_subject_request"."user_id" is not null and "data_subject_request"."status" in ('open', 'in_progress', 'waiting_on_requester');--> statement-breakpoint
CREATE INDEX "data_subject_request_event_request_id_created_at_idx" ON "data_subject_request_event" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_event_actor_user_id_idx" ON "data_subject_request_event" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_event_request_id_idempotency_key_key" ON "data_subject_request_event" USING btree ("request_id","idempotency_key") WHERE "data_subject_request_event"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_notification_delivery_key" ON "data_subject_request_notification" USING btree ("request_id","template","channel","recipient_user_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_status_next_attempt_at_idx" ON "data_subject_request_notification" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_recipient_created_at_idx" ON "data_subject_request_notification" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_preservation_request_registration_key" ON "data_subject_request_preservation" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_preservation_registration_id_status_idx" ON "data_subject_request_preservation" USING btree ("registration_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_task_request_id_registration_id_key" ON "data_subject_request_task" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_task_status_idx" ON "data_subject_request_task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "extension_name_claim_extension_id_idx" ON "extension_name_claim" USING btree ("extension_id");--> statement-breakpoint
CREATE INDEX "health_history_service_id_checked_at_idx" ON "health_history" USING btree ("service_id","checked_at");--> statement-breakpoint
CREATE INDEX "health_history_checked_at_idx" ON "health_history" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "installed_extension_installed_by_user_id_idx" ON "installed_extension" USING btree ("installed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installed_extension_component_kind_component_id_key" ON "installed_extension_component" USING btree ("kind","component_id");--> statement-breakpoint
CREATE INDEX "installed_integration_installed_by_user_id_idx" ON "installed_integration" USING btree ("installed_by_user_id");--> statement-breakpoint
CREATE INDEX "integration_secret_updated_by_user_id_idx" ON "integration_secret" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_task_run_running_key" ON "integration_task_run" USING btree ("integration_id","task_name") WHERE "integration_task_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "integration_task_run_started_at_idx" ON "integration_task_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "mangrove_keypair_wrap_user_id_idx" ON "mangrove_keypair_wrap" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mangrove_keypair_wrap_user_id_passphrase_key" ON "mangrove_keypair_wrap" USING btree ("user_id") WHERE "mangrove_keypair_wrap"."wrap_type" = 'passphrase';--> statement-breakpoint
CREATE INDEX "mobile_auth_handoff_user_id_expires_at_idx" ON "mobile_auth_handoff" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "oauth_access_token_expires_at_idx" ON "oauth_access_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_client_assertion_expires_at_idx" ON "oauth_client_assertion" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_expires_at_idx" ON "oauth_refresh_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "parked_location_vehicle_id_idx" ON "parked_location" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "parked_location_expires_at_idx" ON "parked_location" USING btree ("expires_at") WHERE "parked_location"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_key" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_vehicle_user_id_default_key" ON "personal_vehicle" USING btree ("user_id") WHERE "personal_vehicle"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "platform_configuration_preview_actor_user_id_operation_key_key" ON "platform_configuration_preview" USING btree ("actor_user_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_configuration_preview_preview_fingerprint_key" ON "platform_configuration_preview" USING btree ("preview_fingerprint");--> statement-breakpoint
CREATE INDEX "platform_configuration_preview_expires_at_idx" ON "platform_configuration_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "saved_place_list_id_idx" ON "saved_place" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "service_secret_updated_by_user_id_idx" ON "service_secret" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_auth_assurance_user_id_authenticated_at_idx" ON "session_auth_assurance" USING btree ("user_id","authenticated_at");--> statement-breakpoint
CREATE INDEX "share_link_user_id_idx" ON "share_link" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "share_link_expires_at_idx" ON "share_link" USING btree ("expires_at") WHERE "share_link"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "system_secret_updated_by_user_id_idx" ON "system_secret" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "system_setting_updated_by_user_id_idx" ON "system_setting" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transit_credential_preview_actor_user_id_operation_key_key" ON "transit_credential_preview" USING btree ("actor_user_id","operation_key");--> statement-breakpoint
CREATE INDEX "transit_credential_preview_expires_at_idx" ON "transit_credential_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "integration_application_receipt_integration_id_created_at_idx" ON "integration_application_receipt" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_application_receipt_actor_user_id_idx" ON "integration_application_receipt" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "integration_application_receipt_created_at_idx" ON "integration_application_receipt" USING btree ("created_at");