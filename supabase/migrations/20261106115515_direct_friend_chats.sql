-- TARA: private direct chats bound to one current friendship. Apply once after
-- plan conversations. No existing setup, accounts, content or settings are reset.
begin;

create table public.direct_chats (
  id uuid primary key default gen_random_uuid(),
  friendship_id uuid not null unique references public.friendships(id) on delete cascade,
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  check (user_a < user_b),
  unique (user_a,user_b)
);
create table public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.direct_chats(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000
    and body = btrim(body,E' \n') and body ~ '[^[:space:]]'
    and translate(body,E'\n','') !~ '[[:cntrl:]]'),
  client_nonce uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (chat_id,author_id,client_nonce)
);
create table public.direct_message_reads (
  message_id uuid not null references public.direct_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default clock_timestamp(),
  primary key (message_id,user_id)
);
create index direct_chats_user_a on public.direct_chats(user_a,created_at desc,id desc);
create index direct_chats_user_b on public.direct_chats(user_b,created_at desc,id desc);
create index direct_messages_chat_time on public.direct_messages(chat_id,created_at desc,id desc);
create index direct_messages_author on public.direct_messages(author_id,chat_id,id);
create index direct_message_reads_user on public.direct_message_reads(user_id,message_id);

-- A matching live friendship ID is mandatory. Re-friending cannot revive an
-- older thread, because deleting that friendship cascades its entire thread.
create function yeto_private.can_read_direct_chat(chat_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.direct_chats c join public.friendships f on f.id = c.friendship_id
      and f.user_a = c.user_a and f.user_b = c.user_b
    where c.id = chat_id and auth.uid() in (c.user_a,c.user_b)
      and not exists(select 1 from public.blocks b where
        (b.blocker_id = c.user_a and b.blocked_id = c.user_b)
        or (b.blocker_id = c.user_b and b.blocked_id = c.user_a))
  );
$$;
create function yeto_private.can_read_direct_message(message_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.direct_messages m join public.direct_chats c on c.id = m.chat_id
    where m.id = message_id and m.author_id in (c.user_a,c.user_b)
      and yeto_private.can_read_direct_chat(c.id)
  );
$$;
revoke all on function yeto_private.can_read_direct_chat(uuid),yeto_private.can_read_direct_message(uuid)
  from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_direct_chat(uuid),yeto_private.can_read_direct_message(uuid) to authenticated;
alter table public.direct_chats enable row level security;
alter table public.direct_messages enable row level security;
alter table public.direct_message_reads enable row level security;
create policy direct_chats_read on public.direct_chats for select to authenticated
  using ((select auth.uid()) in (user_a,user_b) and yeto_private.can_read_direct_chat(id));
create policy direct_messages_read on public.direct_messages for select to authenticated
  using (yeto_private.can_read_direct_message(id));
create policy direct_message_reads_read on public.direct_message_reads for select to authenticated
  using (user_id = (select auth.uid()) and yeto_private.can_read_direct_message(message_id));
revoke all on public.direct_chats,public.direct_messages,public.direct_message_reads from public,anon,authenticated,service_role;
grant select on public.direct_chats,public.direct_messages,public.direct_message_reads to authenticated;

create function public.direct_chats_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return jsonb_build_object('chats',coalesce((
    select jsonb_agg(jsonb_build_object('id',listed.id,'created_at',listed.created_at,
      'friend',jsonb_build_object('id',listed.friend_id,'username',listed.username,'display_name',listed.display_name),
      'last_message',case when listed.message_id is null then null else jsonb_build_object(
        'id',listed.message_id,'body',listed.body,'created_at',listed.message_time,'from_me',listed.author_id = auth.uid()) end,
      'unread_count',listed.unread_count) order by listed.sort_time desc,listed.id desc)
    from (
      select c.id,c.created_at,p.id as friend_id,p.username,p.display_name,
        latest.id as message_id,latest.body,latest.created_at as message_time,latest.author_id,
        coalesce(latest.created_at,c.created_at) as sort_time,
        (select count(*)::integer from public.direct_messages m where m.chat_id = c.id
          and m.author_id <> auth.uid() and not exists(select 1 from public.direct_message_reads r
            where r.message_id = m.id and r.user_id = auth.uid())) as unread_count
      from public.direct_chats c
      join public.profiles p on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
      left join lateral (select m.* from public.direct_messages m where m.chat_id = c.id
        order by m.created_at desc,m.id desc limit 1) latest on true
      where auth.uid() in (c.user_a,c.user_b)
      order by coalesce(latest.created_at,c.created_at) desc,c.id desc limit 100
    ) listed
  ),'[]'::jsonb));
