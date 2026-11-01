-- Yeto: account and friendship foundation. No location data or sharing grants.
-- Apply once to a NEW Supabase project using its SQL editor or migrations.
begin;

create schema if not exists yeto_private;
revoke all on schema yeto_private from public, anon, authenticated, service_role;
grant usage on schema yeto_private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique
    check (username ~ '^[a-z0-9_]{3,40}$'),
  display_name text not null
    check (char_length(display_name) between 1 and 60
      and display_name = btrim(display_name)
      and display_name !~ '[[:cntrl:]]'
      and display_name ~ '[^[:space:]]'),
  created_at timestamptz not null default now()
);

create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> recipient_id)
);
create unique index friend_requests_one_pending_pair
  on public.friend_requests (least(requester_id, recipient_id), greatest(requester_id, recipient_id))
  where status = 'pending';
create index friend_requests_recipient on public.friend_requests(recipient_id, created_at desc);
create index friend_requests_requester on public.friend_requests(requester_id, created_at desc);

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);
create index friendships_user_b on public.friendships(user_b);

create table public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked on public.blocks(blocked_id);

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;

-- Only the caller's own block relationship can be inspected by this helper.
-- SECURITY DEFINER avoids recursive profiles/blocks policies; fixed search_path
-- and schema-qualified names prevent object shadowing.
create function yeto_private.is_blocked_with(other_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = other_id)
       or (b.blocker_id = other_id and b.blocked_id = auth.uid())
  );
$$;
revoke all on function yeto_private.is_blocked_with(uuid) from public, anon, authenticated, service_role;
grant execute on function yeto_private.is_blocked_with(uuid) to authenticated;

-- Serialize all relationship mutations for a pair, including opposite-direction
-- requests and concurrent blocks. Always acquire profile locks in the same order.
create function yeto_private.lock_pair(first_id uuid, second_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform p.id from public.profiles p
  where p.id in (first_id, second_id) order by p.id for update;
end;
$$;
revoke all on function yeto_private.lock_pair(uuid, uuid) from public, anon, authenticated, service_role;

create policy profiles_read on public.profiles for select to authenticated
  using ((select auth.uid()) is not null
    and (id = (select auth.uid()) or not yeto_private.is_blocked_with(id)));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy friend_requests_read_participants on public.friend_requests for select to authenticated
  using (((select auth.uid()) in (requester_id, recipient_id))
    and not yeto_private.is_blocked_with(
      case when requester_id = (select auth.uid()) then recipient_id else requester_id end));
create policy friendships_read_participants on public.friendships for select to authenticated
  using (((select auth.uid()) in (user_a, user_b))
    and not yeto_private.is_blocked_with(
      case when user_a = (select auth.uid()) then user_b else user_a end));
create policy blocks_read_own on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

revoke all on public.profiles, public.friend_requests, public.friendships, public.blocks
  from public, anon, authenticated;
grant select on public.profiles, public.friend_requests, public.friendships, public.blocks to authenticated;
grant update (username, display_name) on public.profiles to authenticated;

create function yeto_private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  chosen_name text;
begin
  chosen_name := btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '[[:cntrl:]]', ' ', 'g')), 60));
  if chosen_name = '' then chosen_name := 'Yeto friend'; end if;
  insert into public.profiles(id, username, display_name)
  values (new.id, 'yeto_' || replace(new.id::text, '-', ''), chosen_name);
  return new;
end;
$$;
revoke all on function yeto_private.handle_new_user() from public, anon, authenticated, service_role;
create trigger on_auth_user_created after insert on auth.users
for each row execute function yeto_private.handle_new_user();

-- Provision any users already created before this migration. Full UUID suffixes
-- ensure a user's chosen username or duplicate display name cannot break signup.
insert into public.profiles(id, username, display_name)
select u.id, 'yeto_' || replace(u.id::text, '-', ''),
  coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(u.raw_user_meta_data ->> 'display_name', ''), '[[:cntrl:]]', ' ', 'g')), 60)), ''), 'Yeto friend')
from auth.users u on conflict (id) do nothing;

create function public.search_people(search_text text)
returns table(id uuid, username text, display_name text)
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  query text := lower(btrim(coalesce(search_text, '')));
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if char_length(query) < 2 or char_length(query) > 60 then return; end if;
  return query select p.id, p.username, p.display_name from public.profiles p
    where p.id <> actor
      and (left(p.username, char_length(query)) = query
        or left(lower(p.display_name), char_length(query)) = query)
      and not yeto_private.is_blocked_with(p.id)
    order by p.username limit 20;
end;
$$;

