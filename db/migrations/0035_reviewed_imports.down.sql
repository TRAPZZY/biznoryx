begin;
do $$ begin
  if exists(select 1 from ingestion_import_manifests) or exists(select 1 from import_profiles) then
    raise exception 'Import evidence exists. Roll back application code without dropping evidence.';
  end if;
end $$;
drop table ingestion_import_manifests;
drop table import_profiles;
-- Identity indexes may be referenced by subsequent feature migrations.
commit;
