import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Isolated PostgreSQL semantics only. Model installed account objects, install
// the real social/additive inbox SQL, and never contact a hosted database.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const FUTURE = "2099-11-01T15:00:00+08:00";
let preservedBefore;
let preservedAfter;
let initialA;
let initialB;
let oldRequest;
let oldPlan;

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
const inbox = (actor = A) => scalar(actor, "select public.activity_inbox_snapshot()");
const read = (actor, ids) => as(actor, "select public.mark_activity_read($1::uuid[])", [ids]);
const social = (actor) => scalar(actor, "select public.social_snapshot()");
const target = (actor, postId = null, planId = null) => scalar(actor,
  "select public.activity_target_snapshot($1::uuid,$2::uuid)", [postId, planId]);
const post = (actor = A, viewers = [B], body = "A private audience update") => scalar(actor,
  "select public.create_social_post($1,$2::uuid[])", [body, viewers]);
const plan = (actor = A, invitees = [B], title = "Coffee together") => scalar(actor,
  "select public.create_social_plan($1,$2,$3::timestamptz,$4,$5::uuid[])", [title, "BGC café", FUTURE, "coffee", invitees]);
const like = (actor, id, liked = true) => as(actor, "select public.set_social_like($1,$2)", [id, liked]);
const comment = (actor, id, body = "Ingat!") => scalar(actor,
  "select public.add_social_comment($1,$2)", [id, body]);
const rsvp = (actor, id, going) => as(actor, "select public.set_social_attendance($1,$2)", [id, going]);
const request = (actor, other) => scalar(actor, "select public.send_friend_request($1)", [other]);
const respond = (actor, id, accept) => as(actor, "select public.respond_friend_request($1,$2)", [id, accept]);
const befriend = (a, b) => db.query("insert into public.friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid))", [a, b]);

