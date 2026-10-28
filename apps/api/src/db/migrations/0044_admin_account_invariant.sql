CREATE TABLE "account_admin_guard" (
	"id" integer PRIMARY KEY NOT NULL,
	"active_count" integer NOT NULL,
	CONSTRAINT "account_admin_guard_singleton" CHECK ("account_admin_guard"."id"=1),
	CONSTRAINT "account_admin_guard_nonnegative" CHECK ("account_admin_guard"."active_count">=0)
);
--> statement-breakpoint
ALTER TABLE "auth_policy_application" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_policy_state" ALTER COLUMN "activated_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_policy_application" ADD CONSTRAINT "auth_policy_application_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_policy_state" ADD CONSTRAINT "auth_policy_state_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Drizzle emits the schema above; this custom SQL installs the transactional invariant.
LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM "user" u CROSS JOIN LATERAL unnest(string_to_array(coalesce(u.role,'user'),',')) token WHERE btrim(token) NOT IN ('user','admin','privacy_admin')) THEN
  RAISE EXCEPTION 'Unrecognized historical account role';
 END IF;
END $$;
--> statement-breakpoint
WITH normalized AS (
 SELECT id, ARRAY(SELECT btrim(token) FROM unnest(string_to_array(coalesce(role,'user'),',')) token) AS roles FROM "user"
)
UPDATE "user" u SET role=CASE WHEN 'admin'=ANY(n.roles) THEN 'admin' WHEN 'privacy_admin'=ANY(n.roles) THEN 'privacy_admin' ELSE 'user' END
FROM normalized n WHERE u.id=n.id;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT openmapx_canonical_account_role CHECK (role IS NULL OR role IN ('user','admin','privacy_admin'));
--> statement-breakpoint
INSERT INTO account_admin_guard(id,active_count) SELECT 1,count(*)::integer FROM "user" WHERE role='admin' AND banned IS NOT TRUE;
--> statement-breakpoint
CREATE FUNCTION openmapx_preserve_admin_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active integer:=0; new_active integer:=0; delta integer;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_active:=CASE WHEN OLD.role='admin' AND OLD.banned IS NOT TRUE THEN 1 ELSE 0 END; END IF;
 IF TG_OP <> 'DELETE' THEN new_active:=CASE WHEN NEW.role='admin' AND NEW.banned IS NOT TRUE THEN 1 ELSE 0 END; END IF;
 delta:=new_active-old_active;
 IF delta <> 0 THEN
  UPDATE account_admin_guard SET active_count=active_count+delta WHERE id=1 AND (delta>0 OR active_count+delta>0);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='LAST_ADMIN_REQUIRED',MESSAGE='LAST_ADMIN_REQUIRED'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER openmapx_admin_capacity BEFORE INSERT OR UPDATE OF role,banned OR DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION openmapx_preserve_admin_capacity();
