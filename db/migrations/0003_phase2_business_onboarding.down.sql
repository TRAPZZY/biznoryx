begin;

drop policy if exists kpi_definitions_rls on kpi_definitions;
drop policy if exists business_goals_rls on business_goals;
drop policy if exists business_terms_rls on business_terms;
drop policy if exists business_facts_rls on business_facts;
drop policy if exists business_model_entries_rls on business_model_entries;
drop policy if exists business_profiles_rls on business_profiles;
drop table if exists kpi_definitions;
drop table if exists business_goals;
drop table if exists business_terms;
drop table if exists business_facts;
drop table if exists business_model_entries;
drop table if exists business_profiles;
drop type if exists goal_status;
drop type if exists kpi_value_type;
drop type if exists business_model_entry_type;
drop type if exists fact_kind;
drop type if exists onboarding_status;

commit;
