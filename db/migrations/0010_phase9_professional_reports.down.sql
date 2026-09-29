begin;

drop policy if exists professional_report_sections_rls on professional_report_sections;
drop policy if exists professional_reports_rls on professional_reports;
drop table if exists professional_report_sections;
drop table if exists professional_reports;
drop type if exists professional_report_section_kind;
drop type if exists professional_report_status;

commit;
