import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Personal reminder and calendar contracts in isolated PostgreSQL, never hosted data.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const FUTURE = "2099-11-01T15:00:00+08:00";
const MIGRATION = "20261104123952_plan_calendar_reminders.sql";
let beforeUpgrade;
let afterUpgrade;

async function as(actor, sql, params = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor ?? ""]);
    return tx.query(sql, params);
  });
}
async function scalar(actor, sql, params = []) {
  return Object.values((await as(actor, sql, params)).rows[0])[0];
}
const preferences = (actor = A) => scalar(actor,"select public.plan_reminders_snapshot()");
const configure = (actor,id,minutes) => as(actor,"select public.set_plan_reminders($1,$2::integer[])",[id,minutes]);
const calendar = (actor,id) => scalar(actor,"select public.plan_calendar_snapshot($1)",[id]);
const inbox = (actor = A) => scalar(actor,"select public.activity_inbox_snapshot()");
const reminderEvents = async (actor = A) => (await inbox(actor)).items.filter(event=>event.kind === "plan_reminder");
const plan = (actor = A,invited = [B],starts = FUTURE) => scalar(actor,
  "select public.create_social_plan('Coffee together','BGC café',$1::timestamptz,'coffee',$2::uuid[])",[starts,invited]);
const dispatch = async () => (await db.query("select yeto_private.dispatch_plan_reminders() as sent")).rows[0].sent;
const befriend = (a,b) => db.query("insert into public.friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid))",[a,b]);
async function seed() {
  for (const [i,id] of [A,B,C,D].entries()) await db.query("insert into public.profiles(id,username,display_name) values($1,$2,$3)",[id,`person_${i}`,["Ana","Bea","Luis","Paolo"][i]]);
  await befriend(A,B); await befriend(A,C);
}
async function makeDue(id,untilStart = "30 minutes") {
  await db.query("update public.social_plans set starts_at=now()+$2::interval where id=$1",[id,untilStart]);
  await db.query("update public.plan_reminders set enabled_at=now()-interval '3 days' where plan_id=$1",[id]);
}
const stripReminderFields = box => ({...box,items:box.items.map(({reminder_minutes,plan_starts_at,...item})=>item)});
async function preservedState() {
  const state = {};
  for (const table of ["profiles","friendships","friend_requests","blocks","audience_circles","audience_circle_members","social_posts","social_post_audience","social_post_likes","social_post_comments","social_plans","social_plan_invites","social_plan_attendees","plan_polls","plan_poll_invites","plan_poll_options","plan_poll_votes"]) {
    state[table] = (await db.query(`select row_to_json(t) as row from public.${table} t order by row_to_json(t)::text`)).rows;
  }
  state.events = (await db.query("select * from public.activity_events order by id")).rows.map(({reminder_minutes,...event})=>event);
  state.inboxA = stripReminderFields(await inbox(A));
  state.inboxB = stripReminderFields(await inbox(B));
  return state;
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
  const accountSql = await readFile(new URL("../supabase/migrations/202610310001_accounts_and_friends.sql",import.meta.url),"utf8");
  const definitions = [...accountSql.matchAll(/create function public\.(send_friend_request|respond_friend_request|cancel_friend_request|remove_friend|block_person|unblock_person)\([\s\S]*?^\$\$;/gm)];
  assert.equal(definitions.length,6);
  for (const [sql] of definitions) await db.exec(sql);
  for (const signature of ["send_friend_request(uuid)","respond_friend_request(uuid,boolean)","cancel_friend_request(uuid)","remove_friend(uuid)","block_person(uuid)","unblock_person(uuid)"]) await db.exec(`revoke all on function public.${signature} from public,anon,authenticated,service_role; grant execute on function public.${signature} to authenticated`);
  for (const file of ["202611010001_social_feed_and_plans.sql","202611020002_saved_audience_circles.sql","202611020003_activity_inbox.sql"]) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),"utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261104121739_availability_polls.sql",import.meta.url),"utf8"));
  await seed();
  await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const existingPost = await scalar(A,"select public.create_social_post('Existing update',$1::uuid[])",[[B]]);
  await as(B,"select public.set_social_like($1,true)",[existingPost]);
  await scalar(B,"select public.add_social_comment($1,'Existing comment')",[existingPost]);
  await plan();
  await scalar(A,"select public.create_plan_poll('Existing poll','Café','coffee',$1::timestamptz[],$2::uuid[])",[[FUTURE,"2099-11-02T15:00:00+08:00"],[B]]);
  await scalar(D,"select public.send_friend_request($1)",[A]);
  await as(B,"select public.mark_activity_read($1::uuid[])",[(await inbox(B)).items.map(item=>item.id)]);
  beforeUpgrade = await preservedState();
  await db.exec(await readFile(new URL(`../supabase/migrations/${MIGRATION}`,import.meta.url),"utf8"));
  afterUpgrade = await preservedState();
});
beforeEach(async () => {
  await db.exec("truncate public.profiles,public.friendships,public.blocks,public.friend_requests cascade");
  await seed();
});
after(async () => { await db.close(); });

