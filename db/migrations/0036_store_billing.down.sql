begin;
do $$ begin
  if exists(select 1 from organization_billing_subscriptions where provider in ('app_store','play_store')) then
    raise exception 'Store subscriptions must be migrated before rollback';
  end if;
end $$;
drop function runtime_store_customer_organization(uuid);
drop function runtime_store_transaction_retired(text);
drop table retired_store_transactions;
drop table store_billing_transactions;
drop table organization_store_accounts;
alter table organization_billing_subscriptions drop constraint billing_provider_pricing_check;
alter table organization_billing_subscriptions alter column amount_minor set not null,alter column currency set not null;
commit;
