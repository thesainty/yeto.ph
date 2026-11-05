-- TARA: personal plan reminders and fresh calendar export data. Apply once
-- after availability polls. Scheduling is a separate additive migration.
begin;

create table public.plan_reminders (
  plan_id uuid not null references public.social_plans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  minutes_before integer not null check (minutes_before in (60,1440)),
  enabled_at timestamptz not null default clock_timestamp(),
  notified_at timestamptz,
  primary key (plan_id,user_id,minutes_before)
);
create index plan_reminders_user on public.plan_reminders(user_id,plan_id,minutes_before);
create index plan_reminders_pending on public.plan_reminders(plan_id,enabled_at) where notified_at is null;
create index social_plans_reminder_time on public.social_plans(starts_at,id);
alter table public.plan_reminders enable row level security;
create policy plan_reminders_read on public.plan_reminders for select to authenticated
  using (user_id = (select auth.uid()) and yeto_private.can_read_social_plan(plan_id));
revoke all on public.plan_reminders from public,anon,authenticated,service_role;
grant select on public.plan_reminders to authenticated;

create function public.plan_reminders_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return jsonb_build_object('reminders',coalesce((
    select jsonb_agg(jsonb_build_object('plan_id',r.plan_id,'minutes_before',r.offsets) order by r.plan_id)
    from (
      select plan_id,jsonb_agg(minutes_before order by minutes_before) as offsets
      from public.plan_reminders group by plan_id
    ) r
  ),'[]'::jsonb));
end;
$$;

create function yeto_private.set_plan_reminders(plan_id uuid,reminder_minutes integer[])
returns void language plpgsql security definer set search_path = '' as $$
declare selected integer[] := coalesce(reminder_minutes,'{}'::integer[]); starts timestamptz; checked_at timestamptz;
begin
  perform yeto_private.lock_social_plan(plan_id);
  checked_at := clock_timestamp();
  if cardinality(selected) > 500 or array_ndims(selected) > 1 then
    raise exception 'Choose one-day and/or one-hour reminders.' using errcode = '22023';
  end if;
  if array_position(selected,null) is not null
    or exists(select 1 from unnest(selected) value where value not in (60,1440)) then
    raise exception 'Choose one-day and/or one-hour reminders.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct value order by value),'{}'::integer[]) into selected from unnest(selected) value;
  select p.starts_at into starts from public.social_plans p where p.id = plan_id;
  -- A retry or editing the other offset preserves an existing saved reminder.
  -- Newly enabling an already-passed deadline never creates retrospective spam.
  if exists(select 1 from unnest(selected) value
    where starts - make_interval(mins => value) <= checked_at and not exists(
      select 1 from public.plan_reminders r where r.plan_id = set_plan_reminders.plan_id
        and r.user_id = auth.uid() and r.minutes_before = value
    )) then
    raise exception 'That reminder time has already passed.' using errcode = '22023';
  end if;
  delete from public.plan_reminders r where r.plan_id = set_plan_reminders.plan_id
    and r.user_id = auth.uid() and not (r.minutes_before = any(selected));
  insert into public.plan_reminders(plan_id,user_id,minutes_before)
    select set_plan_reminders.plan_id,auth.uid(),unnest(selected) on conflict do nothing;
end;
$$;
create function public.set_plan_reminders(plan_id uuid,reminder_minutes integer[])
returns void language sql security invoker set search_path = '' as $$
  select yeto_private.set_plan_reminders(plan_id,reminder_minutes);
$$;

