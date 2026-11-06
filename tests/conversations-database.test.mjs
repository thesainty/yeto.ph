import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Plan conversation contracts in isolated PostgreSQL; no hosted accounts or writes.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const FUTURE = "2099-11-01T15:00:00+08:00";
const MIGRATION = "20261105120302_plan_conversations.sql";
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
const stripMessageFields = box => ({...box,items:box.items.map(({message_id,...item})=>item)});
async function preservedState() {
  const state = {};
  for (const table of ["profiles","friendships","friend_requests","blocks","audience_circles","audience_circle_members","social_posts","social_post_audience","social_post_likes","social_post_comments","social_plans","social_plan_invites","social_plan_attendees","plan_polls","plan_poll_invites","plan_poll_options","plan_poll_votes","plan_reminders"]) {
    state[table] = (await db.query(`select row_to_json(t) as row from public.${table} t order by row_to_json(t)::text`)).rows;
  }
  state.events = (await db.query("select * from public.activity_events order by id")).rows.map(({message_id,...event})=>event);
  state.inboxA = stripMessageFields(await inbox(A));
  state.inboxB = stripMessageFields(await inbox(B));
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
  await db.exec(await readFile(new URL("../supabase/migrations/20261104123952_plan_calendar_reminders.sql",import.meta.url),"utf8"));
  await seed();
  await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const existingPost = await scalar(A,"select public.create_social_post('Existing update',$1::uuid[])",[[B]]);
  await as(B,"select public.set_social_like($1,true)",[existingPost]);
  await scalar(B,"select public.add_social_comment($1,'Existing comment')",[existingPost]);
  const oldPlan = await plan();
  await configure(A,oldPlan,[60]);
  await configure(B,oldPlan,[60]);
  await makeDue(oldPlan);
  await dispatch();
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


const conversation = (actor,id,cursor = null) => scalar(actor,
  "select public.plan_conversation_snapshot($1,$2::timestamptz,$3::uuid)", [id,cursor?.created_at ?? null,cursor?.id ?? null]);
const conversations = (actor = A) => scalar(actor,"select public.plan_conversations_snapshot()");
const send = (actor,id,body = "See you at the entrance!",nonce = crypto.randomUUID()) => scalar(actor,
  "select public.send_plan_message($1,$2,$3::uuid)", [id,body,nonce]);
const removeMessage = (actor,id) => as(actor,"select public.delete_plan_message($1)",[id]);
const markRead = (actor,id,messages) => as(actor,"select public.mark_plan_messages_read($1,$2::uuid[])",[id,messages]);
const chatEvents = async actor => (await inbox(actor)).items.filter(item=>item.kind === "plan_message");
const unread = async (actor,id) => (await conversation(actor,id)).unread_count;
const messageIds = async (actor,id) => (await conversation(actor,id)).messages.map(message=>message.id);
const removeFriend = (actor,other) => as(actor,"select public.remove_friend($1)",[other]);
const block = (actor,other) => as(actor,"select public.block_person($1)",[other]);
const unblock = (actor,other) => as(actor,"select public.unblock_person($1)",[other]);
const denied = error => ["42501","P0001"].includes(error.code);
const invalid = error => ["22023","23514"].includes(error.code);

test("the additive conversation upgrade preserves existing accounts, plans, polls, reminders and inbox read state", async () => {
  assert.deepEqual(afterUpgrade,beforeUpgrade);
});

test("Only-me plan messages stay private, preserve plain text and create no self notifications", async () => {
  const id=await plan(A,[]);
  const message=await send(A,id,"  Ingat!\r\nSee you soon.  ");
  const result=await conversation(A,id);
  assert.equal(result.plan_id,id);
  assert.equal(result.unread_count,0);
  assert.deepEqual(result.messages.map(item=>[item.id,item.author.id,item.body]),[[message,A,"Ingat!\nSee you soon."]]);
  assert.equal(result.has_more,false);
  assert.equal(result.next_before,null);
  assert.equal((await chatEvents(A)).length,0);
  await assert.rejects(conversation(B,id),denied);
  await assert.rejects(send(B,id),denied);
});

test("the host's fixed invited audience can converse even when invitees are not friends with each other", async () => {
  const id=await plan(A,[B,C]);
  const message=await send(B,id,"Meet at the main entrance.");
  for (const reader of [A,B,C]) assert.deepEqual(await messageIds(reader,id),[message]);
  assert.equal(await unread(A,id),1);
  assert.equal(await unread(B,id),0);
  assert.equal(await unread(C,id),1);
  assert.equal((await chatEvents(A))[0].message_id,message);
  assert.equal((await chatEvents(C))[0].message_id,message);
  assert.equal((await chatEvents(B)).length,0);
  assert.deepEqual(Object.keys((await conversation(A,id)).messages[0].author).sort(),["display_name","id","username"]);
  await assert.rejects(conversation(D,id),denied);
  await assert.rejects(send(D,id),denied);
});

test("anonymous, missing-subject and inherited roles cannot execute conversation RPCs or write tables", async () => {
  const id=await plan();
  const message=await send(A,id);
  for (const signature of [
    "plan_conversations_snapshot()","plan_conversation_snapshot(uuid,timestamptz,uuid)",
    "send_plan_message(uuid,text,uuid)","delete_plan_message(uuid)","mark_plan_messages_read(uuid,uuid[])",
  ]) {
    for (const role of ["anon","service_role"]) {
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,`public.${signature}`])).rows[0].allowed,false);
    }
    const metadata=(await db.query("select prosecdef from pg_proc where oid=$1::regprocedure",[`public.${signature}`])).rows[0];
    assert.equal(metadata.prosecdef,false,`${signature} must retain caller privileges at the public boundary`);
  }
  await assert.rejects(as(null,"select public.plan_conversations_snapshot()",[],"anon"),denied);
  await assert.rejects(as(null,"select public.plan_conversation_snapshot($1,null,null)",[id]),denied);
  await assert.rejects(as(null,"select public.send_plan_message($1,'Hello',$2)",[id,crypto.randomUUID()]),denied);
  await assert.rejects(as(null,"select public.delete_plan_message($1)",[message]),denied);
  await assert.rejects(as(null,"select public.mark_plan_messages_read($1,$2::uuid[])",[id,[message]]),denied);
  for (const table of ["plan_messages","plan_message_audience","plan_message_reads"]) {
    const grants=(await db.query("select has_table_privilege('anon',$1,'SELECT') as anon_read,has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as writes",[`public.${table}`])).rows[0];
    assert.equal(grants.anon_read,false);
    assert.equal(grants.writes,false);
  }
  await assert.rejects(as(B,"insert into public.plan_messages(plan_id,author_id,body,client_nonce) values($1,$2,'Forged',$3)",[id,A,crypto.randomUUID()]),denied);
  await assert.rejects(as(B,"insert into public.plan_message_audience(message_id,user_id) values($1,$2)",[message,D]),denied);
  await assert.rejects(as(B,"insert into public.plan_message_reads(message_id,user_id) values($1,$2)",[message,A]),denied);
});

