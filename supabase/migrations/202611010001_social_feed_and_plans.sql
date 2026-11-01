-- TARA: additive feed and invited plans. Apply ONCE after the existing account
-- migration. This does not recreate accounts, modify saved profiles, or grant
-- location access. Audience/invitation lists are explicit and private by default.
begin;

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 240 and body = btrim(body) and body ~ '[^[:space:]]'),
  created_at timestamptz not null default now()
);
create table public.social_post_audience (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (post_id, user_id)
);
create table public.social_post_likes (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table public.social_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 240 and body = btrim(body) and body ~ '[^[:space:]]'),
  created_at timestamptz not null default now()
);
create table public.social_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 70 and title = btrim(title) and title ~ '[^[:space:]]'),
  place text not null check (char_length(place) between 1 and 90 and place = btrim(place) and place ~ '[^[:space:]]'),
  starts_at timestamptz not null,
  kind text not null check (kind in ('coffee', 'food', 'trip')),
  created_at timestamptz not null default now()
);
create table public.social_plan_invites (
  plan_id uuid not null references public.social_plans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (plan_id, user_id)
);
create table public.social_plan_attendees (
  plan_id uuid not null references public.social_plans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);
create index social_posts_author on public.social_posts(author_id, created_at desc);
create index social_post_audience_user on public.social_post_audience(user_id, post_id);
create index social_post_comments_post on public.social_post_comments(post_id, created_at, id);
create index social_plans_owner on public.social_plans(owner_id, created_at desc);
create index social_plan_invites_user on public.social_plan_invites(user_id, plan_id);

-- Helpers inspect only the calling user's access. Definer privileges avoid
-- recursive RLS, with a fixed empty path and schema-qualified relation names.
create function yeto_private.social_friends_with(other_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.friendships f
    where f.user_a = least(auth.uid(), other_id)
      and f.user_b = greatest(auth.uid(), other_id)
  ) and not yeto_private.is_blocked_with(other_id);
$$;
create function yeto_private.can_read_social_post(post_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.social_posts p where p.id = post_id and (
      p.author_id = auth.uid() or (
        yeto_private.social_friends_with(p.author_id)
        and exists (select 1 from public.social_post_audience a
                    where a.post_id = p.id and a.user_id = auth.uid())
      )
    )
  );
$$;
create function yeto_private.can_read_social_plan(plan_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.social_plans p where p.id = plan_id and (
      p.owner_id = auth.uid() or (
        yeto_private.social_friends_with(p.owner_id)
        and exists (select 1 from public.social_plan_invites i
                    where i.plan_id = p.id and i.user_id = auth.uid())
      )
    )
  );
