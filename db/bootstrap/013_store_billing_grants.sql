begin;
grant select,insert,update on organization_store_accounts,store_billing_transactions to biznoryx_app;
grant execute on function runtime_store_customer_organization(uuid) to biznoryx_app;
grant execute on function runtime_store_transaction_retired(text) to biznoryx_app;
commit;