test("empty, control-character and oversized bodies fail atomically while a 1000-character message is accepted", async () => {
  const id=await plan();
  for (const body of [null,"","   ","\n\r\n","x".repeat(1001),"Hello\u0001there","Hello\tthere"]) {
    await assert.rejects(send(A,id,body),invalid);
  }
  await assert.rejects(send(A,id,"Hello",null),invalid);
  assert.equal((await conversation(A,id)).messages.length,0);
  assert.equal((await chatEvents(B)).length,0);
  const message=await send(A,id,"x".repeat(1000));
  assert.equal((await conversation(B,id)).messages[0].id,message);
});

test("retrying a nonce returns the original message without duplicating content, unread counts or notifications", async () => {
  const id=await plan();
  const nonce=crypto.randomUUID();
  const first=await send(A,id,"A reliable hello",nonce);
  const event=(await chatEvents(B))[0];
  await markRead(B,id,[first]);
  const acknowledged=(await chatEvents(B))[0];
  assert.ok(acknowledged.read_at);
  assert.equal(await send(A,id,"A reliable hello",nonce),first);
  assert.equal((await conversation(B,id)).messages.length,1);
  assert.equal(await unread(B,id),0);
  assert.equal((await chatEvents(B))[0].id,event.id);
  assert.equal((await chatEvents(B))[0].read_at,acknowledged.read_at);
  await assert.rejects(send(A,id,"Different draft",nonce),invalid);
  assert.equal((await conversation(B,id)).messages[0].body,"A reliable hello");
  const otherAuthor=await send(B,id,"A reliable hello",nonce);
  assert.notEqual(otherAuthor,first);
});