test("the additive upgrade preserves old plans, audiences, polls and every existing inbox/read state", async () => {
  assert.deepEqual(afterUpgrade,beforeUpgrade);
  assert.deepEqual(await preferences(),{reminders:[]});
  assert.equal((await db.query("select count(*)::integer as total from public.plan_reminders")).rows[0].total,0);
});

test("reminders default off and personal preferences cannot change another participant's choices", async () => {
  const id = await plan();
  for (const actor of [A,B,C,D]) assert.deepEqual(await preferences(actor),{reminders:[]});
  await configure(A,id,[1440,60,60]);
  await configure(B,id,[60]);
  assert.deepEqual((await preferences(A)).reminders,[{plan_id:id,minutes_before:[60,1440]}]);
  assert.deepEqual((await preferences(B)).reminders,[{plan_id:id,minutes_before:[60]}]);
  await configure(A,id,[]);
  assert.deepEqual(await preferences(A),{reminders:[]});
  assert.deepEqual((await preferences(B)).reminders,[{plan_id:id,minutes_before:[60]}]);
  assert.equal(await dispatch(),0);
});

test("RLS protects personal settings even from other invitees and denies all direct client writes", async () => {
  const id = await plan(A,[B,C]);
  await configure(A,id,[1440]); await configure(B,id,[60]);
  assert.deepEqual((await as(B,"select user_id,minutes_before from public.plan_reminders")).rows,[{user_id:B,minutes_before:60}]);
  assert.deepEqual((await as(C,"select * from public.plan_reminders")).rows,[]);
  for (const statement of [
    `insert into public.plan_reminders(plan_id,user_id,minutes_before) values('${id}','${B}',1440)`,
    `update public.plan_reminders set user_id='${C}'`,
    "delete from public.plan_reminders",
  ]) await assert.rejects(as(A,statement),/permission denied/);
  for (const role of ["anon","service_role"]) await assert.rejects(as(null,"select * from public.plan_reminders",[],role),/permission denied/);
});

test("anonymous callers, missing identities and inherited roles cannot invoke personal RPCs or the global worker", async () => {
  const id = await plan();
  const calls = [
    "select public.plan_reminders_snapshot()",
    `select public.plan_calendar_snapshot('${id}')`,
    `select public.set_plan_reminders('${id}',array[60])`,
  ];
  for (const statement of calls) {
    await assert.rejects(as(null,statement,[],"anon"),/permission denied/);
    await assert.rejects(as(null,statement),/Sign in/);
    await assert.rejects(as(A,statement,[],"service_role"),/permission denied/);
  }
  for (const role of ["anon","authenticated","service_role"]) {
    await assert.rejects(as(A,"select yeto_private.dispatch_plan_reminders()",[],role),/permission denied/);
  }
  const wrapper = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.set_plan_reminders(uuid,integer[])'::regprocedure")).rows[0];
  assert.equal(wrapper.prosecdef,false);
  assert.deepEqual(wrapper.proconfig,['search_path=""']);
});

test("only the host or a currently authorized invited friend can save reminders or export calendar details", async () => {
  const id = await plan();
  for (const actor of [C,D]) {
    await assert.rejects(configure(actor,id,[60]),error=>error.code === "42501");
    assert.deepEqual(await calendar(actor,id),{plan:null,reminder_minutes:[]});
  }
  await configure(B,id,[60]);
  assert.equal((await calendar(A,id)).plan.id,id);
  assert.equal((await calendar(B,id)).plan.id,id);
  assert.deepEqual(await calendar(C,"99999999-9999-4999-8999-999999999999"),{plan:null,reminder_minutes:[]});
});

