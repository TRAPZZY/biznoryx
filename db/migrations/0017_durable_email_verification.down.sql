begin;

drop policy if exists
  email_verification_challenges_rls
  on email_verification_challenges;

drop table if exists
  email_verification_challenges;

alter table app_users
  drop column if exists email_verified_at;

commit;