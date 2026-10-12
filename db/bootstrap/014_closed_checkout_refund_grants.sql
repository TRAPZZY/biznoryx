begin;
grant execute on function runtime_save_closed_checkout(uuid,text,jsonb,boolean,timestamptz),runtime_closed_checkout(text),runtime_pending_closed_checkouts() to biznoryx_app;
commit;
