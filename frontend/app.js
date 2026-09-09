// =============================================================================
// WA Backend Console — a vanilla-JS test harness for the Baileys/Express/
// Supabase backend. No build step: open index.html (served over http, not
// file://, so fetch/CORS behave) and point it at your running backend.
// =============================================================================

const state = {
  backendUrl: localStorage.getItem('wa_backendUrl') || 'http://localhost:8080',
  apiKey: localStorage.getItem('wa_apiKey') || '',
  socket: null,
  sessions: [],
  currentSessionId: null,
  chats: [],
  currentChatJid: null,
  messagesById: new Map(), // id -> row, for the currently open chat
  groups: [],
  currentGroupJid: null,
};

// ----------------------------------------------------------------------------
// REST helper
// ----------------------------------------------------------------------------
async function api(method, path, body) {
  const url = `${state.backendUrl.replace(/\/$/, '')}/api${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json.data;
}

function mediaUrl(mediaId) {
  return `${state.backendUrl.replace(/\/$/, '')}/api/sessions/${state.currentSessionId}/media/${mediaId}?apiKey=${encodeURIComponent(state.apiKey)}`;
}

function toast(msg, isError = false) {
  logEvent(isError ? 'error' : 'info', msg);
  if (isError) console.error(msg);
}

// ----------------------------------------------------------------------------
// Connection bar (backend URL / API key / health check)
// ----------------------------------------------------------------------------
const backendUrlInput = document.getElementById('backendUrl');
const apiKeyInput = document.getElementById('apiKey');
const healthDot = document.querySelector('#healthIndicator .dot');
const healthLabel = document.querySelector('#healthIndicator .health-label');

backendUrlInput.value = state.backendUrl;
apiKeyInput.value = state.apiKey;

document.getElementById('saveConn').addEventListener('click', () => {
  state.backendUrl = backendUrlInput.value.trim() || 'http://localhost:8080';
  state.apiKey = apiKeyInput.value.trim();
  localStorage.setItem('wa_backendUrl', state.backendUrl);
  localStorage.setItem('wa_apiKey', state.apiKey);
  connectSocket();
  checkHealth();
  refreshSessions();
});

async function checkHealth() {
  healthDot.dataset.state = 'pending';
  healthLabel.textContent = 'checking…';
  try {
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/health`);
    const json = await res.json();
    healthDot.dataset.state = json.ok ? 'ok' : 'bad';
    healthLabel.textContent = json.ok ? `up (${Math.round(json.uptime)}s)` : 'unhealthy';
  } catch {
    healthDot.dataset.state = 'bad';
    healthLabel.textContent = 'unreachable';
  }
}
setInterval(checkHealth, 10000);

// ----------------------------------------------------------------------------
// Socket.IO
// ----------------------------------------------------------------------------
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io(state.backendUrl, { auth: { apiKey: state.apiKey }, transports: ['websocket', 'polling'] });

  state.socket.on('connect', () => logEvent('socket', 'connected'));
  state.socket.on('disconnect', () => logEvent('socket', 'disconnected'));
  state.socket.on('connect_error', (err) => logEvent('socket', `connect_error: ${err.message}`, true));

  const events = [
    'connection.qr', 'connection.update', 'creds.update', 'history.sync',
    'contacts.upsert', 'contacts.update', 'chats.upsert', 'chats.update', 'chats.delete',
    'messages.new', 'messages.update', 'messages.delete', 'messages.reaction', 'message-receipt.update',
    'groups.upsert', 'groups.update', 'group-participants.update', 'presence.update',
    'blocklist.set', 'blocklist.update', 'labels.edit', 'labels.association',
  ];
  events.forEach((ev) => state.socket.on(ev, (payload) => handleSocketEvent(ev, payload)));
}

function handleSocketEvent(event, payload) {
  logEvent(event, payload);

  if (event === 'connection.qr' && payload.sessionId === state.currentSessionId) {
    showQrModal(payload.sessionId, payload.qr);
  }
  if (event === 'connection.update') {
    refreshSessions();
    if (payload.status === 'open') hideQrModal();
  }
  if (event === 'messages.new' && payload.chat_jid === state.currentChatJid) {
    state.messagesById.set(payload.id, payload);
    renderMessages();
  }
  if (event === 'chats.upsert' || event === 'chats.update') {
    if (state.currentSessionId) loadChats();
  }
  if (event === 'groups.upsert' || event === 'groups.update' || event === 'group-participants.update') {
    if (state.currentSessionId) loadGroups();
  }
}

