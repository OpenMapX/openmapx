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
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_location" ADD CONSTRAINT "parked_location_vehicle_id_personal_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."personal_vehicle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_vehicle" ADD CONSTRAINT "personal_vehicle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parkedLocation_userId_idx" ON "parked_location" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personalVehicle_userId_idx" ON "personal_vehicle" USING btree ("user_id");