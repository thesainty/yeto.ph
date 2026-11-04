-- TARA: additive private availability polls. Apply once after saved circles and
-- activity inbox. Existing setup, accounts, social audiences and settings stay intact.
begin;

create table public.plan_polls (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 70 and title = btrim(title) and title ~ '[^[:space:]]' and title !~ '[[:cntrl:]]'),
  place text not null check (char_length(place) between 1 and 90 and place = btrim(place) and place ~ '[^[:space:]]' and place !~ '[[:cntrl:]]'),
  kind text not null check (kind in ('coffee','food','trip')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  plan_id uuid references public.social_plans(id) on delete set null,
  check (plan_id is null or closed_at is not null)
);
create table public.plan_poll_invites (
  poll_id uuid not null references public.plan_polls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (poll_id,user_id)
);
create table public.plan_poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.plan_polls(id) on delete cascade,
  starts_at timestamptz not null check (isfinite(starts_at)),
  unique (poll_id,starts_at),
  unique (poll_id,id)
);
create table public.plan_poll_votes (
  poll_id uuid not null references public.plan_polls(id) on delete cascade,
  option_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (poll_id,option_id,user_id),
  foreign key (poll_id,option_id) references public.plan_poll_options(poll_id,id) on delete cascade
);
create index plan_polls_time on public.plan_polls(created_at desc,id desc);
create index plan_polls_owner_time on public.plan_polls(owner_id,created_at desc,id desc);
create index plan_poll_invites_user on public.plan_poll_invites(user_id,poll_id);
create index plan_poll_votes_user on public.plan_poll_votes(user_id,poll_id);
create index plan_polls_plan on public.plan_polls(plan_id) where plan_id is not null;

create function yeto_private.can_read_plan_poll(poll_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.plan_polls p where p.id = poll_id and (
      p.owner_id = auth.uid() or (
        yeto_private.social_friends_with(p.owner_id)
        and exists (select 1 from public.plan_poll_invites i where i.poll_id = p.id and i.user_id = auth.uid())
      )
    )
  );
$$;
revoke all on function yeto_private.can_read_plan_poll(uuid) from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_plan_poll(uuid) to authenticated;

alter table public.plan_polls enable row level security;
alter table public.plan_poll_invites enable row level security;
alter table public.plan_poll_options enable row level security;
alter table public.plan_poll_votes enable row level security;
create policy plan_polls_read on public.plan_polls for select to authenticated
  using (yeto_private.can_read_plan_poll(id));
create policy plan_poll_invites_read on public.plan_poll_invites for select to authenticated
  using (yeto_private.can_read_plan_poll(poll_id) and not yeto_private.is_blocked_with(user_id));
create policy plan_poll_options_read on public.plan_poll_options for select to authenticated
  using (yeto_private.can_read_plan_poll(poll_id));
create policy plan_poll_votes_read on public.plan_poll_votes for select to authenticated
  using (yeto_private.can_read_plan_poll(poll_id) and not yeto_private.is_blocked_with(user_id));
revoke all on public.plan_polls,public.plan_poll_invites,public.plan_poll_options,public.plan_poll_votes
  from public,anon,authenticated,service_role;
grant select on public.plan_polls,public.plan_poll_invites,public.plan_poll_options,public.plan_poll_votes to authenticated;

-- Read serialization stays under the caller's RLS. Blocked participants do not
-- leak through invitee profiles or vote totals; no voter-name payload is copied.
create function yeto_private.plan_poll_json(poll_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',p.id,'owner',jsonb_build_object('id',owner.id,'username',owner.username,'display_name',owner.display_name),
    'title',p.title,'place',p.place,'kind',p.kind,'created_at',p.created_at,
    'closed_at',p.closed_at,'plan_id',p.plan_id,
    'invitees',coalesce((
      select jsonb_agg(jsonb_build_object('id',ip.id,'username',ip.username,'display_name',ip.display_name) order by ip.username,ip.id)
      from public.plan_poll_invites i join public.profiles ip on ip.id = i.user_id where i.poll_id = p.id
    ),'[]'::jsonb),
    'options',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',o.id,'starts_at',o.starts_at,
        'vote_count',(select count(*) from public.plan_poll_votes v where v.poll_id = p.id and v.option_id = o.id),
        'voted_by_me',exists(select 1 from public.plan_poll_votes v where v.poll_id = p.id and v.option_id = o.id and v.user_id = auth.uid())
      ) order by o.starts_at,o.id)
      from public.plan_poll_options o where o.poll_id = p.id
    ),'[]'::jsonb)
  ) from public.plan_polls p join public.profiles owner on owner.id = p.owner_id where p.id = poll_id;
