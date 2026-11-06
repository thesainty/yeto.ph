import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Friend-only direct-chat contracts in isolated PostgreSQL; no hosted writes.
const db = new PGlite();
const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const FUTURE = "2099-11-01T15:00:00+08:00";
const MIGRATION = "20261106115515_direct_friend_chats.sql";
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
const stripDirectFields = box => ({...box,items:box.items.map(({direct_chat_id,direct_message_id,...item})=>item)});
async function preservedState() {
  const state = {};
  for (const table of ["profiles","friendships","friend_requests","blocks","audience_circles","audience_circle_members","social_posts","social_post_audience","social_post_likes","social_post_comments","social_plans","social_plan_invites","social_plan_attendees","plan_polls","plan_poll_invites","plan_poll_options","plan_poll_votes","plan_reminders","plan_messages","plan_message_audience","plan_message_reads"]) {
    state[table] = (await db.query(`select row_to_json(t) as row from public.${table} t order by row_to_json(t)::text`)).rows;
  }
  state.events = (await db.query("select * from public.activity_events order by id")).rows.map(({direct_chat_id,direct_message_id,...event})=>event);
  state.inboxA = stripDirectFields(await inbox(A));
  state.inboxB = stripDirectFields(await inbox(B));
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
  await db.exec(await readFile(new URL("../supabase/migrations/20261105120302_plan_conversations.sql",import.meta.url),"utf8"));
  await seed();
  await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  const existingPost = await scalar(A,"select public.create_social_post('Existing update',$1::uuid[])",[[B]]);
  await as(B,"select public.set_social_like($1,true)",[existingPost]);
  await scalar(B,"select public.add_social_comment($1,'Existing comment')",[existingPost]);
  const oldPlan = await plan();
  const oldMessage = await scalar(A,"select public.send_plan_message($1,'Existing plan message',$2)",[oldPlan,crypto.randomUUID()]);
  await as(B,"select public.mark_plan_messages_read($1,$2::uuid[])",[oldPlan,[oldMessage]]);
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

const openChat = (actor,friend) => scalar(actor,"select public.open_direct_chat($1)",[friend]);
const chats = (actor = A) => scalar(actor,"select public.direct_chats_snapshot()");
const chat = (actor,id,cursor = null) => scalar(actor,
  "select public.direct_chat_snapshot($1,$2::timestamptz,$3::uuid)",[id,cursor?.created_at ?? null,cursor?.id ?? null]);
const send = (actor,id,body = "A little hello 👋",nonce = crypto.randomUUID()) => scalar(actor,
  "select public.send_direct_message($1,$2,$3::uuid)",[id,body,nonce]);
const removeMessage = (actor,id) => as(actor,"select public.delete_direct_message($1)",[id]);
const read = (actor,id,ids) => as(actor,"select public.mark_direct_messages_read($1,$2::uuid[])",[id,ids]);
const directEvents = async actor => (await inbox(actor)).items.filter(item=>item.kind === "direct_message");
const unread = async (actor,id) => (await chat(actor,id)).unread_count;
const messageIds = async (actor,id) => (await chat(actor,id)).messages.map(item=>item.id);
const removeFriend = (actor,other) => as(actor,"select public.remove_friend($1)",[other]);
const block = (actor,other) => as(actor,"select public.block_person($1)",[other]);
const unblock = (actor,other) => as(actor,"select public.unblock_person($1)",[other]);
const denied = error => ["42501","P0001"].includes(error.code);
const invalid = error => ["22023","23514"].includes(error.code);

test("the additive direct-chat upgrade preserves all old accounts, plan conversations, reminders and inbox read state", async () => {
  assert.deepEqual(afterUpgrade,beforeUpgrade);
});

test("opening a current friend chat is idempotent in both directions and sends no message or notification", async () => {
  const id=await openChat(A,B);
  assert.equal(await openChat(A,B),id);
  assert.equal(await openChat(B,A),id);
  const a=await chat(A,id), b=await chat(B,id);
  assert.equal(a.chat.id,id);
  assert.equal(a.chat.friend.id,B);
  assert.equal(b.chat.friend.id,A);
  assert.deepEqual(a.messages,[]);
  assert.equal(a.unread_count,0);
  assert.equal(a.has_more,false);
  assert.equal(a.next_before,null);
  assert.equal((await chats(A)).chats[0].last_message,null);
  assert.equal((await chats(B)).chats[0].friend.id,A);
  assert.equal((await directEvents(A)).length,0);
  assert.equal((await directEvents(B)).length,0);
  assert.equal((await db.query("select count(*)::integer as n from public.direct_chats")).rows[0].n,1);
});

test("only current unblocked friends can start a chat; self, strangers, missing people and pending requests are rejected", async () => {
  for (const friend of [A,D,crypto.randomUUID(),null]) await assert.rejects(openChat(A,friend),error=>denied(error)||invalid(error));
  await assert.rejects(openChat(B,C),denied);
  await scalar(D,"select public.send_friend_request($1)",[A]);
  await assert.rejects(openChat(A,D),denied);
  await block(A,B);
  await assert.rejects(openChat(A,B),denied);
  await assert.rejects(openChat(B,A),denied);
  assert.equal((await db.query("select count(*)::integer as n from public.direct_chats")).rows[0].n,0);
});

test("a direct conversation is readable only by its two participants, including against another friend of the sender", async () => {
  const id=await openChat(A,B);
  const message=await send(A,id,"Private between Ana and Bea");
  assert.deepEqual(await messageIds(A,id),[message]);
  assert.deepEqual(await messageIds(B,id),[message]);
  for (const outsider of [C,D]) {
    await assert.rejects(chat(outsider,id),denied);
    await assert.rejects(send(outsider,id),denied);
    await assert.rejects(read(outsider,id,[message]),denied);
    assert.deepEqual((await chats(outsider)).chats,[]);
    assert.equal((await as(outsider,"select * from public.direct_chats")).rows.length,0);
    assert.equal((await as(outsider,"select * from public.direct_messages")).rows.length,0);
  }
  const page=await chat(B,id);
  assert.equal(page.messages[0].author.id,A);
  assert.deepEqual(Object.keys(page.messages[0].author).sort(),["display_name","id","username"]);
  assert.equal(await unread(A,id),0);
  assert.equal(await unread(B,id),1);
});

test("public RPCs retain caller privileges and inherited anonymous/platform grants cannot bypass RLS or write directly", async () => {
  const id=await openChat(A,B);
  const message=await send(A,id);
  for (const signature of ["direct_chats_snapshot()","open_direct_chat(uuid)","direct_chat_snapshot(uuid,timestamptz,uuid)","send_direct_message(uuid,text,uuid)","delete_direct_message(uuid)","mark_direct_messages_read(uuid,uuid[])"]) {
    for (const role of ["anon","service_role"]) assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,`public.${signature}`])).rows[0].allowed,false);
    assert.equal((await db.query("select prosecdef from pg_proc where oid=$1::regprocedure",[`public.${signature}`])).rows[0].prosecdef,false);
  }
  await assert.rejects(as(null,"select public.direct_chats_snapshot()",[],"anon"),denied);
  await assert.rejects(as(null,"select public.open_direct_chat($1)",[B]),denied);
  await assert.rejects(as(null,"select public.direct_chat_snapshot($1,null,null)",[id]),denied);
  await assert.rejects(as(null,"select public.send_direct_message($1,'Hello',$2)",[id,crypto.randomUUID()]),denied);
  await assert.rejects(as(null,"select public.delete_direct_message($1)",[message]),denied);
  await assert.rejects(as(null,"select public.mark_direct_messages_read($1,$2::uuid[])",[id,[message]]),denied);
  for (const table of ["direct_chats","direct_messages","direct_message_reads"]) {
    const grants=(await db.query("select has_table_privilege('anon',$1,'SELECT') as anon_read,has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as writes,has_table_privilege('service_role',$1,'SELECT') as platform_read",[`public.${table}`])).rows[0];
    assert.equal(grants.anon_read,false);
    assert.equal(grants.writes,false);
    assert.equal(grants.platform_read,false);
    assert.equal((await db.query("select relrowsecurity from pg_class where oid=$1::regclass",[`public.${table}`])).rows[0].relrowsecurity,true);
  }
  await assert.rejects(as(B,"insert into public.direct_messages(chat_id,author_id,body,client_nonce) values($1,$2,'Forged',$3)",[id,A,crypto.randomUUID()]),denied);
  await assert.rejects(as(B,"update public.direct_messages set body='Forged' where id=$1",[message]),denied);
  await assert.rejects(as(B,"insert into public.direct_message_reads(message_id,user_id) values($1,$2)",[message,A]),denied);
  await assert.rejects(as(B,"delete from public.direct_chats where id=$1",[id]),denied);
});

