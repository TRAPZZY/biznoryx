begin;

create table verified_business_actions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  source_finding_id uuid not null
    references verified_performance_findings(id)
    on delete restrict,

  title text not null,

  description text not null default '',

  status text not null default 'planned'
    check (
      status in (
        'planned',
        'in_progress',
        'blocked',
        'completed',
        'cancelled'
      )
    ),

  owner_user_id uuid not null
    references app_users(id)
    on delete restrict,

  due_date date,

  evidence jsonb not null
    check (
      jsonb_typeof(evidence) = 'object'
    ),

  created_by_user_id uuid not null
    references app_users(id)
    on delete restrict,

  completed_at timestamptz,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    source_finding_id
  ),

  check (
    (
      status = 'completed'
      and completed_at is not null
    )
    or
    (
      status <> 'completed'
      and completed_at is null
    )
  )
);

create index verified_business_actions_tenant_status_idx
  on verified_business_actions (
    organization_id,
    status,
    updated_at desc
  );

create index verified_business_actions_owner_idx
  on verified_business_actions (
    organization_id,
    owner_user_id,
    status
  );

create index verified_business_actions_due_date_idx
  on verified_business_actions (
    organization_id,
    due_date
  )
  where due_date is not null;

create index verified_business_actions_finding_idx
  on verified_business_actions (
    organization_id,
    source_finding_id
  );

alter table verified_business_actions
  enable row level security;

alter table verified_business_actions
  force row level security;

create policy verified_business_actions_tenant_policy
on verified_business_actions
using (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
)
with check (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
);

commit;
