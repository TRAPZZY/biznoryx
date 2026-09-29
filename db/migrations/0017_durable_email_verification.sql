begin;

alter table app_users
  add column if not exists email_verified_at timestamptz;

create table if not exists email_verification_challenges (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references app_users(id)
    on delete cascade,

  email text not null,

  purpose text not null
    default 'email_verification'
    check (
      purpose in (
        'email_verification',
        'password_reset'
      )
    ),

  code_hash text not null
    check (length(code_hash) = 64),

  attempts integer not null
    default 0
    check (attempts >= 0),

  max_attempts integer not null
    default 5
    check (max_attempts > 0),

  expires_at timestamptz not null,

  consumed_at timestamptz,

  superseded_at timestamptz,

  created_at timestamptz not null
    default now()
);

create index if not exists email_verification_challenges_user_idx
  on email_verification_challenges (
    user_id,
    purpose,
    created_at desc
  );

create index if not exists email_verification_challenges_active_idx
  on email_verification_challenges (
    user_id,
    purpose,
    expires_at
  )
  where consumed_at is null;

alter table email_verification_challenges
  enable row level security;

create policy email_verification_challenges_rls
  on email_verification_challenges
  using (
    user_id =
      nullif(
        current_setting(
          'app.current_user_id',
          true
        ),
        ''
      )::uuid
  )
  with check (
    user_id =
      nullif(
        current_setting(
          'app.current_user_id',
          true
        ),
        ''
      )::uuid
  );

commit;