test("message bounds reject blanks, controls and oversized text atomically while preserving Unicode and normalized newlines", async () => {
  const id=await openChat(A,B);
  for (const body of [null,"","   ","\r\n\n","x".repeat(1001),"Hello\u0001there","Hello\tthere"]) await assert.rejects(send(A,id,body),invalid);
  await assert.rejects(send(A,id,"Hello",null),invalid);
  assert.deepEqual((await chat(B,id)).messages,[]);
  assert.equal((await directEvents(B)).length,0);
  const first=await send(A,id,"  Kumusta! 👋\r\nKita-kits sa café. ❤️  ");
  assert.equal((await chat(B,id)).messages[0].body,"Kumusta! 👋\nKita-kits sa café. ❤️");
  assert.equal((await chat(B,id)).messages[0].id,first);
  await send(B,id,"x".repeat(1000));
  assert.equal((await chat(A,id)).messages.at(-1).body.length,1000);
});

test("nonce retries cannot duplicate a saved message, rotate notifications or reset read state", async () => {
  const id=await openChat(A,B), nonce=crypto.randomUUID();
  const first=await send(A,id,"A reliable hello",nonce);
  const event=(await directEvents(B))[0];
  await read(B,id,[first]);
  const seen=(await directEvents(B))[0];
  assert.ok(seen.read_at);
  assert.equal(await send(A,id,"A reliable hello",nonce),first);
  assert.deepEqual(await messageIds(B,id),[first]);
  assert.equal(await unread(B,id),0);
  assert.equal((await directEvents(B))[0].id,event.id);
  assert.equal((await directEvents(B))[0].read_at,seen.read_at);
  await assert.rejects(send(A,id,"Changed contents",nonce),invalid);
  assert.equal((await chat(B,id)).messages[0].body,"A reliable hello");
  assert.notEqual(await send(B,id,"A reliable hello",nonce),first);
});

