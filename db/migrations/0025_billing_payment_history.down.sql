begin;

drop policy if exists billing_payments_rls on billing_payments;
drop table if exists billing_payments;

commit;