end;
$$;

create function public.direct_chat_snapshot(chat_id uuid,before_created_at timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare details jsonb; items jsonb; more boolean; unread integer; cursor jsonb := null;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not yeto_private.can_read_direct_chat(chat_id) then raise exception 'This chat is unavailable.' using errcode = '42501'; end if;
  if (before_created_at is null) <> (before_id is null) or (before_created_at is not null and not isfinite(before_created_at)) then
    raise exception 'Choose a valid earlier-message cursor.' using errcode = '22023';
  end if;
  select jsonb_build_object('id',c.id,'created_at',c.created_at,
    'friend',jsonb_build_object('id',p.id,'username',p.username,'display_name',p.display_name)) into details
    from public.direct_chats c join public.profiles p on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
    where c.id = chat_id;
  select count(*) > 50 into more from (
    select m.id from public.direct_messages m where m.chat_id = direct_chat_snapshot.chat_id
      and (before_created_at is null or (m.created_at,m.id) < (before_created_at,before_id))
    order by m.created_at desc,m.id desc limit 51
  ) page;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'body',m.body,'created_at',m.created_at,
    'author',jsonb_build_object('id',p.id,'username',p.username,'display_name',p.display_name)) order by m.created_at,m.id),'[]'::jsonb)
    into items from (
      select * from public.direct_messages m where m.chat_id = direct_chat_snapshot.chat_id
        and (before_created_at is null or (m.created_at,m.id) < (before_created_at,before_id))
      order by m.created_at desc,m.id desc limit 50
    ) m join public.profiles p on p.id = m.author_id;
  select count(*)::integer into unread from public.direct_messages m
    where m.chat_id = direct_chat_snapshot.chat_id and m.author_id <> auth.uid()
      and not exists(select 1 from public.direct_message_reads r where r.message_id = m.id and r.user_id = auth.uid());
  if more then cursor := jsonb_build_object('created_at',items->0->'created_at','id',items->0->'id'); end if;
  return jsonb_build_object('chat',details,'messages',items,'unread_count',unread,'has_more',more,'next_before',cursor);
end;
$$;

