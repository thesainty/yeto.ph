import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Isolated PostgreSQL semantics, never a hosted database or a rerun of account
// setup. The scaffold models the already-installed account objects and grants.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const FUTURE = "2099-11-01T15:00:00+08:00";
let preservedBefore;
let preservedAfter;

async function as(actor, sql, params = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [actor ?? ""]);
    return tx.query(sql, params);
  });
}
async function scalar(actor, sql, params = []) {
  return Object.values((await as(actor, sql, params)).rows[0])[0];
}
const circles = (actor = A) => scalar(actor, "select public.audience_circles_snapshot()");
const save = (actor = A, name = "Pamilya", members = [B], id = null) => scalar(actor,
  "select public.save_audience_circle($1,$2,$3::uuid[])", [id, name, members]);
const remove = (actor, id) => as(actor, "select public.delete_audience_circle($1)", [id]);
const snapshot = (actor) => scalar(actor, "select public.social_snapshot()");
const post = (actor = A, members = [B], body = "Before the circle changed") => scalar(actor,
  "select public.create_social_post($1,$2::uuid[])", [body, members]);
const plan = (actor = A, members = [B]) => scalar(actor,
  "select public.create_social_plan($1,$2,$3::timestamptz,$4,$5::uuid[])",
  ["Coffee", "BGC café", FUTURE, "coffee", members]);
const befriend = (a, b) => db.query("insert into public.friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid))", [a, b]);
const unfriend = (a, b) => db.query("delete from public.friendships where user_a=least($1::uuid,$2::uuid) and user_b=greatest($1::uuid,$2::uuid)", [a, b]);

async function seed() {
  for (const [i, id] of [A, B, C, D].entries()) {
    await db.query("insert into public.profiles values($1,$2,$3)", [id, `person_${i}`, ["Ana", "Bea", "Luis", "Paolo"][i]]);
  }
  await befriend(A, B);
  await befriend(A, C);
}

