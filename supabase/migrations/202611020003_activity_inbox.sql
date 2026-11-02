-- TARA: private in-app activity inbox. Apply ONCE after the existing account
-- and social migrations. This does not rerun setup, change old content or
-- audiences, enable push/email, or grant any location access.
begin;

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('friend_request','friend_accepted','plan_invite','plan_rsvp','post_comment','post_like')),
  post_id uuid references public.social_posts(id) on delete cascade,
  plan_id uuid references public.social_plans(id) on delete cascade,
  request_id uuid references public.friend_requests(id) on delete cascade,
  comment_id uuid references public.social_post_comments(id) on delete cascade,
  rsvp_going boolean,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (recipient_id <> actor_id),
  check (
    (kind in ('friend_request','friend_accepted') and request_id is not null and post_id is null and plan_id is null and comment_id is null and rsvp_going is null)
    or (kind = 'plan_invite' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is null)
    or (kind = 'plan_rsvp' and plan_id is not null and post_id is null and request_id is null and comment_id is null and rsvp_going is not null)
    or (kind = 'post_comment' and post_id is not null and comment_id is not null and plan_id is null and request_id is null and rsvp_going is null)
    or (kind = 'post_like' and post_id is not null and plan_id is null and request_id is null and comment_id is null and rsvp_going is null)
  )
);
create index activity_events_recipient_time on public.activity_events(recipient_id, created_at desc, id desc);
create index activity_events_pair on public.activity_events(recipient_id, actor_id);
create unique index activity_events_request on public.activity_events(recipient_id,kind,request_id) where request_id is not null;
create unique index activity_events_plan on public.activity_events(recipient_id,kind,plan_id,actor_id) where plan_id is not null;
create unique index activity_events_comment on public.activity_events(recipient_id,comment_id) where comment_id is not null;
create unique index activity_events_like on public.activity_events(recipient_id,post_id,actor_id) where kind = 'post_like';

-- Recheck both recipient access and source validity on every read, even if a
-- source was removed by an administrator outside the normal relationship RPCs.
-- No post/comment body, old name, circle name, or other private payload is copied.
create function yeto_private.can_read_activity(activity_id uuid)
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
revoke all on function yeto_private.can_read_activity(uuid) from public,anon,authenticated,service_role;
grant execute on function yeto_private.can_read_activity(uuid) to authenticated;
alter table public.activity_events enable row level security;
create policy activity_events_read_owner on public.activity_events for select to authenticated
  using (recipient_id = (select auth.uid()) and yeto_private.can_read_activity(id));
revoke all on public.activity_events from public,anon,authenticated,service_role;
grant select on public.activity_events to authenticated;

create function public.activity_inbox_snapshot()
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
        'comment_id', e.comment_id, 'plan_title', sp.title, 'rsvp_going', e.rsvp_going
      ) order by e.created_at desc,e.id desc)
      from (select * from public.activity_events order by created_at desc,id desc limit 100) e
      join public.profiles p on p.id = e.actor_id
      left join public.social_plans sp on sp.id = e.plan_id
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

