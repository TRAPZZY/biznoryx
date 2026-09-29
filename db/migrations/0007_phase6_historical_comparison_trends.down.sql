begin;

drop policy if exists metric_trend_summaries_rls on metric_trend_summaries;
drop policy if exists metric_period_comparisons_rls on metric_period_comparisons;
drop table if exists metric_trend_summaries;
drop table if exists metric_period_comparisons;
drop type if exists trend_direction;
drop type if exists comparison_status;

commit;
