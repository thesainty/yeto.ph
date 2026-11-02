-- TARA: private saved audience circles. Apply ONCE after the existing account
-- and social migrations; never rerun the old setup. Existing accounts, profiles,
-- relationships, posts/plans, storage identifiers and settings are unchanged.
begin;

create table public.audience_circles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (
    char_length(name) between 1 and 40 and name = btrim(name)
    and name ~ '[^[:space:]]' and name !~ '[[:cntrl:]]'
  ),
  created_at timestamptz not null default now()
);
create unique index audience_circles_owner_name
  on public.audience_circles(owner_id, lower(name));
create table public.audience_circle_members (
  circle_id uuid not null references public.audience_circles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  primary key (circle_id, friend_id)
);
create index audience_circle_members_friend on public.audience_circle_members(friend_id, circle_id);

alter table public.audience_circles enable row level security;
alter table public.audience_circle_members enable row level security;
create policy audience_circles_read_owner on public.audience_circles for select to authenticated
  using (owner_id = (select auth.uid()));
create policy audience_circle_members_read_owner on public.audience_circle_members for select to authenticated
  using (exists (select 1 from public.audience_circles c
    where c.id = circle_id and c.owner_id = (select auth.uid())));
-- Explicitly undo platform default grants. Clients can read only their own
-- circles through RLS, and all writes must pass the authenticated RPCs.
revoke all on public.audience_circles, public.audience_circle_members
  from public, anon, authenticated, service_role;
grant select on public.audience_circles, public.audience_circle_members to authenticated;

-- The old 50-recipient cap was too small for all-current-friends selection.
-- Bound each submitted list at 500 (before deduplication), and retain the same
-- UUID-ordered profile locks and current-friend validation for both social RPCs.
create or replace function yeto_private.check_social_viewers(viewer_ids uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected uuid[] := coalesce(viewer_ids, '{}'::uuid[]);
  person uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if cardinality(selected) > 500 or array_position(selected, null) is not null then
    raise exception 'Choose up to 500 current friends.' using errcode = '22023';
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
revoke all on function yeto_private.check_social_viewers(uuid[]) from public, anon, authenticated, service_role;

create function public.audience_circles_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name,
      'member_ids', coalesce((
        select jsonb_agg(m.friend_id order by m.friend_id)
        from public.audience_circle_members m where m.circle_id = c.id
      ), '[]'::jsonb)
    ) order by lower(c.name), c.id)
    from public.audience_circles c where c.owner_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

create function public.save_audience_circle(circle_id uuid, circle_name text, member_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected uuid[];
  saved_id uuid;
  chosen_name text := btrim(circle_name);
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if chosen_name is null or char_length(chosen_name) not between 1 and 40
     or chosen_name !~ '[^[:space:]]' or chosen_name ~ '[[:cntrl:]]' then
    raise exception 'Choose a circle name of 1–40 visible characters.' using errcode = '22023';
  end if;
  -- This locks the owner and all selected friends before reading relationships
  -- or touching a circle. The owner lock also serializes the 50-circle quota.
  selected := yeto_private.check_social_viewers(member_ids);
  if not exists(select 1 from public.profiles p where p.id = actor) then
    raise exception 'Your account profile is unavailable.' using errcode = '42501';
  end if;
  if circle_id is null then
    if (select count(*) from public.audience_circles c where c.owner_id = actor) >= 50 then
      raise exception 'Keep up to 50 saved circles.' using errcode = '22023';
    end if;
    insert into public.audience_circles(owner_id, name) values(actor, chosen_name)
      returning id into saved_id;
  else
    update public.audience_circles c set name = chosen_name
      where c.id = circle_id and c.owner_id = actor returning c.id into saved_id;
    if saved_id is null then
      raise exception 'This circle is unavailable.' using errcode = '42501';
    end if;
    delete from public.audience_circle_members m where m.circle_id = saved_id;
  end if;
  insert into public.audience_circle_members(circle_id, friend_id)
    select saved_id, unnest(selected);
  return saved_id;
end;
$$;

create function public.delete_audience_circle(circle_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  perform p.id from public.profiles p where p.id = actor for update;
  delete from public.audience_circles c where c.id = circle_id and c.owner_id = actor;
  if not found then raise exception 'This circle is unavailable.' using errcode = '42501'; end if;
end;
$$;

-- Prune both owners' saved memberships permanently when a friendship ends.
-- Existing social revocation triggers remain unchanged and continue to remove
-- post/plan grants, reactions and attendance. A later friendship adds nothing.
create function yeto_private.prune_audience_circles_after_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.audience_circle_members m using public.audience_circles c
    where c.id = m.circle_id and (
      (c.owner_id = old.user_a and m.friend_id = old.user_b)
      or (c.owner_id = old.user_b and m.friend_id = old.user_a)
    );
  return old;
end;
$$;
create trigger prune_audience_circles_after_friendship after delete on public.friendships
  for each row execute function yeto_private.prune_audience_circles_after_friendship();

-- Also handle an inserted block before/without friendship cleanup. The normal
-- block RPC locks both profiles and deletes friendship in the same transaction.
create function yeto_private.prune_audience_circles_after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.audience_circle_members m using public.audience_circles c
    where c.id = m.circle_id and (
      (c.owner_id = new.blocker_id and m.friend_id = new.blocked_id)
      or (c.owner_id = new.blocked_id and m.friend_id = new.blocker_id)
    );
  return new;
end;
$$;
create trigger prune_audience_circles_after_block after insert on public.blocks
  for each row execute function yeto_private.prune_audience_circles_after_block();

revoke all on function yeto_private.prune_audience_circles_after_friendship(),
  yeto_private.prune_audience_circles_after_block() from public, anon, authenticated, service_role;
revoke all on function public.audience_circles_snapshot(), public.save_audience_circle(uuid,text,uuid[]),
  public.delete_audience_circle(uuid) from public, anon, authenticated, service_role;
grant execute on function public.audience_circles_snapshot(), public.save_audience_circle(uuid,text,uuid[]),
  public.delete_audience_circle(uuid) to authenticated;

comment on table public.audience_circles is 'Owner-private saved recipient shortcuts; never live access grants.';
comment on table public.audience_circle_members is 'Current friends saved by the circle owner. No location access. Publishing copies UUIDs into the existing fixed audience/invitation tables.';

notify pgrst, 'reload schema';

commit;
