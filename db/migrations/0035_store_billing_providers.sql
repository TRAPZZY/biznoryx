begin;
alter type billing_provider add value if not exists 'app_store';
alter type billing_provider add value if not exists 'play_store';
commit;
