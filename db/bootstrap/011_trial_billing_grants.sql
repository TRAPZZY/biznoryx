grant select, insert, update on billing_trials to biznoryx_app;
grant select, insert on billing_trial_audit to biznoryx_app;
grant execute on function runtime_paystack_trial_organization(text, text) to biznoryx_app;
grant execute on function runtime_pending_trial_organizations(integer) to biznoryx_app;