test("new friends, circle changes and later plan invitations never add recipients to older messages", async () => {
  const id=await plan(A,[B]);
  const circle=await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const nonce=crypto.randomUUID();
  const original=await send(A,id,"Only the original audience.",nonce);
  await scalar(A,"select public.save_audience_circle($1,'Pamilya',$2::uuid[])",[circle,[B,C]]);
  await befriend(A,D);
  await assert.rejects(conversation(C,id),denied);
  await assert.rejects(conversation(D,id),denied);
  await db.query("insert into public.social_plan_invites(plan_id,user_id) values($1,$2)",[id,C]);
  assert.equal(await send(A,id,"Only the original audience.",nonce),original);
  assert.deepEqual(await messageIds(C,id),[]);
  assert.equal((await chatEvents(C)).length,0);
  const later=await send(A,id,"A later message for the current audience.");
  assert.deepEqual(await messageIds(C,id),[later]);
  assert.deepEqual(await messageIds(B,id),[original,later]);
});

test("keyset pagination returns the latest 50 in ascending order without duplicate or skipped tied timestamps", async () => {
  const id=await plan();
  const sent=[];
  for (let index=0;index<65;index++) sent.push(await send(A,id,`Message ${index+1}`));
  await db.query("update public.plan_messages set created_at='2099-01-01T01:00:00Z' where plan_id=$1",[id]);
  const ordered=[...sent].sort();
  const latest=await conversation(B,id);
  assert.equal(latest.messages.length,50);
  assert.deepEqual(latest.messages.map(message=>message.id),ordered.slice(-50));
  assert.equal(latest.has_more,true);
  assert.deepEqual(latest.next_before,{created_at:latest.messages[0].created_at,id:latest.messages[0].id});
  const earlier=await conversation(B,id,latest.next_before);
  assert.deepEqual(earlier.messages.map(message=>message.id),ordered.slice(0,15));
  assert.equal(earlier.has_more,false);
  assert.equal(earlier.next_before,null);
  assert.equal(new Set([...earlier.messages,...latest.messages].map(message=>message.id)).size,65);
  assert.equal(latest.unread_count,65);
  await assert.rejects(as(B,"select public.plan_conversation_snapshot($1,now(),null)",[id]),invalid);
  await assert.rejects(as(B,"select public.plan_conversation_snapshot($1,null,$2)",[id,ordered[0]]),invalid);
});

test("exact message acknowledgements leave concurrently arrived messages and their latest inbox event unread", async () => {
  const id=await plan();
  const first=await send(A,id,"First");
  const second=await send(A,id,"Second");
  const loaded=(await conversation(B,id)).messages.map(message=>message.id);
  const third=await send(A,id,"Arrived after the read");
  const event=(await chatEvents(B))[0];
  await markRead(B,id,loaded);
  assert.equal(await unread(B,id),1);
  assert.deepEqual((await conversations(B)).conversations.find(item=>item.plan_id===id),{plan_id:id,unread_count:1});
  assert.equal((await chatEvents(B))[0].message_id,third);
  assert.equal((await chatEvents(B))[0].id,event.id);
  assert.equal((await chatEvents(B))[0].read_at,null);
  await markRead(B,id,[third]);
  assert.equal(await unread(B,id),0);
  assert.ok((await chatEvents(B))[0].read_at);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_message_reads where user_id=$1 and message_id=any($2::uuid[])",[B,[first,second,third]])).rows[0].n,3);
});

test("read receipts are private, deduplicate retries, reject foreign-plan IDs atomically and enforce their bound", async () => {
  const id=await plan(A,[B,C]);
  const other=await plan(A,[B]);
  const first=await send(A,id,"Read privately");
  const foreign=await send(A,other,"Other plan");
  await assert.rejects(markRead(B,id,[first,foreign]),error=>denied(error)||invalid(error));
  assert.equal(await unread(B,id),1);
  await markRead(B,id,[first,first]);
  await markRead(B,id,[first]);
  assert.equal((await as(B,"select * from public.plan_message_reads")).rows.length,1);
  assert.equal((await as(A,"select * from public.plan_message_reads")).rows.length,0);
  assert.equal((await as(C,"select * from public.plan_message_reads")).rows.length,0);
  await assert.rejects(markRead(B,id,Array.from({length:101},()=>crypto.randomUUID())),invalid);
});

