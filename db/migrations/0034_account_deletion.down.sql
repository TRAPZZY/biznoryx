begin;
-- Completed deletions cannot be undone. Drain pending requests before rollback.
do $$ begin
  if exists (select 1 from account_deletion_requests where status <> 'completed') then
    raise exception 'Pending account deletions must finish before rollback';
  end if;
end $$;
create or replace function manual_entry_immutable() returns trigger language plpgsql as $$
begin raise exception 'Manual submission evidence is immutable' using errcode = '23514'; end;
$$;
drop function runtime_finish_account_deletion(uuid);
drop function runtime_account_deletion_retry(uuid,text);
drop function runtime_pending_account_deletions();
drop function runtime_account_deletion_status(text);
drop function runtime_request_account_deletion(uuid,text,jsonb,boolean);
drop function runtime_account_deletion_context(uuid);
drop table account_deletion_requests;
commit;