function subscribeSession(sessionId) {
  if (!state.socket) return;
  state.socket.emit('subscribe', sessionId);
}
function unsubscribeSession(sessionId) {
  if (!state.socket) return;
  state.socket.emit('unsubscribe', sessionId);
}

// ----------------------------------------------------------------------------
// Event log
// ----------------------------------------------------------------------------
const eventLogEl = document.getElementById('eventLog');
function logEvent(name, payload, isError = false) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  li.innerHTML = `
    <span class="ev-time">${time}</span>
    <span class="ev-name" style="color:${isError ? 'var(--danger)' : 'var(--accent)'}">${escapeHtml(name)}</span>
    <span class="ev-payload">${escapeHtml(payloadStr || '')}</span>
  `;
  eventLogEl.prepend(li);
  while (eventLogEl.children.length > 300) eventLogEl.removeChild(eventLogEl.lastChild);
}
document.getElementById('clearLogs').addEventListener('click', () => { eventLogEl.innerHTML = ''; });

// ----------------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------------
document.getElementById('tabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');

  if (btn.dataset.tab === 'contacts') loadContacts();
  if (btn.dataset.tab === 'groups') loadGroups();
  if (btn.dataset.tab === 'privacy') loadPrivacy();
});

// ----------------------------------------------------------------------------
// Sessions
// ----------------------------------------------------------------------------
const sessionListEl = document.getElementById('sessionList');
const currentSessionValueEl = document.getElementById('currentSessionValue');

document.getElementById('newSessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('newSessionId');
  const sessionId = input.value.trim();
  if (!sessionId) return;
  try {
    await api('POST', `/sessions/${encodeURIComponent(sessionId)}`);
    input.value = '';
    selectSession(sessionId);
    await refreshSessions();
  } catch (err) {
    toast(`Failed to start session: ${err.message}`, true);
  }
});

document.getElementById('refreshSessions').addEventListener('click', refreshSessions);

async function refreshSessions() {
  try {
    state.sessions = await api('GET', '/sessions');
    renderSessions();
  } catch (err) {
    toast(`Could not load sessions: ${err.message}`, true);
  }
}

