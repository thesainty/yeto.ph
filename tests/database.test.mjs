import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Execute real PostgreSQL constraints, functions, grants, and RLS locally.
// auth.users/auth.uid emulate Supabase's documented auth boundary; these tests
// do not claim to validate a hosted Supabase project, JWT issuance, or email.
const db = new PGlite();
const ids = {
  ana: "10000000-0000-4000-8000-000000000001",
  bea: "20000000-0000-4000-8000-000000000002",
  luis: "30000000-0000-4000-8000-000000000003",
  paolo: "40000000-0000-4000-8000-000000000004",
};

async function as(actor, sql, params = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      actor ?? "",
    ]);
    return tx.query(sql, params);
  });
}
async function send(actor, target) {
  const result = await as(
    actor,
    "select public.send_friend_request($1) as id",
    [target],
  );
  return result.rows[0].id;
}
async function becomeFriends(a, b) {
  const request = await send(a, b);
  await as(b, "select public.respond_friend_request($1, true)", [request]);
  return request;
}

before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
  `);
  // Supabase may grant new functions explicitly to API roles by default;
  // revoking only PUBLIC must not accidentally leave anonymous RPC access.
  await db.exec(
    "alter default privileges grant execute on functions to anon, authenticated, service_role",
  );
  const migration = await readFile(
    new URL(
      "../supabase/migrations/202610310001_accounts_and_friends.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.exec(migration);
});
beforeEach(async () => {
  await db.exec("truncate auth.users cascade");
  for (const [name, id] of Object.entries(ids)) {
    await db.query(
      "insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)",
      [
        id,
        `${name}@example.test`,
        JSON.stringify({ display_name: name[0].toUpperCase() + name.slice(1) }),
      ],
    );
    await as(id, "update public.profiles set username = $1 where id = $2", [
      name,
      id,
    ]);
  }
});
after(async () => {
  await db.close();
});

test("signup trigger creates unique safe defaults and never exposes email", async () => {
  const id = "50000000-0000-4000-8000-000000000005";
  await db.query(
    "insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)",
    [
      id,
      "private@example.test",
      JSON.stringify({ display_name: "\t \n", username: "ana" }),
    ],
  );
  const result = await as(id, "select * from public.profiles where id = $1", [
    id,
  ]);
  assert.equal(result.rows[0].username, `yeto_${id.replaceAll("-", "")}`);
  assert.equal(result.rows[0].display_name, "Yeto friend");
  assert.equal(Object.hasOwn(result.rows[0], "email"), false);
  await assert.rejects(
    as(id, "select email from auth.users"),
    /permission denied/,
  );
  const longId = "60000000-0000-4000-8000-000000000006";
  await db.query(
    "insert into auth.users(id, raw_user_meta_data) values ($1, $2::jsonb)",
    [longId, JSON.stringify({ display_name: "x".repeat(59) + " more text" })],
  );
  assert.equal(
    (
      await as(
        longId,
        "select display_name from public.profiles where id = $1",
        [longId],
      )
    ).rows[0].display_name,
    "x".repeat(59),
  );
});

test("anonymous callers and missing auth subjects cannot read or mutate profiles", async () => {
  await assert.rejects(
    as(null, "select * from public.profiles", [], "anon"),
    /permission denied/,
  );
  await assert.rejects(
    as(null, "select public.search_people($1)", ["an"], "anon"),
    /permission denied/,
  );
  assert.equal(
    (await as(null, "select * from public.profiles")).rows.length,
    0,
  );
  await assert.rejects(
    as(null, "select public.send_friend_request($1)", [ids.ana]),
    /Sign in first/,
  );
  await assert.rejects(
    as(ids.ana, "select yeto_private.lock_pair($1, $2)", [ids.ana, ids.bea]),
    /permission denied/,
  );
});

test("profile ownership and username/display-name constraints are enforced by PostgreSQL", async () => {
  assert.equal(
    (
      await as(
        ids.ana,
        "update public.profiles set display_name = $1 where id = $2 returning id",
        ["Changed by stranger", ids.bea],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await as(
        ids.ana,
        "update public.profiles set display_name = $1 where id = $2 returning display_name",
        ["Ana Reyes", ids.ana],
      )
    ).rows[0].display_name,
    "Ana Reyes",
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set username = $1 where id = $2", [
      "UPPERCASE",
      ids.ana,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set username = $1 where id = $2", [
      "a",
      ids.ana,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set username = $1 where id = $2", [
      "bea",
      ids.ana,
    ]),
    /unique constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set display_name = $1 where id = $2", [
      " ",
      ids.ana,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set display_name = $1 where id = $2", [
      "Ana\nReyes",
      ids.ana,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set display_name = $1 where id = $2", [
      "x".repeat(61),
      ids.ana,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    as(ids.ana, "update public.profiles set id = $1 where id = $2", [
      ids.bea,
      ids.ana,
    ]),
    /permission denied/,
  );
});

test("search is bounded, case-insensitive, excludes self, and treats wildcard input literally", async () => {
  assert.deepEqual(
    (
      await as(ids.ana, "select * from public.search_people($1)", ["BE"])
    ).rows.map((p) => p.id),
    [ids.bea],
  );
  assert.equal(
    (await as(ids.ana, "select * from public.search_people($1)", ["an"])).rows
      .length,
    0,
  );
  for (const query of ["", "b", "%_", "x".repeat(61)]) {
    assert.equal(
      (await as(ids.ana, "select * from public.search_people($1)", [query]))
        .rows.length,
      0,
    );
  }
});

test("request cannot spoof sender, duplicate either direction, or target self/missing user", async () => {
  const id = await send(ids.ana, ids.bea);
  assert.ok(id);
  const request = (await as(ids.ana, "select * from public.friend_requests"))
    .rows[0];
  assert.equal(request.requester_id, ids.ana);
  assert.equal(request.status, "pending");
  await assert.rejects(send(ids.ana, ids.bea), /already pending/);
  await assert.rejects(send(ids.bea, ids.ana), /already pending/);
  await assert.rejects(send(ids.ana, ids.ana), /another person/);
  await assert.rejects(
    send(ids.ana, "50000000-0000-4000-8000-000000000005"),
    /unavailable/,
  );
  await assert.rejects(
    as(
      ids.ana,
      "insert into public.friend_requests(requester_id,recipient_id) values($1,$2)",
      [ids.luis, ids.bea],
    ),
    /permission denied/,
  );
});

test("only intended recipient can respond; pending requests grant no friendship", async () => {
  const id = await send(ids.ana, ids.bea);
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    0,
  );
  assert.equal(
    (await as(ids.luis, "select * from public.friend_requests")).rows.length,
    0,
  );
  await assert.rejects(
    as(ids.ana, "select public.respond_friend_request($1,true)", [id]),
    /unavailable/,
  );
  await assert.rejects(
    as(ids.luis, "select public.respond_friend_request($1,true)", [id]),
    /unavailable/,
  );
  await as(ids.bea, "select public.respond_friend_request($1,true)", [id]);
  const friendship = (await as(ids.ana, "select * from public.friendships"))
    .rows[0];
  assert.equal(friendship.user_a, ids.ana);
  assert.equal(friendship.user_b, ids.bea);
  assert.equal(
    (await as(ids.luis, "select * from public.friendships")).rows.length,
    0,
  );
  await assert.rejects(
    as(ids.bea, "select public.respond_friend_request($1,true)", [id]),
    /no longer pending/,
  );
  await assert.rejects(send(ids.ana, ids.bea), /already friends/);
  await assert.rejects(
    as(ids.ana, "update public.friend_requests set status = $1 where id = $2", [
      "declined",
      id,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    as(
      ids.luis,
      "insert into public.friendships(user_a,user_b) values($1,$2)",
      [ids.ana, ids.luis],
    ),
    /permission denied/,
  );
});

test("decline and cancellation never create friendship; only sender can cancel", async () => {
  let id = await send(ids.ana, ids.bea);
  await as(ids.bea, "select public.respond_friend_request($1,false)", [id]);
  assert.equal(
    (await as(ids.ana, "select * from public.friend_requests")).rows[0].status,
    "declined",
  );
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    0,
  );
  id = await send(ids.ana, ids.bea);
  await assert.rejects(
    as(ids.bea, "select public.cancel_friend_request($1)", [id]),
    /unavailable/,
  );
  await as(ids.ana, "select public.cancel_friend_request($1)", [id]);
  assert.equal(
    (
      await as(ids.ana, "select * from public.friend_requests where id = $1", [
        id,
      ])
    ).rows[0].status,
    "cancelled",
  );
  await assert.rejects(
    as(ids.bea, "select public.respond_friend_request($1,true)", [id]),
    /no longer pending/,
  );
});

test("either participant may remove a friendship, unrelated caller may not", async () => {
  await becomeFriends(ids.ana, ids.bea);
  await as(ids.luis, "select public.remove_friend($1)", [ids.ana]);
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    1,
  );
  await as(ids.bea, "select public.remove_friend($1)", [ids.ana]);
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    0,
  );
  await send(ids.ana, ids.bea);
});

test("blocking removes friendship, hides profiles in both directions, keeps blocks private", async () => {
  await becomeFriends(ids.ana, ids.bea);
  await as(ids.ana, "select public.block_person($1)", [ids.bea]);
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    0,
  );
  assert.equal(
    (
      await as(ids.bea, "select * from public.profiles where id = $1", [
        ids.ana,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await as(ids.ana, "select * from public.profiles where id = $1", [
        ids.bea,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (await as(ids.ana, "select * from public.blocks")).rows.length,
    1,
  );
  assert.equal(
    (await as(ids.bea, "select * from public.blocks")).rows.length,
    0,
  );
  assert.equal(
    (await as(ids.luis, "select * from public.blocks")).rows.length,
    0,
  );
  assert.equal(
    (await as(ids.bea, "select * from public.search_people($1)", ["an"])).rows
      .length,
    0,
  );
  await assert.rejects(send(ids.bea, ids.ana), /unavailable/);
  await assert.rejects(send(ids.ana, ids.bea), /unavailable/);
  await assert.rejects(
    as(
      ids.ana,
      "insert into public.blocks(blocker_id,blocked_id) values($1,$2)",
      [ids.luis, ids.paolo],
    ),
    /permission denied/,
  );
});

test("block cancels pending requests atomically and blocks acceptance", async () => {
  const id = await send(ids.bea, ids.ana);
  await as(ids.ana, "select public.block_person($1)", [ids.bea]);
  assert.equal(
    (
      await db.query(
        "select status from public.friend_requests where id = $1",
        [id],
      )
    ).rows[0].status,
    "cancelled",
  );
  assert.equal(
    (await as(ids.bea, "select * from public.friend_requests")).rows.length,
    0,
  );
  await assert.rejects(
    as(ids.ana, "select public.respond_friend_request($1,true)", [id]),
    /no longer pending/,
  );
});

test("unblock only removes caller’s own block and never restores friendship or requests", async () => {
  await becomeFriends(ids.ana, ids.bea);
  await as(ids.ana, "select public.block_person($1)", [ids.bea]);
  await as(ids.bea, "select public.block_person($1)", [ids.ana]);
  await as(ids.bea, "select public.unblock_person($1)", [ids.ana]);
  await assert.rejects(send(ids.bea, ids.ana), /unavailable/);
  await as(ids.ana, "select public.unblock_person($1)", [ids.bea]);
  assert.equal(
    (await as(ids.ana, "select * from public.friendships")).rows.length,
    0,
  );
  assert.equal(
    (await as(ids.bea, "select * from public.search_people($1)", ["an"])).rows
      .length,
    1,
  );
  const id = await send(ids.bea, ids.ana);
  assert.ok(id);
});

test("no RPC grants anonymous execution or permits authenticated caller without a subject", async () => {
  const calls = [
    ["select public.search_people($1)", ["be"]],
    ["select public.send_friend_request($1)", [ids.bea]],
    ["select public.respond_friend_request($1,true)", [ids.ana]],
    ["select public.cancel_friend_request($1)", [ids.ana]],
    ["select public.remove_friend($1)", [ids.bea]],
    ["select public.block_person($1)", [ids.bea]],
    ["select public.unblock_person($1)", [ids.bea]],
  ];
  for (const [query, params] of calls) {
    await assert.rejects(as(null, query, params, "anon"), /permission denied/);
    await assert.rejects(as(null, query, params), /Sign in first/);
  }
});