before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create schema yeto_private;
    grant usage on schema yeto_private to authenticated;
    create table public.profiles(id uuid primary key,username text,display_name text);
    create table public.friendships(id uuid primary key default gen_random_uuid(),user_a uuid,user_b uuid,unique(user_a,user_b));
    create table public.blocks(blocker_id uuid,blocked_id uuid,primary key(blocker_id,blocked_id));
    create table public.friend_requests(id uuid primary key default gen_random_uuid(),requester_id uuid,recipient_id uuid,status text,updated_at timestamptz);
    create function yeto_private.is_blocked_with(other_id uuid)
    returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.blocks b where
        (b.blocker_id=auth.uid() and b.blocked_id=other_id) or
        (b.blocker_id=other_id and b.blocked_id=auth.uid()));
    $$;
    create function yeto_private.lock_pair(first_id uuid,second_id uuid)
    returns void language plpgsql security definer set search_path='' as $$
      begin perform p.id from public.profiles p where p.id in(first_id,second_id) order by p.id for update; end;
    $$;
    revoke all on function yeto_private.lock_pair(uuid,uuid) from public;
    alter table public.profiles enable row level security;
    create policy profiles_read on public.profiles for select to authenticated
      using(auth.uid() is not null and (id=auth.uid() or not yeto_private.is_blocked_with(id)));
    grant select on public.profiles to authenticated;
    alter default privileges grant all on tables to anon, authenticated, service_role;
    alter default privileges grant execute on functions to anon, authenticated, service_role;
  `);
  // Execute the actual installed account RPC definitions rather than rebuilding
  // or rerunning the old account migration. This exercises the real remove/block
  // transaction paths against the additive circle and social triggers.
  const accountsSql = await readFile(new URL("../supabase/migrations/202610310001_accounts_and_friends.sql", import.meta.url), "utf8");
  const relationshipRpcs = [...accountsSql.matchAll(/create function public\.(remove_friend|block_person)\(target_id uuid\)[\s\S]*?^\$\$;/gm)];
  assert.equal(relationshipRpcs.length, 2);
  for (const [sql] of relationshipRpcs) await db.exec(sql);
  await db.exec("revoke all on function public.remove_friend(uuid), public.block_person(uuid) from public,anon,authenticated,service_role; grant execute on function public.remove_friend(uuid),public.block_person(uuid) to authenticated");
  await db.exec(await readFile(new URL("../supabase/migrations/202611010001_social_feed_and_plans.sql", import.meta.url), "utf8"));
  await seed();
  await post();
  await plan();
  preservedBefore = {
    profiles: (await db.query("select * from public.profiles order by id")).rows,
    friendships: (await db.query("select * from public.friendships order by id")).rows,
    social: await snapshot(A),
  };
  await db.exec(await readFile(new URL("../supabase/migrations/202611020002_saved_audience_circles.sql", import.meta.url), "utf8"));
  preservedAfter = {
    profiles: (await db.query("select * from public.profiles order by id")).rows,
    friendships: (await db.query("select * from public.friendships order by id")).rows,
    social: await snapshot(A),
  };
});
beforeEach(async () => {
  await db.exec("truncate public.profiles,public.friendships,public.blocks cascade");
  await seed();
});
after(async () => { await db.close(); });

test("the additive upgrade preserves all existing profiles, relationships, posts and plan grants", async () => {
  assert.deepEqual(preservedAfter, preservedBefore);
  assert.deepEqual(await circles(), []);
});

test("saved circles and their membership are visible only to their owner, including members", async () => {
  const id = await save();
  const own = await circles();
  assert.deepEqual(own, [{ id, name: "Pamilya", member_ids: [B] }]);
  for (const actor of [B, C, D]) {
    assert.deepEqual(await circles(actor), []);
    assert.deepEqual((await as(actor, "select * from public.audience_circles")).rows, []);
    assert.deepEqual((await as(actor, "select * from public.audience_circle_members")).rows, []);
  }
  const other = await save(B, "Pamilya", [A]);
  assert.notEqual(other, id, "Different owners may independently use the same private name");
  assert.deepEqual((await circles(B)).map((c) => c.id), [other]);
});

test("anonymous, missing-identity and inherited platform grants cannot read, write or invoke helpers", async () => {
  const id = await save();
  for (const sql of ["select public.audience_circles_snapshot()", "select public.save_audience_circle(null,'Circle','{}')", `select public.delete_audience_circle('${id}')`, "select * from public.audience_circles", "select * from public.audience_circle_members"]) {
    await assert.rejects(as(null, sql, [], "anon"), /permission denied/);
  }
  await assert.rejects(circles(null), /Sign in first/);
  await assert.rejects(save(null), /Sign in first/);
  await assert.rejects(remove(null, id), /Sign in first/);
  for (const sql of [
    `insert into public.audience_circles(owner_id,name) values('${B}','Spoof')`,
    `update public.audience_circles set name='Bypass' where id='${id}'`,
    `delete from public.audience_circles where id='${id}'`,
    `insert into public.audience_circle_members values('${id}','${C}')`,
    `delete from public.audience_circle_members where circle_id='${id}'`,
    `select yeto_private.check_social_viewers(array['${B}'::uuid])`,
    "select yeto_private.prune_audience_circles_after_friendship()",
    "select yeto_private.prune_audience_circles_after_block()",
  ]) await assert.rejects(as(A, sql), /permission denied/);
  await assert.rejects(as(A, "select * from public.audience_circles", [], "service_role"), /permission denied/);
});

test("owners can create empty circles, rename, replace members and delete; forged IDs cannot mutate them", async () => {
  const id = await save(A, "  Pamilya  ", []);
  assert.deepEqual(await circles(), [{ id, name: "Pamilya", member_ids: [] }]);
  assert.equal(await save(A, "Close friends", [B, C, B], id), id);
  assert.deepEqual(await circles(), [{ id, name: "Close friends", member_ids: [B, C] }]);
  await assert.rejects(save(B, "Stolen", [A], id), /unavailable/);
  await assert.rejects(remove(B, id), /unavailable/);
  await assert.rejects(save(A, "Missing", [], D), /unavailable/);
  await assert.rejects(remove(A, D), /unavailable/);
  assert.equal((await circles())[0].name, "Close friends");
  await remove(A, id);
  assert.deepEqual(await circles(), []);
  assert.equal((await db.query("select * from public.audience_circle_members")).rows.length, 0);
});

test("circle names reject blanks, controls and oversize values; duplicate rename is atomic", async () => {
  for (const name of [null, "", "   ", "\n\t", "Pamilya\n", "x".repeat(41)]) {
    await assert.rejects(save(A, name, []), /1–40 visible/);
  }
  const first = await save(A, "Pamilya", [B]);
  const second = await save(A, "Barkada", [C]);
  await assert.rejects(save(A, "pamilya", []), /duplicate key/);
  await assert.rejects(save(A, "PAMILYA", [B], second), /duplicate key/);
  const rows = await circles();
  assert.deepEqual(rows.find((c) => c.id === first).member_ids, [B]);
  assert.deepEqual(rows.find((c) => c.id === second), { id: second, name: "Barkada", member_ids: [C] });
});

test("circle membership accepts only current unblocked friends; failed replacements leave data intact", async () => {
  const id = await save();
  for (const members of [[A], [D], [B, null]]) {
    await assert.rejects(save(A, "Changed", members, id), /current.*friends/);
  }
  await db.query("insert into public.blocks values($1,$2)", [C, A]);
  await assert.rejects(save(A, "Changed", [C], id), /current, unblocked friends/);
  assert.deepEqual(await circles(), [{ id, name: "Pamilya", member_ids: [B] }]);
});

test("the 50-circle account quota permits renaming and frees a slot after deletion", async () => {
  const ids = [];
  for (let i = 0; i < 50; i += 1) ids.push(await save(A, `Circle ${i}`, []));
  await assert.rejects(save(A, "One too many", []), /up to 50 saved circles/);
  await save(A, "Renamed at capacity", [B], ids[0]);
  await remove(A, ids[1]);
  await save(A, "A free slot", []);
  assert.equal((await circles()).length, 50);
});

test("500 real friends work for circles, posts and plans; 501 is rejected without partial writes", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  await db.query("insert into public.profiles select id, 'large_' || row_number() over(), 'Friend ' || row_number() over() from unnest($1::uuid[]) id", [ids]);
  await db.query("insert into public.friendships(user_a,user_b) select $1::uuid, unnest($2::uuid[])", [A, ids]);
  const fiveHundred = ids.slice(0, 500);
  const circleId = await save(A, "A large circle", fiveHundred);
  const postId = await post(A, fiveHundred);
  const planId = await plan(A, fiveHundred);
  assert.equal((await circles())[0].member_ids.length, 500);
  assert.equal((await db.query("select * from public.social_post_audience where post_id=$1", [postId])).rows.length, 500);
  assert.equal((await db.query("select * from public.social_plan_invites where plan_id=$1", [planId])).rows.length, 500);
  await assert.rejects(save(A, "Too many", ids, circleId), /up to 500/);
  await assert.rejects(post(A, ids), /up to 500/);
  await assert.rejects(plan(A, ids), /up to 500/);
  // Retain the bounded submitted-array rule, including repeated IDs.
  await assert.rejects(post(A, Array(501).fill(B)), /up to 500/);
  assert.equal((await circles())[0].name, "A large circle");
  assert.equal((await db.query("select * from public.social_posts")).rows.length, 1);
  assert.equal((await db.query("select * from public.social_plans")).rows.length, 1);
});

test("overlapping circles deduplicate recipient UUIDs without duplicate grants", async () => {
  const id = await save(A, "Close friends", [B, B, C]);
  assert.deepEqual((await circles()).find((c) => c.id === id).member_ids, [B, C]);
  const postId = await post(A, [B, C, B]);
  const planId = await plan(A, [B, C, B]);
  assert.equal((await db.query("select * from public.social_post_audience where post_id=$1", [postId])).rows.length, 2);
  assert.equal((await db.query("select * from public.social_plan_invites where plan_id=$1", [planId])).rows.length, 2);
});

test("publishing snapshots recipients: circle edits, deletion and newly accepted friends never expand older access", async () => {
  const id = await save();
  const selected = (await circles())[0].member_ids;
  const postId = await post(A, selected);
  const planId = await plan(A, selected);
  await save(A, "More friends now", [B, C], id);
  await befriend(A, D);
  await save(A, "Everyone now", [B, C, D], id);
  assert.deepEqual((await snapshot(B)).posts.map((p) => p.id), [postId]);
  assert.deepEqual((await snapshot(B)).plans.map((p) => p.id), [planId]);
  for (const actor of [C, D]) assert.deepEqual(await snapshot(actor), { posts: [], plans: [] });
  await save(A, "Empty now", [], id);
  await remove(A, id);
  assert.equal((await snapshot(B)).posts.length, 1, "Circle deletion does not rewrite published audiences");
  assert.equal((await snapshot(B)).plans.length, 1);
  await post(A, []);
  await plan(A, []);
  assert.equal((await snapshot(B)).posts.length, 1, "Only-me posts stay private");
  assert.equal((await snapshot(B)).plans.length, 1);
});

test("unfriending prunes both owners' circles and retains permanent social access revocation", async () => {
  const aCircle = await save(A, "Pamilya", [B, C]);
  const bCircle = await save(B, "Barkada", [A]);
  const postId = await post();
  const planId = await plan();
  await as(B, "select public.set_social_like($1,true)", [postId]);
  await as(B, "select public.add_social_comment($1,'Hello')", [postId]);
  await as(B, "select public.set_social_attendance($1,true)", [planId]);
  await unfriend(A, B);
  assert.deepEqual(await circles(A), [{ id: aCircle, name: "Pamilya", member_ids: [C] }]);
  assert.deepEqual(await circles(B), [{ id: bCircle, name: "Barkada", member_ids: [] }]);
  assert.deepEqual(await snapshot(B), { posts: [], plans: [] });
  assert.equal((await snapshot(A)).posts[0].like_count, 0);
  assert.deepEqual((await snapshot(A)).posts[0].comments, []);
  assert.deepEqual((await snapshot(A)).plans[0].attendees.map((p) => p.id), [A]);
  await befriend(A, B);
  assert.deepEqual((await circles(A))[0].member_ids, [C]);
  assert.deepEqual((await circles(B))[0].member_ids, []);
  assert.deepEqual(await snapshot(B), { posts: [], plans: [] });
  await assert.rejects(as(B, "select public.set_social_attendance($1,true)", [planId]), /unavailable/);
});

test("either-direction blocks immediately prune memberships; unblocking and re-friending do not restore them", async () => {
  await save(A, "Pamilya", [B, C]);
  await save(B, "Barkada", [A]);
  await db.query("insert into public.blocks values($1,$2)", [B, A]);
  assert.deepEqual((await circles(A))[0].member_ids, [C]);
  assert.deepEqual((await circles(B))[0].member_ids, []);
  await assert.rejects(save(A, "Pamilya", [B], (await circles())[0].id), /current, unblocked friends/);
  await unfriend(A, B); // Normal block RPC performs this in its transaction.
  await db.query("delete from public.blocks where blocker_id=$1 and blocked_id=$2", [B, A]);
  await befriend(A, B);
  assert.deepEqual((await circles(A))[0].member_ids, [C]);
  assert.deepEqual((await circles(B))[0].member_ids, []);
  await db.query("insert into public.blocks values($1,$2)", [A, C]);
  assert.deepEqual((await circles(A))[0].member_ids, []);
});

test("the existing authenticated remove and block RPCs prune circles and permanently revoke published access", async () => {
  await save(A, "Pamilya", [B, C]);
  await save(B, "Barkada", [A]);
  await save(C, "Close friends", [A]);
  await post(A, [B, C]);
  await plan(A, [B, C]);
  await as(A, "select public.remove_friend($1)", [B]);
  assert.deepEqual((await circles(A))[0].member_ids, [C]);
  assert.deepEqual((await circles(B))[0].member_ids, []);
  assert.deepEqual(await snapshot(B), { posts: [], plans: [] });
  await befriend(A, B);
  assert.deepEqual((await circles(A))[0].member_ids, [C]);
  assert.deepEqual(await snapshot(B), { posts: [], plans: [] });
  await as(C, "select public.block_person($1)", [A]);
  assert.deepEqual((await circles(A))[0].member_ids, []);
  assert.deepEqual((await circles(C))[0].member_ids, []);
  assert.deepEqual(await snapshot(C), { posts: [], plans: [] });
  await db.query("delete from public.blocks where blocker_id=$1 and blocked_id=$2", [C, A]);
  await befriend(A, C);
  assert.deepEqual((await circles(A))[0].member_ids, []);
  assert.deepEqual(await snapshot(C), { posts: [], plans: [] });
});
