import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// PostgreSQL/RLS contracts in an isolated engine; this never contacts hosted data.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const TIMES = ["2099-11-01T15:00:00+08:00", "2099-11-02T15:00:00+08:00"];
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
const snapshot = (actor = A) => scalar(actor,"select public.plan_polls_snapshot()");
const target = (actor,id) => scalar(actor,"select public.plan_poll_target_snapshot($1)",[id]);
const poll = (actor = A, invited = [B], times = TIMES, title = "Coffee this weekend?", place = "BGC café", kind = "coffee") => scalar(actor,
  "select public.create_plan_poll($1,$2,$3,$4::timestamptz[],$5::uuid[])",[title,place,kind,times,invited]);
const vote = (actor,id,options) => as(actor,"select public.set_plan_poll_votes($1,$2::uuid[])",[id,options]);
const convert = (actor,id,option) => scalar(actor,"select public.convert_plan_poll($1,$2)",[id,option]);
const remove = (actor,id) => as(actor,"select public.delete_plan_poll($1)",[id]);
const inbox = (actor = A) => scalar(actor,"select public.activity_inbox_snapshot()");
const social = (actor = A) => scalar(actor,"select public.social_snapshot()");
const befriend = (a,b) => db.query("insert into public.friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid))",[a,b]);
async function seed() {
  for (const [i,id] of [A,B,C,D].entries()) await db.query("insert into public.profiles(id,username,display_name) values($1,$2,$3)",[id,`person_${i}`,["Ana","Bea","Luis","Paolo"][i]]);
  await befriend(A,B); await befriend(A,C);
}
const stripPollFields = (box) => ({...box,items:box.items.map(({poll_id,poll_title,...item}) => item)});
async function preservedState() {
  const state = {};
  for (const table of ["profiles","friendships","friend_requests","audience_circles","audience_circle_members","social_posts","social_post_audience","social_plans","social_plan_invites","social_plan_attendees"]) {
    state[table] = (await db.query(`select row_to_json(t) as row from public.${table} t order by row_to_json(t)::text`)).rows;
  }
  state.social = await social();
  state.events = (await db.query("select * from public.activity_events order by id")).rows.map(({poll_id,...event})=>event);
  state.inboxA = stripPollFields(await inbox(A));
  state.inboxB = stripPollFields(await inbox(B));
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
  await seed();
  await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const post = await scalar(A,"select public.create_social_post('An existing private update',$1::uuid[])",[[B]]);
  await as(B,"select public.set_social_like($1,true)",[post]);
  await scalar(A,"select public.create_social_plan('Existing meetup','BGC',$1::timestamptz,'coffee',$2::uuid[])",[TIMES[0],[B]]);
  await scalar(D,"select public.send_friend_request($1)",[A]);
  await as(B,"select public.mark_activity_read($1::uuid[])",[(await inbox(B)).items.map(item=>item.id)]);
  beforeUpgrade = await preservedState();
  await db.exec(await readFile(new URL("../supabase/migrations/20261104121739_availability_polls.sql",import.meta.url),"utf8"));
  afterUpgrade = await preservedState();
});
beforeEach(async () => {
  await db.exec("truncate public.profiles,public.friendships,public.blocks,public.friend_requests cascade");
  await seed();
});
after(async () => { await db.close(); });

test("the additive migration preserves accounts, circles, social audiences and all existing activity/read state", async () => {
  assert.deepEqual(afterUpgrade,beforeUpgrade);
  assert.deepEqual(await snapshot(),{polls:[]});
});

test("Only me is a private poll and converts to an equally private normal plan", async () => {
  const id = await poll(A,[]);
  const own = (await snapshot()).polls[0];
  assert.equal(own.id,id);
  assert.deepEqual(own.invitees,[]);
  assert.equal(own.options.length,2);
  for (const actor of [B,C,D]) {
    assert.deepEqual(await snapshot(actor),{polls:[]});
    assert.deepEqual(await target(actor,id),{polls:[]});
    assert.deepEqual((await as(actor,"select * from public.plan_poll_options")).rows,[]);
  }
  await vote(A,id,[own.options[0].id,own.options[1].id]);
  const planId = await convert(A,id,own.options[0].id);
  const plan = (await social()).plans[0];
  assert.equal(plan.id,planId);
  assert.deepEqual(plan.invitees,[]);
  assert.deepEqual(plan.attendees.map(person=>person.id),[A]);
  assert.equal((await inbox(B)).items.length,0);
  assert.equal((await target(A,id)).polls[0].plan_id,planId);
});