$$;
create function yeto_private.social_post_audience_size(post_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case when yeto_private.can_read_social_post(post_id)
    then (select count(*)::integer from public.social_post_audience a where a.post_id = social_post_audience_size.post_id)
    else 0 end;
$$;
revoke all on function yeto_private.social_friends_with(uuid), yeto_private.can_read_social_post(uuid),
  yeto_private.can_read_social_plan(uuid), yeto_private.social_post_audience_size(uuid)
  from public, anon, authenticated, service_role;
grant execute on function yeto_private.social_friends_with(uuid), yeto_private.can_read_social_post(uuid),
  yeto_private.can_read_social_plan(uuid), yeto_private.social_post_audience_size(uuid) to authenticated;

alter table public.social_posts enable row level security;
alter table public.social_post_audience enable row level security;
alter table public.social_post_likes enable row level security;
alter table public.social_post_comments enable row level security;
alter table public.social_plans enable row level security;
alter table public.social_plan_invites enable row level security;
alter table public.social_plan_attendees enable row level security;
create policy social_posts_read on public.social_posts for select to authenticated
  using (yeto_private.can_read_social_post(id));
create policy social_post_audience_read on public.social_post_audience for select to authenticated
  using (yeto_private.can_read_social_post(post_id) and (
    user_id = auth.uid() or exists (select 1 from public.social_posts p where p.id = post_id and p.author_id = auth.uid())
  ));
create policy social_post_likes_read on public.social_post_likes for select to authenticated
  using (yeto_private.can_read_social_post(post_id) and not yeto_private.is_blocked_with(user_id));
create policy social_post_comments_read on public.social_post_comments for select to authenticated
  using (yeto_private.can_read_social_post(post_id) and not yeto_private.is_blocked_with(author_id));
create policy social_plans_read on public.social_plans for select to authenticated
  using (yeto_private.can_read_social_plan(id));
create policy social_plan_invites_read on public.social_plan_invites for select to authenticated
  using (yeto_private.can_read_social_plan(plan_id) and not yeto_private.is_blocked_with(user_id));
create policy social_plan_attendees_read on public.social_plan_attendees for select to authenticated
  using (yeto_private.can_read_social_plan(plan_id) and not yeto_private.is_blocked_with(user_id));
revoke all on public.social_posts, public.social_post_audience, public.social_post_likes,
  public.social_post_comments, public.social_plans, public.social_plan_invites, public.social_plan_attendees
  from public, anon, authenticated;
grant select on public.social_posts, public.social_post_audience, public.social_post_likes,
  public.social_post_comments, public.social_plans, public.social_plan_invites, public.social_plan_attendees
  to authenticated;

-- Serialize audience creation with existing relationship mutations by locking
-- every involved profile in UUID order, the same order as lock_pair().
create function yeto_private.check_social_viewers(viewer_ids uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected uuid[] := coalesce(viewer_ids, '{}'::uuid[]);
  person uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if cardinality(selected) > 50 or array_position(selected, null) is not null then
    raise exception 'Choose up to 50 current friends.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct item), '{}'::uuid[]) into selected from unnest(selected) item;
  perform p.id from public.profiles p where p.id = any(array_append(selected, actor)) order by p.id for update;
  foreach person in array selected loop
    if person = actor or not yeto_private.social_friends_with(person) then
      raise exception 'Choose only current, unblocked friends.' using errcode = '42501';
    end if;
  end loop;
  return selected;
end;
$$;
-- Lock before checking access so a remove/block cannot race a successful write.
create function yeto_private.lock_social_post(post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select p.author_id into owner_id from public.social_posts p where p.id = post_id;
  if owner_id is null then raise exception 'This post is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_pair(auth.uid(), owner_id);
  perform p.id from public.social_posts p where p.id = post_id for update;
  if not yeto_private.can_read_social_post(post_id) then
    raise exception 'This post is unavailable.' using errcode = '42501';
  end if;
end;
$$;
create function yeto_private.lock_social_plan(plan_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select p.owner_id into owner_id from public.social_plans p where p.id = plan_id;
  if owner_id is null then raise exception 'This plan is unavailable.' using errcode = '42501'; end if;
  perform yeto_private.lock_pair(auth.uid(), owner_id);
  perform p.id from public.social_plans p where p.id = plan_id for update;
  if not yeto_private.can_read_social_plan(plan_id) then
    raise exception 'This plan is unavailable.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function yeto_private.check_social_viewers(uuid[]), yeto_private.lock_social_post(uuid),
  yeto_private.lock_social_plan(uuid) from public, anon, authenticated, service_role;

create function public.create_social_post(body_text text, viewer_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare selected uuid[]; post_uuid uuid;
begin
  selected := yeto_private.check_social_viewers(viewer_ids);
  if body_text is null or char_length(btrim(body_text)) not between 1 and 240 or body_text !~ '[^[:space:]]' then
    raise exception 'Write an update of 1–240 characters.' using errcode = '22023';
  end if;
  insert into public.social_posts(author_id, body) values(auth.uid(), btrim(body_text)) returning id into post_uuid;
  insert into public.social_post_audience(post_id, user_id) select post_uuid, unnest(selected);
  return post_uuid;
end;
$$;
create function public.delete_social_post(post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform yeto_private.lock_social_post(post_id);
  if not exists(select 1 from public.social_posts p where p.id = post_id and p.author_id = auth.uid()) then
    raise exception 'Only the author can delete this post.' using errcode = '42501';
  end if;
  delete from public.social_posts p where p.id = post_id;
end;
$$;
create function public.set_social_like(post_id uuid, liked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform yeto_private.lock_social_post(post_id);
  if liked is null then raise exception 'Choose like or unlike.' using errcode = '22023'; end if;
  if liked then
    insert into public.social_post_likes(post_id, user_id) values(post_id, auth.uid()) on conflict do nothing;
  else delete from public.social_post_likes l where l.post_id = set_social_like.post_id and l.user_id = auth.uid(); end if;
end;
$$;
create function public.add_social_comment(post_id uuid, body_text text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare comment_uuid uuid;
begin
  perform yeto_private.lock_social_post(post_id);
  if body_text is null or char_length(btrim(body_text)) not between 1 and 240 or body_text !~ '[^[:space:]]' then
    raise exception 'Write a comment of 1–240 characters.' using errcode = '22023';
  end if;
  insert into public.social_post_comments(post_id, author_id, body)
    values(post_id, auth.uid(), btrim(body_text)) returning id into comment_uuid;
  return comment_uuid;
end;
$$;
create function public.delete_social_comment(comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_post uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select c.post_id into target_post from public.social_post_comments c where c.id = comment_id and c.author_id = auth.uid();
  if target_post is null then raise exception 'Only the author can delete this comment.' using errcode = '42501'; end if;
  perform yeto_private.lock_social_post(target_post);
  delete from public.social_post_comments c where c.id = comment_id and c.author_id = auth.uid();
end;
$$;
create function public.create_social_plan(plan_title text, plan_place text, plan_starts_at timestamptz, plan_kind text, invitee_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare selected uuid[]; plan_uuid uuid;
begin
  selected := yeto_private.check_social_viewers(invitee_ids);
  if plan_title is null or char_length(btrim(plan_title)) not between 1 and 70 or plan_title !~ '[^[:space:]]'
     or plan_place is null or char_length(btrim(plan_place)) not between 1 and 90 or plan_place !~ '[^[:space:]]'
     or plan_starts_at is null or not isfinite(plan_starts_at) or plan_starts_at <= now()
     or plan_kind is null or plan_kind not in ('coffee', 'food', 'trip') then
    raise exception 'Choose a title, place, future date, and plan type.' using errcode = '22023';
  end if;
  insert into public.social_plans(owner_id,title,place,starts_at,kind)
    values(auth.uid(),btrim(plan_title),btrim(plan_place),plan_starts_at,plan_kind) returning id into plan_uuid;
  insert into public.social_plan_invites(plan_id,user_id) select plan_uuid,unnest(selected);
  insert into public.social_plan_attendees(plan_id,user_id) values(plan_uuid,auth.uid());
  return plan_uuid;
end;
$$;
create function public.delete_social_plan(plan_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform yeto_private.lock_social_plan(plan_id);
  if not exists(select 1 from public.social_plans p where p.id = plan_id and p.owner_id = auth.uid()) then
    raise exception 'Only the organizer can cancel this plan.' using errcode = '42501';
  end if;
  delete from public.social_plans p where p.id = plan_id;
end;
$$;
create function public.set_social_attendance(plan_id uuid, going boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform yeto_private.lock_social_plan(plan_id);
  if going is null then raise exception 'Choose join or leave.' using errcode = '22023'; end if;
  if not going and exists(select 1 from public.social_plans p where p.id = plan_id and p.owner_id = auth.uid()) then
    raise exception 'Organizers stay attending; cancel the plan instead.' using errcode = '22023';
  end if;
  if going then
    insert into public.social_plan_attendees(plan_id,user_id) values(plan_id,auth.uid()) on conflict do nothing;
  else delete from public.social_plan_attendees a where a.plan_id = set_social_attendance.plan_id and a.user_id = auth.uid(); end if;
end;
$$;

-- Losing friendship permanently revokes existing grants in both directions.
-- New friendship does not silently re-share old posts/plans. This trigger only
-- touches the new social tables; existing accounts/content are preserved.
create function yeto_private.revoke_social_pair()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.social_post_likes l using public.social_posts p where p.id = l.post_id
    and ((p.author_id = old.user_a and l.user_id = old.user_b) or (p.author_id = old.user_b and l.user_id = old.user_a));
  delete from public.social_post_comments c using public.social_posts p where p.id = c.post_id
    and ((p.author_id = old.user_a and c.author_id = old.user_b) or (p.author_id = old.user_b and c.author_id = old.user_a));
  delete from public.social_post_audience a using public.social_posts p where p.id = a.post_id
    and ((p.author_id = old.user_a and a.user_id = old.user_b) or (p.author_id = old.user_b and a.user_id = old.user_a));
  delete from public.social_plan_attendees a using public.social_plans p where p.id = a.plan_id
    and ((p.owner_id = old.user_a and a.user_id = old.user_b) or (p.owner_id = old.user_b and a.user_id = old.user_a));
  delete from public.social_plan_invites i using public.social_plans p where p.id = i.plan_id
    and ((p.owner_id = old.user_a and i.user_id = old.user_b) or (p.owner_id = old.user_b and i.user_id = old.user_a));
  return old;
end;
$$;
revoke all on function yeto_private.revoke_social_pair() from public, anon, authenticated, service_role;
create trigger revoke_social_access_after_friendship after delete on public.friendships
  for each row execute function yeto_private.revoke_social_pair();

-- SECURITY INVOKER deliberately keeps table RLS and existing profile blocking
-- policies in force, including names on comments, reactions and attendance.
create function public.social_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'posts', coalesce((
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
      ) order by p.created_at desc,p.id desc)
      from (select * from public.social_posts order by created_at desc,id desc limit 100) p
      join public.profiles author on author.id=p.author_id
    ),'[]'::jsonb),
    'plans',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'owner',jsonb_build_object('id',owner.id,'username',owner.username,'display_name',owner.display_name),
        'title',p.title,'place',p.place,'starts_at',p.starts_at,'kind',p.kind,'created_at',p.created_at,
        'invitees',coalesce((select jsonb_agg(jsonb_build_object('id',ip.id,'username',ip.username,'display_name',ip.display_name) order by ip.username,ip.id)
          from public.social_plan_invites i join public.profiles ip on ip.id=i.user_id where i.plan_id=p.id),'[]'::jsonb),
        'attendees',coalesce((select jsonb_agg(jsonb_build_object('id',ap.id,'username',ap.username,'display_name',ap.display_name) order by ap.username,ap.id)
          from public.social_plan_attendees a join public.profiles ap on ap.id=a.user_id where a.plan_id=p.id),'[]'::jsonb)
      ) order by p.starts_at,p.id)
      from (select * from public.social_plans order by created_at desc,id desc limit 100) p
      join public.profiles owner on owner.id=p.owner_id
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.create_social_post(text,uuid[]), public.delete_social_post(uuid),
  public.set_social_like(uuid,boolean), public.add_social_comment(uuid,text), public.delete_social_comment(uuid),
  public.create_social_plan(text,text,timestamptz,text,uuid[]), public.delete_social_plan(uuid),
  public.set_social_attendance(uuid,boolean), public.social_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.create_social_post(text,uuid[]), public.delete_social_post(uuid),
  public.set_social_like(uuid,boolean), public.add_social_comment(uuid,text), public.delete_social_comment(uuid),
  public.create_social_plan(text,text,timestamptz,text,uuid[]), public.delete_social_plan(uuid),
  public.set_social_attendance(uuid,boolean), public.social_snapshot() to authenticated;

comment on table public.social_posts is 'TARA updates shared with explicitly selected current friends. No location collection or grants.';
comment on table public.social_plans is 'TARA meetups with explicit invitations. Attendance never grants location access.';
notify pgrst, 'reload schema';
commit;
