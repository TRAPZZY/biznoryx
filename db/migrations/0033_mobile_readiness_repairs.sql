begin;

-- Release only reservations that have no accepted data or committed manual entry.
delete from manual_entry_period_sources p
where p.input_mode = 'full_file'
  and not exists (
    select 1 from ingestion_runs ir join reporting_periods rp on rp.id = ir.reporting_period_id
    where ir.organization_id = p.organization_id and ir.data_stream_id = p.data_stream_id
      and to_char(rp.period_start, 'YYYY-MM') = p.period
      and ir.status <> 'rejected'
  )
  and not exists (
    select 1 from manual_entry_submissions s where s.organization_id = p.organization_id
      and s.data_stream_id = p.data_stream_id and s.period = p.period
  );

create or replace function runtime_pending_trial_organizations(p_limit integer)
returns table (organization_id uuid) language sql security definer
set search_path = public, pg_temp stable as $$
  select organization_id from public.billing_trials
  where ((converted_at is null and canceled_at is null and
            (state->>'verificationStatus' = 'pending' or
             (ends_at is not null and ends_at > now() - interval '30 days') or
             (card_verified_at is not null and provider_subscription_code is null)))
      or state->>'refundStatus' not in ('processed', 'not_required')
      or (state->>'cancelStatus' = 'requested' and canceled_at is null)
      or (state->>'provisionStatus' = 'attempted' and canceled_at is null))
    and coalesce((state->>'nextProcessAt')::timestamptz, '-infinity'::timestamptz) <= now()
  order by updated_at limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function runtime_pending_trial_organizations(integer) from public;

commit;