test("new friends and circle changes cannot expand a two-person direct chat", async () => {
  const id=await openChat(A,B);
  const original=await send(A,id,"Only the original friend");
  const circle=await scalar(A,"select public.save_audience_circle(null,'Pamilya',$1::uuid[])",[[B]]);
  await scalar(A,"select public.save_audience_circle($1,'Pamilya',$2::uuid[])",[circle,[B,C]]);
  await befriend(A,D);
  const other=await openChat(A,D);
  await send(A,other,"A separate conversation");
  await assert.rejects(chat(C,id),denied);
  await assert.rejects(chat(D,id),denied);
  assert.deepEqual(await messageIds(B,id),[original]);
  assert.equal((await chats(D)).chats.length,1);
  assert.equal((await chats(D)).chats[0].id,other);
});

test("the conversation list returns each caller's friend, fresh last-message preview and personal unread count", async () => {
  const id=await openChat(A,B);
  const message=await send(A,id,"The latest private text");
  const a=(await chats(A)).chats.find(item=>item.id===id), b=(await chats(B)).chats.find(item=>item.id===id);
  assert.equal(a.friend.id,B); assert.equal(b.friend.id,A);
  assert.deepEqual(a.last_message,{id:message,body:"The latest private text",created_at:(await chat(A,id)).messages[0].created_at,from_me:true});
  assert.equal(b.last_message.from_me,false);
  assert.equal(a.unread_count,0); assert.equal(b.unread_count,1);
  await read(B,id,[message]);
  assert.equal((await chats(B)).chats[0].unread_count,0);
  await removeMessage(A,message);
  assert.equal((await chats(B)).chats[0].last_message,null);
});

