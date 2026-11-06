begin;
-- Preserve customer files and the deletion outbox.
-- An operator must check queue state before runtime rollback.
drop function if exists
  finish_source_file_deletion(uuid,uuid,boolean,text,integer);
drop function if exists
  claim_source_file_deletions(integer);
commit;