test("calendar exports contain fresh authorized event details and only the caller's alarm choices", async () => {
  const id = await plan(A,[B,C]);
  await configure(A,id,[1440]); await configure(B,id,[60]);
  const exported = await calendar(B,id);
  assert.deepEqual(Object.keys(exported.plan).sort(),["created_at","id","place","starts_at","title"]);
  assert.equal(exported.plan.title,"Coffee together");
  assert.equal(exported.plan.place,"BGC café");
  assert.deepEqual(exported.reminder_minutes,[60]);
  assert.equal(JSON.stringify(exported).includes("person_"),false);
  assert.equal(JSON.stringify(exported).includes(A),false);
  await db.query("update public.social_plans set title='A changed title',place='New café' where id=$1",[id]);
  assert.equal((await calendar(B,id)).plan.title,"A changed title");
  assert.equal((await calendar(B,id)).plan.place,"New café");
  assert.deepEqual((await calendar(A,id)).reminder_minutes,[1440]);
});

test("only supported reminder offsets are accepted and failed changes leave personal settings intact", async () => {
  const id = await plan();
  await configure(B,id,[60]);
  for (const minutes of [[1],[59],[120],[1441],[null],[60,null],[[60],[1440]]]) {
    await assert.rejects(configure(B,id,minutes),error=>["22023","22P02"].includes(error.code));
    assert.deepEqual((await preferences(B)).reminders,[{plan_id:id,minutes_before:[60]}]);
  }
  await configure(B,id,[1440,60]);
  assert.deepEqual((await preferences(B)).reminders,[{plan_id:id,minutes_before:[60,1440]}]);
  await configure(B,id,null);
  assert.deepEqual(await preferences(B),{reminders:[]});
});

test("past deadlines cannot be newly enabled, while existing choices can be retained or switched off", async () => {
  const id = await plan();
  await configure(B,id,[60]);
  await db.query("update public.social_plans set starts_at=now()+interval '30 minutes' where id=$1",[id]);
  await assert.rejects(configure(A,id,[60]),error=>error.code === "22023");
  await assert.rejects(configure(B,id,[60,1440]),error=>error.code === "22023");
  await configure(B,id,[60]);
  assert.deepEqual((await preferences(B)).reminders,[{plan_id:id,minutes_before:[60]}]);
  await db.query("update public.social_plans set starts_at=now()-interval '1 minute' where id=$1",[id]);
  await assert.rejects(configure(A,id,[1440]),error=>error.code === "22023");
  await configure(B,id,[]);
  assert.deepEqual(await preferences(B),{reminders:[]});
});

test("the worker delivers due reminders once, preserves read state on retry and supports self reminders", async () => {
  const id = await plan();
  await configure(A,id,[60]); await configure(B,id,[60]);
  await makeDue(id);
  assert.equal(await dispatch(),2);
  const host = await reminderEvents(A); const guest = await reminderEvents(B);
  assert.equal(host.length,1); assert.equal(guest.length,1);
  assert.equal(host[0].actor.id,A);
  assert.equal(host[0].reminder_minutes,60);
  assert.equal(guest[0].plan_id,id);
  assert.equal(guest[0].plan_title,"Coffee together");
  assert.ok(guest[0].plan_starts_at);
  await as(B,"select public.mark_activity_read($1::uuid[])",[[guest[0].id]]);
  const readAt = (await reminderEvents(B))[0].read_at;
  assert.ok(readAt);
  assert.equal(await dispatch(),0);
  assert.equal((await reminderEvents(B))[0].read_at,readAt);
  assert.equal((await reminderEvents(B))[0].id,guest[0].id);
});

test("one-day and one-hour alerts each arrive once for the same plan without colliding with invitation events", async () => {
  const id = await plan();
  await configure(B,id,[1440,60]);
  await makeDue(id,"23 hours");
  assert.equal(await dispatch(),1);
  assert.deepEqual((await reminderEvents(B)).map(event=>event.reminder_minutes),[1440]);
  await makeDue(id,"30 minutes");
  assert.equal(await dispatch(),1);
  assert.deepEqual((await reminderEvents(B)).map(event=>event.reminder_minutes).sort((a,b)=>a-b),[60,1440]);
  assert.equal((await inbox(B)).items.filter(event=>event.kind === "plan_invite").length,1);
  assert.equal(await dispatch(),0);
});

