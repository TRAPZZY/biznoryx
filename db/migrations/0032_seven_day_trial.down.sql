begin;

-- Trial evidence and encrypted authorizations must survive rollback. Disable the
-- integration before rollback; do not orphan still-scheduled provider billing.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    revoke select, insert, update on billing_trials from biznoryx_app;
    revoke select, insert on billing_trial_audit from biznoryx_app;
    revoke execute on function runtime_paystack_trial_organization(text, text) from biznoryx_app;
    revoke execute on function runtime_pending_trial_organizations(integer) from biznoryx_app;
  end if;
end $$;

commit;