function renderSessions() {
  if (!state.sessions.length) {
    sessionListEl.innerHTML = '<li class="empty-hint">No sessions yet — start one above.</li>';
    return;
  }
  sessionListEl.innerHTML = state.sessions.map((s) => {
    const dotState = { open: 'ok', connecting: 'pending', qr: 'pending', logged_out: 'bad', disconnected: 'unknown' }[s.status] || 'unknown';
    return `
      <li class="session-item ${s.session_id === state.currentSessionId ? 'selected' : ''}" data-id="${escapeHtml(s.session_id)}">
        <div class="session-item-top">
          <span class="session-id"><span class="dot" data-state="${dotState}"></span> ${escapeHtml(s.session_id)}</span>
        </div>
        <div class="session-meta">${escapeHtml(s.status)}${s.phone_number ? ' · ' + escapeHtml(s.phone_number) : ''}</div>
        <div class="session-actions">
          ${s.status === 'qr' ? `<button class="btn btn-sm btn-ghost" data-action="qr">QR</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-action="stop">Stop</button>
          <button class="btn btn-sm btn-danger" data-action="logout">Logout</button>
        </div>
      </li>`;
  }).join('');
}

sessionListEl.addEventListener('click', async (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const sessionId = item.dataset.id;
  const actionBtn = e.target.closest('[data-action]');

  if (!actionBtn) {
    selectSession(sessionId);
    return;
  }
  const action = actionBtn.dataset.action;
  try {
    if (action === 'stop') await api('POST', `/sessions/${sessionId}/stop`);
    if (action === 'logout') {
      if (!confirm(`Logout ${sessionId}? This wipes stored credentials — a new QR scan will be required.`)) return;
      await api('POST', `/sessions/${sessionId}/logout`);
    }
    if (action === 'qr') {
      const { qr } = await api('GET', `/sessions/${sessionId}/qr`);
      if (qr) showQrModal(sessionId, qr);
      else toast('No QR available right now (session may already be linked).');
    }
    await refreshSessions();
  } catch (err) {
    toast(`Action failed: ${err.message}`, true);
  }
});

function selectSession(sessionId) {
  if (state.currentSessionId) unsubscribeSession(state.currentSessionId);
  state.currentSessionId = sessionId;
  currentSessionValueEl.textContent = sessionId;
  subscribeSession(sessionId);
  renderSessions();
  loadChats();
  loadContacts();
  loadGroups();
  loadPrivacy();
}

// ----------------------------------------------------------------------------
// QR modal
// ----------------------------------------------------------------------------
const qrModal = document.getElementById('qrModal');
function showQrModal(sessionId, qrDataUrl) {
  document.getElementById('qrSessionLabel').textContent = sessionId;
  document.getElementById('qrImage').src = qrDataUrl;
  qrModal.classList.remove('hidden');
}
function hideQrModal() { qrModal.classList.add('hidden'); }
document.getElementById('closeQrModal').addEventListener('click', hideQrModal);

// ----------------------------------------------------------------------------
// Chats
// ----------------------------------------------------------------------------
const chatListEl = document.getElementById('chatList');
document.getElementById('refreshChats').addEventListener('click', loadChats);

async function loadChats() {
  if (!state.currentSessionId) return;
  try {
    state.chats = await api('GET', `/sessions/${state.currentSessionId}/chats?limit=100`);
    renderChats();
  } catch (err) {
    toast(`Could not load chats: ${err.message}`, true);
  }
}

function renderChats() {
  if (!state.chats.length) {
    chatListEl.innerHTML = '<li class="empty-hint">No chats yet for this session.</li>';
    return;
  }
  chatListEl.innerHTML = state.chats.map((c) => `
    <li class="chat-item ${c.jid === state.currentChatJid ? 'selected' : ''}" data-jid="${escapeHtml(c.jid)}">
      ${c.unread_count ? `<span class="chat-item-badge">${c.unread_count}</span>` : ''}
      <div class="chat-item-name">${escapeHtml(c.name || '(unnamed)')}</div>
      <div class="chat-item-jid">${escapeHtml(c.jid)}</div>
    </li>
  `).join('');
}

chatListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.chat-item');
  if (!item) return;
  openChat(item.dataset.jid);
});

async function openChat(jid) {
  state.currentChatJid = jid;
  renderChats();
  document.getElementById('threadTitle').textContent = jid;
  try {
    const rows = await api('GET', `/sessions/${state.currentSessionId}/messages/${encodeURIComponent(jid)}?limit=100`);
    state.messagesById = new Map(rows.map((r) => [r.id, r]));
    renderMessages();
  } catch (err) {
    toast(`Could not load messages: ${err.message}`, true);
  }
}

function renderMessages() {
  const messageListEl = document.getElementById('messageList');
  const rows = [...state.messagesById.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (!rows.length) {
    messageListEl.innerHTML = '<li class="empty-hint">No messages loaded.</li>';
    return;
  }
  messageListEl.innerHTML = rows.map((m) => {
    const body = m.deleted_at
      ? 'This message was deleted'
      : (m.text_body || (m.media_id ? `[${escapeHtml(m.message_type)}] media id: ${m.media_id}` : `[${escapeHtml(m.message_type)}]`));
    return `
      <li class="msg ${m.from_me ? 'from-me' : ''} ${m.deleted_at ? 'deleted' : ''}" data-id="${escapeHtml(m.id)}">
        <div class="msg-meta">${m.from_me ? 'you' : escapeHtml(m.sender_jid || '')} · ${new Date(m.timestamp).toLocaleString()} · ${escapeHtml(m.status || '')}${m.starred ? ' · ★' : ''}</div>
        <div class="msg-body">${escapeHtml(body)}</div>
        ${m.deleted_at ? '' : `
        <div class="msg-actions">
          <button data-action="react">react</button>
          <button data-action="star">${m.starred ? 'unstar' : 'star'}</button>
          ${m.from_me ? '<button data-action="edit">edit</button>' : ''}
          <button data-action="delete">delete</button>
        </div>`}
      </li>`;
  }).join('');
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

document.getElementById('messageList').addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;
  const li = e.target.closest('.msg');
  const id = li.dataset.id;
  const row = state.messagesById.get(id);
  const chatJid = state.currentChatJid;
  const action = actionBtn.dataset.action;

  try {
    if (action === 'react') {
      const emoji = prompt('Emoji to react with (e.g. 👍):', '👍');
      if (!emoji) return;
      await api('POST', `/sessions/${state.currentSessionId}/messages/${encodeURIComponent(chatJid)}/${id}/react`, {
        emoji, fromMe: row.from_me,
      });
    }
    if (action === 'star') {
      await api('POST', `/sessions/${state.currentSessionId}/messages/${encodeURIComponent(chatJid)}/${id}/star`, {
        fromMe: row.from_me, star: !row.starred,
      });
      row.starred = !row.starred;
      renderMessages();
    }
    if (action === 'edit') {
      const text = prompt('New text:', row.text_body || '');
      if (text === null) return;
      const updated = await api('PATCH', `/sessions/${state.currentSessionId}/messages/${encodeURIComponent(chatJid)}/${id}`, {
        text, fromMe: true,
      });
      state.messagesById.set(updated.id, updated);
      renderMessages();
    }
    if (action === 'delete') {
      if (!confirm('Delete this message for everyone?')) return;
      await api('DELETE', `/sessions/${state.currentSessionId}/messages/${encodeURIComponent(chatJid)}/${id}`, {
        fromMe: row.from_me,
      });
      row.deleted_at = new Date().toISOString();
      renderMessages();
    }
  } catch (err) {
    toast(`Message action failed: ${err.message}`, true);
  }
});

document.getElementById('markReadBtn').addEventListener('click', async () => {
  if (!state.currentChatJid) return;
  const unread = [...state.messagesById.values()].filter((m) => !m.from_me && m.status !== 'read');
  if (!unread.length) return toast('Nothing to mark as read.');
  try {
    await api('POST', `/sessions/${state.currentSessionId}/messages/read`, {
      keys: unread.map((m) => ({ remoteJid: state.currentChatJid, id: m.id, fromMe: false })),
    });
    toast('Marked as read.');
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
});

document.getElementById('subscribePresenceBtn').addEventListener('click', async () => {
  if (!state.currentChatJid) return;
  try {
    await api('POST', `/sessions/${state.currentSessionId}/chats/${encodeURIComponent(state.currentChatJid)}/presence-subscribe`);
    toast('Subscribed to presence for this chat.');
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
});

// ---- composer -----------------------------------------------------------
const composerType = document.getElementById('composerType');
composerType.addEventListener('change', () => {
  ['Text', 'Media', 'Location', 'Poll'].forEach((k) => {
    document.getElementById(`composerFields${k}`).classList.toggle('hidden', k.toLowerCase() !== composerType.value);
  });
});

document.getElementById('composerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentChatJid) return toast('Select a chat first.', true);
  const to = state.currentChatJid;
  try {
    let row;
    switch (composerType.value) {
      case 'text': {
        const text = document.getElementById('composerText').value.trim();
        if (!text) return;
        row = await api('POST', `/sessions/${state.currentSessionId}/messages/text`, { to, text });
        document.getElementById('composerText').value = '';
        break;
      }
      case 'media': {
        const type = document.getElementById('mediaType').value;
        const source = document.getElementById('mediaSource').value.trim();
        const caption = document.getElementById('mediaCaption').value.trim();
        if (!source) return toast('Provide a media URL or base64 string.', true);
        row = await api('POST', `/sessions/${state.currentSessionId}/messages/media`, { to, type, source, caption });
        break;
      }
      case 'location': {
        const latitude = parseFloat(document.getElementById('locLat').value);
        const longitude = parseFloat(document.getElementById('locLng').value);
        const name = document.getElementById('locName').value.trim();
        if (Number.isNaN(latitude) || Number.isNaN(longitude)) return toast('Latitude and longitude required.', true);
        row = await api('POST', `/sessions/${state.currentSessionId}/messages/location`, { to, latitude, longitude, name });
        break;
      }
      case 'poll': {
        const name = document.getElementById('pollName').value.trim();
        const values = document.getElementById('pollOptions').value.split(',').map((v) => v.trim()).filter(Boolean);
        if (!name || values.length < 2) return toast('Poll needs a question and at least 2 options.', true);
        row = await api('POST', `/sessions/${state.currentSessionId}/messages/poll`, { to, name, values });
        break;
      }
    }
    if (row) {
      state.messagesById.set(row.id, row);
      renderMessages();
    }
  } catch (err) {
    toast(`Send failed: ${err.message}`, true);
  }
});

// ----------------------------------------------------------------------------
// Contacts
// ----------------------------------------------------------------------------
const contactsBodyEl = document.getElementById('contactsBody');
let allContacts = [];

document.getElementById('refreshContacts').addEventListener('click', loadContacts);
document.getElementById('contactFilter').addEventListener('input', renderContacts);

async function loadContacts() {
  if (!state.currentSessionId) return;
  try {
    allContacts = await api('GET', `/sessions/${state.currentSessionId}/contacts?limit=500`);
    renderContacts();
  } catch (err) {
    toast(`Could not load contacts: ${err.message}`, true);
  }
}

function renderContacts() {
  const filter = document.getElementById('contactFilter').value.toLowerCase();
  const rows = allContacts.filter((c) =>
    !filter || (c.displayName || '').toLowerCase().includes(filter) || c.jid.toLowerCase().includes(filter)
  );
  if (!rows.length) {
    contactsBodyEl.innerHTML = `<tr><td colspan="5" class="empty-hint">${state.currentSessionId ? 'No contacts found.' : 'Select a session to load contacts.'}</td></tr>`;
    return;
  }
  contactsBodyEl.innerHTML = rows.map((c) => `
    <tr data-jid="${escapeHtml(c.jid)}">
      <td>${escapeHtml(c.displayName || '—')}</td>
      <td class="mono">${escapeHtml(c.jid)}</td>
      <td>${escapeHtml(c.notify || '')}</td>
      <td>${c.is_business ? 'yes' : ''}</td>
      <td><button class="btn btn-sm btn-ghost" data-action="refresh-pic">picture</button></td>
    </tr>
  `).join('');
}

contactsBodyEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="refresh-pic"]');
  if (!btn) return;
  const jid = btn.closest('tr').dataset.jid;
  try {
    const { imgUrl } = await api('POST', `/sessions/${state.currentSessionId}/contacts/${encodeURIComponent(jid)}/refresh-picture`);
    toast(imgUrl ? `Picture URL: ${imgUrl}` : 'No profile picture set / privacy restricted.');
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
});

// ----------------------------------------------------------------------------
// Groups
// ----------------------------------------------------------------------------
const groupListEl = document.getElementById('groupList');
document.getElementById('refreshGroups').addEventListener('click', loadGroups);

async function loadGroups() {
  if (!state.currentSessionId) return;
  try {
    state.groups = await api('GET', `/sessions/${state.currentSessionId}/groups`);
    renderGroups();
  } catch (err) {
    toast(`Could not load groups: ${err.message}`, true);
  }
}

function renderGroups() {
  if (!state.groups.length) {
    groupListEl.innerHTML = '<li class="empty-hint">No groups for this session yet.</li>';
    return;
  }
  groupListEl.innerHTML = state.groups.map((g) => `
    <li class="chat-item ${g.jid === state.currentGroupJid ? 'selected' : ''}" data-jid="${escapeHtml(g.jid)}">
      <div class="chat-item-name">${escapeHtml(g.subject || '(unnamed group)')}</div>
      <div class="chat-item-jid">${escapeHtml(g.jid)} · ${(g.participants || []).length} members</div>
    </li>
  `).join('');
}

groupListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.chat-item');
  if (!item) return;
  state.currentGroupJid = item.dataset.jid;
  renderGroups();
  renderGroupDetail();
});

document.getElementById('createGroupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const subject = document.getElementById('newGroupSubject').value.trim();
  const participants = document.getElementById('newGroupParticipants').value.split(',').map((v) => v.trim()).filter(Boolean);
  if (!subject || !participants.length) return toast('Subject and at least one participant required.', true);
  try {
    await api('POST', `/sessions/${state.currentSessionId}/groups`, { subject, participants });
    document.getElementById('createGroupForm').reset();
    await loadGroups();
  } catch (err) {
    toast(`Failed to create group: ${err.message}`, true);
  }
});

function renderGroupDetail() {
  const g = state.groups.find((x) => x.jid === state.currentGroupJid);
  const body = document.getElementById('groupDetailBody');
  if (!g) { body.innerHTML = '<p class="empty-hint">Select a group from the list above.</p>'; return; }

  body.innerHTML = `
    <p><strong>${escapeHtml(g.subject || '')}</strong> <span class="mono">${escapeHtml(g.jid)}</span></p>
    <div class="participant-list">
      ${(g.participants || []).map((p) => `
        <div class="participant-row">
          <span class="mono">${escapeHtml(p.jid)}</span>
          <span>${escapeHtml(p.admin || 'member')}</span>
        </div>`).join('')}
    </div>
    <form id="participantsForm" class="inline-form" style="margin-top:10px;">
      <input id="participantsInput" type="text" placeholder="numbers, comma separated" />
      <select id="participantsAction">
        <option value="add">add</option>
        <option value="remove">remove</option>
        <option value="promote">promote</option>
        <option value="demote">demote</option>
      </select>
      <button type="submit" class="btn btn-sm btn-ghost">Apply</button>
    </form>
    <form id="subjectForm" class="inline-form">
      <input id="subjectInput" type="text" placeholder="new subject" />
      <button type="submit" class="btn btn-sm btn-ghost">Rename</button>
    </form>
    <div class="inline-form">
      <button class="btn btn-sm btn-ghost" data-g-action="invite">Get invite code</button>
      <button class="btn btn-sm btn-ghost" data-g-action="revoke">Revoke invite</button>
      <button class="btn btn-sm btn-danger" data-g-action="leave">Leave group</button>
    </div>
    <pre id="groupResult" class="log-json"></pre>
  `;

  document.getElementById('participantsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const participants = document.getElementById('participantsInput').value.split(',').map((v) => v.trim()).filter(Boolean);
    const action = document.getElementById('participantsAction').value;
    if (!participants.length) return;
    try {
      await api('POST', `/sessions/${state.currentSessionId}/groups/${encodeURIComponent(g.jid)}/participants`, { participants, action });
      await loadGroups();
      renderGroupDetail();
    } catch (err) { toast(`Failed: ${err.message}`, true); }
  });

  document.getElementById('subjectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = document.getElementById('subjectInput').value.trim();
    if (!subject) return;
    try {
      await api('PATCH', `/sessions/${state.currentSessionId}/groups/${encodeURIComponent(g.jid)}/subject`, { subject });
      await loadGroups();
      renderGroupDetail();
    } catch (err) { toast(`Failed: ${err.message}`, true); }
  });

  body.querySelector('[data-g-action]')?.parentElement.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-g-action]');
    if (!btn) return;
    const gAction = btn.dataset.gAction;
    const resultEl = document.getElementById('groupResult');
    try {
      if (gAction === 'invite') {
        const data = await api('GET', `/sessions/${state.currentSessionId}/groups/${encodeURIComponent(g.jid)}/invite-code`);
        resultEl.textContent = JSON.stringify(data, null, 2);
      }
      if (gAction === 'revoke') {
        const data = await api('POST', `/sessions/${state.currentSessionId}/groups/${encodeURIComponent(g.jid)}/invite-code/revoke`);
        resultEl.textContent = JSON.stringify(data, null, 2);
      }
      if (gAction === 'leave') {
        if (!confirm('Leave this group?')) return;
        await api('POST', `/sessions/${state.currentSessionId}/groups/${encodeURIComponent(g.jid)}/leave`);
        state.currentGroupJid = null;
        await loadGroups();
        renderGroupDetail();
      }
    } catch (err) { toast(`Failed: ${err.message}`, true); }
  });
}

// ----------------------------------------------------------------------------
// Privacy
// ----------------------------------------------------------------------------
const PRIVACY_FIELDS = [
  { key: 'lastSeen', label: 'Last seen', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'online', label: 'Online', options: ['all', 'match_last_seen'] },
  { key: 'profilePicture', label: 'Profile picture', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'status', label: 'Status', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'readReceipts', label: 'Read receipts', options: ['all', 'none'] },
  { key: 'groupsAdd', label: 'Groups: who can add me', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
];

document.getElementById('refreshPrivacy').addEventListener('click', async () => {
  if (!state.currentSessionId) return;
  try {
    await api('POST', `/sessions/${state.currentSessionId}/privacy/refresh`);
    loadPrivacy();
  } catch (err) { toast(`Failed: ${err.message}`, true); }
});

async function loadPrivacy() {
  if (!state.currentSessionId) return;
  let cached = {};
  try {
    cached = (await api('GET', `/sessions/${state.currentSessionId}/privacy`)) || {};
  } catch { /* ignore */ }
  renderPrivacy(cached);
  loadBlocklist();
}

function renderPrivacy(cached) {
  const grid = document.getElementById('privacyGrid');
  grid.innerHTML = PRIVACY_FIELDS.map((f) => `
    <div class="privacy-card" data-key="${f.key}">
      <label>${escapeHtml(f.label)}</label>
      <select>
        ${f.options.map((o) => `<option value="${o}" ${cached[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
    </div>
  `).join('');
  grid.querySelectorAll('.privacy-card select').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const key = e.target.closest('.privacy-card').dataset.key;
      try {
        await api('PATCH', `/sessions/${state.currentSessionId}/privacy/${key}`, { value: e.target.value });
        toast(`Updated ${key} → ${e.target.value}`);
      } catch (err) { toast(`Failed: ${err.message}`, true); }
    });
  });
}