test("keyset history paginates tied timestamps without duplicates or omissions", async () => {
  const id=await openChat(A,B), sent=[];
  for (let index=0;index<65;index++) sent.push(await send(A,id,`Message ${index+1}`));
  await db.query("update public.direct_messages set created_at='2099-01-01T01:00:00Z' where chat_id=$1",[id]);
  const sorted=[...sent].sort(), latest=await chat(B,id);
  assert.equal(latest.messages.length,50);
  assert.deepEqual(latest.messages.map(item=>item.id),sorted.slice(-50));
  assert.equal(latest.has_more,true);
  assert.deepEqual(latest.next_before,{created_at:latest.messages[0].created_at,id:latest.messages[0].id});
  const earlier=await chat(B,id,latest.next_before);
  assert.deepEqual(earlier.messages.map(item=>item.id),sorted.slice(0,15));
  assert.equal(earlier.has_more,false); assert.equal(earlier.next_before,null);
  assert.equal(new Set([...earlier.messages,...latest.messages].map(item=>item.id)).size,65);
  assert.equal(latest.unread_count,65);
  await assert.rejects(as(B,"select public.direct_chat_snapshot($1,now(),null)",[id]),invalid);
  await assert.rejects(as(B,"select public.direct_chat_snapshot($1,null,$2)",[id,sorted[0]]),invalid);
  await assert.rejects(as(B,"select public.direct_chat_snapshot($1,'infinity'::timestamptz,$2)",[id,sorted[0]]),invalid);
});

test("exact loaded-message acknowledgements leave new messages and the newest coalesced notification unread", async () => {
  const id=await openChat(A,B);
  const first=await send(A,id,"First"), second=await send(A,id,"Second");
  const loaded=(await chat(B,id)).messages.map(item=>item.id);
  const old=(await directEvents(B))[0];
  const third=await send(A,id,"Arrived after fetch");
  const event=(await directEvents(B))[0];
  await as(B,"select public.mark_activity_read($1::uuid[])",[[old.id]]);
  await read(B,id,loaded);
  assert.equal(await unread(B,id),1);
  assert.equal((await directEvents(B))[0].id,event.id);
  assert.equal((await directEvents(B))[0].direct_message_id,third);
  assert.equal((await directEvents(B))[0].read_at,null);
  await read(B,id,[third]);
  assert.equal(await unread(B,id),0);
  assert.ok((await directEvents(B))[0].read_at);
  assert.equal((await db.query("select count(*)::integer as n from public.direct_message_reads where user_id=$1 and message_id=any($2::uuid[])",[B,[first,second,third]])).rows[0].n,3);
});

