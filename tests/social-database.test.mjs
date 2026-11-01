import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Isolated PostgreSQL permissions tests only. This minimal scaffold does NOT
// execute the existing Supabase account setup or contact any hosted database.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const future = "2099-11-01T15:00:00+08:00";

async function as(actor, sql, params = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [actor ?? ""]);
    return tx.query(sql, params);
  });
}
async function scalar(actor, sql, params = []) {
  const result = await as(actor, sql, params);
  return Object.values(result.rows[0])[0];
}
const snap = (actor) => scalar(actor, "select public.social_snapshot()");
const post = (actor = A, viewers = [B], body = "Home safely!") => scalar(actor,
  "select public.create_social_post($1,$2::uuid[])", [body, viewers]);
const plan = (actor = A, viewers = [B], title = "Coffee together") => scalar(actor,
  "select public.create_social_plan($1,$2,$3::timestamptz,$4,$5::uuid[])", [title, "BGC café", future, "coffee", viewers]);
const like = (actor, id, liked = true) => as(actor, "select public.set_social_like($1,$2)", [id, liked]);
const comment = (actor, id, body = "Ingat!") => scalar(actor, "select public.add_social_comment($1,$2)", [id, body]);
async function unfriend(a = A, b = B) {
  await db.query("delete from public.friendships where user_a=$1 and user_b=$2", [a, b]);
}
async function befriend(a = A, b = B) {
  await db.query("insert into public.friendships(user_a,user_b) values($1,$2)", [a, b]);
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
  await db.exec(await readFile(new URL("../supabase/migrations/202611010001_social_feed_and_plans.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await db.exec("truncate public.profiles,public.friendships,public.blocks cascade");
  for (const [i, id] of [A, B, C, D].entries()) {
    await db.query("insert into public.profiles values($1,$2,$3)", [id, `person_${i}`, ["Ana Real", "Bea Real", "Luis Real", "Paolo Real"][i]]);
  }
  await befriend(A, B);
  await befriend(A, C);
});
after(async () => { await db.close(); });

test("private defaults and explicit audiences do not expose updates to other friends", async () => {
  const privatePost = await post(A, []);
  const selectedPost = await post();
  assert.equal((await snap(A)).posts.length, 2);
  assert.deepEqual((await snap(B)).posts.map((p) => p.id), [selectedPost]);
  assert.equal((await snap(C)).posts.length, 0);
  assert.equal((await snap(D)).posts.length, 0);
  assert.equal((await as(C, "select * from public.social_posts")).rows.length, 0);
  assert.equal((await snap(A)).posts.find((p) => p.id === privatePost).audience_count, 0);
  assert.equal((await snap(B)).posts[0].audience_count, 1);
});

test("anonymous users, missing identity and direct writes cannot bypass RPC authorization", async () => {
  const id = await post();
  for (const sql of ["select public.social_snapshot()", "select * from public.social_posts", "select * from public.social_plans"])
    await assert.rejects(as(null, sql, [], "anon"), /permission denied/);
  await assert.rejects(as(null, "select public.social_snapshot()"), /Sign in first/);
  await assert.rejects(post(null, []), /Sign in first/);
  await assert.rejects(as(B, "insert into public.social_post_likes(post_id,user_id) values($1,$2)", [id, A]), /permission denied/);
  await assert.rejects(as(B, "update public.social_posts set author_id=$1", [B]), /permission denied/);
  await assert.rejects(as(B, "delete from public.social_plans"), /permission denied/);
  await assert.rejects(as(B, "select yeto_private.check_social_viewers($1::uuid[])", [[A]]), /permission denied/);
});

test("RPC audience validation rejects strangers, own ID, blocked IDs, null IDs and oversized lists atomically", async () => {
  await assert.rejects(post(A, [D]), /current, unblocked friends/);
  await assert.rejects(plan(A, [D]), /current, unblocked friends/);
  await assert.rejects(post(A, [A]), /current, unblocked friends/);
  await assert.rejects(post(A, [B, null]), /up to 50/);
  await assert.rejects(post(A, Array(51).fill(B)), /up to 50/);
  await db.query("insert into public.blocks values($1,$2)", [B, A]);
  await assert.rejects(post(A, [B]), /current, unblocked friends/);
  assert.deepEqual(await snap(A), { posts: [], plans: [] });
});

test("likes and comments bind authorship to auth.uid and require current post access", async () => {
  const id = await post();
  await like(B, id);
  await like(B, id); // Idempotent desired state, never double count.
  const cid = await comment(B, id, "  See you soon!  ");
  const shared = (await snap(A)).posts[0];
  assert.equal(shared.like_count, 1);
  assert.equal(shared.comments[0].author.id, B);
  assert.equal(shared.comments[0].body, "See you soon!");
  assert.equal((await snap(B)).posts[0].liked_by_me, true);
  await assert.rejects(like(C, id), /unavailable/);
  await assert.rejects(comment(D, id), /unavailable/);
  await assert.rejects(as(A, "select public.delete_social_comment($1)", [cid]), /Only the author/);
  await as(B, "select public.delete_social_comment($1)", [cid]);
  await like(B, id, false);
  assert.equal((await snap(A)).posts[0].like_count, 0);
  assert.equal((await snap(A)).posts[0].comments.length, 0);
});

test("only the post author can delete, with cascading comments/likes/audience deletion", async () => {
  const id = await post();
  await like(B, id);
  await comment(B, id);
  await assert.rejects(as(B, "select public.delete_social_post($1)", [id]), /Only the author/);
  await as(A, "select public.delete_social_post($1)", [id]);
  assert.equal((await snap(B)).posts.length, 0);
  for (const table of ["social_post_likes", "social_post_comments", "social_post_audience"])
    assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
});

test("plan invitations are explicit; only host and invitees can see attendee names or RSVP", async () => {
  const id = await plan();
  assert.equal((await snap(C)).plans.length, 0);
  const before = (await snap(B)).plans[0];
  assert.equal(before.owner.id, A);
  assert.deepEqual(before.invitees.map((p) => p.id), [B]);
  assert.deepEqual(before.attendees.map((p) => p.id), [A]);
  await assert.rejects(as(C, "select public.set_social_attendance($1,true)", [id]), /unavailable/);
  await as(B, "select public.set_social_attendance($1,true)", [id]);
  await as(B, "select public.set_social_attendance($1,true)", [id]);
  assert.equal((await snap(A)).plans[0].attendees.length, 2);
  await as(B, "select public.set_social_attendance($1,false)", [id]);
  assert.deepEqual((await snap(A)).plans[0].attendees.map((p) => p.id), [A]);
  await assert.rejects(as(A, "select public.set_social_attendance($1,false)", [id]), /Organizers stay/);
});

test("only the organizer cancels a plan and cancellation removes invitations and attendance", async () => {
  const id = await plan();
  await assert.rejects(as(B, "select public.delete_social_plan($1)", [id]), /Only the organizer/);
  await as(A, "select public.delete_social_plan($1)", [id]);
  assert.equal((await snap(B)).plans.length, 0);
  assert.equal((await db.query("select * from public.social_plan_attendees")).rows.length, 0);
  assert.equal((await db.query("select * from public.social_plan_invites")).rows.length, 0);
});

test("unfriend revokes audiences, interactions and invitations permanently in both directions", async () => {
  const aPost = await post(A, [B]);
  const bPost = await post(B, [A]);
  const aPlan = await plan(A, [B]);
  const bPlan = await plan(B, [A]);
  await like(B, aPost);
  await comment(B, aPost);
  await as(B, "select public.set_social_attendance($1,true)", [aPlan]);
  await unfriend();
  assert.deepEqual((await snap(A)).posts.map((p) => p.id), [aPost]);
  assert.deepEqual((await snap(B)).posts.map((p) => p.id), [bPost]);
  assert.deepEqual((await snap(A)).plans.map((p) => p.id), [aPlan]);
  assert.deepEqual((await snap(B)).plans.map((p) => p.id), [bPlan]);
  assert.equal((await snap(A)).posts[0].like_count, 0);
  assert.equal((await snap(A)).posts[0].comments.length, 0);
  await befriend();
  assert.equal((await snap(B)).posts.length, 1, "Old grants must not return on re-friending");
  assert.equal((await snap(B)).plans.length, 1);
  await assert.rejects(like(B, aPost), /unavailable/);
});

test("blocking either direction hides content immediately even before friendship cleanup", async () => {
  const id = await post();
  const pid = await plan();
  await db.query("insert into public.blocks values($1,$2)", [B, A]);
  assert.deepEqual(await snap(B), { posts: [], plans: [] });
  await assert.rejects(comment(B, id), /unavailable/);
  await assert.rejects(as(B, "select public.set_social_attendance($1,true)", [pid]), /unavailable/);
});

test("participants blocked from each other cannot inspect comment, reaction or attendance identities", async () => {
  const id = await post(A, [B, C]);
  const pid = await plan(A, [B, C]);
  await like(B, id);
  await comment(B, id);
  await as(B, "select public.set_social_attendance($1,true)", [pid]);
  await db.query("insert into public.blocks values($1,$2)", [B, C]);
  const visible = await snap(C);
  assert.equal(visible.posts[0].like_count, 0);
  assert.equal(visible.posts[0].comments.length, 0);
  assert.deepEqual(visible.plans[0].invitees.map((p) => p.id), [C]);
  assert.deepEqual(visible.plans[0].attendees.map((p) => p.id), [A]);
  assert.equal((await snap(A)).posts[0].comments[0].author.id, B);
});

test("server rejects invalid content, stale times, unknown plan types and forged ids", async () => {
  for (const body of ["", "    ", "\n\t", "x".repeat(241)]) await assert.rejects(post(A, [], body), /1–240/);
  const id = await post();
  await assert.rejects(comment(B, id, "x".repeat(241)), /1–240/);
  for (const [title, place, starts, kind] of [
    [" ", "Cafe", future, "coffee"], ["Coffee", "", future, "coffee"],
    ["Coffee", "Cafe", "2020-01-01", "coffee"], ["Coffee", "Cafe", "infinity", "coffee"],
    ["Coffee", "Cafe", future, "unknown"],
  ]) await assert.rejects(as(A, "select public.create_social_plan($1,$2,$3::timestamptz,$4,$5::uuid[])", [title, place, starts, kind, []]), /title, place, future date/);
  await assert.rejects(as(B, "select public.delete_social_post($1)", [D]), /unavailable/);
  await assert.rejects(as(B, "select public.set_social_attendance($1,true)", [D]), /unavailable/);
  await assert.rejects(like(B, id, null), /like or unlike/);
});