document.getElementById('blockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const jid = document.getElementById('blockJid').value.trim();
  if (!jid) return;
  try {
    await api('POST', `/sessions/${state.currentSessionId}/privacy/blocklist/${encodeURIComponent(jid)}/block`);
    loadBlocklist();
  } catch (err) { toast(`Failed: ${err.message}`, true); }
});
document.getElementById('unblockBtn').addEventListener('click', async () => {
  const jid = document.getElementById('blockJid').value.trim();
  if (!jid) return;
  try {
    await api('POST', `/sessions/${state.currentSessionId}/privacy/blocklist/${encodeURIComponent(jid)}/unblock`);
    loadBlocklist();
  } catch (err) { toast(`Failed: ${err.message}`, true); }
});

async function loadBlocklist() {
  if (!state.currentSessionId) return;
  try {
    const list = await api('GET', `/sessions/${state.currentSessionId}/privacy/blocklist`);
    const arr = Array.isArray(list) ? list : (list?.list || []);
    document.getElementById('blocklist').innerHTML = arr.length
      ? arr.map((jid) => `<li class="chat-item"><span class="mono">${escapeHtml(jid)}</span></li>`).join('')
      : '<li class="empty-hint">No blocked contacts.</li>';
  } catch (err) {
    document.getElementById('blocklist').innerHTML = '<li class="empty-hint">Could not load blocklist.</li>';
  }
}