test("explicit invitation permits read/vote but does not grant organizer controls to invitees or other friends", async () => {
  const id = await poll();
  const item = (await target(B,id)).polls[0];
  assert.equal(item.owner.id,A);
  assert.deepEqual(item.invitees.map(person=>person.id),[B]);
  const option = item.options[0].id;
  for (const actor of [C,D]) {
    assert.deepEqual(await target(actor,id),{polls:[]});
    await assert.rejects(vote(actor,id,[option]),/unavailable/);
  }
  await vote(B,id,[option]);
  await assert.rejects(convert(B,id,option),/Only the organizer/);
  await assert.rejects(remove(B,id),/Only the organizer/);
  await assert.rejects(remove(C,id),/unavailable/);
  assert.equal((await target(B,id)).polls[0].options[0].voted_by_me,true);
});

test("anonymous callers, missing subjects, direct writes and inherited platform grants cannot bypass the RPC boundaries", async () => {
  const id = await poll();
  const option = (await target(A,id)).polls[0].options[0].id;
  const calls = [
    "select public.plan_polls_snapshot()",
    `select public.plan_poll_target_snapshot('${id}')`,
    `select public.create_plan_poll('Title','Place','coffee',array['2099-11-01'::timestamptz,'2099-11-02'::timestamptz],'{}')`,
    `select public.set_plan_poll_votes('${id}','{}')`,
    `select public.convert_plan_poll('${id}','${option}')`,
    `select public.delete_plan_poll('${id}')`,
  ];
  for (const sql of calls) {
    await assert.rejects(as(null,sql,[],"anon"),/permission denied/);
    await assert.rejects(as(null,sql),/Sign in first/);
    await assert.rejects(as(A,sql,[],"service_role"),/permission denied/);
  }
  const wrappers = (await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','yeto_private') and p.proname=any($1::text[]) order by n.nspname,p.proname",[["create_plan_poll","set_plan_poll_votes","convert_plan_poll","delete_plan_poll"]])).rows;
  assert.equal(wrappers.length,8);
  for (const fn of wrappers) {
    assert.equal(fn.prosecdef,fn.nspname === 'yeto_private');
    assert.deepEqual(fn.proconfig,['search_path=""']);
  }
  for (const sql of calls.filter(sql=>!sql.includes('snapshot')).map(sql=>sql.replace('public.','yeto_private.'))) {
    await assert.rejects(as(null,sql,[],"anon"),/permission denied/);
    await assert.rejects(as(A,sql,[],"service_role"),/permission denied/);
    await assert.rejects(as(null,sql),/Sign in first/);
  }
  for (const table of ["plan_polls","plan_poll_invites","plan_poll_options","plan_poll_votes"]) {
    await assert.rejects(as(null,`select * from public.${table}`,[],"anon"),/permission denied/);
    await assert.rejects(as(A,`select * from public.${table}`,[],"service_role"),/permission denied/);
    await assert.rejects(as(A,`delete from public.${table}`),/permission denied/);
    await assert.rejects(as(A,`update public.${table} set ${table === "plan_polls" ? "title='Stolen'" : table === "plan_poll_options" ? "starts_at=now()" : "user_id='"+C+"'"}`),/permission denied/);
  }
  for (const sql of [
    `insert into public.plan_polls(owner_id,title,place,kind) values('${B}','Forged','BGC','coffee')`,
    `insert into public.plan_poll_invites values('${id}','${C}')`,
    `insert into public.plan_poll_options(poll_id,starts_at) values('${id}','2099-12-01')`,
    `insert into public.plan_poll_votes values('${id}','${option}','${C}')`,
    `select yeto_private.lock_plan_poll('${id}')`,
    "select yeto_private.capture_poll_invite_activity()",
    "select yeto_private.prune_polls_after_friendship()",
    "select yeto_private.prune_polls_after_block()",
    "select yeto_private.prune_deleted_poll_invite()",
  ]) await assert.rejects(as(A,sql),/permission denied/);
});

test("invalid details and 2–5 distinct future option bounds fail atomically without invitations", async () => {
  for (const times of [null,[],[TIMES[0]],[...TIMES,...TIMES,...TIMES],[TIMES[0],TIMES[0]],[TIMES[0],null],[TIMES[0],"2000-01-01"],[TIMES[0],"infinity"]]) {
    await assert.rejects(poll(A,[B],times),/2–5 different future times/);
  }
  for (const title of [null,"","  ","\n\t","x".repeat(71),"Title\nline"]) await assert.rejects(poll(A,[B],TIMES,title),/title, place/);
  for (const place of [null,"","  ","x".repeat(91),"Place\tname"]) await assert.rejects(poll(A,[B],TIMES,"Title",place),/title, place/);
  for (const kind of [null,"unknown"]) await assert.rejects(poll(A,[B],TIMES,"Title","Place",kind),/title, place/);
  assert.deepEqual(await snapshot(),{polls:[]});
  assert.equal((await inbox(B)).items.length,0);
  assert.equal((await db.query("select * from public.plan_poll_options")).rows.length,0);
  const five = [...Array(5)].map((_,i)=>`2099-12-0${i+1}T08:00:00Z`);
  assert.equal((await target(A,await poll(A,[],five))).polls[0].options.length,5);
});

test("audiences bind to at most 500 current unblocked friends, deduplicate UUIDs and reject spoofed grants", async () => {
  for (const invited of [[A],[D],[null]]) await assert.rejects(poll(A,invited),/current|500/);
  const id = await poll(A,[B,B]);
  assert.deepEqual((await target(A,id)).polls[0].invitees.map(person=>person.id),[B]);
  assert.equal((await inbox(B)).items.length,1);
  await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[B,A]);
  await assert.rejects(poll(A,[B]),/current, unblocked/);
  await assert.rejects(poll(A,Array(501).fill(C)),/500 current/);
  const ids = (await db.query(`insert into public.profiles(id,username,display_name)
    select ('50000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'many_'||i,'Friend '||i from generate_series(1,500) i returning id`)).rows.map(row=>row.id);
  await db.query("insert into public.friendships(user_a,user_b) select least($1::uuid,id),greatest($1::uuid,id) from public.profiles where id=any($2::uuid[])",[A,ids]);
  const large = await poll(A,ids);
  assert.equal((await target(A,large)).polls[0].invitees.length,500);
  const planId = await convert(A,large,(await target(A,large)).polls[0].options[0].id);
  assert.equal((await social()).plans.find(plan=>plan.id===planId).invitees.length,500);
});

