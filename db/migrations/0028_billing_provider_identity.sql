begin;

create unique index billing_provider_subscription_identity_unique_idx
  on organization_billing_subscriptions(provider, provider_subscription_code)
  where provider_subscription_code is not null;

-- Signed webhooks need to resolve a provider identity before setting tenant context.
create function runtime_paystack_subscription_organization(p_subscription_code text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select organization_id
  from public.organization_billing_subscriptions
  where provider = 'paystack'
    and provider_subscription_code = p_subscription_code;
$$;

revoke all on function runtime_paystack_subscription_organization(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant execute on function runtime_paystack_subscription_organization(text) to biznoryx_app;
  end if;
end $$;

commit;