// ----------------------------------------------------------------------------
// USync
// ----------------------------------------------------------------------------
document.getElementById('usyncForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentSessionId) return toast('Select a session first.', true);
  const numbers = document.getElementById('usyncNumbers').value.split('\n').map((v) => v.trim()).filter(Boolean);
  if (!numbers.length) return;
  try {
    const results = await api('POST', `/sessions/${state.currentSessionId}/usync/check-numbers`, { numbers });
    const body = document.getElementById('usyncBody');
    body.innerHTML = results.map((r, i) => `
      <tr>
        <td class="mono">${escapeHtml(numbers[i] || '')}</td>
        <td>${r.exists ? 'yes' : 'no'}</td>
        <td class="mono">${escapeHtml(r.jid || '')}</td>
      </tr>
    `).join('');
  } catch (err) {
    toast(`USync check failed: ${err.message}`, true);
  }
});

// ----------------------------------------------------------------------------
// Media
// ----------------------------------------------------------------------------
document.getElementById('mediaLookupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentSessionId) return toast('Select a session first.', true);
  const mediaId = document.getElementById('mediaIdInput').value.trim();
  if (!mediaId) return;
  const preview = document.getElementById('mediaPreview');
  try {
    const info = await api('GET', `/sessions/${state.currentSessionId}/media/${mediaId}/info`);
    const src = mediaUrl(mediaId);
    let tag = `<a href="${src}" target="_blank">Open raw file</a>`;
    if (info.mime_type?.startsWith('image/')) tag = `<img src="${src}" alt="media preview" />`;
    else if (info.mime_type?.startsWith('video/')) tag = `<video src="${src}" controls></video>`;
    else if (info.mime_type?.startsWith('audio/')) tag = `<audio src="${src}" controls></audio>`;
    preview.classList.remove('empty-hint');
    preview.innerHTML = `${tag}<div class="log-json" style="margin-top:8px;">${escapeHtml(JSON.stringify(info, null, 2))}</div>`;
  } catch (err) {
    toast(`Could not load media: ${err.message}`, true);
  }
});

document.getElementById('mediaUploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentSessionId) return toast('Select a session first.', true);
  const file = document.getElementById('mediaFileInput').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/sessions/${state.currentSessionId}/media/upload`, {
      method: 'POST',
      headers: { 'x-api-key': state.apiKey },
      body: form,
    });
    const json = await res.json();
    document.getElementById('uploadResult').textContent = JSON.stringify(json.data || json, null, 2);
  } catch (err) {
    toast(`Upload failed: ${err.message}`, true);
  }
});

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
connectSocket();
checkHealth();
refreshSessions();