test("opting out removes only that account's pending preferences and delivered reminder events", async () => {
  const id = await plan();
  await configure(A,id,[60]); await configure(B,id,[60,1440]);
  await makeDue(id); await dispatch();
  await configure(B,id,[]);
  assert.deepEqual(await preferences(B),{reminders:[]});
  assert.deepEqual(await reminderEvents(B),[]);
  assert.equal((await reminderEvents(A)).length,1);
  assert.equal((await inbox(B)).items.filter(event=>event.kind === "plan_invite").length,1);
  assert.equal(await dispatch(),0);
});

test("the worker never sends after the plan starts or retrospectively when the opt-in came after its deadline", async () => {
  const id = await plan();
  await configure(B,id,[60]);
  // Moving a plan's time models a delayed/imported preference without changing
  // the current timestamp; enabled_at deliberately remains after the due time.
  await db.query("update public.social_plans set starts_at=now()+interval '30 minutes' where id=$1",[id]);
  assert.equal(await dispatch(),0);
  assert.deepEqual(await reminderEvents(B),[]);
  await db.query("update public.plan_reminders set enabled_at=now()-interval '3 days' where plan_id=$1",[id]);
  await db.query("update public.social_plans set starts_at=now()-interval '1 minute' where id=$1",[id]);
  assert.equal(await dispatch(),0);
  assert.deepEqual(await reminderEvents(B),[]);
});

test("an old transaction clock cannot dispatch a reminder after the plan has actually started", async () => {
  const id = await plan();
  await configure(B,id,[60]);
  await db.transaction(async (tx) => {
    await tx.query("update public.social_plans set starts_at=clock_timestamp()+interval '50 milliseconds' where id=$1",[id]);
    await tx.query("update public.plan_reminders set enabled_at=clock_timestamp()-interval '3 days' where plan_id=$1",[id]);
    await new Promise(resolve=>setTimeout(resolve,120));
    const timing = (await tx.query("select starts_at>now() as future_at_transaction_start, starts_at<=clock_timestamp() as actually_started from public.social_plans where id=$1",[id])).rows[0];
    assert.deepEqual(timing,{future_at_transaction_start:true,actually_started:true});
    assert.equal((await tx.query("select yeto_private.dispatch_plan_reminders() as sent")).rows[0].sent,0);
  });
  assert.deepEqual(await reminderEvents(B),[]);
});

test("enabling checks the actual deadline and records actual opt-in time inside a long-lived transaction", async () => {
  const id = await plan();
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query("update public.social_plans set starts_at=clock_timestamp()+interval '60 minutes 50 milliseconds' where id=$1",[id]);
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[B]);
    await new Promise(resolve=>setTimeout(resolve,120));
    const timing = (await tx.query("select starts_at-interval '1 hour'>now() as future_at_transaction_start, starts_at-interval '1 hour'<=clock_timestamp() as deadline_passed from public.social_plans where id=$1",[id])).rows[0];
    assert.deepEqual(timing,{future_at_transaction_start:true,deadline_passed:true});
    await tx.query("select public.set_plan_reminders($1,array[60])",[id]);
  }),error=>error.code === "22023");
  assert.deepEqual(await preferences(B),{reminders:[]});
  await db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[B]);
    await new Promise(resolve=>setTimeout(resolve,60));
    await tx.query("select public.set_plan_reminders($1,array[60])",[id]);
    assert.equal((await tx.query("select enabled_at>now() as actual_opt_in from public.plan_reminders where plan_id=$1",[id])).rows[0].actual_opt_in,true);
  });
});

test("cancelling a plan cascades preferences and inbox reminders and removes export access", async () => {
  const id = await plan();
  await configure(A,id,[60]); await configure(B,id,[60]);
  await makeDue(id); await dispatch();
  await as(A,"select public.delete_social_plan($1)",[id]);
  for (const actor of [A,B]) {
    assert.deepEqual(await preferences(actor),{reminders:[]});
    assert.deepEqual(await reminderEvents(actor),[]);
    assert.deepEqual(await calendar(actor,id),{plan:null,reminder_minutes:[]});
  }
  assert.equal(await dispatch(),0);
});

