-- TARA: give NEW accounts friendly random usernames instead of yeto_<UUID>.
-- Apply this upgrade once to the EXISTING project. Do not rerun account setup.
-- Existing profiles, usernames, relationships, posts, and plans are untouched.
begin;

-- Replacing the function preserves the existing signup trigger and function OID.
-- Display names keep the original sanitization rules. Client-supplied username
-- metadata is deliberately ignored: the unique profile constraint is authoritative.
create or replace function yeto_private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  adjectives constant text[] := array[
    'bouncy','sleepy','happy','wiggly','jolly','silly','sunny','cozy',
    'tiny','zippy','bubbly','dancing','giggle','cheery','chill','wobbly'
  ];
  foods constant text[] := array[
    'taho','pandesal','lumpia','mango','pancit','adobo','buko','calamansi',
    'halohalo','bibingka','turon','suman','kutsinta','sago','siopao','ube'
  ];
  chosen_name text;
  chosen_username text;
  attempt integer := 0;
  collided_constraint text;
begin
  chosen_name := btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '[[:cntrl:]]', ' ', 'g')), 60));
  if chosen_name = '' then chosen_name := 'TARA friend'; end if;

  loop
    attempt := attempt + 1;
    if attempt <= 12 then
      chosen_username := adjectives[1 + floor(pg_catalog.random() * array_length(adjectives, 1))::integer]
        || '_' || foods[1 + floor(pg_catalog.random() * array_length(foods, 1))::integer]
        || '_' || lpad(floor(pg_catalog.random() * 10000)::integer::text, 4, '0');
    else
      -- Exhausted the short-name attempts: a fresh UUID gives a 37-character
      -- playful fallback unrelated to the account ID or email. Even this path
      -- retries on a username collision rather than making signup fail.
      chosen_username := 'taho_' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    end if;

    begin
      insert into public.profiles(id, username, display_name)
      values (new.id, chosen_username, chosen_name);
      return new;
    exception when unique_violation then
      get stacked diagnostics collided_constraint = constraint_name;
      -- Do not hide other data/constraint errors or retry a profile-ID conflict.
      if collided_constraint is distinct from 'profiles_username_key' then
        raise;
      end if;
    end;
  end loop;
end;
$$;

-- Trigger-only function; retain protection even with permissive default grants.
revoke all on function yeto_private.handle_new_user()
  from public, anon, authenticated, service_role;

commit;
