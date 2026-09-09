-- ============================================================================
-- WhatsApp Multi-Session Backend — Supabase (Postgres) Schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- SESSIONS — one row per WhatsApp account/device connected to this backend
-- ----------------------------------------------------------------------------
create table if not exists wa_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text unique not null,           -- app-level identifier you choose (e.g. "acct-1")
  owner_id text,                              -- optional: your CRM user/tenant id
  wa_jid text,                                -- e.g. "9199xxxxxxx@s.whatsapp.net" once linked
  phone_number text,
  display_name text,
  status text not null default 'disconnected', -- disconnected | connecting | qr | open | logged_out
  qr text,                                    -- latest QR string (data URL) while status = qr
  connected_at timestamptz,
  last_disconnect_reason text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_wa_sessions_owner on wa_sessions(owner_id);

-- ----------------------------------------------------------------------------
-- AUTH STATE — replaces useMultiFileAuthState with a DB-backed store so a
-- single scan survives restarts/redeploys and works across machines.
-- One row for the "creds" blob, many rows for the signal key store entries.
-- ----------------------------------------------------------------------------
create table if not exists wa_auth_creds (
  session_id text primary key references wa_sessions(session_id) on delete cascade,
  creds jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists wa_auth_keys (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  key_type text not null,   -- 'pre-key' | 'session' | 'sender-key' | 'app-state-sync-key' | 'app-state-sync-version' | 'sender-key-memory'
  key_id text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, key_type, key_id)
);

-- ----------------------------------------------------------------------------
-- CONTACTS — WhatsApp's "saved name" resolution: pushName (their own profile
-- name) vs notify/verifiedName vs your own address-book name if you sync one.
-- ----------------------------------------------------------------------------
create table if not exists wa_contacts (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  jid text not null,
  name text,              -- contact's own set display/profile name (from contacts.upsert / pushName)
  notify text,            -- push name as WhatsApp reports it on incoming messages
  verified_name text,     -- business verified name, if any
  short_name text,
  img_url text,           -- cached profile picture URL
  is_business boolean default false,
  is_enterprise boolean default false,
  status text,            -- "about" text
  last_synced_at timestamptz default now(),
  primary key (session_id, jid)
);

-- ----------------------------------------------------------------------------
-- CHATS
-- ----------------------------------------------------------------------------
create table if not exists wa_chats (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  jid text not null,
  name text,
  is_group boolean not null default false,
  unread_count int not null default 0,
  archived boolean not null default false,
  pinned boolean not null default false,
  muted_until timestamptz,
  last_message_id text,
  last_message_ts timestamptz,
  conversation_timestamp bigint,
  ephemeral_expiration int,          -- disappearing messages, seconds
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);
create index if not exists idx_wa_chats_last_msg on wa_chats(session_id, last_message_ts desc);

-- ----------------------------------------------------------------------------
-- MESSAGES
-- ----------------------------------------------------------------------------
create table if not exists wa_messages (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  id text not null,                  -- WhatsApp message key.id
  chat_jid text not null,
  sender_jid text,                   -- participant for groups, remoteJid for 1:1
  from_me boolean not null default false,
  message_type text,                 -- conversation | imageMessage | videoMessage | audioMessage | documentMessage | stickerMessage | contactMessage | locationMessage | pollCreationMessage | reactionMessage | ...
  content jsonb,                     -- raw proto message content (sanitized)
  text_body text,                    -- flattened text/caption for search
  media_id uuid,                     -- fk -> wa_media.id when applicable
  quoted_message_id text,
  mentions text[],
  status text default 'pending',     -- pending | sent | delivered | read | played | failed
  timestamp timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  starred boolean default false,
  raw jsonb,                         -- full original WAMessage for auditing/replay
  created_at timestamptz not null default now(),
  primary key (session_id, id, chat_jid)
);
create index if not exists idx_wa_messages_chat on wa_messages(session_id, chat_jid, timestamp desc);
create index if not exists idx_wa_messages_text on wa_messages using gin (to_tsvector('simple', coalesce(text_body, '')));

-- ----------------------------------------------------------------------------
-- MEDIA — metadata; the binary itself lives on local disk (or Supabase
-- Storage, optionally) at `storage_path` / `storage_url`.
-- ----------------------------------------------------------------------------
create table if not exists wa_media (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references wa_sessions(session_id) on delete cascade,
  message_id text,
  chat_jid text,
  media_type text,          -- image | video | audio | document | sticker | ptt
  mime_type text,
  file_name text,
  file_size bigint,
  width int,
  height int,
  duration_seconds int,
  storage_path text,        -- local disk path
  storage_url text,         -- supabase storage public/signed URL, if uploaded
  sha256 text,
  caption text,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_media_msg on wa_media(session_id, message_id);

-- ----------------------------------------------------------------------------
-- GROUPS
-- ----------------------------------------------------------------------------
create table if not exists wa_groups (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  jid text not null,
  subject text,
  description text,
  owner_jid text,
  creation_ts timestamptz,
  participants jsonb,        -- [{ jid, admin: 'admin'|'superadmin'|null }]
  restrict_mode boolean default false,   -- only admins can change group info
  announce_mode boolean default false,   -- only admins can send messages
  is_community boolean default false,
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);

-- ----------------------------------------------------------------------------
-- MESSAGE ACTIONS — reactions, deletes, edits, stars kept as an event log
-- (independent from the mutation applied to wa_messages) for audit/history.
-- ----------------------------------------------------------------------------
create table if not exists wa_message_actions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references wa_sessions(session_id) on delete cascade,
  chat_jid text not null,
  message_id text not null,
  action_type text not null,   -- reaction | delete | edit | star | unstar
  actor_jid text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- PRIVACY SETTINGS (cached mirror of account.privacySettingsGet)
-- ----------------------------------------------------------------------------
create table if not exists wa_privacy_settings (
  session_id text primary key references wa_sessions(session_id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- PRESENCE — last known presence per chat/jid (composing, online, etc.)
-- ----------------------------------------------------------------------------
create table if not exists wa_presence (
  session_id text not null references wa_sessions(session_id) on delete cascade,
  jid text not null,
  presence text,             -- unavailable | available | composing | recording | paused
  last_seen timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);

-- ----------------------------------------------------------------------------
-- HISTORY SYNC PROGRESS — track background sync so it can resume/report
-- ----------------------------------------------------------------------------
create table if not exists wa_history_sync_state (
  session_id text primary key references wa_sessions(session_id) on delete cascade,
  is_syncing boolean default false,
  progress int default 0,       -- 0-100 as reported by WhatsApp
  chunks_received int default 0,
  is_latest boolean default false,
  last_chunk_at timestamptz,
  completed_at timestamptz
);

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array['wa_sessions','wa_auth_creds','wa_auth_keys','wa_chats',
                            'wa_groups','wa_privacy_settings','wa_presence']
  loop
    execute format('drop trigger if exists trg_set_updated_at on %I;', t);
    execute format('create trigger trg_set_updated_at before update on %I
                     for each row execute function set_updated_at();', t);
  end loop;
end $$;
