grant select on account_deletion_requests to biznoryx_app;
grant execute on function runtime_account_deletion_context(uuid), runtime_request_account_deletion(uuid,text,jsonb,boolean),
  runtime_account_deletion_status(text), runtime_pending_account_deletions(), runtime_account_deletion_retry(uuid,text),
  runtime_finish_account_deletion(uuid) to biznoryx_app;
