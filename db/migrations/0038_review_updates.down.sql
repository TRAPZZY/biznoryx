begin;
do $$ begin
  raise exception 'Preserve delivered update history. Roll back application code; review schema rollback separately.';
end $$;
commit;
