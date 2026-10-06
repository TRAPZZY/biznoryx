begin;

alter table evidence_report_definitions add column revenue_breakdown jsonb;
alter table evidence_report_definitions add constraint evidence_revenue_breakdown_valid check (
  revenue_breakdown is null or (
    unit = 'currency' and
    jsonb_typeof(revenue_breakdown) = 'object' and
    revenue_breakdown ?& array['productColumn', 'quantityColumn', 'quantityUnit', 'currency', 'confirmed'] and
    jsonb_typeof(revenue_breakdown->'productColumn') = 'string' and
    jsonb_typeof(revenue_breakdown->'quantityColumn') = 'string' and
    jsonb_typeof(revenue_breakdown->'quantityUnit') = 'string' and
    jsonb_typeof(revenue_breakdown->'currency') = 'string' and
    revenue_breakdown->'confirmed' = 'true'::jsonb and
    octet_length(revenue_breakdown->>'productColumn') between 1 and 160 and
    octet_length(revenue_breakdown->>'quantityColumn') between 1 and 160 and
    length(revenue_breakdown->>'quantityUnit') between 1 and 40 and
    revenue_breakdown->>'currency' ~ '^[A-Z]{3}$' and
    revenue_breakdown->>'productColumn' <> revenue_breakdown->>'quantityColumn' and
    revenue_breakdown->>'productColumn' <> source_column and
    revenue_breakdown->>'quantityColumn' <> source_column
  )
);

commit;