test("voters replace only their own multi-option choices; invalid cross-poll choices never erase existing votes", async () => {
  const id = await poll(A,[B,C]);
  const options = (await target(A,id)).polls[0].options.map(option=>option.id);
  await vote(B,id,[...options,options[0]]);
  await vote(C,id,[options[0]]);
  let result = (await target(B,id)).polls[0];
  assert.deepEqual(result.options.map(option=>[option.vote_count,option.voted_by_me]),[[2,true],[1,true]]);
  const other = await poll(A,[B]);
  const foreignOption = (await target(A,other)).polls[0].options[0].id;
  for (const bad of [[foreignOption],[D],[null],Array(6).fill(options[0])]) {
    await assert.rejects(vote(B,id,bad),/times from this poll/);
  }
  result = (await target(B,id)).polls[0];
  assert.deepEqual(result.options.map(option=>option.voted_by_me),[true,true]);
  await vote(B,id,[options[1]]);
  assert.deepEqual((await target(B,id)).polls[0].options.map(option=>[option.vote_count,option.voted_by_me]),[[1,false],[1,true]]);
  await vote(B,id,[]);
  assert.deepEqual((await target(B,id)).polls[0].options.map(option=>[option.vote_count,option.voted_by_me]),[[1,false],[0,false]]);
});

