begin;

drop policy if exists action_outcomes_rls on action_outcomes;
drop policy if exists management_actions_rls on management_actions;
drop table if exists action_outcomes;
drop table if exists management_actions;
drop type if exists action_outcome_assessment;
drop type if exists management_action_status;

commit;