test("coalesced notifications rotate identity for new messages and never copy message text", async () => {
  const id=await plan(A,[B,C]);
  const first=await send(B,id,"A secret body never copied into an event");
  const old=(await chatEvents(A))[0];
  const second=await send(C,id,"Another private body");
  const latest=(await chatEvents(A))[0];
  assert.notEqual(latest.id,old.id);
  assert.equal(latest.message_id,second);
  assert.equal(latest.actor.id,C);
  assert.equal((await chatEvents(A)).length,1);
  assert.equal(latest.read_at,null);
  await as(A,"select public.mark_activity_read($1::uuid[])",[[old.id]]);
  assert.equal((await chatEvents(A))[0].read_at,null);
  await markRead(A,id,[first]);
  assert.equal((await chatEvents(A))[0].read_at,null);
  await markRead(A,id,[second]);
  assert.ok((await chatEvents(A))[0].read_at);
  const eventRows=(await db.query("select row_to_json(e)::text as item from public.activity_events e where kind='plan_message'")).rows;
  assert.ok(eventRows.every(row=>!row.item.includes("secret body")&&!row.item.includes("Another private body")));
});

test("only the authorized author can delete a message, cascading its grants, receipts and linked notifications", async () => {
  const id=await plan(A,[B,C]);
  const first=await send(A,id,"Keep this earlier message");
  const latest=await send(B,id,"Delete my own message");
  await markRead(C,id,[latest]);
  await assert.rejects(removeMessage(A,latest),denied);
  await assert.rejects(removeMessage(C,latest),denied);
  await removeMessage(B,latest);
  assert.deepEqual(await messageIds(A,id),[first]);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_message_audience where message_id=$1",[latest])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_message_reads where message_id=$1",[latest])).rows[0].n,0);
  assert.equal((await chatEvents(A)).length,0);
  assert.equal((await chatEvents(C)).length,0);
});

test("cancelling a plan removes all conversation content, grants, receipts, unread counts and message notifications", async () => {
  const id=await plan();
  const message=await send(A,id);
  await markRead(B,id,[message]);
  await as(A,"select public.delete_social_plan($1)",[id]);
  await assert.rejects(conversation(A,id),denied);
  for (const table of ["plan_messages","plan_message_audience","plan_message_reads"]) assert.equal((await db.query(`select count(*)::integer as n from public.${table}`)).rows[0].n,0);
  assert.equal((await chatEvents(B)).length,0);
  assert.ok(!(await conversations(B)).conversations.some(item=>item.plan_id===id));
});

test("removing an invitation erases the departed author's messages and every departed-recipient grant and receipt", async () => {
  const id=await plan(A,[B,C]);
  const first=await send(A,id,"Host message");
  const departed=await send(B,id,"Departing author message");
  const guest=await send(C,id,"Another guest message");
  await markRead(B,id,[first,guest]);
  await db.query("delete from public.social_plan_invites where plan_id=$1 and user_id=$2",[id,B]);
  assert.deepEqual(await messageIds(A,id),[first,guest]);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_messages where id=$1",[departed])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_message_audience where user_id=$1",[B])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::integer as n from public.plan_message_reads where user_id=$1",[B])).rows[0].n,0);
  assert.equal((await chatEvents(B)).length,0);
  await db.query("insert into public.social_plan_invites(plan_id,user_id) values($1,$2)",[id,B]);
  assert.deepEqual(await messageIds(B,id),[]);
  const fresh=await send(A,id,"A new grant only");
  assert.deepEqual(await messageIds(B,id),[fresh]);
});

test("unfriending the organizer permanently removes conversation access in both directions", async () => {
  const firstPlan=await plan(A,[B]);
  const secondPlan=await plan(B,[A]);
  await send(A,firstPlan,"A-owned plan");
  await send(B,firstPlan,"B guest");
  await send(B,secondPlan,"B-owned plan");
  await send(A,secondPlan,"A guest");
  await removeFriend(A,B);
  await assert.rejects(conversation(B,firstPlan),denied);
  await assert.rejects(conversation(A,secondPlan),denied);
  assert.equal((await chatEvents(A)).length,0);
  assert.equal((await chatEvents(B)).length,0);
  await befriend(A,B);
  await assert.rejects(conversation(B,firstPlan),denied);
  await assert.rejects(conversation(A,secondPlan),denied);
  assert.equal((await conversation(A,firstPlan)).messages.length,1);
  assert.equal((await conversation(B,secondPlan)).messages.length,1);
});