test("read markers are private, idempotent and reject foreign chats or more than 100 message IDs atomically", async () => {
  const firstChat=await openChat(A,B), otherChat=await openChat(A,C);
  const first=await send(A,firstChat,"Read privately"), foreign=await send(A,otherChat,"Other friend");
  await assert.rejects(read(B,firstChat,[first,foreign]),error=>denied(error)||invalid(error));
  assert.equal(await unread(B,firstChat),1);
  await read(B,firstChat,[first,first]); await read(B,firstChat,[first]);
  assert.equal((await as(B,"select * from public.direct_message_reads")).rows.length,1);
  assert.equal((await as(A,"select * from public.direct_message_reads")).rows.length,0);
  assert.equal((await as(C,"select * from public.direct_message_reads")).rows.length,0);
  await assert.rejects(read(B,firstChat,Array.from({length:101},()=>crypto.randomUUID())),invalid);
  await assert.rejects(read(B,firstChat,[null]),invalid);
});

test("inbox messages coalesce per recipient/chat without self notifications or copied message bodies", async () => {
  const id=await openChat(A,B);
  const first=await send(A,id,"A secret never copied into an activity row");
  const old=(await directEvents(B))[0];
  const second=await send(A,id,"Another private body");
  const latest=(await directEvents(B))[0];
  assert.equal((await directEvents(B)).length,1);
  assert.notEqual(latest.id,old.id);
  assert.equal(latest.direct_chat_id,id); assert.equal(latest.direct_message_id,second);
  assert.equal(latest.actor.id,A); assert.equal(latest.read_at,null);
  assert.equal((await directEvents(A)).length,0);
  await send(B,id,"A separate response");
  assert.equal((await directEvents(A)).length,1);
  assert.equal((await directEvents(B)).length,1);
  const rows=(await db.query("select row_to_json(e)::text as item from public.activity_events e where kind='direct_message'")).rows;
  assert.ok(rows.every(row=>!row.item.includes("secret never")&&!row.item.includes("Another private body")));
  assert.equal((await chat(B,id)).messages[0].id,first);
});

test("only the currently authorized author can delete a message and its receipt/notification references", async () => {
  const id=await openChat(A,B);
  const first=await send(A,id,"An earlier message"), latest=await send(A,id,"Delete this one");
  await read(B,id,[latest]);
  await assert.rejects(removeMessage(B,latest),denied);
  await assert.rejects(removeMessage(C,latest),denied);
  await removeMessage(A,latest);
  assert.deepEqual(await messageIds(B,id),[first]);
  assert.equal((await db.query("select count(*)::integer as n from public.direct_message_reads where message_id=$1",[latest])).rows[0].n,0);
  assert.equal((await directEvents(B)).length,0);
  assert.equal(await unread(B,id),1);
  assert.equal((await chats(B)).chats[0].last_message.id,first);
});

test("removing a friendship deletes its entire direct chat and re-friending creates a fresh empty thread", async () => {
  const old=await openChat(A,B);
  const first=await send(A,old,"Old message"), second=await send(B,old,"Old reply");
  await read(B,old,[first]); await read(A,old,[second]);
  await removeFriend(B,A);
  for (const user of [A,B]) {
    await assert.rejects(chat(user,old),denied);
    assert.deepEqual((await chats(user)).chats,[]);
    assert.equal((await directEvents(user)).length,0);
  }
  for (const table of ["direct_chats","direct_messages","direct_message_reads"]) assert.equal((await db.query(`select count(*)::integer as n from public.${table}`)).rows[0].n,0);
  await assert.rejects(openChat(A,B),denied);
  await befriend(A,B);
  const fresh=await openChat(A,B);
  assert.notEqual(fresh,old);
  assert.deepEqual((await chat(B,fresh)).messages,[]);
  assert.equal(await unread(B,fresh),0);
  await assert.rejects(chat(B,old),denied);
  await assert.rejects(removeMessage(A,first),denied);
});

test("either-direction blocking removes direct chats and unblocking/refriending never restores their old contents", async () => {
  for (const [blocker,other] of [[A,B],[B,A]]) {
    const old=await openChat(A,B);
    await send(A,old,"Old private text");
    await block(blocker,other);
    await assert.rejects(chat(A,old),denied);
    await assert.rejects(chat(B,old),denied);
    assert.equal((await directEvents(B)).length,0);
    await unblock(blocker,other);
    await assert.rejects(openChat(A,B),denied);
    await befriend(A,B);
    const fresh=await openChat(B,A);
    assert.notEqual(fresh,old);
    assert.deepEqual((await chat(A,fresh)).messages,[]);
  }
});

