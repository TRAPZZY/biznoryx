begin;

-- Source reservations removed for rejected-only periods are intentionally not restored.
create or replace function runtime_pending_trial_organizations(p_limit integer)
returns table (organization_id uuid) language sql security definer
set search_path = public, pg_temp stable as $$
  select organization_id from public.billing_trials
  where ((converted_at is null and (ends_at is null or ends_at > now() - interval '30 days'))
      or state->>'refundStatus' not in ('processed', 'not_required')
      or state->>'cancelStatus' = 'requested' or state->>'provisionStatus' = 'attempted')
    and coalesce((state->>'nextProcessAt')::timestamptz, '-infinity'::timestamptz) <= now()
  order by updated_at limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function runtime_pending_trial_organizations(integer) from public;

commit;