test("blocking the organizer or invitee revokes old messages and never restores them after unblock and refriend", async () => {
  for (const [blocker,other] of [[A,B],[B,A]]) {
    const id=await plan(A,[B]);
    const original=await send(A,id,"An old private audience");
    await send(B,id,"Old guest message");
    await block(blocker,other);
    await assert.rejects(conversation(B,id),denied);
    await unblock(blocker,other);
    await befriend(A,B);
    await assert.rejects(conversation(B,id),denied);
    assert.deepEqual(await messageIds(A,id),[original]);
  }
});

test("blocks between invitees permanently hide their old pair messages while the host retains them", async () => {
  const id=await plan(A,[B,C]);
  const fromB=await send(B,id,"B private audience");
  const fromC=await send(C,id,"C private audience");
  await markRead(B,id,[fromC]);
  await block(B,C);
  assert.deepEqual(await messageIds(A,id),[fromB,fromC]);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
  assert.equal((await chatEvents(B)).length,0);
  assert.equal((await chatEvents(C)).length,0);
  await unblock(B,C);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
  const later=await send(B,id,"New message after the block ends");
  assert.deepEqual(await messageIds(C,id),[fromC,later]);
});

test("a block inserted before relationship cleanup immediately hides messages and prunes old pair grants", async () => {
  const id=await plan(A,[B,C]);
  const fromB=await send(B,id,"Before direct block");
  const fromC=await send(C,id,"Before direct block too");
  await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[C,B]);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
  assert.deepEqual(await messageIds(A,id),[fromB,fromC]);
  await unblock(C,B);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
});

test("sending while two invitees are blocked excludes the blocked pair but still reaches their selected host", async () => {
  const id=await plan(A,[B,C]);
  await block(B,C);
  const guest=await send(B,id,"For the eligible audience");
  assert.deepEqual(await messageIds(A,id),[guest]);
  assert.deepEqual(await messageIds(C,id),[]);
  assert.equal(await unread(C,id),0);
  const host=await send(A,id,"For both invited friends");
  assert.deepEqual(await messageIds(B,id),[guest,host]);
  assert.deepEqual(await messageIds(C,id),[host]);
});

test("removing friendship between invitees permanently prunes old pair grants without changing host membership", async () => {
  const id=await plan(A,[B,C]);
  await befriend(B,C);
  const fromB=await send(B,id,"B before removal");
  const fromC=await send(C,id,"C before removal");
  await removeFriend(B,C);
  assert.deepEqual(await messageIds(A,id),[fromB,fromC]);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
  await befriend(B,C);
  assert.deepEqual(await messageIds(B,id),[fromB]);
  assert.deepEqual(await messageIds(C,id),[fromC]);
});

test("ordinary RSVP, calendar access and two-offset reminders remain compatible with chat notification indexes", async () => {
  const id=await plan();
  await configure(A,id,[60,1440]);
  await configure(B,id,[60]);
  await send(A,id,"A chat before RSVP");
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  await as(B,"select public.set_social_attendance($1,false)",[id]);
  assert.equal((await preferences(B)).reminders.length,0);
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  assert.equal((await calendar(B,id)).plan.id,id);
  await makeDue(id);
  assert.equal(await dispatch(),2);
  assert.equal((await reminderEvents(A)).length,2);
  assert.equal((await chatEvents(B)).length,1);
  assert.equal((await inbox(A)).items.filter(event=>event.kind==="plan_rsvp").length,1);
});

test("exact authorized conversation targets remain available outside the latest-100 plan list", async () => {
  const old=await plan(A,[B]);
  const message=await send(A,old,"An older still-private conversation");
  for (let index=0;index<101;index++) await plan(A,[]);
  const social=await scalar(B,"select public.activity_target_snapshot(null,$1)",[old]);
  assert.equal(social.plans[0].id,old);
  assert.deepEqual(await messageIds(B,old),[message]);
  assert.equal(await unread(B,old),1);
  assert.equal((await chatEvents(B))[0].plan_id,old);
});
