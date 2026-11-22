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
	"actor_id" text,
	"target_id" text,
	"action" text NOT NULL,
	"intent_digest" text NOT NULL,
	"result" jsonb,
	"mail_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_admin_guard" (
	"id" integer PRIMARY KEY NOT NULL,
	"active_count" integer NOT NULL,
	CONSTRAINT "account_admin_guard_singleton" CHECK ("account_admin_guard"."id"=1),
	CONSTRAINT "account_admin_guard_nonnegative" CHECK ("account_admin_guard"."active_count">=0)
);
--> statement-breakpoint
CREATE TABLE "account_mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"ciphertext" text,
	"iv" text,
	"tag" text,
	"attempt_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mail_state_check" CHECK ("account_mail_outbox"."state" in ('queued','sending','sent','failed','unknown')),
	CONSTRAINT "account_mail_kind_check" CHECK ("account_mail_outbox"."kind" in ('verification','password_setup'))
);
--> statement-breakpoint
CREATE TABLE "admin_action_reauthentication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"starting_session_id" text NOT NULL,
	"purpose" text NOT NULL,
	"target_id" text NOT NULL,
	"intent_fingerprint" text,
	"nonce_digest" text NOT NULL,
	"request_key" text,
	"auth_policy_revision" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"completed_session_id" text,
	"completed_method" text,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_reauth_state_check" CHECK ("admin_action_reauthentication"."state" in ('pending','completed','consumed','superseded','expired')),
	CONSTRAINT "admin_reauth_purpose_check" CHECK ("admin_action_reauthentication"."purpose" in ('account.verify','account.password.set','account.reset.send','account.invite','credentials.export','credentials.import','transit.credentials','platform.domain.apply','privacy.export'))
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"target_id" text,
	"target_type" text,
	"action" text NOT NULL,
	"details" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_job" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"protocol" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"progress" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_job_log" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"stream" text DEFAULT 'stdout' NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"msg" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_policy_application" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"intent_digest" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_policy_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"activation_version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" text NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_policy_singleton" CHECK ("auth_policy_state"."id"=1 AND "auth_policy_state"."activation_version"=1)
);
--> statement-breakpoint
CREATE TABLE "capability_binding" (
	"integration_id" text NOT NULL,
	"capability" text NOT NULL,
	"service_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_binding_integration_id_capability_pk" PRIMARY KEY("integration_id","capability")
);
--> statement-breakpoint
CREATE TABLE "configuration_migration_preview" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configuration_migration_preview_bounds" CHECK ("configuration_migration_preview"."kind" in ('migration','credentials') and length("configuration_migration_preview"."id") = 36 and "configuration_migration_preview"."intent_fingerprint" ~ '^[a-f0-9]{64}$' and octet_length("configuration_migration_preview"."ciphertext") <= 1572864 and length("configuration_migration_preview"."iv") = 16 and length("configuration_migration_preview"."tag") = 24 and "configuration_migration_preview"."expires_at" > "configuration_migration_preview"."created_at" and "configuration_migration_preview"."expires_at" <= "configuration_migration_preview"."created_at" + interval '10 minutes' and ("configuration_migration_preview"."consumed_by_job_id" is null or length("configuration_migration_preview"."consumed_by_job_id") = 36))
);
--> statement-breakpoint
CREATE TABLE "data_disclosure_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	"state" text NOT NULL,
	"outcome" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "configuration_fence_fence_id_unique" UNIQUE("fence_id"),
	CONSTRAINT "configuration_fence_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "configuration_fence_state" CHECK (("data_manager"."configuration_fence"."state" = 'prepared' AND "data_manager"."configuration_fence"."outcome" IS NULL AND "data_manager"."configuration_fence"."settled_at" IS NULL) OR ("data_manager"."configuration_fence"."state" = 'settled' AND "data_manager"."configuration_fence"."outcome" IN ('applied','unused','contained') AND "data_manager"."configuration_fence"."settled_at" IS NOT NULL) OR ("data_manager"."configuration_fence"."state" = 'refused' AND "data_manager"."configuration_fence"."outcome" IS NULL AND "data_manager"."configuration_fence"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."feed_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region" text NOT NULL,
	"name" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_imported_at" timestamp with time zone,
	"hash" text,
	"validation_status" text,
	"validation_message" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_manager"."job_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"message" text,
	"error" jsonb,
	"artifacts" jsonb
);
--> statement-breakpoint
CREATE TABLE "data_manager"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"triggered_by" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"execution_version" integer,
	"operation_key" text,
	"operation_fingerprint" text,
	"execution_fingerprint" text,
	"admitted_at" bigint,
	"deadline_at" bigint,
	"requested_deadline_at" bigint,
	"execution_parent" jsonb,
	"execution_input" jsonb,
	"execution_state" jsonb,
	"execution_agent_operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_admission" jsonb,
	"execution_progress" jsonb,
	"execution_completion" jsonb,
	"released_at" timestamp with time zone,
	"ownership_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "data_manager_jobs_execution_bounds" CHECK ("data_manager"."jobs"."ownership_version" >= 0 AND ("data_manager"."jobs"."execution_progress" IS NULL OR octet_length("data_manager"."jobs"."execution_progress"::text) <= 524288)),
	CONSTRAINT "data_manager_jobs_execution_row" CHECK (("data_manager"."jobs"."execution_admission" IS NULL) = ("data_manager"."jobs"."execution_progress" IS NULL) AND ("data_manager"."jobs"."execution_admission" IS NULL OR "data_manager"."jobs"."execution_version" = 2) AND ("data_manager"."jobs"."execution_version" IS DISTINCT FROM 2 OR "data_manager"."jobs"."execution_admission" IS NOT NULL OR "data_manager"."jobs"."finished_at" IS NOT NULL) AND ("data_manager"."jobs"."execution_completion" IS NULL OR "data_manager"."jobs"."execution_admission" IS NOT NULL) AND ("data_manager"."jobs"."released_at" IS NULL OR ("data_manager"."jobs"."finished_at" IS NOT NULL AND "data_manager"."jobs"."execution_admission" IS NOT NULL))),
	CONSTRAINT "data_manager_jobs_execution_shape" CHECK ("data_manager"."jobs"."execution_version" IS NULL OR coalesce(("data_manager"."jobs"."execution_version" = 2 AND "data_manager"."jobs"."operation_key" ~ '^opk1_[A-Za-z0-9_-]{16,64}$' AND "data_manager"."jobs"."operation_fingerprint" ~ '^[a-f0-9]{64}$' AND "data_manager"."jobs"."execution_fingerprint" ~ '^[a-f0-9]{64}$' AND "data_manager"."jobs"."admitted_at" >= 0 AND "data_manager"."jobs"."deadline_at" > "data_manager"."jobs"."admitted_at" AND "data_manager"."jobs"."execution_input" IS NOT NULL AND "data_manager"."jobs"."execution_state" IS NOT NULL), false))
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_artifact_references" (
	"principal" text NOT NULL,
	"package_id" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"retained_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_artifact_references_principal_package_id_pk" PRIMARY KEY("principal","package_id")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_job_owners" (
	"job_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_job_owners_job_id_principal_pk" PRIMARY KEY("job_id","principal")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_jobs" (
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
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_subject_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"user_id" text,
	"actor_user_id" text,
	"actor_session_id" text,
	"encrypted_locator" text,
	"locator_type" text DEFAULT 'user_id' NOT NULL,
	"account_state" text DEFAULT 'current' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
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
	CONSTRAINT "data_subject_request_state_check" CHECK ("data_subject_request"."state" in ('open', 'in_progress', 'waiting_on_requester', 'completed', 'refused')),
	CONSTRAINT "data_subject_request_version_check" CHECK ("data_subject_request"."version" > 0),
	CONSTRAINT "data_subject_request_locator_type_check" CHECK ("data_subject_request"."locator_type" in ('user_id', 'email', 'username', 'erasure_reference', 'other_reference')),
	CONSTRAINT "data_subject_request_account_state_check" CHECK ("data_subject_request"."account_state" in ('current', 'inaccessible', 'deleted', 'unknown')),
	CONSTRAINT "data_subject_request_identity_check" CHECK (("data_subject_request"."identity_method" is null and "data_subject_request"."identity_verified_at" is null) or ("data_subject_request"."identity_method" in ('account_session', 'manual') and "data_subject_request"."identity_verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_event_payload_version_check" CHECK ("data_subject_request_event"."payload_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"recipient_user_id" text,
	"template" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"occurrence_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_notification_template_check" CHECK ("data_subject_request_notification"."template" in ('acknowledgement', 'waiting_on_requester', 'extension', 'completed', 'refused', 'admin_new_request', 'admin_deadline')),
	CONSTRAINT "data_subject_request_notification_channel_check" CHECK ("data_subject_request_notification"."channel" in ('email')),
	CONSTRAINT "data_subject_request_notification_state_check" CHECK ("data_subject_request_notification"."state" in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled')),
	CONSTRAINT "data_subject_request_notification_attempts_check" CHECK ("data_subject_request_notification"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_preservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"source_cutoff_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"status" text DEFAULT 'held' NOT NULL,
	"outcome_code" text
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"public_code" text,
	"resolution_code" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_task_status_check" CHECK ("data_subject_request_task"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "health_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"status" text NOT NULL,
	"response_time" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"installed_by" text,
	CONSTRAINT "installed_extension_installation_kind_check" CHECK ("installed_extension"."installation_kind" in ('catalog','standalone')),
	CONSTRAINT "installed_extension_standalone_provenance_check" CHECK ("installed_extension"."installation_kind" <> 'standalone' or coalesce(("installed_extension"."source_trust" = 'community' and "installed_extension"."id" ~ '^local-[0-9a-f-]{36}$' and jsonb_typeof("installed_extension"."provenance") = 'object' and "installed_extension"."provenance"->>'kind' in ('artifact','source','uploaded-artifact','legacy_unknown') and "installed_extension"."provenance"->>'contentDigest' ~ '^[a-f0-9]{64}$'),false))
);
--> statement-breakpoint
CREATE TABLE "installed_extension_component" (
	"extension_id" text NOT NULL,
	"kind" text NOT NULL,
	"component_id" text NOT NULL,
	CONSTRAINT "installed_extension_component_extension_id_kind_component_id_pk" PRIMARY KEY("extension_id","kind","component_id")
);
--> statement-breakpoint
CREATE TABLE "installed_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"repository" text,
	"installed_version" text NOT NULL,
	"source_type" text DEFAULT 'registry' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by" text,
	"managed_by_extension" text,
	"last_transaction_id" text
);
--> statement-breakpoint
CREATE TABLE "integration_config" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrationConfig_integrationId_unq" UNIQUE("integration_id")
);
--> statement-breakpoint
CREATE TABLE "integration_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "integrationSecret_integrationId_key_unq" UNIQUE("integration_id","key")
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
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"icon" text,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	"field_contributors" jsonb,
	CONSTRAINT "labeledPlace_userId_label_unq" UNIQUE("user_id","label")
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
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wrap_type" text NOT NULL,
	"label" text NOT NULL,
	"identity_string" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	CONSTRAINT "mobile_auth_handoff_callback_code_hash_unique" UNIQUE("callback_code_hash")
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
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"vehicle_id" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"address" text,
	"note" text,
	"expires_at" timestamp with time zone,
	"source" text NOT NULL,
	"accuracy_meters" double precision,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parkedLocation_userId_vehicleId_unq" UNIQUE NULLS NOT DISTINCT("user_id","vehicle_id")
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
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"public_origin" text NOT NULL,
	"display_name" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_tag" text NOT NULL,
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
	CONSTRAINT "personalTimelineConnection_userId_unq" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "personal_vehicle" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"powertrain" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"preset_id" text,
	"ev" jsonb,
	"fuel_consumption_l_per_100km" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personalVehicle_userId_name_unq" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "platform_configuration_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
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
	CONSTRAINT "platform_preview_bounds" CHECK (length("platform_configuration_preview"."operation_key") between 1 and 128 and "platform_configuration_preview"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."preview_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."auth_policy_revision" ~ '^[a-f0-9]{64}$' and octet_length("platform_configuration_preview"."preview"::text) <= 131072 and jsonb_typeof("platform_configuration_preview"."preview") = 'object' and "platform_configuration_preview"."expires_at" > "platform_configuration_preview"."created_at" and "platform_configuration_preview"."expires_at" <= "platform_configuration_preview"."created_at" + interval '10 minutes' and (("platform_configuration_preview"."consumed_at" is null) = ("platform_configuration_preview"."consumed_by_job_id" is null)) and ("platform_configuration_preview"."retired_at" is null or ("platform_configuration_preview"."consumed_at" is not null and "platform_configuration_preview"."retired_at" >= "platform_configuration_preview"."consumed_at")))
);
--> statement-breakpoint
CREATE TABLE "saved_list" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"is_private" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savedList_userId_name_unq" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "saved_place" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	"field_contributors" jsonb,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_config" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serviceConfig_serviceId_unq" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE "service_repository" (
	"hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"last_sha" text NOT NULL,
	"pinned_ref" text,
	"managed_by_extension" text NOT NULL,
	"last_transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_repository_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "service_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "serviceSecret_serviceId_key_unq" UNIQUE("service_id","key")
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
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"mode" text NOT NULL,
	"label" text NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "share_link_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "transit_credential_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"authorization_ciphertext" text,
	"authorization_iv" text,
	"authorization_tag" text,
	"candidate_id" uuid,
	"credentials_revision" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transit_credential_preview_bounds" CHECK (octet_length("transit_credential_preview"."ciphertext") <= 1500000 and length("transit_credential_preview"."intent_fingerprint") = 64 and length("transit_credential_preview"."iv") = 16 and length("transit_credential_preview"."tag") = 24)
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
	"actor_id" text,
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
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_target_id_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_request_key_account_action_receipt_key_fk" FOREIGN KEY ("request_key") REFERENCES "public"."account_action_receipt"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_action_reauthentication" ADD CONSTRAINT "admin_action_reauthentication_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job" ADD CONSTRAINT "admin_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job_log" ADD CONSTRAINT "admin_job_log_job_id_admin_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."admin_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_policy_application" ADD CONSTRAINT "auth_policy_application_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_policy_state" ADD CONSTRAINT "auth_policy_state_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_migration_preview" ADD CONSTRAINT "configuration_migration_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_disclosure_event" ADD CONSTRAINT "data_disclosure_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_manager"."job_stages" ADD CONSTRAINT "job_stages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "data_manager"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_manager"."offline_package_job_owners" ADD CONSTRAINT "offline_package_job_owners_job_id_offline_package_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "data_manager"."offline_package_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_session_id_session_id_fk" FOREIGN KEY ("actor_session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_event" ADD CONSTRAINT "data_subject_request_event_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_preservation" ADD CONSTRAINT "data_subject_request_preservation_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD CONSTRAINT "data_subject_request_task_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extension" ADD CONSTRAINT "installed_extension_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extension_component" ADD CONSTRAINT "installed_extension_component_extension_id_installed_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."installed_extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_integration" ADD CONSTRAINT "installed_integration_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secret" ADD CONSTRAINT "integration_secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labeled_place" ADD CONSTRAINT "labeled_place_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair" ADD CONSTRAINT "mangrove_keypair_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair_wrap" ADD CONSTRAINT "mangrove_keypair_wrap_user_id_mangrove_keypair_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mangrove_keypair"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD CONSTRAINT "mobile_auth_handoff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_vehicle_id_personal_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."personal_vehicle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_timeline_connection" ADD CONSTRAINT "personal_timeline_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_vehicle" ADD CONSTRAINT "personal_vehicle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration_preview" ADD CONSTRAINT "platform_configuration_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_list" ADD CONSTRAINT "saved_list_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_place" ADD CONSTRAINT "saved_place_list_id_saved_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."saved_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_secret" ADD CONSTRAINT "service_secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transit_credential_preview" ADD CONSTRAINT "transit_credential_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_application_receipt" ADD CONSTRAINT "integration_application_receipt_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_action_actor_time_idx" ON "account_action_receipt" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "account_action_target_time_idx" ON "account_action_receipt" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mail_action_kind_uq" ON "account_mail_outbox" USING btree ("request_key","kind");--> statement-breakpoint
CREATE INDEX "account_mail_pending_idx" ON "account_mail_outbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "admin_reauth_actor_expiry_idx" ON "admin_action_reauthentication" USING btree ("actor_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_reauth_request_uq" ON "admin_action_reauthentication" USING btree ("actor_id","request_key");--> statement-breakpoint
CREATE INDEX "audit_actorId_idx" ON "admin_audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_createdAt_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "adminJob_status_idx" ON "admin_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "adminJob_type_idx" ON "admin_job" USING btree ("type");--> statement-breakpoint
CREATE INDEX "adminJob_createdAt_idx" ON "admin_job" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "adminJob_one_active_system_maintenance_uq" ON "admin_job" USING btree ((true)) WHERE "admin_job"."type" IN ('system.update', 'system.diagnostics') AND "admin_job"."status" IN ('queued', 'running', 'cancel_pending');--> statement-breakpoint
CREATE INDEX "adminJobLog_jobId_idx" ON "admin_job_log" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "app_logs_level_source_idx" ON "app_logs" USING btree ("level","source","created_at");--> statement-breakpoint
CREATE INDEX "app_logs_created_at_idx" ON "app_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_capability_binding_service" ON "capability_binding" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_actor_kind_idx" ON "configuration_migration_preview" USING btree ("actor_id","kind");--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_expiry_idx" ON "configuration_migration_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_user_occurred_idx" ON "data_disclosure_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_recipient_idx" ON "data_disclosure_event" USING btree ("recipient_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_disclosure_event_idempotency_idx" ON "data_disclosure_event" USING btree ("idempotency_key") WHERE "data_disclosure_event"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_fence_one_prepared_uq" ON "data_manager"."configuration_fence" USING btree ("state") WHERE "data_manager"."configuration_fence"."state" = 'prepared';--> statement-breakpoint
CREATE INDEX "job_stages_job_id_idx" ON "data_manager"."job_stages" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_manager_jobs_execution_key_uq" ON "data_manager"."jobs" USING btree ("operation_key") WHERE "data_manager"."jobs"."operation_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "offline_package_artifact_refs_package_idx" ON "data_manager"."offline_package_artifact_references" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "offline_package_artifact_refs_principal_age_idx" ON "data_manager"."offline_package_artifact_references" USING btree ("principal","retained_at");--> statement-breakpoint
CREATE INDEX "offline_package_job_owners_principal_idx" ON "data_manager"."offline_package_job_owners" USING btree ("principal");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_package_jobs_live_request_key_uq" ON "data_manager"."offline_package_jobs" USING btree ("request_key") WHERE "data_manager"."offline_package_jobs"."status" IN ('preparing', 'ready-to-download');--> statement-breakpoint
CREATE INDEX "offline_package_jobs_status_created_idx" ON "data_manager"."offline_package_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "offline_package_jobs_package_id_idx" ON "data_manager"."offline_package_jobs" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_user_state_idx" ON "data_subject_request" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "data_subject_request_due_idx" ON "data_subject_request" USING btree ("state","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_active_user_kind_idx" ON "data_subject_request" USING btree ("user_id","kind") WHERE "data_subject_request"."user_id" is not null and "data_subject_request"."state" in ('open', 'in_progress', 'waiting_on_requester');--> statement-breakpoint
CREATE INDEX "data_subject_request_event_request_idx" ON "data_subject_request_event" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_event_idempotency_idx" ON "data_subject_request_event" USING btree ("request_id","idempotency_key") WHERE "data_subject_request_event"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_notification_event_idx" ON "data_subject_request_notification" USING btree ("request_id","template","channel","recipient_user_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_state_idx" ON "data_subject_request_notification" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_recipient_idx" ON "data_subject_request_notification" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_preservation_request_registration_idx" ON "data_subject_request_preservation" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_preservation_registration_status_idx" ON "data_subject_request_preservation" USING btree ("registration_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_task_request_registration_idx" ON "data_subject_request_task" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_task_status_idx" ON "data_subject_request_task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "healthHistory_serviceId_checkedAt_idx" ON "health_history" USING btree ("service_id","checked_at");--> statement-breakpoint
CREATE INDEX "installedExtension_sourceTrust_idx" ON "installed_extension" USING btree ("source_trust");--> statement-breakpoint
CREATE INDEX "installedExtensionComponent_componentId_idx" ON "installed_extension_component" USING btree ("component_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installedExtensionComponent_kind_componentId_key" ON "installed_extension_component" USING btree ("kind","component_id");--> statement-breakpoint
CREATE INDEX "installedIntegration_sourceType_idx" ON "installed_integration" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "integrationConfig_integrationId_idx" ON "integration_config" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "integrationSecret_integrationId_idx" ON "integration_secret" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "labeledPlace_userId_idx" ON "labeled_place" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mobile_auth_handoff_user_expires_idx" ON "mobile_auth_handoff" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "oauth_access_token_expires_at_idx" ON "oauth_access_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" USING btree ("user_id");--> statement-breakpoint
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
CREATE INDEX "parkedLocation_userId_idx" ON "parked_location" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_key" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "personalTimelineConnection_userId_idx" ON "personal_timeline_connection" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personalVehicle_userId_idx" ON "personal_vehicle" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_preview_actor_key_uq" ON "platform_configuration_preview" USING btree ("actor_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_preview_fingerprint_uq" ON "platform_configuration_preview" USING btree ("preview_fingerprint");--> statement-breakpoint
CREATE INDEX "platform_preview_expiry_idx" ON "platform_configuration_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "savedList_userId_idx" ON "saved_list" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "savedPlace_listId_idx" ON "saved_place" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "serviceConfig_serviceId_idx" ON "service_config" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "serviceSecret_serviceId_idx" ON "service_secret" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_auth_assurance_user_idx" ON "session_auth_assurance" USING btree ("user_id","authenticated_at");--> statement-breakpoint
CREATE INDEX "shareLink_userId_idx" ON "share_link" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transit_credential_preview_actor_key_uq" ON "transit_credential_preview" USING btree ("actor_id","operation_key");--> statement-breakpoint
CREATE INDEX "transit_credential_preview_expiry_idx" ON "transit_credential_preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "integration_application_target_time_idx" ON "integration_application_receipt" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_application_actor_idx" ON "integration_application_receipt" USING btree ("actor_id");