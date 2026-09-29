drop trigger if exists
  ingestion_run_processing_job_trigger
on ingestion_runs;

drop function if exists
  enqueue_ingestion_processing_job();

drop table if exists
  worker_heartbeats;

drop table if exists
  processing_jobs;