test("published audience snapshots never expand when circles change or new friendships arrive", async () => {
  const circle = await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const id = await poll(A,[B]);
  await befriend(A,D);
  await scalar(A,"select public.save_audience_circle($1,'Bigger Pamilya',$2::uuid[])",[circle,[B,C,D]]);
  assert.deepEqual((await target(A,id)).polls[0].invitees.map(person=>person.id),[B]);
  assert.deepEqual(await target(C,id),{polls:[]});
  assert.deepEqual(await target(D,id),{polls:[]});
  const planId = await convert(A,id,(await target(A,id)).polls[0].options[0].id);
  assert.deepEqual((await social()).plans.find(plan=>plan.id===planId).invitees.map(person=>person.id),[B]);
  await scalar(A,"select public.save_audience_circle($1,'Other Pamilya',$2::uuid[])",[circle,[C]]);
  assert.deepEqual((await social()).plans[0].invitees.map(person=>person.id),[B]);
});

test("conversion makes one normal plan, retains the fixed audience and leaves availability voters to RSVP", async () => {
  const id = await poll(A,[B,C]);
  const item = (await target(A,id)).polls[0];
  await vote(B,id,[item.options[0].id]);
  await vote(C,id,[item.options[1].id]);
  const planId = await convert(A,id,item.options[0].id);
  assert.equal(await convert(A,id,item.options[0].id),planId);
  assert.equal(await convert(A,id,item.options[1].id),planId);
  const plans = (await social()).plans;
  assert.equal(plans.length,1);
  assert.equal(plans[0].title,item.title);
  assert.equal(plans[0].place,item.place);
  assert.equal(new Date(plans[0].starts_at).valueOf(),new Date(item.options[0].starts_at).valueOf());
  assert.deepEqual(plans[0].invitees.map(person=>person.id),[B,C]);
  assert.deepEqual(plans[0].attendees.map(person=>person.id),[A]);
  const closed = (await target(B,id)).polls[0];
  assert.ok(closed.closed_at);
  assert.equal(closed.plan_id,planId);
  await assert.rejects(vote(B,id,[]),/closed/);
  assert.equal((await inbox(B)).items.filter(event=>event.kind==='plan_invite').length,1);
  await as(B,"select public.set_social_attendance($1,true)",[planId]);
  assert.deepEqual((await social()).plans[0].attendees.map(person=>person.id),[A,B]);
});

test("cancelling a resulting plan never reopens its poll, while deleting a poll leaves the resulting plan intact", async () => {
  const id = await poll();
  const option = (await target(A,id)).polls[0].options[0].id;
  const planId = await convert(A,id,option);
  await as(A,"select public.delete_social_plan($1)",[planId]);
  const closed = (await target(A,id)).polls[0];
  assert.ok(closed.closed_at);
  assert.equal(closed.plan_id,null);
  await assert.rejects(convert(A,id,option),/closed/);
  await assert.rejects(vote(B,id,[option]),/closed/);
  const second = await poll();
  const secondPlan = await convert(A,second,(await target(A,second)).polls[0].options[0].id);
  await remove(A,second);
  assert.equal((await social()).plans[0].id,secondPlan);
  assert.deepEqual(await target(B,second),{polls:[]});
});

test("expired choices reject new availability and conversion without deleting previously saved choices", async () => {
  const id = await poll();
  const option = (await target(A,id)).polls[0].options[0].id;
  await vote(B,id,[option]);
  await db.query("update public.plan_poll_options set starts_at='2000-01-01' where id=$1",[option]);
  await assert.rejects(vote(B,id,[option]),/future times/);
  assert.equal((await target(B,id)).polls[0].options[0].voted_by_me,true);
  await assert.rejects(convert(A,id,option),/future time/);
  await vote(B,id,[]);
  assert.equal((await target(B,id)).polls[0].options[0].vote_count,0);
});

