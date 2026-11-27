// Builds the app's whole database in an in-memory Postgres (PGlite), the same way a new Supabase project
// would be set up: sql_history/apparel_schema_public.sql, then every file in supabase/migrations in date
// order. Nothing here talks to the live Supabase project.
//
// Supabase's own parts are stood in for:
//   auth.users, auth.uid()   a plain table, and a function that reads the "test.uid" setting
//   storage.buckets/objects  empty tables, so the invoice bucket and its policies can be created
//   net.http_post()          records each call in net.calls instead of sending anything
//   anon / authenticated / service_role   plain roles
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
// One-off data fixes that need a real sign-in email or real stock; they add no tables, rules or functions.
const SKIP = new Set(["20261125120000_safety_vests_to_50.sql"]);

const STUBS = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage; create schema extensions; create schema net;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, last_sign_in_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create table net.calls (id bigint generated always as identity primary key, url text, body jsonb);
create function net.http_post(url text, body jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
  returns bigint language sql security definer as $$ insert into net.calls (url, body) values (url, body) returning id $$;
`;

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !SKIP.has(f)).sort();
}

/** Reads one SQL file, without the one statement PGlite can't run (pg_net is stood in for above). */
export function readSql(file) {
  return fs.readFileSync(file, "utf8").replace(/^create extension if not exists pg_net[^;]*;/m, "");
}

/** A new database with every SQL file run, in order. `upTo` stops after the file whose name starts with it. */
export async function buildDatabase({ upTo } = {}) {
  const db = new PGlite();
  await db.exec(STUBS);
  const run = async (file) => {
    try { await db.exec(readSql(file)); }
    catch (e) { await db.exec("rollback").catch(() => {}); throw new Error(`${path.basename(file)} failed: ${e.message}`); }
  };
  await run(path.join(ROOT, "sql_history/apparel_schema_public.sql"));
  for (const f of migrationFiles()) {
    await run(path.join(MIGRATIONS, f));
    if (upTo && f.startsWith(upTo)) break;
  }
  return db;
}

/** Runs one migration file again on a built database. Resolves to null, or to the error message. */
export async function rerun(db, name) {
  const f = migrationFiles().find((x) => x.startsWith(name));
  try { await db.exec(readSql(path.join(MIGRATIONS, f))); return null; }
  catch (e) { await db.exec("rollback").catch(() => {}); return e.message; }
}

/** Helpers for acting as an app user. */
export function session(db) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  let current = "";   // who auth.uid() is right now
  const setUid = (id) => db.exec(`select set_config('test.uid', '${id || ""}', false)`);
  return {
    q, one,
    /** Adds a login and its app user; returns the user's id. */
    async addUser(name, role, departmentId = null, active = true) {
      const { id } = await one("insert into auth.users (email) values ($1) returning id", [`${name.toLowerCase()}@example.com`]);
      await q("insert into apparel.app_users (user_id, display_name, role, active, department_id) values ($1, $2, $3, $4, $5)", [id, name, role, active, departmentId]);
      return id;
    },
    /** Runs fn as that signed-in user, with row-level security applied, then goes back to the owner (and to whoever login() set). */
    async as(userId, fn) {
      await setUid(userId); await db.exec("set role authenticated");
      try { return await fn(); } finally { await db.exec("reset role"); await setUid(current); }
    },
    /** Sets who auth.uid() is while staying the database owner (as the SQL Editor is, but with a login). */
    async login(userId) { current = userId || ""; await setUid(current); },
    /** The error message fn fails with, or null if it works. */
    async fails(fn) { try { await fn(); return null; } catch (e) { await db.exec("rollback").catch(() => {}); return e.message || String(e); } },
  };
}
