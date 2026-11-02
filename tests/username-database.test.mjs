import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// This in-memory scaffold does not execute old setup SQL, create hosted accounts,
// contact Supabase, or alter the existing project's data.
const db = new PGlite();
const OLD_CUSTOM = "10000000-0000-4000-8000-000000000001";
const OLD_DEFAULT = "20000000-0000-4000-8000-000000000002";
let oldFunctionOid;
let oldTriggerOid;

const idFor = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function signup(n, metadata = { display_name: "New Person" }) {
  const id = idFor(n);
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)", [
    id, `private-${n}@example.test`, JSON.stringify(metadata),
  ]);
  const result = await db.query("select * from public.profiles where id=$1", [id]);
  return result.rows[0];
}

before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema yeto_private;
    grant usage on schema yeto_private to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create table public.profiles(
      id uuid primary key references auth.users(id) on delete cascade,
      username text not null unique check(username ~ '^[a-z0-9_]{3,40}$'),
      display_name text not null check(char_length(display_name) between 1 and 60
        and display_name=btrim(display_name) and display_name !~ '[[:cntrl:]]' and display_name ~ '[^[:space:]]')
    );
    alter default privileges grant execute on functions to anon,authenticated,service_role;
    create function yeto_private.handle_new_user()
    returns trigger language plpgsql security definer set search_path='' as $$
    begin
      insert into public.profiles values(new.id,'yeto_'||replace(new.id::text,'-',''),'Existing Person');
      return new;
    end;
    $$;
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function yeto_private.handle_new_user();
    insert into auth.users(id,email) values
      ('${OLD_CUSTOM}','old-custom@example.test'),('${OLD_DEFAULT}','old-default@example.test');
    update public.profiles set username='my_chosen_name' where id='${OLD_CUSTOM}';
  `);
  oldFunctionOid = (await db.query("select 'yeto_private.handle_new_user()'::regprocedure::oid as oid")).rows[0].oid;
  oldTriggerOid = (await db.query("select oid from pg_trigger where tgname='on_auth_user_created'")).rows[0].oid;
  await db.exec(await readFile(new URL("../supabase/migrations/202611020001_playful_signup_usernames.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await db.query("delete from auth.users where id not in ($1,$2)", [OLD_CUSTOM, OLD_DEFAULT]);
});
after(async () => { await db.close(); });

test("upgrade preserves existing custom/default usernames and the existing signup trigger", async () => {
  const rows = (await db.query("select * from public.profiles order by id")).rows;
  assert.deepEqual(rows, [
    { id: OLD_CUSTOM, username: "my_chosen_name", display_name: "Existing Person" },
    { id: OLD_DEFAULT, username: `yeto_${OLD_DEFAULT.replaceAll("-", "")}`, display_name: "Existing Person" },
  ]);
  assert.equal((await db.query("select 'yeto_private.handle_new_user()'::regprocedure::oid as oid")).rows[0].oid, oldFunctionOid);
  assert.equal((await db.query("select oid from pg_trigger where tgname='on_auth_user_created'")).rows[0].oid, oldTriggerOid);
});

test("new accounts receive varied safe friendly names without exposing email or account UUID", async () => {
  await db.exec("select pg_catalog.setseed(0.217)");
  const handles = [];
  for (let n = 1; n <= 48; n += 1) {
    const profile = await signup(n);
    assert.match(profile.username, /^[a-z]+_[a-z]+_[0-9]{4}$/);
    assert.ok(profile.username.length <= 40);
    assert.equal(profile.username.includes("yeto"), false);
    assert.equal(profile.username.includes("private"), false);
    assert.equal(profile.username.includes(profile.id.replaceAll("-", "")), false);
    handles.push(profile.username);
  }
  assert.equal(new Set(handles).size, handles.length);
  assert.ok(new Set(handles.map((handle) => handle.split("_")[0])).size > 1);
  assert.ok(new Set(handles.map((handle) => handle.split("_")[1])).size > 1);
});

test("new display names retain sanitization and ignore a forged username in metadata", async () => {
  const valid = await signup(1, { display_name: "  JuanTv  ", username: "my_chosen_name" });
  assert.equal(valid.display_name, "JuanTv");
  assert.notEqual(valid.username, "my_chosen_name");
  assert.equal((await signup(2, { display_name: "\t\n " })).display_name, "TARA friend");
  assert.equal((await signup(3, { display_name: " A\tB\nC " })).display_name, "A B C");
  assert.equal((await signup(4, { display_name: "x".repeat(80) })).display_name, "x".repeat(60));
});

test("a reserved short-name collision retries without overwriting the existing owner", async () => {
  await db.exec("select pg_catalog.setseed(0.372)");
  const first = await signup(1);
  await db.exec("select pg_catalog.setseed(0.372)");
  const second = await signup(2);
  assert.notEqual(second.username, first.username);
  assert.match(second.username, /^[a-z]+_[a-z]+_[0-9]{4}$/);
  assert.deepEqual((await db.query("select * from public.profiles where id=$1", [first.id])).rows[0], first);
});

test("exhausted short-name retries use a valid playful UUID fallback", async () => {
  await db.exec("select pg_catalog.setseed(0.491)");
  for (let n = 1; n <= 12; n += 1) await signup(n);
  await db.exec("select pg_catalog.setseed(0.491)");
  const fallback = await signup(13);
  assert.match(fallback.username, /^taho_[0-9a-f]{32}$/);
  assert.equal(fallback.username.length, 37);
  assert.equal(fallback.username.includes(fallback.id.replaceAll("-", "")), false);
  assert.equal((await db.query("select count(*)::integer as count from public.profiles")).rows[0].count, 15);
});

test("unrelated unique violations propagate instead of being retried or swallowed", async () => {
  await db.exec("alter table public.profiles add constraint unrelated_display_name_unique unique(display_name)").catch(async () => {
    // The preserved legacy rows deliberately share a name; temporarily separate
    // only this local fixture before adding an unrelated uniqueness constraint.
    await db.query("update public.profiles set display_name='Other Existing Person' where id=$1", [OLD_DEFAULT]);
    await db.exec("alter table public.profiles add constraint unrelated_display_name_unique unique(display_name)");
  });
  try {
    await signup(1, { display_name: "One Shared Name" });
    await assert.rejects(signup(2, { display_name: "One Shared Name" }), (error) => {
      assert.equal(error.code, "23505");
      assert.equal(error.constraint, "unrelated_display_name_unique");
      return true;
    });
    assert.equal((await db.query("select count(*)::integer as count from auth.users where id=$1", [idFor(2)])).rows[0].count, 0);
  } finally {
    await db.exec("alter table public.profiles drop constraint unrelated_display_name_unique");
    await db.query("update public.profiles set display_name='Existing Person' where id=$1", [OLD_DEFAULT]);
  }
});

test("the definer trigger keeps fixed search_path and has no direct public/API-role execution grants", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const result = await db.query("select has_function_privilege($1,'yeto_private.handle_new_user()','EXECUTE') as allowed", [role]);
    assert.equal(result.rows[0].allowed, false, role);
  }
  const fn = (await db.query("select prosecdef,proconfig from pg_proc where oid='yeto_private.handle_new_user()'::regprocedure")).rows[0];
  assert.equal(fn.prosecdef, true);
  assert.deepEqual(fn.proconfig, ['search_path=""']);
  const user = await signup(1);
  assert.match(user.username, /^[a-z]+_[a-z]+_[0-9]{4}$/);
});