-- Resolve the exact plan under fresh RLS for each export. Export data contains
-- no invitee/attendee identities, account address, or reusable access token.
create function public.plan_calendar_snapshot(plan_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare item jsonb; offsets jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if plan_id is null then raise exception 'Choose a plan.' using errcode = '22023'; end if;
  select jsonb_build_object('id',p.id,'title',p.title,'place',p.place,'starts_at',p.starts_at,'created_at',p.created_at)
    into item from public.social_plans p where p.id = plan_id;
  select coalesce(jsonb_agg(r.minutes_before order by r.minutes_before),'[]'::jsonb) into offsets
    from public.plan_reminders r where r.plan_id = plan_calendar_snapshot.plan_id;
  return jsonb_build_object('plan',item,'reminder_minutes',case when item is null then '[]'::jsonb else offsets end);
end;
$$;
revoke all on function yeto_private.set_plan_reminders(uuid,integer[]),public.plan_reminders_snapshot(),
  public.set_plan_reminders(uuid,integer[]),public.plan_calendar_snapshot(uuid) from public,anon,authenticated,service_role;
grant execute on function yeto_private.set_plan_reminders(uuid,integer[]),public.plan_reminders_snapshot(),
  public.set_plan_reminders(uuid,integer[]),public.plan_calendar_snapshot(uuid) to authenticated;

-- Source references and personal settings are authoritative. Removing a setting
-- also removes its reminder event; old activity is untouched by this upgrade.
alter table public.activity_events add column reminder_minutes integer;
alter table public.activity_events add constraint activity_events_reminder_preference
  foreign key (plan_id,recipient_id,reminder_minutes)
  references public.plan_reminders(plan_id,user_id,minutes_before) on delete cascade;
do $$ declare constraint_name text;
begin
  for constraint_name in select c.conname from pg_constraint c
    where c.conrelid = 'public.activity_events'::regclass and c.contype = 'c'
      and (pg_get_constraintdef(c.oid) like '%kind%'
        or (pg_get_constraintdef(c.oid) like '%recipient_id%' and pg_get_constraintdef(c.oid) like '%actor_id%'))
  loop execute format('alter table public.activity_events drop constraint %I',constraint_name); end loop;
end; $$;
alter table public.activity_events add constraint activity_events_actor_check
  check (recipient_id <> actor_id or kind = 'plan_reminder');
alter table public.activity_events add constraint activity_events_kind_check
  check (kind in ('friend_request','friend_accepted','plan_invite','plan_rsvp','post_comment','post_like','poll_invite','plan_reminder'));
alter table public.activity_events add constraint activity_events_source_check check (
  (kind in ('friend_request','friend_accepted') and request_id is not null and post_id is null and plan_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null)
  or (kind = 'plan_invite' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null)
  or (kind = 'plan_rsvp' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is not null and poll_id is null and reminder_minutes is null)
  or (kind = 'post_comment' and post_id is not null and comment_id is not null and plan_id is null and request_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null)
  or (kind = 'post_like' and post_id is not null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null)
  or (kind = 'poll_invite' and poll_id is not null and post_id is null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and reminder_minutes is null)
  or (kind = 'plan_reminder' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is not null and reminder_minutes in (60,1440))
);
drop index public.activity_events_plan;
create unique index activity_events_plan on public.activity_events(recipient_id,kind,plan_id,actor_id)
  where plan_id is not null and kind <> 'plan_reminder';
create unique index activity_events_plan_reminder on public.activity_events(recipient_id,plan_id,reminder_minutes)
  where kind = 'plan_reminder';
create index activity_events_reminder_preference_lookup on public.activity_events(plan_id,recipient_id,reminder_minutes)
  where reminder_minutes is not null;

-- Keep ordinary RSVP upserts matched to the narrowed plan-activity index.
create or replace function yeto_private.capture_plan_rsvp_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare organizer uuid; target_plan uuid; responder uuid;
begin
  if tg_op = 'DELETE' then target_plan := old.plan_id; responder := old.user_id;
  else target_plan := new.plan_id; responder := new.user_id; end if;
  select p.owner_id into organizer from public.social_plans p where p.id = target_plan;
  if organizer is not null and organizer <> responder and exists (
    select 1 from public.social_plan_invites i where i.plan_id = target_plan and i.user_id = responder
  ) and exists (
    select 1 from public.friendships f where f.user_a = least(organizer,responder) and f.user_b = greatest(organizer,responder)
  ) and not exists (
    select 1 from public.blocks b where (b.blocker_id = organizer and b.blocked_id = responder)
      or (b.blocker_id = responder and b.blocked_id = organizer)
  ) then
    -- One current RSVP activity per invitee/plan, never a flood from toggling.
    -- Rotate the UUID for a new state so a delayed read of the previous state
    -- cannot accidentally mark this newer, unseen activity as read.
    insert into public.activity_events(recipient_id,actor_id,kind,plan_id,rsvp_going,created_at)
      values(organizer,responder,'plan_rsvp',target_plan,tg_op = 'INSERT',clock_timestamp())
      on conflict (recipient_id,kind,plan_id,actor_id) where plan_id is not null and kind <> 'plan_reminder' do update
        set id = excluded.id,rsvp_going = excluded.rsvp_going,created_at = excluded.created_at,read_at = null;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function yeto_private.capture_plan_rsvp_activity() from public,anon,authenticated,service_role;

create function yeto_private.prune_plan_reminders_after_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_reminders r where r.plan_id = old.plan_id and r.user_id = old.user_id;
  return old;
end;
$$;
create trigger prune_plan_reminders_after_invite after delete on public.social_plan_invites
  for each row execute function yeto_private.prune_plan_reminders_after_invite();
create function yeto_private.prune_plan_reminders_after_rsvp()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_reminders r where r.plan_id = old.plan_id and r.user_id = old.user_id;
  return old;
end;
$$;
create trigger prune_plan_reminders_after_rsvp after delete on public.social_plan_attendees
  for each row execute function yeto_private.prune_plan_reminders_after_rsvp();
create function yeto_private.prune_plan_reminders_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_reminders r using public.social_plans p where p.id = r.plan_id and (
    (p.owner_id = new.blocker_id and r.user_id = new.blocked_id)
    or (p.owner_id = new.blocked_id and r.user_id = new.blocker_id)
  );
  return new;
end;
$$;
create trigger prune_plan_reminders_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_plan_reminders_after_block();
revoke all on function yeto_private.prune_plan_reminders_after_invite(),
  yeto_private.prune_plan_reminders_after_rsvp(),yeto_private.prune_plan_reminders_after_block()
  from public,anon,authenticated,service_role;

-- Server-only dispatcher, invoked by the separately-installed Cron job. Freeze
-- a bounded batch and lock every involved profile in global UUID order BEFORE
-- taking any plan/preference lock; retaining several pair locks out of order
-- could deadlock with audience creation or relationship removal.
create function yeto_private.dispatch_plan_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare due jsonb; candidate record; plan public.social_plans%rowtype; preference public.plan_reminders%rowtype;
  inserted integer; dispatched integer := 0; checked_at timestamptz;
begin
  if not pg_try_advisory_xact_lock(6089203435220049::bigint) then return 0; end if;
  select coalesce(jsonb_agg(to_jsonb(batch)),'[]'::jsonb) into due from (
    select r.plan_id,r.user_id,r.minutes_before,p.owner_id
    from public.plan_reminders r join public.social_plans p on p.id = r.plan_id
    where r.notified_at is null and p.starts_at > now()
      and p.starts_at - make_interval(mins => r.minutes_before) <= now()
      and r.enabled_at <= p.starts_at - make_interval(mins => r.minutes_before)
    order by p.starts_at,r.plan_id,r.user_id,r.minutes_before limit 500
  ) batch;
  perform p.id from public.profiles p where p.id in (
    select x.user_id from jsonb_to_recordset(due) as x(user_id uuid)
    union select x.owner_id from jsonb_to_recordset(due) as x(owner_id uuid)
  ) order by p.id for update;
  for candidate in select * from jsonb_to_recordset(due)
    as x(plan_id uuid,user_id uuid,minutes_before integer,owner_id uuid)
    order by x.plan_id,x.user_id,x.minutes_before
  loop
    select p.* into plan from public.social_plans p where p.id = candidate.plan_id for update;
    if not found then continue; end if;
    select r.* into preference from public.plan_reminders r
      where r.plan_id = candidate.plan_id and r.user_id = candidate.user_id and r.minutes_before = candidate.minutes_before for update;
    if not found or preference.notified_at is not null then continue; end if;
    -- now() is fixed at transaction start. A profile or plan lock can wait
    -- across the start time, so decide delivery using the clock after locks.
    checked_at := clock_timestamp();
    if not (plan.owner_id = preference.user_id or (
      exists(select 1 from public.social_plan_invites i where i.plan_id = plan.id and i.user_id = preference.user_id)
      and exists(select 1 from public.friendships f
        where f.user_a = least(plan.owner_id,preference.user_id) and f.user_b = greatest(plan.owner_id,preference.user_id))
      and not exists(select 1 from public.blocks b where
        (b.blocker_id = plan.owner_id and b.blocked_id = preference.user_id)
        or (b.blocker_id = preference.user_id and b.blocked_id = plan.owner_id))
    )) then
      delete from public.plan_reminders r where r.plan_id = preference.plan_id and r.user_id = preference.user_id;
      continue;
    end if;
    if plan.starts_at > checked_at and plan.starts_at - make_interval(mins => preference.minutes_before) <= checked_at
      and preference.enabled_at <= plan.starts_at - make_interval(mins => preference.minutes_before) then
      insert into public.activity_events(recipient_id,actor_id,kind,plan_id,reminder_minutes,created_at)
        values(preference.user_id,plan.owner_id,'plan_reminder',plan.id,preference.minutes_before,checked_at) on conflict do nothing;
      get diagnostics inserted = row_count;
      update public.plan_reminders r set notified_at = checked_at
        where r.plan_id = preference.plan_id and r.user_id = preference.user_id and r.minutes_before = preference.minutes_before;
      dispatched := dispatched + inserted;
    end if;
  end loop;
  return dispatched;
end;
$$;
revoke all on function yeto_private.dispatch_plan_reminders() from public,anon,authenticated,service_role;

create or replace function yeto_private.can_read_activity(activity_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.activity_events e
    where e.id = activity_id and e.recipient_id = auth.uid()
      and not yeto_private.is_blocked_with(e.actor_id)
      and case e.kind
        when 'friend_request' then exists (
          select 1 from public.friend_requests r where r.id = e.request_id and r.status = 'pending'
            and r.requester_id = e.actor_id and r.recipient_id = auth.uid()
        )
        when 'friend_accepted' then yeto_private.social_friends_with(e.actor_id) and exists (
          select 1 from public.friend_requests r where r.id = e.request_id and r.status = 'accepted'
            and r.requester_id = auth.uid() and r.recipient_id = e.actor_id
        )
        when 'plan_invite' then yeto_private.social_friends_with(e.actor_id)
          and yeto_private.can_read_social_plan(e.plan_id) and exists (
            select 1 from public.social_plans p join public.social_plan_invites i on i.plan_id = p.id
            where p.id = e.plan_id and p.owner_id = e.actor_id and i.user_id = auth.uid()
          )
        when 'poll_invite' then yeto_private.social_friends_with(e.actor_id)
          and yeto_private.can_read_plan_poll(e.poll_id) and exists (
            select 1 from public.plan_polls p join public.plan_poll_invites i on i.poll_id = p.id
            where p.id = e.poll_id and p.owner_id = e.actor_id and i.user_id = auth.uid()
          )
        when 'plan_reminder' then yeto_private.can_read_social_plan(e.plan_id) and exists (
          select 1 from public.social_plans p
          join public.plan_reminders r on r.plan_id = p.id and r.user_id = auth.uid()
          where p.id = e.plan_id and p.owner_id = e.actor_id
            and r.minutes_before = e.reminder_minutes and r.notified_at is not null
        )
        when 'plan_rsvp' then yeto_private.social_friends_with(e.actor_id)
          and yeto_private.can_read_social_plan(e.plan_id) and exists (
            select 1 from public.social_plans p join public.social_plan_invites i on i.plan_id = p.id
            where p.id = e.plan_id and p.owner_id = auth.uid() and i.user_id = e.actor_id
          )
        when 'post_comment' then yeto_private.social_friends_with(e.actor_id)
          and yeto_private.can_read_social_post(e.post_id) and exists (
            select 1 from public.social_posts p
            join public.social_post_comments c on c.post_id = p.id
            join public.social_post_audience a on a.post_id = p.id and a.user_id = e.actor_id
            where p.id = e.post_id and p.author_id = auth.uid() and c.id = e.comment_id and c.author_id = e.actor_id
          )
        when 'post_like' then yeto_private.social_friends_with(e.actor_id)
          and yeto_private.can_read_social_post(e.post_id) and exists (
            select 1 from public.social_posts p
            join public.social_post_likes l on l.post_id = p.id and l.user_id = e.actor_id
            join public.social_post_audience a on a.post_id = p.id and a.user_id = e.actor_id
            where p.id = e.post_id and p.author_id = auth.uid()
          )
        else false
      end
  );
$$;

create or replace function public.activity_inbox_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind,
        'actor', jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name),
        'created_at', e.created_at, 'read_at', e.read_at,
        'post_id', e.post_id, 'plan_id', e.plan_id, 'request_id', e.request_id,
        'comment_id', e.comment_id, 'plan_title', sp.title, 'rsvp_going', e.rsvp_going,
        'poll_id', e.poll_id, 'poll_title', pp.title,
        'reminder_minutes', e.reminder_minutes, 'plan_starts_at', sp.starts_at
      ) order by e.created_at desc,e.id desc)
      from (select * from public.activity_events order by created_at desc,id desc limit 100) e
      join public.profiles p on p.id = e.actor_id
      left join public.social_plans sp on sp.id = e.plan_id
      left join public.plan_polls pp on pp.id = e.poll_id
    ),'[]'::jsonb),
    -- Count the same bounded window that the user can review and acknowledge;
    -- older activity must not leave an impossible-to-clear unread badge.
    'unread_count', (select count(*) from (
      select read_at from public.activity_events order by created_at desc,id desc limit 100
    ) shown where read_at is null)
  ) into result;
  return result;
end;
$$;

revoke all on function yeto_private.can_read_activity(uuid),public.activity_inbox_snapshot() from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_activity(uuid),public.activity_inbox_snapshot() to authenticated;

comment on table public.plan_reminders is 'Personal optional plan reminders. Each account chooses one-day and/or one-hour alerts; access revocation and opting out permanently remove reminders and linked activity.';
notify pgrst, 'reload schema';
commit;
