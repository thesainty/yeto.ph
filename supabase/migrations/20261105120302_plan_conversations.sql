-- TARA: private conversations for an existing plan's selected people.
-- Apply once after calendar/reminders; existing setup and saved data stay intact.
begin;

create table public.plan_messages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.social_plans(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000
    and body = btrim(body,E' \n') and body ~ '[^[:space:]]'
    and translate(body,E'\n','') !~ '[[:cntrl:]]'),
  client_nonce uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (plan_id,author_id,client_nonce)
);
create table public.plan_message_audience (
  message_id uuid not null references public.plan_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id,user_id)
);
create table public.plan_message_reads (
  message_id uuid not null references public.plan_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default clock_timestamp(),
  primary key (message_id,user_id)
);
create index plan_messages_plan_time on public.plan_messages(plan_id,created_at desc,id desc);
create index plan_messages_author on public.plan_messages(author_id,plan_id,id);
create index plan_message_audience_user on public.plan_message_audience(user_id,message_id);
create index plan_message_reads_user on public.plan_message_reads(user_id,message_id);

-- A plan invitation alone never opens a message published before that person
-- was selected. The explicit message grant must still exist on every read.
create function yeto_private.can_read_plan_message(message_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.plan_messages m where m.id = message_id
      and yeto_private.can_read_social_plan(m.plan_id)
      and not yeto_private.is_blocked_with(m.author_id)
      and (m.author_id = auth.uid() or exists (
        select 1 from public.plan_message_audience a where a.message_id = m.id and a.user_id = auth.uid()
      ))
  );
$$;
revoke all on function yeto_private.can_read_plan_message(uuid) from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_plan_message(uuid) to authenticated;
alter table public.plan_messages enable row level security;
alter table public.plan_message_audience enable row level security;
alter table public.plan_message_reads enable row level security;
create policy plan_messages_read on public.plan_messages for select to authenticated
  using (yeto_private.can_read_plan_message(id));
create policy plan_message_audience_read on public.plan_message_audience for select to authenticated
  using (user_id = (select auth.uid()) and yeto_private.can_read_plan_message(message_id));
create policy plan_message_reads_read on public.plan_message_reads for select to authenticated
  using (user_id = (select auth.uid()) and yeto_private.can_read_plan_message(message_id));
revoke all on public.plan_messages,public.plan_message_audience,public.plan_message_reads from public,anon,authenticated,service_role;
grant select on public.plan_messages,public.plan_message_audience,public.plan_message_reads to authenticated;

create function public.plan_conversations_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return jsonb_build_object('conversations',coalesce((
    select jsonb_agg(jsonb_build_object('plan_id',g.plan_id,'unread_count',g.unread_count) order by g.plan_id)
    from (
      select m.plan_id,count(*) filter(where m.author_id <> auth.uid() and not exists (
        select 1 from public.plan_message_reads r where r.message_id = m.id and r.user_id = auth.uid()
      ))::integer as unread_count
      from public.plan_messages m group by m.plan_id
    ) g
  ),'[]'::jsonb));
end;
$$;
create function public.plan_conversation_snapshot(plan_id uuid,before_created_at timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare items jsonb; more boolean; unread integer; cursor jsonb := null;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not yeto_private.can_read_social_plan(plan_id) then raise exception 'This conversation is unavailable.' using errcode = '42501'; end if;
  if (before_created_at is null) <> (before_id is null) or (before_created_at is not null and not isfinite(before_created_at)) then
    raise exception 'Choose a valid earlier-message cursor.' using errcode = '22023';
  end if;
  select count(*) > 50 into more from (
    select m.id from public.plan_messages m where m.plan_id = plan_conversation_snapshot.plan_id
      and (before_created_at is null or (m.created_at,m.id) < (before_created_at,before_id))
    order by m.created_at desc,m.id desc limit 51
  ) page;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'body',m.body,'created_at',m.created_at,
    'author',jsonb_build_object('id',a.id,'username',a.username,'display_name',a.display_name)) order by m.created_at,m.id),'[]'::jsonb)
    into items from (
      select * from public.plan_messages m where m.plan_id = plan_conversation_snapshot.plan_id
        and (before_created_at is null or (m.created_at,m.id) < (before_created_at,before_id))
      order by m.created_at desc,m.id desc limit 50
    ) m join public.profiles a on a.id = m.author_id;
  select count(*)::integer into unread from public.plan_messages m
    where m.plan_id = plan_conversation_snapshot.plan_id and m.author_id <> auth.uid()
      and not exists(select 1 from public.plan_message_reads r where r.message_id = m.id and r.user_id = auth.uid());
  if more then cursor := jsonb_build_object('created_at',items->0->'created_at','id',items->0->'id'); end if;
  return jsonb_build_object('plan_id',plan_id,'messages',items,'unread_count',unread,'has_more',more,'next_before',cursor);