create function public.mark_activity_read(activity_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare selected uuid[] := coalesce(activity_ids,'{}'::uuid[]);
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if cardinality(selected) > 100 or array_position(selected,null) is not null then
    raise exception 'Choose up to 100 activities.' using errcode = '22023';
  end if;
  -- Never take a recipient/owner argument or mark a time range: a newly arriving
  -- event must stay unread when the UI marks an already displayed batch.
  update public.activity_events e set read_at = coalesce(e.read_at,now())
    where e.id = any(selected) and e.recipient_id = auth.uid()
      and yeto_private.can_read_activity(e.id);
end;
$$;
revoke all on function public.activity_inbox_snapshot(),public.mark_activity_read(uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.activity_inbox_snapshot(),public.mark_activity_read(uuid[]) to authenticated;

-- An inbox target can fall outside the feed's latest-100 window. Fetch that
-- exact item under the same RLS, rather than extending any audience or exposing
-- text in the notification record. Unknown/revoked targets return empty lists.
create function public.activity_target_snapshot(post_id uuid, plan_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if (post_id is null) = (plan_id is null) then
    raise exception 'Choose one activity target.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'posts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'author',jsonb_build_object('id',author.id,'username',author.username,'display_name',author.display_name),
        'body',p.body,'created_at',p.created_at,'audience_count',yeto_private.social_post_audience_size(p.id),
        'liked_by_me',exists(select 1 from public.social_post_likes l where l.post_id=p.id and l.user_id=auth.uid()),
        'like_count',(select count(*) from public.social_post_likes l where l.post_id=p.id),
        'comments',coalesce((
          select jsonb_agg(jsonb_build_object('id',c.id,'body',c.body,'created_at',c.created_at,
            'author',jsonb_build_object('id',cp.id,'username',cp.username,'display_name',cp.display_name)) order by c.created_at,c.id)
          from (select * from public.social_post_comments sc where sc.post_id=p.id order by sc.created_at desc,sc.id desc limit 100) c
          join public.profiles cp on cp.id=c.author_id
        ),'[]'::jsonb)
      ))
      from public.social_posts p join public.profiles author on author.id=p.author_id
      where p.id=activity_target_snapshot.post_id
    ),'[]'::jsonb),
    'plans',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'owner',jsonb_build_object('id',owner.id,'username',owner.username,'display_name',owner.display_name),
        'title',p.title,'place',p.place,'starts_at',p.starts_at,'kind',p.kind,'created_at',p.created_at,
        'invitees',coalesce((select jsonb_agg(jsonb_build_object('id',ip.id,'username',ip.username,'display_name',ip.display_name) order by ip.username,ip.id)
          from public.social_plan_invites i join public.profiles ip on ip.id=i.user_id where i.plan_id=p.id),'[]'::jsonb),
        'attendees',coalesce((select jsonb_agg(jsonb_build_object('id',ap.id,'username',ap.username,'display_name',ap.display_name) order by ap.username,ap.id)
          from public.social_plan_attendees a join public.profiles ap on ap.id=a.user_id where a.plan_id=p.id),'[]'::jsonb)
      ))
      from public.social_plans p join public.profiles owner on owner.id=p.owner_id
      where p.id=activity_target_snapshot.plan_id
    ),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.activity_target_snapshot(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.activity_target_snapshot(uuid,uuid) to authenticated;

create function yeto_private.capture_friend_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.status = old.status then return new; end if;
    delete from public.activity_events e where e.request_id = new.id and e.kind = 'friend_request';
  end if;
  if new.status = 'pending' and new.requester_id <> new.recipient_id and not exists (
    select 1 from public.blocks b where
      (b.blocker_id = new.requester_id and b.blocked_id = new.recipient_id)
      or (b.blocker_id = new.recipient_id and b.blocked_id = new.requester_id)
  ) then
    insert into public.activity_events(recipient_id,actor_id,kind,request_id,created_at)
      values(new.recipient_id,new.requester_id,'friend_request',new.id,new.created_at)
      on conflict do nothing;
  elsif tg_op = 'UPDATE' and new.status = 'accepted' then
    -- The existing accept RPC inserts friendship immediately after this update.
    -- Read-time validation keeps the activity hidden unless that also succeeds.
    insert into public.activity_events(recipient_id,actor_id,kind,request_id,created_at)
      values(new.requester_id,new.recipient_id,'friend_accepted',new.id,new.updated_at)
      on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_activity_friend_request after insert or update of status on public.friend_requests
  for each row execute function yeto_private.capture_friend_activity();

create function yeto_private.capture_plan_invite_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare organizer uuid; happened_at timestamptz;
begin
  select p.owner_id,p.created_at into organizer,happened_at from public.social_plans p where p.id = new.plan_id;
  if organizer is not null and organizer <> new.user_id then
    insert into public.activity_events(recipient_id,actor_id,kind,plan_id,created_at)
      values(new.user_id,organizer,'plan_invite',new.plan_id,happened_at)
      on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_activity_plan_invite after insert on public.social_plan_invites
  for each row execute function yeto_private.capture_plan_invite_activity();

create function yeto_private.capture_plan_rsvp_activity()
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
      on conflict (recipient_id,kind,plan_id,actor_id) where plan_id is not null do update
        set id = excluded.id,rsvp_going = excluded.rsvp_going,created_at = excluded.created_at,read_at = null;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
create trigger capture_activity_plan_rsvp after insert or delete on public.social_plan_attendees
  for each row execute function yeto_private.capture_plan_rsvp_activity();

create function yeto_private.capture_post_comment_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare author uuid;
begin
  select p.author_id into author from public.social_posts p where p.id = new.post_id;
  if author is not null and author <> new.author_id then
    insert into public.activity_events(recipient_id,actor_id,kind,post_id,comment_id,created_at)
      values(author,new.author_id,'post_comment',new.post_id,new.id,new.created_at)
      on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_activity_post_comment after insert on public.social_post_comments
  for each row execute function yeto_private.capture_post_comment_activity();

create function yeto_private.capture_post_like_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare author uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.activity_events e where e.kind = 'post_like' and e.post_id = old.post_id and e.actor_id = old.user_id;
    return old;
  end if;
  select p.author_id into author from public.social_posts p where p.id = new.post_id;
  if author is not null and author <> new.user_id then
    insert into public.activity_events(recipient_id,actor_id,kind,post_id,created_at)
      values(author,new.user_id,'post_like',new.post_id,new.created_at)
      on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_activity_post_like after insert or delete on public.social_post_likes
  for each row execute function yeto_private.capture_post_like_activity();

create function yeto_private.prune_activity_after_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.activity_events e where
    (e.recipient_id = old.user_a and e.actor_id = old.user_b)
    or (e.recipient_id = old.user_b and e.actor_id = old.user_a);
  return old;
end;
$$;
create trigger prune_activity_after_friendship after delete on public.friendships
  for each row execute function yeto_private.prune_activity_after_friendship();
create function yeto_private.prune_activity_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.activity_events e where
    (e.recipient_id = new.blocker_id and e.actor_id = new.blocked_id)
    or (e.recipient_id = new.blocked_id and e.actor_id = new.blocker_id);
  return new;
end;
$$;
create trigger prune_activity_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_activity_after_block();

revoke all on function yeto_private.capture_friend_activity(),yeto_private.capture_plan_invite_activity(),
  yeto_private.capture_plan_rsvp_activity(),yeto_private.capture_post_comment_activity(),
  yeto_private.capture_post_like_activity(),yeto_private.prune_activity_after_friendship(),
  yeto_private.prune_activity_after_block() from public,anon,authenticated,service_role;

-- Existing actionable requests/invitations appear on first activation. Historic
-- reactions/comments/RSVPs are deliberately not imported as a flood of new alerts.
insert into public.activity_events(recipient_id,actor_id,kind,request_id,created_at)
select r.recipient_id,r.requester_id,'friend_request',r.id,r.created_at
from public.friend_requests r where r.status = 'pending' and not exists (
  select 1 from public.blocks b where
    (b.blocker_id = r.requester_id and b.blocked_id = r.recipient_id)
    or (b.blocker_id = r.recipient_id and b.blocked_id = r.requester_id)
) on conflict do nothing;
insert into public.activity_events(recipient_id,actor_id,kind,plan_id,created_at)
select i.user_id,p.owner_id,'plan_invite',p.id,p.created_at
from public.social_plan_invites i join public.social_plans p on p.id = i.plan_id
where i.user_id <> p.owner_id and exists (
  select 1 from public.friendships f where f.user_a = least(i.user_id,p.owner_id) and f.user_b = greatest(i.user_id,p.owner_id)
) and not exists (
  select 1 from public.blocks b where
    (b.blocker_id = i.user_id and b.blocked_id = p.owner_id)
    or (b.blocker_id = p.owner_id and b.blocked_id = i.user_id)
) on conflict do nothing;

comment on table public.activity_events is 'Owner-private in-app activity and read state. Source access is rechecked, pair events are permanently pruned after removal/blocking, and no post/comment text or circle data is copied.';
notify pgrst, 'reload schema';
commit;
