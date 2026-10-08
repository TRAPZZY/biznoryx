begin;
set local row_security = off;

-- This structural rollback is only safe before business evidence exists.
do $$ begin
  if exists (select 1 from manual_entry_drafts) or exists (select 1 from manual_entry_submissions) then
    raise exception 'Manual entry evidence exists; retain additive tables and roll back the runtime instead';
  end if;
end $$;

drop trigger manual_ingestion_source_guard on ingestion_runs;
drop function enforce_manual_ingestion_source();
drop function claim_ingestion_period_source(uuid, uuid, text, text);
alter table ingestion_runs drop column manual_submission_id;
alter table ingestion_runs drop column data_status;
alter table reporting_periods drop column data_status;
drop table manual_entry_period_sources;
drop table manual_entry_deliveries;
alter table manual_entry_drafts drop constraint manual_entry_drafts_organization_id_correction_of_fkey;
drop table manual_entry_submissions;
drop function manual_entry_immutable();
drop table manual_entry_drafts;
drop index manual_stream_org_identity;

commit;