async function seed() {
  for (const [i, id] of [A, B, C, D].entries()) {
    await db.query("insert into public.profiles(id,username,display_name) values($1,$2,$3)",
      [id, `person_${i}`, ["Ana", "Bea", "Luis", "Paolo"][i]]);
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
    grant usage on schema auth to anon,authenticated;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create schema yeto_private;
    grant usage on schema yeto_private to authenticated;
    create table public.profiles(id uuid primary key,username text,display_name text);
    create table public.friendships(
      id uuid primary key default gen_random_uuid(),
      user_a uuid references public.profiles(id) on delete cascade,
      user_b uuid references public.profiles(id) on delete cascade,
      created_at timestamptz not null default now(),unique(user_a,user_b)
    );
    create table public.blocks(
      blocker_id uuid references public.profiles(id) on delete cascade,
      blocked_id uuid references public.profiles(id) on delete cascade,
      created_at timestamptz not null default now(),primary key(blocker_id,blocked_id)
    );
    create table public.friend_requests(
      id uuid primary key default gen_random_uuid(),
      requester_id uuid references public.profiles(id) on delete cascade,
      recipient_id uuid references public.profiles(id) on delete cascade,
      status text not null default 'pending',
      created_at timestamptz not null default now(),updated_at timestamptz not null default now()
    );
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
    alter table public.friend_requests enable row level security;
    create policy requests_read on public.friend_requests for select to authenticated
      using(auth.uid() in(requester_id,recipient_id) and not yeto_private.is_blocked_with(
        case when requester_id=auth.uid() then recipient_id else requester_id end));
    alter table public.friendships enable row level security;
    create policy friendships_read on public.friendships for select to authenticated
      using(auth.uid() in(user_a,user_b) and not yeto_private.is_blocked_with(
        case when user_a=auth.uid() then user_b else user_a end));
    alter table public.blocks enable row level security;
    create policy blocks_read on public.blocks for select to authenticated using(blocker_id=auth.uid());
    grant select on public.profiles,public.friend_requests,public.friendships,public.blocks to authenticated;
    alter default privileges grant all on tables to anon,authenticated,service_role;
    alter default privileges grant execute on functions to anon,authenticated,service_role;
  `);
  // Use the installed relationship workflows, not a rerun of old account setup.
  const accountSql = await readFile(new URL("../supabase/migrations/202610310001_accounts_and_friends.sql", import.meta.url), "utf8");
  const definitions = [...accountSql.matchAll(/create function public\.(send_friend_request|respond_friend_request|cancel_friend_request|remove_friend|block_person|unblock_person)\([\s\S]*?^\$\$;/gm)];
  assert.equal(definitions.length, 6);
  for (const [sql] of definitions) await db.exec(sql);
  for (const signature of ["send_friend_request(uuid)", "respond_friend_request(uuid,boolean)", "cancel_friend_request(uuid)", "remove_friend(uuid)", "block_person(uuid)", "unblock_person(uuid)"]) {
    await db.exec(`revoke all on function public.${signature} from public,anon,authenticated,service_role; grant execute on function public.${signature} to authenticated`);
  }
  await db.exec(await readFile(new URL("../supabase/migrations/202611010001_social_feed_and_plans.sql", import.meta.url), "utf8"));
  await seed();
  const oldPost = await post();
  await like(B, oldPost);
  await comment(B, oldPost, "Historic comment must not be copied into inbox events");
  oldPlan = await plan();
  oldRequest = await request(D, A);
  preservedBefore = {
    profiles: (await db.query("select * from public.profiles order by id")).rows,
    friendships: (await db.query("select * from public.friendships order by id")).rows,
    requests: (await db.query("select * from public.friend_requests order by id")).rows,
    social: await social(A),
  };
  await db.exec(await readFile(new URL("../supabase/migrations/202611020003_activity_inbox.sql", import.meta.url), "utf8"));
  preservedAfter = {
    profiles: (await db.query("select * from public.profiles order by id")).rows,
    friendships: (await db.query("select * from public.friendships order by id")).rows,
    requests: (await db.query("select * from public.friend_requests order by id")).rows,
    social: await social(A),
  };
  initialA = await inbox(A);
  initialB = await inbox(B);
});
beforeEach(async () => {
  await db.exec("truncate public.profiles,public.friendships,public.blocks,public.friend_requests cascade");
  await seed();
});
after(async () => { await db.close(); });

test("additive inbox installation preserves existing data and backfills pending requests/invitations only", async () => {
  assert.deepEqual(preservedAfter, preservedBefore);
  assert.equal(initialA.unread_count, 1);
  assert.equal(initialA.items[0].kind, "friend_request");
  assert.equal(initialA.items[0].request_id, oldRequest);
  assert.equal(initialB.unread_count, 1);
  assert.equal(initialB.items[0].kind, "plan_invite");
  assert.equal(initialB.items[0].plan_id, oldPlan);
  assert.deepEqual(await inbox(), { items: [], unread_count: 0 });
});

test("pending requests notify only their recipient; acceptance, decline and cancellation have correct lifecycles", async () => {
  const id = await request(D, A);
  const pending = await inbox(A);
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].actor.id, D);
  assert.equal(pending.items[0].request_id, id);
  assert.equal(pending.items[0].kind, "friend_request");
  assert.deepEqual(await inbox(D), { items: [], unread_count: 0 });
  await respond(A, id, true);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  const accepted = await inbox(D);
  assert.equal(accepted.items.length, 1);
  assert.equal(accepted.items[0].kind, "friend_accepted");
  assert.equal(accepted.items[0].actor.id, A);
  assert.equal(accepted.items[0].request_id, id);
  const declined = await request(D, B);
  await respond(B, declined, false);
  assert.deepEqual(await inbox(B), { items: [], unread_count: 0 });
  const cancelled = await request(C, D);
  await as(C, "select public.cancel_friend_request($1)", [cancelled]);
  assert.deepEqual(await inbox(D), accepted, "Cancelling must not create a new notification");
});

test("comments and likes notify only the author without self notifications or content copies", async () => {
  const id = await post(A, [B, C], "Only allowed viewers can read this private body");
  await like(A, id);
  await comment(A, id, "Self comment");
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  await like(B, id);
  await like(B, id); // Desired state is idempotent, so no duplicate event.
  const commentId = await comment(B, id, "A private comment body");
  const own = await inbox(A);
  assert.equal(own.items.length, 2);
  assert.equal(own.unread_count, 2);
  assert.deepEqual(new Set(own.items.map((item) => item.kind)), new Set(["post_like", "post_comment"]));
  assert(own.items.every((item) => item.actor.id === B && item.post_id === id && item.read_at === null));
  assert.equal(own.items.find((item) => item.kind === "post_comment").comment_id, commentId);
  const stored = JSON.stringify((await db.query("select * from public.activity_events")).rows);
  assert(!stored.includes("private body"));
  assert(!stored.includes("private comment body"));
  assert.deepEqual(await inbox(B), { items: [], unread_count: 0 });
  assert.deepEqual(await inbox(C), { items: [], unread_count: 0 });
  await like(B, id, false);
  assert.equal((await inbox(A)).items.length, 1);
  await as(B, "select public.delete_social_comment($1)", [commentId]);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
});

test("plan invitations notify invitees; RSVP join/leave coalesces and resets read status", async () => {
  const id = await plan(A, [B, C], "A chosen private plan");
  const invited = await inbox(B);
  assert.equal(invited.items.length, 1);
  assert.equal(invited.items[0].kind, "plan_invite");
  assert.equal(invited.items[0].plan_id, id);
  assert.equal(invited.items[0].plan_title, "A chosen private plan");
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 }, "Organizer attendance does not notify organizer");
  await rsvp(B, id, true);
  await rsvp(B, id, true);
  const joined = (await inbox(A)).items[0];
  assert.equal(joined.kind, "plan_rsvp");
  assert.equal(joined.actor.id, B);
  assert.equal(joined.rsvp_going, true);
  await read(A, [joined.id]);
  assert.equal((await inbox(A)).unread_count, 0);
  await rsvp(B, id, false);
  const left = await inbox(A);
  assert.equal(left.items.length, 1);
  assert.notEqual(left.items[0].id, joined.id, "A new RSVP revision needs a new ID so a delayed mark-read cannot consume it");
  assert.equal(left.items[0].rsvp_going, false);
  assert.equal(left.items[0].read_at, null);
  assert.equal(left.unread_count, 1);
  await read(A, [joined.id]);
  assert.equal((await inbox(A)).unread_count, 1, "Marking an older RSVP ID cannot mark the newer unseen state read");
  await rsvp(B, id, true);
  assert.equal((await inbox(A)).items.length, 1);
  assert.equal((await inbox(A)).items[0].rsvp_going, true);
});

test("RLS, grants and authenticated RPCs prevent direct writes, forged ownership and anonymous reads", async () => {
  const id = await post();
  await comment(B, id);
  const event = (await inbox(A)).items[0];
  assert.equal((await as(A, "select * from public.activity_events")).rows.length, 1);
  assert.deepEqual((await as(B, "select * from public.activity_events")).rows, []);
  for (const sql of ["select public.activity_inbox_snapshot()", "select public.mark_activity_read('{}')", "select * from public.activity_events", "select public.activity_target_snapshot(null,null)"]) {
    await assert.rejects(as(null, sql, [], "anon"), /permission denied/);
  }
  await assert.rejects(inbox(null), /Sign in first/);
  await assert.rejects(read(null, []), /Sign in first/);
  for (const sql of ["insert into public.activity_events default values", "update public.activity_events set read_at=now()", "delete from public.activity_events"]) {
    await assert.rejects(as(A, sql), /permission denied/);
  }
  await assert.rejects(as(A, "select * from public.activity_events", [], "service_role"), /permission denied/);
  await read(B, [event.id]);
  assert.equal((await inbox(A)).items[0].read_at, null, "Another recipient cannot mark this account's event read");
});

test("read state persists and exact-ID marking never reads someone else's event or concurrent unseen events", async () => {
  const postId = await post();
  await comment(B, postId, "First event");
  const first = (await inbox(A)).items[0];
  await plan();
  const other = (await inbox(B)).items[0];
  await comment(B, postId, "Newer unseen event");
  await read(A, [first.id, other.id, D]);
  const snapshot = await inbox(A);
  assert.equal(snapshot.unread_count, 1);
  assert(snapshot.items.find((item) => item.id === first.id).read_at);
  assert.equal(snapshot.items.find((item) => item.id !== first.id).read_at, null);
  assert.equal((await inbox(B)).unread_count, 1);
  assert.deepEqual(await inbox(A), snapshot, "Read status is persisted in the account database");
  await read(A, []);
  await read(A, null);
  await assert.rejects(read(A, [null]), /100|valid|activity|notification/i);
  await assert.rejects(read(A, Array(101).fill(first.id)), /100/);
});

test("unlike removes its event and a later reaction remains unread despite an old mark-read request", async () => {
  const postId = await post();
  await like(B, postId);
  const original = (await inbox(A)).items[0];
  await read(A, [original.id]);
  assert.equal((await inbox(A)).unread_count, 0);
  await like(B, postId, false);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  await like(B, postId);
  const again = (await inbox(A)).items[0];
  assert.notEqual(again.id, original.id);
  assert.equal(again.read_at, null);
  await read(A, [original.id]);
  assert.equal((await inbox(A)).unread_count, 1);
});

test("latest100 activity window bounds display and unread count; mark-all means exact displayed IDs", async () => {
  const id = await post();
  for (let index = 0; index < 105; index += 1) await comment(B, id, `Notification ${index}`);
  const before = await inbox(A);
  assert.equal(before.items.length, 100);
  assert.equal(before.unread_count, 100);
  assert.equal(new Set(before.items.map((item) => item.id)).size, 100);
  const visibleIds = before.items.map((item) => item.id);
  await read(A, visibleIds);
  assert.equal((await inbox(A)).unread_count, 0);
  await comment(B, id, "Arrived after the displayed list was read");
  await read(A, visibleIds);
  assert.equal((await inbox(A)).unread_count, 1);
});

test("unfriend permanently removes pair activity without restoring it when friendship returns", async () => {
  const aPost = await post(A, [B, C]);
  const bPost = await post(B, [A]);
  const aPlan = await plan(A, [B]);
  await plan(B, [A]);
  await comment(B, aPost);
  await comment(C, aPost, "An unrelated friend's event stays");
  await comment(A, bPost);
  await like(B, aPost);
  await rsvp(B, aPlan, true);
  assert((await inbox(A)).items.some((item) => item.actor.id === B));
  assert((await inbox(B)).items.some((item) => item.actor.id === A));
  await as(A, "select public.remove_friend($1)", [B]);
  assert((await inbox(A)).items.every((item) => item.actor.id !== B));
  assert((await inbox(B)).items.every((item) => item.actor.id !== A));
  assert.equal((await inbox(A)).items.filter((item) => item.actor.id === C).length, 1);
  assert.equal((await db.query("select * from public.activity_events where (recipient_id=$1 and actor_id=$2) or (recipient_id=$2 and actor_id=$1)", [A, B])).rows.length, 0);
  await befriend(A, B);
  assert((await inbox(A)).items.every((item) => item.actor.id !== B));
  assert((await inbox(B)).items.every((item) => item.actor.id !== A));
  assert.deepEqual((await target(B, aPost)).posts, [], "Inbox work never restores old audience grants");
});

test("either-direction blocks prune events immediately and unblocking/refriending cannot revive them", async () => {
  for (const [blocker, blocked] of [[A, B], [C, A]]) {
    const id = await post(A, [blocked === B ? B : C]);
    const actor = blocked === B ? B : C;
    await comment(actor, id);
    await plan(A, [actor]);
    await as(blocker, "select public.block_person($1)", [blocked]);
    assert((await inbox(A)).items.every((item) => item.actor.id !== actor));
    assert((await inbox(actor)).items.every((item) => item.actor.id !== A));
    await as(blocker, "select public.unblock_person($1)", [blocked]);
    await befriend(A, actor);
    assert((await inbox(A)).items.every((item) => item.actor.id !== actor));
    assert((await inbox(actor)).items.every((item) => item.actor.id !== A));
  }
});

test("source deletion and cancellation remove activity without leaving readable private titles or identities", async () => {
  const postId = await post();
  await like(B, postId);
  await comment(B, postId);
  await as(A, "select public.delete_social_post($1)", [postId]);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  const planId = await plan();
  await rsvp(B, planId, true);
  await as(A, "select public.delete_social_plan($1)", [planId]);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  assert.deepEqual(await inbox(B), { items: [], unread_count: 0 });
  const requestId = await request(D, A);
  await db.query("delete from public.friend_requests where id=$1", [requestId]);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
  const finalPost = await post();
  await comment(B, finalPost);
  await db.query("delete from public.profiles where id=$1", [B]);
  assert.deepEqual(await inbox(A), { items: [], unread_count: 0 });
});

test("target lookup retrieves an authorized post/plan beyond latest100 and never returns other targets", async () => {
  const oldPostId = await post();
  const oldPlanId = await plan();
  for (let index = 0; index < 101; index += 1) {
    await post(A, [], `Newer private update ${index}`);
    await plan(A, [], `Newer private plan ${index}`);
  }
  assert(!(await social(A)).posts.some((item) => item.id === oldPostId));
  assert(!(await social(A)).plans.some((item) => item.id === oldPlanId));
  const postResult = await target(B, oldPostId);
  assert.deepEqual(postResult.posts.map((item) => item.id), [oldPostId]);
  assert.deepEqual(postResult.plans, []);
  assert.equal(postResult.posts[0].author.id, A);
  const planResult = await target(B, null, oldPlanId);
  assert.deepEqual(planResult.plans.map((item) => item.id), [oldPlanId]);
  assert.deepEqual(planResult.posts, []);
  assert.equal(planResult.plans[0].owner.id, A);
  assert.deepEqual(await target(C, oldPostId), { posts: [], plans: [] });
  assert.deepEqual(await target(C, null, oldPlanId), { posts: [], plans: [] });
  assert.deepEqual(await target(B, D), { posts: [], plans: [] });
  await assert.rejects(target(A), /one|target|post|plan/i);
  await assert.rejects(target(A, oldPostId, oldPlanId), /one|target|post|plan/i);
  await assert.rejects(target(null, oldPostId), /Sign in first/);
});

test("target detail respects profile blocking and existing comment, reaction and attendance visibility", async () => {
  const postId = await post(A, [B, C]);
  const planId = await plan(A, [B, C]);
  await comment(B, postId, "Visible to the permitted participants");
  await like(B, postId);
  await rsvp(B, planId, true);
  await as(C, "select public.block_person($1)", [B]);
  const forC = await target(C, postId);
  assert.equal(forC.posts.length, 1);
  assert.equal(forC.posts[0].comments.length, 0);
  assert.equal(forC.posts[0].like_count, 0);
  const plansForC = await target(C, null, planId);
  assert.deepEqual(plansForC.plans[0].invitees.map((item) => item.id), [C]);
  assert.deepEqual(plansForC.plans[0].attendees.map((item) => item.id), [A]);
  assert.equal((await target(A, postId)).posts[0].comments[0].author.id, B);
});