test("leaving a plan clears that participant's reminders without changing the host or restoring them on rejoin", async () => {
  const id = await plan();
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  await configure(A,id,[60]); await configure(B,id,[60]);
  await makeDue(id); await dispatch();
  await as(B,"select public.set_social_attendance($1,false)",[id]);
  assert.deepEqual(await preferences(B),{reminders:[]});
  assert.deepEqual(await reminderEvents(B),[]);
  assert.equal((await reminderEvents(A)).length,1);
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  assert.deepEqual(await preferences(B),{reminders:[]});
  assert.equal(await dispatch(),0);
});

test("deleting an invitation revokes its personal reminders even if the friendship remains", async () => {
  const id = await plan();
  await configure(B,id,[60]);
  await makeDue(id); await dispatch();
  await db.query("delete from public.social_plan_invites where plan_id=$1 and user_id=$2",[id,B]);
  assert.deepEqual(await preferences(B),{reminders:[]});
  assert.deepEqual(await reminderEvents(B),[]);
  assert.deepEqual(await calendar(B,id),{plan:null,reminder_minutes:[]});
  assert.equal(await dispatch(),0);
});

test("unfriend permanently prunes reminder preferences and events in both directions", async () => {
  const forward = await plan(A,[B]); const reverse = await plan(B,[A]);
  await configure(B,forward,[60]); await configure(A,reverse,[60]);
  await makeDue(forward); await makeDue(reverse); await dispatch();
  await as(A,"select public.remove_friend($1)",[B]);
  for (const actor of [A,B]) {
    assert.deepEqual(await preferences(actor),{reminders:[]});
    assert.deepEqual(await reminderEvents(actor),[]);
  }
  await befriend(A,B);
  assert.deepEqual(await calendar(B,forward),{plan:null,reminder_minutes:[]});
  assert.deepEqual(await calendar(A,reverse),{plan:null,reminder_minutes:[]});
  assert.equal(await dispatch(),0);
});

test("either-direction blocks revoke reminders before friendship cleanup, and unblock never restores them", async () => {
  for (const [blocker,blocked] of [[A,B],[B,A]]) {
    const id = await plan(A,[B]);
    await configure(B,id,[60]);
    await makeDue(id); await dispatch();
    // Direct block insertion proves the reminder trigger does not rely on the
    // separate friendship deletion carried out by the ordinary block RPC.
    await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[blocker,blocked]);
    assert.deepEqual(await preferences(B),{reminders:[]});
    assert.deepEqual(await reminderEvents(B),[]);
    assert.deepEqual(await calendar(B,id),{plan:null,reminder_minutes:[]});
    await db.query("delete from public.blocks where blocker_id=$1 and blocked_id=$2",[blocker,blocked]);
    assert.deepEqual(await preferences(B),{reminders:[]});
    assert.equal(await dispatch(),0);
  }
});

test("blocking between invitees does not disable another invitee's personal reminder for an accessible host plan", async () => {
  const id = await plan(A,[B,C]);
  await configure(B,id,[60]); await configure(C,id,[60]);
  await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[B,C]);
  await makeDue(id);
  assert.equal(await dispatch(),2);
  assert.equal((await reminderEvents(B)).length,1);
  assert.equal((await reminderEvents(C)).length,1);
});

test("only the plan-reminder kind can use a self actor and its source remains tied to the saved personal preference", async () => {
  const id = await plan(A,[]);
  await configure(A,id,[60]);
  await makeDue(id); await dispatch();
  assert.equal((await reminderEvents(A)).length,1);
  await assert.rejects(db.query("insert into public.activity_events(recipient_id,actor_id,kind,plan_id) values($1,$1,'plan_invite',$2)",[A,id]),error=>error.code === "23514");
  await assert.rejects(db.query("insert into public.activity_events(recipient_id,actor_id,kind,plan_id,reminder_minutes) values($1,$1,'plan_reminder',$2,null)",[A,id]),error=>error.code === "23514");
  await assert.rejects(db.query("insert into public.activity_events(recipient_id,actor_id,kind,plan_id,reminder_minutes) values($1,$1,'plan_reminder',$2,1440)",[A,id]),error=>error.code === "23503");
});