$$;
revoke all on function yeto_private.plan_poll_json(uuid) from public,anon,authenticated,service_role;
grant execute on function yeto_private.plan_poll_json(uuid) to authenticated;

create function public.plan_polls_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return jsonb_build_object('polls',coalesce((
    select jsonb_agg(yeto_private.plan_poll_json(p.id) order by p.created_at desc,p.id desc)
    from (select id,created_at from public.plan_polls order by created_at desc,id desc limit 100) p
  ),'[]'::jsonb));
end;
$$;
create function public.plan_poll_target_snapshot(poll_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare item jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if poll_id is null then raise exception 'Choose a poll.' using errcode = '22023'; end if;
  item := yeto_private.plan_poll_json(poll_id);
  return jsonb_build_object('polls',case when item is null then '[]'::jsonb else jsonb_build_array(item) end);
end;
$$;

-- Every mutation locks profiles before poll rows, in the same UUID order used
-- by account remove/block. A relationship change cannot race a fresh grant.
create function yeto_private.lock_plan_poll(poll_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare organizer uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select p.owner_id into organizer from public.plan_polls p where p.id = poll_id;
  if organizer is null then raise exception 'This poll is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_pair(auth.uid(),organizer);
  perform p.id from public.plan_polls p where p.id = poll_id for update;
  if not yeto_private.can_read_plan_poll(poll_id) then
    raise exception 'This poll is unavailable.' using errcode = '42501';
  end if;
end;
$$;

create function yeto_private.create_plan_poll(poll_title text,poll_place text,poll_kind text,option_times timestamptz[],invitee_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare selected uuid[]; poll_uuid uuid; option_time timestamptz;
begin
  selected := yeto_private.check_social_viewers(invitee_ids);
  if poll_title is null or char_length(btrim(poll_title)) not between 1 and 70 or poll_title !~ '[^[:space:]]' or poll_title ~ '[[:cntrl:]]'
    or poll_place is null or char_length(btrim(poll_place)) not between 1 and 90 or poll_place !~ '[^[:space:]]' or poll_place ~ '[[:cntrl:]]'
    or poll_kind is null or poll_kind not in ('coffee','food','trip') then
    raise exception 'Choose a title, place, and plan type.' using errcode = '22023';
  end if;
  if coalesce(cardinality(option_times),0) not between 2 and 5 or array_ndims(option_times) > 1 then
    raise exception 'Choose 2–5 different future times.' using errcode = '22023';
  end if;
  if array_position(option_times,null) is not null
    or (select count(distinct value) from unnest(option_times) value) <> cardinality(option_times) then
    raise exception 'Choose 2–5 different future times.' using errcode = '22023';
  end if;
  foreach option_time in array option_times loop
    if not isfinite(option_time) or option_time <= now() then
      raise exception 'Choose 2–5 different future times.' using errcode = '22023';
    end if;
  end loop;
  insert into public.plan_polls(owner_id,title,place,kind)
    values(auth.uid(),btrim(poll_title),btrim(poll_place),poll_kind) returning id into poll_uuid;
  insert into public.plan_poll_options(poll_id,starts_at) select poll_uuid,unnest(option_times);
  insert into public.plan_poll_invites(poll_id,user_id) select poll_uuid,unnest(selected);
  return poll_uuid;
end;
$$;

create function yeto_private.set_plan_poll_votes(poll_id uuid,option_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare selected uuid[] := coalesce(option_ids,'{}'::uuid[]);
begin
  perform yeto_private.lock_plan_poll(poll_id);
  if exists(select 1 from public.plan_polls p where p.id = poll_id and p.closed_at is not null) then
    raise exception 'This poll is closed.' using errcode = '22023';
  end if;
  if cardinality(selected) > 5 or array_ndims(selected) > 1 then
    raise exception 'Choose only times from this poll.' using errcode = '22023';
  end if;
  if array_position(selected,null) is not null then
    raise exception 'Choose only times from this poll.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct value),'{}'::uuid[]) into selected from unnest(selected) value;
  if exists(select 1 from unnest(selected) value where not exists(
    select 1 from public.plan_poll_options o where o.id = value and o.poll_id = set_plan_poll_votes.poll_id and o.starts_at > now()
  )) then
    raise exception 'Choose only future times from this poll.' using errcode = '22023';
  end if;
  delete from public.plan_poll_votes v where v.poll_id = set_plan_poll_votes.poll_id and v.user_id = auth.uid();
  insert into public.plan_poll_votes(poll_id,option_id,user_id) select set_plan_poll_votes.poll_id,unnest(selected),auth.uid();
end;
$$;

create function yeto_private.convert_plan_poll(poll_id uuid,option_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); original public.plan_polls%rowtype; selected uuid[]; starts timestamptz; saved_plan uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not exists(select 1 from public.plan_polls p where p.id = poll_id and p.owner_id = actor) then
    raise exception 'Only the organizer can make this plan.' using errcode = '42501';
  end if;
  -- Include the full fixed audience before locking the poll. No later call may
  -- acquire a lower profile lock while holding a poll lock.
  perform p.id from public.profiles p where p.id = actor or p.id in (
    select i.user_id from public.plan_poll_invites i where i.poll_id = convert_plan_poll.poll_id
  ) order by p.id for update;
  select p.* into original from public.plan_polls p where p.id = poll_id and p.owner_id = actor for update;
  if not found then raise exception 'This poll is unavailable.' using errcode = '42501'; end if;
  select o.starts_at into starts from public.plan_poll_options o
    where o.poll_id = convert_plan_poll.poll_id and o.id = option_id;
  if starts is null then raise exception 'Choose a time from this poll.' using errcode = '22023'; end if;
  -- Retrying a successful conversion cannot create a duplicate plan. Deleting
  -- that plan clears only plan_id; closed_at deliberately prevents reopening.
  if original.plan_id is not null then return original.plan_id; end if;
  if original.closed_at is not null then raise exception 'This poll is closed.' using errcode = '22023'; end if;
  if starts <= now() then raise exception 'Choose a future time.' using errcode = '22023'; end if;
  select coalesce(array_agg(i.user_id order by i.user_id),'{}'::uuid[]) into selected
    from public.plan_poll_invites i where i.poll_id = convert_plan_poll.poll_id and yeto_private.social_friends_with(i.user_id);
  -- Reuse existing plan validation, invitation notifications and host attendance.
  -- Voting is availability only: invitees must still RSVP to the resulting plan.
  saved_plan := public.create_social_plan(original.title,original.place,starts,original.kind,selected);
  update public.plan_polls p set closed_at = now(),plan_id = saved_plan where p.id = convert_plan_poll.poll_id;
  return saved_plan;
end;
$$;

create function yeto_private.delete_plan_poll(poll_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform yeto_private.lock_plan_poll(poll_id);
  if not exists(select 1 from public.plan_polls p where p.id = poll_id and p.owner_id = auth.uid()) then
    raise exception 'Only the organizer can delete this poll.' using errcode = '42501';
  end if;
  delete from public.plan_polls p where p.id = poll_id;
end;
$$;

-- Public entry points run as the caller. Privileged writes live only in the
-- non-exposed private schema, bind ownership to auth.uid(), and have fixed paths.
create function public.create_plan_poll(poll_title text,poll_place text,poll_kind text,option_times timestamptz[],invitee_ids uuid[])
returns uuid language sql security invoker set search_path = '' as $$
  select yeto_private.create_plan_poll(poll_title,poll_place,poll_kind,option_times,invitee_ids);
$$;
create function public.set_plan_poll_votes(poll_id uuid,option_ids uuid[])
returns void language sql security invoker set search_path = '' as $$
  select yeto_private.set_plan_poll_votes(poll_id,option_ids);
$$;
create function public.convert_plan_poll(poll_id uuid,option_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select yeto_private.convert_plan_poll(poll_id,option_id);
$$;
create function public.delete_plan_poll(poll_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select yeto_private.delete_plan_poll(poll_id);
$$;
revoke all on function yeto_private.create_plan_poll(text,text,text,timestamptz[],uuid[]),
  yeto_private.set_plan_poll_votes(uuid,uuid[]),yeto_private.convert_plan_poll(uuid,uuid),yeto_private.delete_plan_poll(uuid)
  from public,anon,authenticated,service_role;
grant execute on function yeto_private.create_plan_poll(text,text,text,timestamptz[],uuid[]),
  yeto_private.set_plan_poll_votes(uuid,uuid[]),yeto_private.convert_plan_poll(uuid,uuid),yeto_private.delete_plan_poll(uuid) to authenticated;

-- Preserve existing inbox rows and their read state. Extend only the two
-- kind/source checks; the recipient<>actor constraint remains untouched.
alter table public.activity_events add column poll_id uuid references public.plan_polls(id) on delete cascade;
do $$ declare constraint_name text;
begin
  for constraint_name in select c.conname from pg_constraint c
    where c.conrelid = 'public.activity_events'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%kind%'
  loop execute format('alter table public.activity_events drop constraint %I',constraint_name); end loop;
end; $$;
alter table public.activity_events add constraint activity_events_kind_check
  check (kind in ('friend_request','friend_accepted','plan_invite','plan_rsvp','post_comment','post_like','poll_invite'));
alter table public.activity_events add constraint activity_events_source_check check (
  (kind in ('friend_request','friend_accepted') and request_id is not null and post_id is null and plan_id is null and comment_id is null and rsvp_going is null and poll_id is null)
  or (kind = 'plan_invite' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null)
  or (kind = 'plan_rsvp' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is not null and poll_id is null)
  or (kind = 'post_comment' and post_id is not null and comment_id is not null and plan_id is null and request_id is null and rsvp_going is null and poll_id is null)
  or (kind = 'post_like' and post_id is not null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null)
  or (kind = 'poll_invite' and poll_id is not null and post_id is null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null)
);
create index activity_events_poll on public.activity_events(poll_id) where poll_id is not null;
create unique index activity_events_poll_invite on public.activity_events(recipient_id,poll_id) where kind = 'poll_invite';

create function yeto_private.capture_poll_invite_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare organizer uuid; happened_at timestamptz;
begin
  select p.owner_id,p.created_at into organizer,happened_at from public.plan_polls p where p.id = new.poll_id;
  if organizer is not null and organizer <> new.user_id then
    insert into public.activity_events(recipient_id,actor_id,kind,poll_id,created_at)
      values(new.user_id,organizer,'poll_invite',new.poll_id,happened_at) on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_activity_poll_invite after insert on public.plan_poll_invites
  for each row execute function yeto_private.capture_poll_invite_activity();

create function yeto_private.prune_deleted_poll_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_poll_votes v where v.poll_id = old.poll_id and v.user_id = old.user_id;
  delete from public.activity_events e where e.poll_id = old.poll_id and e.recipient_id = old.user_id;
  return old;
end;
$$;
create trigger prune_deleted_poll_invite after delete on public.plan_poll_invites
  for each row execute function yeto_private.prune_deleted_poll_invite();

create function yeto_private.prune_polls_after_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_poll_invites i using public.plan_polls p where p.id = i.poll_id and (
    (p.owner_id = old.user_a and i.user_id = old.user_b) or (p.owner_id = old.user_b and i.user_id = old.user_a)
  );
  return old;
end;
$$;
create trigger prune_polls_after_friendship after delete on public.friendships
  for each row execute function yeto_private.prune_polls_after_friendship();
create function yeto_private.prune_polls_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_poll_invites i using public.plan_polls p where p.id = i.poll_id and (
    (p.owner_id = new.blocker_id and i.user_id = new.blocked_id) or (p.owner_id = new.blocked_id and i.user_id = new.blocker_id)
  );
  return new;
end;
$$;
create trigger prune_polls_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_polls_after_block();

revoke all on function yeto_private.lock_plan_poll(uuid),yeto_private.capture_poll_invite_activity(),
  yeto_private.prune_deleted_poll_invite(),yeto_private.prune_polls_after_friendship(),yeto_private.prune_polls_after_block()
  from public,anon,authenticated,service_role;
revoke all on function public.plan_polls_snapshot(),public.plan_poll_target_snapshot(uuid),
  public.create_plan_poll(text,text,text,timestamptz[],uuid[]),public.set_plan_poll_votes(uuid,uuid[]),
  public.convert_plan_poll(uuid,uuid),public.delete_plan_poll(uuid) from public,anon,authenticated,service_role;
grant execute on function public.plan_polls_snapshot(),public.plan_poll_target_snapshot(uuid),
  public.create_plan_poll(text,text,text,timestamptz[],uuid[]),public.set_plan_poll_votes(uuid,uuid[]),
  public.convert_plan_poll(uuid,uuid),public.delete_plan_poll(uuid) to authenticated;

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
        'poll_id', e.poll_id, 'poll_title', pp.title
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

comment on table public.plan_polls is 'Private availability polls with immutable explicit invitations. Conversion snapshots the remaining original audience into a normal plan; votes never RSVP.';
comment on table public.plan_poll_votes is 'Availability choices bound to the calling account, visible only to the fixed poll audience with blocking filters.';
notify pgrst, 'reload schema';
commit;