create function public.send_friend_request(target_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  request_uuid uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if target_id is null or target_id = actor then raise exception 'Choose another person.' using errcode = '22023'; end if;
  perform yeto_private.lock_pair(actor, target_id);
  if not exists(select 1 from public.profiles where id = target_id)
    or yeto_private.is_blocked_with(target_id) then
    raise exception 'This person is unavailable.' using errcode = '22023';
  end if;
  if exists(select 1 from public.friendships where user_a = least(actor, target_id) and user_b = greatest(actor, target_id)) then
    raise exception 'You are already friends.' using errcode = '22023';
  end if;
  if exists(select 1 from public.friend_requests where status = 'pending'
    and least(requester_id, recipient_id) = least(actor, target_id)
    and greatest(requester_id, recipient_id) = greatest(actor, target_id)) then
    raise exception 'A request is already pending between you.' using errcode = '22023';
  end if;
  insert into public.friend_requests(requester_id, recipient_id)
    values(actor, target_id) returning id into request_uuid;
  return request_uuid;
end;
$$;

create function public.respond_friend_request(request_id uuid, accept_request boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  request_row public.friend_requests;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if accept_request is null then raise exception 'Choose accept or decline.' using errcode = '22023'; end if;
  select * into request_row from public.friend_requests where id = request_id;
  if not found or request_row.recipient_id <> actor then
    raise exception 'This request is unavailable.' using errcode = '42501';
  end if;
  perform yeto_private.lock_pair(request_row.requester_id, actor);
  select * into request_row from public.friend_requests where id = request_id for update;
  if not found or request_row.status <> 'pending' or yeto_private.is_blocked_with(request_row.requester_id) then
    raise exception 'This request is no longer pending.' using errcode = '22023';
  end if;
  update public.friend_requests set status = case when accept_request then 'accepted' else 'declined' end,
    updated_at = now() where id = request_id;
  if accept_request then
    insert into public.friendships(user_a, user_b)
      values(least(actor, request_row.requester_id), greatest(actor, request_row.requester_id))
      on conflict (user_a, user_b) do nothing;
  end if;
end;
$$;

create function public.cancel_friend_request(request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  request_row public.friend_requests;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into request_row from public.friend_requests where id = request_id;
  if not found or request_row.requester_id <> actor then
    raise exception 'This request is unavailable.' using errcode = '42501';
  end if;
  perform yeto_private.lock_pair(actor, request_row.recipient_id);
  select * into request_row from public.friend_requests where id = request_id for update;
  if not found or request_row.status <> 'pending' then
    raise exception 'This request is no longer pending.' using errcode = '22023';
  end if;
  update public.friend_requests set status = 'cancelled', updated_at = now() where id = request_id;
end;
$$;

create function public.remove_friend(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if target_id is null or actor = target_id then raise exception 'Choose another person.' using errcode = '22023'; end if;
  perform yeto_private.lock_pair(actor, target_id);
  delete from public.friendships where user_a = least(actor, target_id) and user_b = greatest(actor, target_id);
end;
$$;

create function public.block_person(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if target_id is null or actor = target_id then raise exception 'Choose another person.' using errcode = '22023'; end if;
  perform yeto_private.lock_pair(actor, target_id);
  if not exists(select 1 from public.profiles where id = target_id) then
    raise exception 'This person is unavailable.' using errcode = '22023';
  end if;
  insert into public.blocks(blocker_id, blocked_id) values(actor, target_id)
    on conflict (blocker_id, blocked_id) do nothing;
  delete from public.friendships where user_a = least(actor, target_id) and user_b = greatest(actor, target_id);
  update public.friend_requests set status = 'cancelled', updated_at = now()
    where status = 'pending'
      and least(requester_id, recipient_id) = least(actor, target_id)
      and greatest(requester_id, recipient_id) = greatest(actor, target_id);
end;
$$;

create function public.unblock_person(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if target_id is null or actor = target_id then raise exception 'Choose another person.' using errcode = '22023'; end if;
  perform yeto_private.lock_pair(actor, target_id);
  delete from public.blocks where blocker_id = actor and blocked_id = target_id;
end;
$$;

-- PostgreSQL grants new functions EXECUTE to PUBLIC by default: remove it.
revoke all on function public.search_people(text) from public, anon, authenticated, service_role;
revoke all on function public.send_friend_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.cancel_friend_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated, service_role;
revoke all on function public.block_person(uuid) from public, anon, authenticated, service_role;
revoke all on function public.unblock_person(uuid) from public, anon, authenticated, service_role;
grant execute on function public.search_people(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_person(uuid) to authenticated;
grant execute on function public.unblock_person(uuid) to authenticated;

comment on table public.profiles is 'Discoverable username/display name only. No email, location, or sharing consent.';
comment on table public.friendships is 'Accepted social connections. Friendship never grants location access.';
comment on table public.blocks is 'Private outgoing block list. Relationship access is denied in both directions.';
commit;