test("invitations create one account-private actionable inbox item with persistent read state and current title", async () => {
  const id = await poll(A,[B,B]);
  assert.equal((await inbox(A)).items.length,0);
  assert.equal((await inbox(C)).items.length,0);
  let box = await inbox(B);
  assert.equal(box.unread_count,1);
  const event = box.items[0];
  assert.equal(event.kind,'poll_invite');
  assert.equal(event.poll_id,id);
  assert.equal(event.poll_title,'Coffee this weekend?');
  assert.equal(event.plan_id,null);
  assert.equal(event.post_id,null);
  await as(C,"select public.mark_activity_read($1::uuid[])",[[event.id]]);
  assert.equal((await inbox(B)).unread_count,1);
  await as(B,"select public.mark_activity_read($1::uuid[])",[[event.id]]);
  box = await inbox(B);
  assert.equal(box.unread_count,0);
  assert.ok(box.items[0].read_at);
  await remove(A,id);
  assert.equal((await inbox(B)).items.length,0);
  assert.equal((await db.query("select * from public.plan_poll_votes")).rows.length,0);
});

test("unfriending permanently removes poll invitations, votes and inbox items in both directions", async () => {
  const forward = await poll(A,[B,C]);
  const reverse = await poll(B,[A]);
  const option = (await target(B,forward)).polls[0].options[0].id;
  await vote(B,forward,[option]);
  await vote(A,reverse,[(await target(A,reverse)).polls[0].options[0].id]);
  await as(A,"select public.remove_friend($1)",[B]);
  assert.deepEqual(await target(B,forward),{polls:[]});
  assert.deepEqual(await target(A,reverse),{polls:[]});
  assert.deepEqual((await target(A,forward)).polls[0].invitees.map(person=>person.id),[C]);
  assert.equal((await target(A,forward)).polls[0].options[0].vote_count,0);
  assert.equal((await inbox(B)).items.length,0);
  await befriend(A,B);
  assert.deepEqual(await target(B,forward),{polls:[]});
  assert.deepEqual(await target(A,reverse),{polls:[]});
  await assert.rejects(vote(B,forward,[option]),/unavailable/);
  const planId = await convert(A,forward,option);
  assert.deepEqual((await social()).plans.find(plan=>plan.id===planId).invitees.map(person=>person.id),[C]);
});

test("either-direction blocks prune poll grants before friendship cleanup and unblock/refriend cannot restore them", async () => {
  for (const [blocker,blocked] of [[A,B],[B,A]]) {
    const id = await poll();
    const option = (await target(B,id)).polls[0].options[0].id;
    await vote(B,id,[option]);
    await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[blocker,blocked]);
    assert.deepEqual(await target(B,id),{polls:[]});
    assert.equal((await inbox(B)).items.length,0);
    assert.equal((await target(A,id)).polls[0].invitees.length,0);
    assert.equal((await target(A,id)).polls[0].options[0].vote_count,0);
    await db.query("delete from public.blocks");
    assert.deepEqual(await target(B,id),{polls:[]});
  }
});

test("blocking between invitees hides their identities and availability counts without revoking the host's audience", async () => {
  const id = await poll(A,[B,C]);
  const option = (await target(B,id)).polls[0].options[0].id;
  await vote(B,id,[option]); await vote(C,id,[option]);
  await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[C,B]);
  assert.deepEqual((await target(B,id)).polls[0].invitees.map(person=>person.id),[B]);
  assert.equal((await target(B,id)).polls[0].options[0].vote_count,1);
  assert.deepEqual((await as(B,"select user_id from public.plan_poll_votes")).rows.map(row=>row.user_id),[B]);
  assert.equal((await target(A,id)).polls[0].options[0].vote_count,2);
  assert.deepEqual((await target(A,id)).polls[0].invitees.map(person=>person.id),[B,C]);
});

test("the latest100 list remains bounded while exact authorized inbox targets work beyond the window", async () => {
  const oldest = await poll(A,[B]);
  await db.query("update public.plan_polls set created_at='2000-01-01' where id=$1",[oldest]);
  for (let i=0;i<101;i++) await poll(A,[B],TIMES,`More recent poll ${i}`);
  const shown = await snapshot(B);
  assert.equal(shown.polls.length,100);
  assert.equal(shown.polls.some(item=>item.id===oldest),false);
  assert.equal((await target(B,oldest)).polls[0].id,oldest);
  assert.deepEqual(await target(C,oldest),{polls:[]});
  assert.deepEqual(await target(B,D),{polls:[]});
  await assert.rejects(target(B,null),/Choose a poll/);
});
