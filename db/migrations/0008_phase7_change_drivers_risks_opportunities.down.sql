begin;

drop policy if exists finding_evidence_rls on finding_evidence;
drop policy if exists performance_findings_rls on performance_findings;
drop table if exists finding_evidence;
drop table if exists performance_findings;
drop type if exists finding_severity;
drop type if exists finding_status;
drop type if exists finding_kind;

commit;
