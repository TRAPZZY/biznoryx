drop policy if exists
  verified_metric_points_tenant_policy
on verified_metric_points;

drop policy if exists
  verified_metric_definitions_tenant_policy
on verified_metric_definitions;

drop table if exists
  verified_metric_points;

drop table if exists
  verified_metric_definitions;