begin;
do $$ begin
  if exists(select 1 from closed_checkout_refund_recovery where completed_at is null) then raise exception 'Resolve closed checkout recovery before rollback'; end if;
end $$;
drop function runtime_save_closed_checkout(uuid,text,jsonb,boolean,timestamptz),runtime_closed_checkout(text),runtime_pending_closed_checkouts();
drop table closed_checkout_refund_recovery;
commit;