test("a direct block inserted before friendship cleanup immediately deletes the old chat even if the friendship row remains", async () => {
  const old=await openChat(A,B);
  await send(A,old,"Before direct block");
  await db.query("insert into public.blocks(blocker_id,blocked_id) values($1,$2)",[B,A]);
  assert.equal((await db.query("select count(*)::integer as n from public.friendships where user_a=$1 and user_b=$2",[A,B])).rows[0].n,1);
  assert.equal((await db.query("select count(*)::integer as n from public.direct_chats")).rows[0].n,0);
  await assert.rejects(chat(A,old),denied);
  await assert.rejects(openChat(A,B),denied);
  await unblock(B,A);
  const fresh=await openChat(A,B);
  assert.notEqual(fresh,old);
  assert.deepEqual((await chat(B,fresh)).messages,[]);
});

test("unrelated relationship removal and blocks do not erase another private friend conversation", async () => {
  const kept=await openChat(A,B), removed=await openChat(A,C);
  const message=await send(B,kept,"Our separate chat stays");
  await send(C,removed,"This other chat ends");
  await removeFriend(C,A);
  assert.deepEqual(await messageIds(A,kept),[message]);
  await block(C,D);
  assert.deepEqual(await messageIds(B,kept),[message]);
  await assert.rejects(chat(A,removed),denied);
});

test("plan conversations, calendar exports, RSVP activity and two-offset reminders remain independent of direct chats", async () => {
  const id=await plan();
  const planMessage=await scalar(A,"select public.send_plan_message($1,'Plan details stay here',$2)",[id,crypto.randomUUID()]);
  const direct=await openChat(A,B), directMessage=await send(A,direct,"A separate direct conversation");
  await configure(A,id,[60,1440]);
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  await as(B,"select public.set_social_attendance($1,false)",[id]);
  await as(B,"select public.set_social_attendance($1,true)",[id]);
  assert.equal((await calendar(B,id)).plan.id,id);
  await makeDue(id);
  assert.equal(await dispatch(),2);
  assert.equal((await reminderEvents(A)).length,2);
  assert.equal((await inbox(A)).items.filter(item=>item.kind==='plan_rsvp').length,1);
  assert.equal((await inbox(B)).items.find(item=>item.kind==='plan_message').message_id,planMessage);
  assert.equal((await directEvents(B))[0].direct_message_id,directMessage);
  await as(A,"select public.delete_social_plan($1)",[id]);
  assert.deepEqual(await messageIds(B,direct),[directMessage]);
  assert.equal((await directEvents(B)).length,1);
});

test("the latest-100 list stays bounded while an exact authorized older conversation remains accessible", async () => {
  const old=await openChat(A,B), message=await send(A,old,"An older private conversation");
  await db.query("update public.direct_messages set created_at='2000-01-01T00:00:00Z' where chat_id=$1",[old]);
  await db.query("update public.direct_chats set created_at='2000-01-01T00:00:00Z' where id=$1",[old]);
  for (let index=0;index<101;index++) {
    const person=`60000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
    await db.query("insert into public.profiles(id,username,display_name) values($1,$2,$3)",[person,`friend_${index}`,`Friend ${index}`]);
    await befriend(A,person);
    await openChat(A,person);
  }
  const list=await chats(A);
  assert.equal(list.chats.length,100);
  assert.ok(!list.chats.some(item=>item.id===old));
  assert.deepEqual(await messageIds(A,old),[message]);
  assert.equal((await chat(B,old)).chat.id,old);
  assert.equal((await directEvents(B))[0].direct_chat_id,old);
});