create function yeto_private.lock_direct_chat(target_chat_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare thread public.direct_chats%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select c.* into thread from public.direct_chats c where c.id = target_chat_id and auth.uid() in (c.user_a,c.user_b);
  if not found then raise exception 'This chat is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_pair(thread.user_a,thread.user_b);
  perform c.id from public.direct_chats c where c.id = target_chat_id for update;
  if not yeto_private.can_read_direct_chat(target_chat_id) then raise exception 'This chat is unavailable.' using errcode = '42501'; end if;
end;
$$;
revoke all on function yeto_private.lock_direct_chat(uuid) from public,anon,authenticated,service_role;

create function yeto_private.open_direct_chat(friend_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); friendship uuid; chat_uuid uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if friend_id is null or friend_id = actor then raise exception 'Choose another current friend.' using errcode = '22023'; end if;
  perform yeto_private.lock_pair(actor,friend_id);
  select f.id into friendship from public.friendships f
    where f.user_a = least(actor,friend_id) and f.user_b = greatest(actor,friend_id)
      and not yeto_private.is_blocked_with(friend_id);
  if friendship is null then raise exception 'Choose a current, unblocked friend.' using errcode = '42501'; end if;
  insert into public.direct_chats(friendship_id,user_a,user_b)
    values(friendship,least(actor,friend_id),greatest(actor,friend_id)) on conflict (friendship_id) do nothing returning id into chat_uuid;
  if chat_uuid is null then select c.id into chat_uuid from public.direct_chats c where c.friendship_id = friendship; end if;
  if chat_uuid is null then raise exception 'This chat is unavailable.' using errcode = '42501'; end if;
  return chat_uuid;
end;
$$;

-- Direct-message events link to the current live source, never copied bodies.
alter table public.activity_events add column direct_chat_id uuid references public.direct_chats(id) on delete cascade;
alter table public.activity_events add column direct_message_id uuid references public.direct_messages(id) on delete cascade;
create index activity_events_direct_chat on public.activity_events(direct_chat_id) where direct_chat_id is not null;
create index activity_events_direct_message on public.activity_events(direct_message_id) where direct_message_id is not null;
create unique index activity_events_direct_conversation on public.activity_events(recipient_id,direct_chat_id) where kind = 'direct_message';

create function yeto_private.send_direct_message(target_chat_id uuid,body_text text,client_nonce uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare normalized text; saved public.direct_messages%rowtype; message_uuid uuid; recipient uuid;
begin
  perform yeto_private.lock_direct_chat(target_chat_id);
  normalized := btrim(replace(replace(body_text,E'\r\n',E'\n'),E'\r',E'\n'),E' \n');
  if client_nonce is null or normalized is null or char_length(normalized) not between 1 and 1000
    or normalized !~ '[^[:space:]]' or translate(normalized,E'\n','') ~ '[[:cntrl:]]' then
    raise exception 'Write a message of 1–1000 characters.' using errcode = '22023';
  end if;
  select m.* into saved from public.direct_messages m where m.chat_id = target_chat_id
    and m.author_id = auth.uid() and m.client_nonce = send_direct_message.client_nonce;
  if found then
    if saved.body <> normalized then raise exception 'A message retry must use the original contents.' using errcode = '22023'; end if;
    return saved.id;
  end if;
  select case when c.user_a = auth.uid() then c.user_b else c.user_a end into recipient from public.direct_chats c where c.id = target_chat_id;
  insert into public.direct_messages(chat_id,author_id,body,client_nonce)
    values(target_chat_id,auth.uid(),normalized,client_nonce) returning id into message_uuid;
  insert into public.activity_events(recipient_id,actor_id,kind,direct_chat_id,direct_message_id,created_at)
    values(recipient,auth.uid(),'direct_message',target_chat_id,message_uuid,clock_timestamp())
    on conflict (recipient_id,direct_chat_id) where kind = 'direct_message' do update
      set id = excluded.id,actor_id = excluded.actor_id,direct_message_id = excluded.direct_message_id,
          created_at = excluded.created_at,read_at = null;
  return message_uuid;
end;
$$;
create function yeto_private.delete_direct_message(message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_chat uuid;
begin
  select m.chat_id into target_chat from public.direct_messages m where m.id = message_id;
  if target_chat is null then raise exception 'This message is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_direct_chat(target_chat);
  perform m.id from public.direct_messages m where m.id = message_id for update;
  if not exists(select 1 from public.direct_messages m where m.id = message_id and m.author_id = auth.uid())
    or not yeto_private.can_read_direct_message(message_id) then
    raise exception 'Only the author can delete this message.' using errcode = '42501';
  end if;
  delete from public.direct_messages m where m.id = message_id;
end;
$$;
create function yeto_private.mark_direct_messages_read(chat_id uuid,message_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare selected uuid[] := coalesce(message_ids,'{}'::uuid[]);
begin
  perform yeto_private.lock_direct_chat(chat_id);
  if cardinality(selected) > 100 or array_ndims(selected) > 1 then raise exception 'Mark up to 100 messages at a time.' using errcode = '22023'; end if;
  if array_position(selected,null) is not null then raise exception 'Choose valid messages.' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct value),'{}'::uuid[]) into selected from unnest(selected) value;
  if exists(select 1 from unnest(selected) value where not exists (
    select 1 from public.direct_messages m where m.id = value and m.chat_id = mark_direct_messages_read.chat_id
      and yeto_private.can_read_direct_message(m.id)
  )) then raise exception 'These messages are unavailable.' using errcode = '42501'; end if;
  insert into public.direct_message_reads(message_id,user_id)
    select m.id,auth.uid() from public.direct_messages m where m.id = any(selected) and m.author_id <> auth.uid()
    on conflict do nothing;
  update public.activity_events e set read_at = coalesce(e.read_at,clock_timestamp())
    where e.kind = 'direct_message' and e.direct_chat_id = mark_direct_messages_read.chat_id
      and e.recipient_id = auth.uid() and e.direct_message_id = any(selected);
end;
$$;

create function public.open_direct_chat(friend_id uuid)
returns uuid language sql security invoker set search_path = '' as $$ select yeto_private.open_direct_chat(friend_id); $$;
create function public.send_direct_message(chat_id uuid,body_text text,client_nonce uuid)
returns uuid language sql security invoker set search_path = '' as $$ select yeto_private.send_direct_message(chat_id,body_text,client_nonce); $$;
create function public.delete_direct_message(message_id uuid)
returns void language sql security invoker set search_path = '' as $$ select yeto_private.delete_direct_message(message_id); $$;
create function public.mark_direct_messages_read(chat_id uuid,message_ids uuid[])
returns void language sql security invoker set search_path = '' as $$ select yeto_private.mark_direct_messages_read(chat_id,message_ids); $$;
revoke all on function yeto_private.open_direct_chat(uuid),yeto_private.send_direct_message(uuid,text,uuid),
  yeto_private.delete_direct_message(uuid),yeto_private.mark_direct_messages_read(uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function yeto_private.open_direct_chat(uuid),yeto_private.send_direct_message(uuid,text,uuid),
  yeto_private.delete_direct_message(uuid),yeto_private.mark_direct_messages_read(uuid,uuid[]) to authenticated;
revoke all on function public.direct_chats_snapshot(),public.direct_chat_snapshot(uuid,timestamptz,uuid),public.open_direct_chat(uuid),
  public.send_direct_message(uuid,text,uuid),public.delete_direct_message(uuid),public.mark_direct_messages_read(uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.direct_chats_snapshot(),public.direct_chat_snapshot(uuid,timestamptz,uuid),public.open_direct_chat(uuid),
  public.send_direct_message(uuid,text,uuid),public.delete_direct_message(uuid),public.mark_direct_messages_read(uuid,uuid[]) to authenticated;

-- A direct block insertion revokes the thread even before the ordinary account
-- RPC deletes the friendship. Unblocking never reconstructs old chat content.
create function yeto_private.prune_direct_chats_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.direct_chats c where c.user_a = least(new.blocker_id,new.blocked_id)
    and c.user_b = greatest(new.blocker_id,new.blocked_id);
  return new;
end;
$$;
create trigger prune_direct_chats_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_direct_chats_after_block();
revoke all on function yeto_private.prune_direct_chats_after_block() from public,anon,authenticated,service_role;

-- Preserve every existing source shape and self-reminder rule, adding only the
-- new direct-message source. No old activity/read rows are rewritten.
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
  check (kind in ('friend_request','friend_accepted','plan_invite','plan_rsvp','post_comment','post_like','poll_invite','plan_reminder','plan_message','direct_message'));
alter table public.activity_events add constraint activity_events_source_check check (
  (kind in ('friend_request','friend_accepted') and request_id is not null and post_id is null and plan_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'plan_invite' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'plan_rsvp' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is not null and poll_id is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'post_comment' and post_id is not null and comment_id is not null and plan_id is null and request_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'post_like' and post_id is not null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'poll_invite' and poll_id is not null and post_id is null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and reminder_minutes is null and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'plan_reminder' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is not null and reminder_minutes in (60,1440) and message_id is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'plan_message' and plan_id is not null and message_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and direct_chat_id is null and direct_message_id is null)
  or (kind = 'direct_message' and direct_chat_id is not null and direct_message_id is not null and post_id is null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null and poll_id is null and reminder_minutes is null and message_id is null)
);

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
        when 'direct_message' then yeto_private.can_read_direct_chat(e.direct_chat_id)
          and yeto_private.can_read_direct_message(e.direct_message_id) and exists (
            select 1 from public.direct_messages m where m.id = e.direct_message_id
              and m.chat_id = e.direct_chat_id and m.author_id = e.actor_id
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
        'reminder_minutes', e.reminder_minutes, 'plan_starts_at', sp.starts_at, 'message_id', e.message_id,
        'direct_chat_id', e.direct_chat_id, 'direct_message_id', e.direct_message_id
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

comment on table public.direct_chats is 'Private one-to-one threads bound to an original current friendship. Removal or blocking deletes its thread; a later friendship starts a new thread.';
comment on table public.direct_message_reads is 'Private exact-message read markers. Other participants cannot inspect these markers.';
notify pgrst, 'reload schema';
commit;
