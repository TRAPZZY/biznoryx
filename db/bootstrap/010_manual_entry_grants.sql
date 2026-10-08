grant select, insert, update on manual_entry_drafts, manual_entry_deliveries to biznoryx_app;
grant select, insert on manual_entry_submissions, manual_entry_period_sources to biznoryx_app;
grant execute on function claim_ingestion_period_source(uuid, uuid, text, text) to biznoryx_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_worker') then
    grant select on manual_entry_submissions, manual_entry_deliveries, manual_entry_period_sources to biznoryx_worker;
  end if;
end;
$$;
