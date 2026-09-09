# WhatsApp Multi-Session Backend (Baileys + Express + Supabase)

A production-ready backend for running **multiple WhatsApp accounts** through
the unofficial WhatsApp Web protocol (via [Baileys](https://baileys.wiki)),
with:

- **Scan once, never again** — auth state is persisted to Supabase, not disk,
  so credentials survive restarts/redeploys and the QR is only shown until
  the first successful link.
- **Auto-reconnect** on drops (network blips, server restarts) without ever
  touching stored credentials. Only a real logout (from the phone, or via the
  `/logout` endpoint) clears credentials and requires a new scan.
- **Full data store in Supabase Postgres**: sessions, contacts (with
  WhatsApp's own "saved name" resolution), chats, messages (searchable),
  groups, privacy settings, presence, media metadata, and message actions
  (reactions/edits/deletes/stars) as an audit log.
- **Media** downloaded and stored on local disk (fast path), with an optional
  mirror to Supabase Storage if you run more than one instance.
- **Socket.IO** real-time gateway — every Baileys event (new message, chat
  update, presence, group changes, history sync progress, QR updates...) is
  re-broadcast to subscribed frontends, scoped per session.
- **Background history sync** — processed in small batches so it never blocks
  live message send/receive, with progress tracked in `wa_history_sync_state`.
- **USync** number validation (`/usync/check-numbers`) before sending, so you
  never waste a send on a number that isn't on WhatsApp.
- Structured logging via `pino` (pretty in dev, JSON in prod).

---

## 1. Setup

### 1.1 Supabase

1. Create a Supabase project.
2. Open the SQL editor and run `src/db/schema.sql` once.
3. (Optional) If you want media mirrored off-disk too, create a Storage
   bucket matching `SUPABASE_MEDIA_BUCKET` (defaults to `wa-media`) and set
   `MEDIA_UPLOAD_TO_SUPABASE=true`.
4. Copy your **Project URL** and **service_role key** (Settings → API) into
   `.env` — never expose the service role key to a browser/client.

### 1.2 Environment

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and a strong API_KEY
```

### 1.3 Install & run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on change)
```

The server resumes every previously linked session automatically on boot —
no QR needed for accounts that were already scanned.

---

## 2. Linking a WhatsApp account (one-time QR scan)

```bash
curl -X POST http://localhost:8080/api/sessions/acct-1 \
  -H "x-api-key: $API_KEY"
```

Then either:
- **Poll** `GET /api/sessions/acct-1/qr` until `status` flips from `qr` to
  `open`, or
- **Subscribe over Socket.IO** (recommended) — connect with
  `{ auth: { apiKey } }`, emit `subscribe` with `"acct-1"`, and listen for the
  `connection.qr` event (base64 PNG data URL, ready to `<img src="...">`) and
  `connection.update` (fires with `status: "open"` once scanned).

From then on, `POST /api/sessions/acct-1` reconnects silently — no QR.

---

## 3. Architecture

```
src/
  config/        env, pino logger, supabase client
  db/
    schema.sql             full Postgres schema (run once in Supabase)
    supabaseAuthState.js    Baileys AuthenticationState backed by Supabase
                            (replaces useMultiFileAuthState)
  services/
    sessionManager.js       creates/reconnects/destroys sockets per account,
                             QR generation, reconnect/backoff, logout
    messageService.js        send every message type + receive persistence +
                             message actions (react/delete/edit/star)
    chatService.js           chat upsert/list/archive/pin/delete
    contactService.js         contact upsert + "saved name" resolution
    groupService.js           create/manage groups, participants, invites
    mediaService.js           download/store/stream media (disk + Supabase)
    presenceService.js       presence tracking + typing indicators
    privacyService.js         privacy settings + block/unblock
    historySyncService.js     background chunked history processing
    usyncService.js           bulk "is this number on WhatsApp" checks
  events/bindEvents.js        wires every sock.ev.on(...) to persistence +
                             Socket.IO emission
  socket/socketGateway.js    Socket.IO server, per-session rooms
  routes/                   REST API (see below)
  middleware/                API-key auth, async wrapper, error handler
```

### Why Supabase for auth state instead of files?

The default `useMultiFileAuthState` helper writes one JSON file per signal
key to local disk. That breaks the "scan once" requirement the moment you
redeploy, scale to >1 instance, or run on an ephemeral filesystem. Storing
`creds` + keys in Postgres (`wa_auth_creds` / `wa_auth_keys`) makes the whole
auth state durable and portable, while `makeCacheableSignalKeyStore` keeps
the hot path fast (in-memory LRU in front of the DB).

---

## 4. REST API

All routes are under `/api` and require `x-api-key: <API_KEY>`.

### Sessions
| Method | Path | Description |
|---|---|---|
| POST | `/sessions/:id` | Start/resume a session (QR if not yet linked) |
| GET | `/sessions` | List all sessions + status |
| GET | `/sessions/:id` | Get one session |
| GET | `/sessions/:id/qr` | Get current QR (if status is `qr`) |
| GET | `/sessions/:id/history-sync` | Background sync progress |
| POST | `/sessions/:id/stop` | Disconnect, keep credentials |
| POST | `/sessions/:id/logout` | Unlink device + wipe credentials |

### Messages (`/sessions/:id/messages`)
`POST /text`, `/media`, `/location`, `/contact`, `/poll`, `/buttons`, `/list` — send.
`GET /:chatJid` — paginated history. `GET /search/:query` — full-text search.
`POST /read` — mark read. `POST /:chatJid/:messageId/react` — reaction.
`DELETE /:chatJid/:messageId` — delete for everyone.
`PATCH /:chatJid/:messageId` — edit. `POST /:chatJid/:messageId/star` — star/unstar.

### Chats (`/sessions/:id/chats`)
`GET /`, `PATCH /:jid/archive`, `PATCH /:jid/pin`, `PATCH /:jid/mute`,
`DELETE /:jid`, `POST /:jid/presence-subscribe`, `POST /:jid/presence`.

### Groups (`/sessions/:id/groups`)
`GET /`, `GET /:jid`, `POST /` (create), `POST /:jid/participants`
(`action: add|remove|promote|demote`), `PATCH /:jid/subject`,
`PATCH /:jid/description`, `PATCH /:jid/settings`, `POST /:jid/leave`,
`GET /:jid/invite-code`, `POST /:jid/invite-code/revoke`, `POST /join`.

### Contacts (`/sessions/:id/contacts`)
`GET /`, `GET /:jid`, `POST /:jid/refresh-picture`.

### Media (`/sessions/:id/media`)
`GET /:mediaId` (streams the file), `GET /:mediaId/info`, `POST /upload`.

### Privacy (`/sessions/:id/privacy`)
`GET /`, `POST /refresh`, `PATCH /:key` (`lastSeen|online|profilePicture|status|readReceipts|groupsAdd|defaultDisappearingMode`),
`GET /blocklist`, `POST /blocklist/:jid/block`, `POST /blocklist/:jid/unblock`.

### USync (`/sessions/:id/usync`)
`POST /check-numbers` — `{ numbers: ["919999999999", ...] }` → validity + JID.
`GET /status/:jid` — fetch "about" text.

---

## 5. Socket.IO events (per-session room)

Connect with `io(url, { auth: { apiKey } })`, then `socket.emit('subscribe', sessionId)`.

`connection.qr`, `connection.update`, `creds.update`, `history.sync`,
`contacts.upsert`, `contacts.update`, `chats.upsert`, `chats.update`,
`chats.delete`, `messages.new`, `messages.update`, `messages.delete`,
`messages.reaction`, `message-receipt.update`, `groups.upsert`,
`groups.update`, `group-participants.update`, `presence.update`,
`blocklist.set`, `blocklist.update`, `labels.edit`, `labels.association`.

---

## 6. Production notes

- Put this behind a reverse proxy (nginx/Caddy) with TLS.
- Set `MAX_SESSIONS` to a number your instance's RAM can hold (each session
  holds an in-memory signal key cache + open WebSocket).
- Run `npm audit` periodically and keep `baileys` updated — the WhatsApp Web
  protocol changes over time and the library is updated frequently.
- For horizontal scaling across multiple instances, either shard sessions by
  instance (sticky routing) or move Socket.IO to a Redis adapter — the
  Supabase-backed auth state already supports moving a session between
  machines safely.
- Everything above the API-key gate is intentionally simple; swap
  `middleware/auth.js` for real per-tenant auth (JWT, Supabase Auth, etc.) if
  this sits behind a multi-user CRM.
