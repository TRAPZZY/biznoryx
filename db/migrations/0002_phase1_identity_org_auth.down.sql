begin;

drop policy if exists user_sessions_self_rls on user_sessions;
drop policy if exists organization_invitations_rls on organization_invitations;
drop policy if exists organization_memberships_rls on organization_memberships;
drop table if exists user_sessions;
drop table if exists organization_invitations;
drop table if exists organization_memberships;
drop type if exists invitation_status;
drop type if exists membership_status;
drop type if exists membership_role;

commit;
