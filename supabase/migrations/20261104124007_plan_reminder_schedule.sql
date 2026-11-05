-- Install the server schedule only after the personal-reminder core migration.
-- Existing jobs, accounts, data, Auth, Storage, and project settings are preserved.
begin;

create extension if not exists pg_cron;

do $schedule$
begin
  if to_regprocedure('yeto_private.dispatch_plan_reminders()') is null then
    raise exception 'Install the plan reminder core migration first.';
  end if;
  if exists(select 1 from cron.job where jobname = 'tara-plan-reminders-v1') then
    raise exception 'The TARA plan reminder schedule already exists; do not rerun this migration.';
  end if;
  perform cron.schedule('tara-plan-reminders-v1','* * * * *',$job$
    select yeto_private.dispatch_plan_reminders();
    -- Retain only this job's recent history; no other job logs are changed.
    delete from cron.job_run_details
      where jobid = (select jobid from cron.job where jobname = 'tara-plan-reminders-v1' and username = current_user)
        and end_time < now() - interval '7 days';
  $job$);
end;
$schedule$;

commit;
