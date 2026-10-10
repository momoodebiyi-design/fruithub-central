-- Run with a database administrator. Every test object is rolled back.
BEGIN;
DO $$
DECLARE
  accounts jsonb;
  account jsonb;
  bucket text;
  allowed boolean;
  observed integer;
  inserted boolean;
  test_name text;
  seed_owner uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id',p.id,'roles',(
    SELECT jsonb_agg(r.role::text) FROM public.user_roles r WHERE r.user_id=p.id
  ))) INTO accounts FROM public.profiles p WHERE p.is_active;
  SELECT user_id INTO seed_owner FROM public.user_roles WHERE role='super_admin' LIMIT 1;
  IF seed_owner IS NULL THEN RAISE EXCEPTION 'Super Admin test identity required'; END IF;
  INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES
    ('purchase-evidence','__storage_rls_test__/seed',seed_owner::text),
    ('dispatch-invoices','__storage_rls_test__/seed',seed_owner::text);

  FOR account IN SELECT value FROM jsonb_array_elements(accounts) LOOP
    PERFORM set_config('request.jwt.claim.sub',account->>'id',true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',account->>'id','role','authenticated')::text,true);
    FOREACH bucket IN ARRAY ARRAY['purchase-evidence','dispatch-invoices'] LOOP
      allowed := COALESCE((account->'roles') ?| CASE WHEN bucket='purchase-evidence'
        THEN ARRAY['super_admin','management','operations_manager','procurement','inventory_officer']
        ELSE ARRAY['super_admin','management','operations_manager','sales','inventory_officer'] END,false);
      test_name := '__storage_rls_test__/' || (account->>'id');
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO observed FROM storage.objects WHERE bucket_id=bucket AND name='__storage_rls_test__/seed';
      IF observed <> (CASE WHEN allowed THEN 1 ELSE 0 END) THEN
        RAISE EXCEPTION 'Read test failed for roles %, bucket %',account->'roles',bucket;
      END IF;
      inserted := false;
      BEGIN
        INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES(bucket,test_name,account->>'id');
        inserted := true;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      IF inserted <> allowed THEN RAISE EXCEPTION 'Upload permission test failed'; END IF;
      IF allowed THEN
        BEGIN
          INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES(bucket,test_name||'-spoof','00000000-0000-0000-0000-000000000000');
          RAISE EXCEPTION 'Spoofed ownership was accepted';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        UPDATE storage.objects SET name=test_name||'-changed' WHERE bucket_id=bucket AND name=test_name;
        GET DIAGNOSTICS observed = ROW_COUNT;
        IF observed <> 0 THEN RAISE EXCEPTION 'Evidence overwrite allowed'; END IF;
        BEGIN
          DELETE FROM storage.objects WHERE bucket_id=bucket AND name=test_name;
          GET DIAGNOSTICS observed = ROW_COUNT;
          IF observed <> 0 THEN RAISE EXCEPTION 'Evidence deletion allowed'; END IF;
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
      END IF;
      EXECUTE 'RESET ROLE';
    END LOOP;
  END LOOP;

  -- A signed-in identity with no staff profile or role sees no documents.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO observed FROM storage.objects WHERE bucket_id IN ('purchase-evidence','dispatch-invoices');
  IF observed <> 0 THEN RAISE EXCEPTION 'Roleless identity read documents'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO observed FROM storage.objects WHERE bucket_id IN ('purchase-evidence','dispatch-invoices');
  IF observed <> 0 THEN RAISE EXCEPTION 'Anonymous identity read documents'; END IF;
  EXECUTE 'RESET ROLE';
END $$;
ROLLBACK;
SELECT 'PASS: existing staff roles, roleless and anonymous reads; upload ownership; immutable evidence; test objects rolled back' AS result;
