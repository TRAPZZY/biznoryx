begin;

do $$
begin
  if exists (
    select 1 from source_file_deletion_outbox
  ) then
    raise exception
      'Deletion history exists. An automatic rollback would lose cleanup records.';
  end if;
end $$;

drop trigger if exists prevent_pending_source_reuse_trigger
  on ingestion_runs;

drop function if exists prevent_pending_source_reuse();

drop table if exists source_file_deletion_outbox;

-- Review runtime-role grants separately before revocation.

commit;