end;
$$;

-- Every mutation acquires every current participant's profile in global UUID
-- order before taking the plan row, matching remove/block and audience writes.
create function yeto_private.lock_plan_conversation(plan_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare organizer uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select p.owner_id into organizer from public.social_plans p where p.id = plan_id;
  if organizer is null then raise exception 'This conversation is unavailable.' using errcode = '42501'; end if;
  perform p.id from public.profiles p where p.id = auth.uid() or p.id = organizer or p.id in (
    select i.user_id from public.social_plan_invites i where i.plan_id = lock_plan_conversation.plan_id
  ) order by p.id for update;
  perform p.id from public.social_plans p where p.id = plan_id for update;
  if not yeto_private.can_read_social_plan(plan_id) then
    raise exception 'This conversation is unavailable.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function yeto_private.lock_plan_conversation(uuid) from public,anon,authenticated,service_role;

-- Notifications refer to the current message; they never store its contents.
alter table public.activity_events add column message_id uuid references public.plan_messages(id) on delete cascade;
create index activity_events_message on public.activity_events(message_id) where message_id is not null;
do $$ declare constraint_name text;
begin
  for constraint_name in select c.conname from pg_constraint c
    where c.conrelid = 'public.activity_events'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%kind%'
  loop execute format('alter table public.activity_events drop constraint %I',constraint_name); end loop;
end; $$;
alter table public.activity_events add constraint activity_events_actor_check
  check (recipient_id <> actor_id or kind = 'plan_reminder');
alter table public.activity_events add constraint activity_events_kind_check
  check (kind in ('friend_request','friend_accepted','plan_invite','plan_rsvp','post_comment','post_like','poll_invite','plan_reminder','plan_message'));
alter table public.activity_events add constraint activity_events_source_check check (
  (kind in ('friend_request','friend_accepted') and request_id is not null and post_id is null and plan_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null)
  or (kind = 'plan_invite' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null)
  or (kind = 'plan_rsvp' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is not null and poll_id is null and reminder_minutes is null and message_id is null)
  or (kind = 'post_comment' and post_id is not null and comment_id is not null and plan_id is null and request_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null)
  or (kind = 'post_like' and post_id is not null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null)
  or (kind = 'poll_invite' and poll_id is not null and post_id is null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and reminder_minutes is null and message_id is null)
  or (kind = 'plan_reminder' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is not null and reminder_minutes in (60,1440) and message_id is null)
  or (kind = 'plan_message' and plan_id is not null and message_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null)
);
drop index public.activity_events_plan;
create unique index activity_events_plan on public.activity_events(recipient_id,kind,plan_id,actor_id)
  where plan_id is not null and kind not in ('plan_reminder','plan_message');
create unique index activity_events_conversation on public.activity_events(recipient_id,plan_id) where kind = 'plan_message';

create function yeto_private.send_plan_message(target_plan_id uuid,body_text text,client_nonce uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare organizer uuid; normalized text; saved public.plan_messages%rowtype; message_uuid uuid;
begin
  perform yeto_private.lock_plan_conversation(target_plan_id);
  normalized := btrim(replace(replace(body_text,E'\r\n',E'\n'),E'\r',E'\n'),E' \n');
  if client_nonce is null or normalized is null or char_length(normalized) not between 1 and 1000
    or normalized !~ '[^[:space:]]' or translate(normalized,E'\n','') ~ '[[:cntrl:]]' then
    raise exception 'Write a message of 1–1000 characters.' using errcode = '22023';
  end if;
  select m.* into saved from public.plan_messages m where m.plan_id = target_plan_id
    and m.author_id = auth.uid() and m.client_nonce = send_plan_message.client_nonce;
  if found then
    if saved.body <> normalized then raise exception 'A message retry must use the original contents.' using errcode = '22023'; end if;
    return saved.id;
  end if;
  select p.owner_id into organizer from public.social_plans p where p.id = target_plan_id;
  insert into public.plan_messages(plan_id,author_id,body,client_nonce)
    values(target_plan_id,auth.uid(),normalized,client_nonce) returning id into message_uuid;
  insert into public.plan_message_audience(message_id,user_id)
    select message_uuid,p.id from public.profiles p where p.id <> auth.uid()
      and not yeto_private.is_blocked_with(p.id)
      and (p.id = organizer or exists (
        select 1 from public.social_plan_invites i where i.plan_id = target_plan_id and i.user_id = p.id
          and exists(select 1 from public.friendships f where f.user_a = least(organizer,p.id) and f.user_b = greatest(organizer,p.id))
          and not exists(select 1 from public.blocks b where
            (b.blocker_id = organizer and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = organizer))
      ));
  insert into public.activity_events(recipient_id,actor_id,kind,plan_id,message_id,created_at)
    select a.user_id,auth.uid(),'plan_message',target_plan_id,message_uuid,clock_timestamp()
    from public.plan_message_audience a where a.message_id = message_uuid
    on conflict (recipient_id,plan_id) where kind = 'plan_message' do update
      set id = excluded.id,actor_id = excluded.actor_id,message_id = excluded.message_id,
          created_at = excluded.created_at,read_at = null;
  return message_uuid;
end;
$$;
create function yeto_private.delete_plan_message(message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_plan uuid;
begin
  select m.plan_id into target_plan from public.plan_messages m where m.id = message_id;
  if target_plan is null then raise exception 'This message is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_plan_conversation(target_plan);
  perform m.id from public.plan_messages m where m.id = message_id for update;
  if not exists(select 1 from public.plan_messages m where m.id = message_id and m.author_id = auth.uid())
    or not yeto_private.can_read_plan_message(message_id) then
    raise exception 'Only the author can delete this message.' using errcode = '42501';
  end if;
  delete from public.plan_messages m where m.id = message_id;
end;
$$;
create function yeto_private.mark_plan_messages_read(plan_id uuid,message_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare selected uuid[] := coalesce(message_ids,'{}'::uuid[]);
begin
  perform yeto_private.lock_plan_conversation(plan_id);
  if cardinality(selected) > 100 or array_ndims(selected) > 1 then raise exception 'Mark up to 100 messages at a time.' using errcode = '22023'; end if;
  if array_position(selected,null) is not null then raise exception 'Choose valid messages.' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct value),'{}'::uuid[]) into selected from unnest(selected) value;
  if exists(select 1 from unnest(selected) value where not exists (
    select 1 from public.plan_messages m where m.id = value and m.plan_id = mark_plan_messages_read.plan_id
      and yeto_private.can_read_plan_message(m.id)
  )) then raise exception 'These messages are unavailable.' using errcode = '42501'; end if;
  insert into public.plan_message_reads(message_id,user_id)
    select m.id,auth.uid() from public.plan_messages m where m.id = any(selected) and m.author_id <> auth.uid()
    on conflict do nothing;
  update public.activity_events e set read_at = coalesce(e.read_at,clock_timestamp())
    where e.kind = 'plan_message' and e.plan_id = mark_plan_messages_read.plan_id
      and e.recipient_id = auth.uid() and e.message_id = any(selected);
end;
$$;

create function public.send_plan_message(plan_id uuid,body_text text,client_nonce uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select yeto_private.send_plan_message(plan_id,body_text,client_nonce);
$$;
create function public.delete_plan_message(message_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select yeto_private.delete_plan_message(message_id);
$$;
create function public.mark_plan_messages_read(plan_id uuid,message_ids uuid[])
returns void language sql security invoker set search_path = '' as $$
  select yeto_private.mark_plan_messages_read(plan_id,message_ids);
$$;
revoke all on function yeto_private.send_plan_message(uuid,text,uuid),yeto_private.delete_plan_message(uuid),
  yeto_private.mark_plan_messages_read(uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function yeto_private.send_plan_message(uuid,text,uuid),yeto_private.delete_plan_message(uuid),
  yeto_private.mark_plan_messages_read(uuid,uuid[]) to authenticated;
revoke all on function public.plan_conversations_snapshot(),public.plan_conversation_snapshot(uuid,timestamptz,uuid),
  public.send_plan_message(uuid,text,uuid),public.delete_plan_message(uuid),public.mark_plan_messages_read(uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.plan_conversations_snapshot(),public.plan_conversation_snapshot(uuid,timestamptz,uuid),
  public.send_plan_message(uuid,text,uuid),public.delete_plan_message(uuid),public.mark_plan_messages_read(uuid,uuid[]) to authenticated;

-- A removed snapshot grant can never be reconstructed from a later friendship.
create function yeto_private.prune_plan_message_grant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_message_reads r where r.message_id = old.message_id and r.user_id = old.user_id;
  delete from public.activity_events e where e.kind = 'plan_message' and e.message_id = old.message_id and e.recipient_id = old.user_id;
  return old;
end;
$$;
create trigger prune_plan_message_grant after delete on public.plan_message_audience
  for each row execute function yeto_private.prune_plan_message_grant();
create function yeto_private.prune_plan_conversation_after_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.activity_events e where e.kind = 'plan_message' and e.plan_id = old.plan_id and e.recipient_id = old.user_id;
  delete from public.plan_message_reads r using public.plan_messages m
    where m.id = r.message_id and m.plan_id = old.plan_id and r.user_id = old.user_id;
  delete from public.plan_message_audience a using public.plan_messages m
    where m.id = a.message_id and m.plan_id = old.plan_id and a.user_id = old.user_id;
  delete from public.plan_messages m where m.plan_id = old.plan_id and m.author_id = old.user_id;
  return old;
end;
$$;
create trigger prune_plan_conversation_after_invite after delete on public.social_plan_invites
  for each row execute function yeto_private.prune_plan_conversation_after_invite();
create function yeto_private.prune_plan_conversation_after_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.plan_message_audience a using public.plan_messages m where m.id = a.message_id
    and ((m.author_id = old.user_a and a.user_id = old.user_b) or (m.author_id = old.user_b and a.user_id = old.user_a));
  return old;
end;
$$;
create trigger prune_plan_conversation_after_friendship after delete on public.friendships
  for each row execute function yeto_private.prune_plan_conversation_after_friendship();
create function yeto_private.prune_plan_conversation_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Direct block insertion also revokes host/guest membership before ordinary
  -- relationship cleanup; guest-to-guest blocks only remove their pair grants.
  delete from public.activity_events e using public.social_plans p
    where e.kind = 'plan_message' and e.plan_id = p.id and (
      (p.owner_id = new.blocker_id and e.recipient_id = new.blocked_id)
      or (p.owner_id = new.blocked_id and e.recipient_id = new.blocker_id));
  delete from public.plan_message_audience a using public.plan_messages m,public.social_plans p
    where m.id = a.message_id and p.id = m.plan_id and (
      (m.author_id = new.blocker_id and a.user_id = new.blocked_id)
      or (m.author_id = new.blocked_id and a.user_id = new.blocker_id)
      or (p.owner_id = new.blocker_id and a.user_id = new.blocked_id)
      or (p.owner_id = new.blocked_id and a.user_id = new.blocker_id));
  delete from public.plan_message_reads r using public.plan_messages m,public.social_plans p
    where m.id = r.message_id and p.id = m.plan_id and (
      (p.owner_id = new.blocker_id and r.user_id = new.blocked_id)
      or (p.owner_id = new.blocked_id and r.user_id = new.blocker_id));
  delete from public.plan_messages m using public.social_plans p where p.id = m.plan_id and (
    (p.owner_id = new.blocker_id and m.author_id = new.blocked_id)
    or (p.owner_id = new.blocked_id and m.author_id = new.blocker_id));
  return new;
end;
$$;
create trigger prune_plan_conversation_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_plan_conversation_after_block();
revoke all on function yeto_private.prune_plan_message_grant(),yeto_private.prune_plan_conversation_after_invite(),
  yeto_private.prune_plan_conversation_after_friendship(),yeto_private.prune_plan_conversation_after_block()
  from public,anon,authenticated,service_role;
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
      on conflict (recipient_id,kind,plan_id,actor_id) where plan_id is not null and kind not in ('plan_reminder','plan_message') do update
        set id = excluded.id,rsvp_going = excluded.rsvp_going,created_at = excluded.created_at,read_at = null;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

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
        when 'plan_message' then yeto_private.can_read_plan_message(e.message_id) and exists (
          select 1 from public.plan_messages m where m.id = e.message_id
            and m.plan_id = e.plan_id and m.author_id = e.actor_id
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
        'reminder_minutes', e.reminder_minutes, 'plan_starts_at', sp.starts_at, 'message_id', e.message_id
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

revoke all on function yeto_private.capture_plan_rsvp_activity(),yeto_private.can_read_activity(uuid),public.activity_inbox_snapshot()
  from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_activity(uuid),public.activity_inbox_snapshot() to authenticated;

comment on table public.plan_messages is 'Private plan text conversations with explicit recipient snapshots and idempotent client nonces. Removing or blocking a participant permanently prunes old access.';
comment on table public.plan_message_reads is 'Personal exact-message read markers. Other participants cannot read these markers.';
notify pgrst, 'reload schema';
commit;
