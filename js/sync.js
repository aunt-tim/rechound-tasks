// ─── GOOGLE DRIVE STATE SYNC (Tasks-only) ────────────────────────────────
// Reads/writes the SAME rechound-state.json file in your Google Drive that
// the main RecHound tracker uses, but only ever touches the tasks-* keys —
// it merges onto whatever's already in the file, so it can't clobber CRM,
// revenue, or other data stored there by the main app.
// NOT synced: rh-gd-client-id, rh-gd-file-id, rh-gd-token, rh-gd-token-expiry (device-specific)

const STATE_FILENAME = 'rechound-state.json';
const SYNC_KEYS = ['tasks-nodes', 'tasks-priorityOrder'];
const DEFAULT_CLIENT_ID = '346840408369-rtvkg57bacg2a89n13sum29ca317bvla.apps.googleusercontent.com';
const GD_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let syncDebounceTimer = null;
let isSyncing = false;
let pendingPush = false;
let tokenClient = null;

function gdClientId()    { return localStorage.getItem('rh-gd-client-id') || DEFAULT_CLIENT_ID; }
function gdToken()       { return localStorage.getItem('rh-gd-token'); }
function gdTokenExpiry() { return parseInt(localStorage.getItem('rh-gd-token-expiry') || '0'); }
function gdFileId()      { return localStorage.getItem('rh-gd-file-id'); }

function isTokenValid() {
  const token = gdToken();
  const expiry = gdTokenExpiry();
  return !!(token && Date.now() < expiry - 60000); // 1-min buffer
}

function setSyncStatus(msg, colour = 'rgba(255,220,100,0.8)') {
  const ind = document.getElementById('sync-indicator');
  const hdr = document.querySelector('header');
  if (!ind) return;

  const isOk  = colour.includes('100,220');
  const isErr = colour.includes('255,80');
  const isBusy = !isOk && !isErr && !!msg;

  if (hdr) {
    hdr.classList.remove('sync-busy', 'sync-ok', 'sync-err');
    if (isBusy) hdr.classList.add('sync-busy');
    else if (isOk)  hdr.classList.add('sync-ok');
    else if (isErr) hdr.classList.add('sync-err');
  }

  if (!msg) { ind.style.display = 'none'; if (hdr) hdr.classList.remove('sync-busy','sync-ok','sync-err'); return; }
  ind.style.display = 'flex';
  const dot = isOk ? '🟢' : isErr ? '🔴' : '🟡';
  ind.textContent = dot + ' ' + msg;
  ind.style.color = colour;
}

function bundleData() {
  const bundle = {};
  SYNC_KEYS.forEach(k => { if (_store[k] !== undefined) bundle[k] = _store[k]; });
  return bundle;
}
function restoreData(bundle) {
  SYNC_KEYS.forEach(k => { if (bundle[k] !== undefined) _store[k] = bundle[k]; });
}

// ── AUTH ──
let _refreshTimer = null;

function showReconnectBanner() {
  if (document.getElementById('rh-reconnect-banner')) return;
  const btn = document.createElement('button');
  btn.id = 'rh-reconnect-banner';
  btn.textContent = '🔑 Drive disconnected — click to reconnect';
  btn.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:10020',
    'background:rgba(220,60,60,0.95)', 'color:#fff',
    'font-family:"Oswald",sans-serif', 'font-size:0.85rem',
    'padding:10px 18px', 'border:none', 'border-radius:4px',
    'cursor:pointer', 'box-shadow:2px 2px 10px rgba(0,0,0,0.5)',
    'letter-spacing:0.5px'
  ].join(';');
  btn.onclick = () => { btn.remove(); connectDrive(); };
  document.body.appendChild(btn);
}
function hideReconnectBanner() { document.getElementById('rh-reconnect-banner')?.remove(); }

function scheduleTokenRefresh(expiresIn) {
  clearTimeout(_refreshTimer);
  const delay = Math.max(0, (expiresIn - 600) * 1000);
  _refreshTimer = setTimeout(trySilentRefresh, delay);
}
function trySilentRefresh() {
  if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });
}

function initTokenClient() {
  if (!window.google?.accounts?.oauth2) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: gdClientId(),
    scope: GD_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        if (isTokenValid()) return;
        setSyncStatus('Drive disconnected', 'rgba(255,80,80,0.9)');
        updateConnectUI(false);
        showReconnectBanner();
        return;
      }
      const expiry = Date.now() + (resp.expires_in * 1000);
      localStorage.setItem('rh-gd-token', resp.access_token);
      localStorage.setItem('rh-gd-token-expiry', String(expiry));
      hideReconnectBanner();
      updateConnectUI(true);
      scheduleTokenRefresh(resp.expires_in);
      setSyncStatus('Drive connected ✓', 'rgba(100,220,100,0.9)');
      setTimeout(() => setSyncStatus(''), 3000);
      statePull().then(pulled => { if (pulled) window.reloadTasksFromStore?.(); });
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!tokenClient) return;
  if (!gdToken()) return;
  const remaining = Math.floor((gdTokenExpiry() - Date.now()) / 1000);
  if (remaining <= 0) {
    updateConnectUI(false);
    showReconnectBanner();
    trySilentRefresh();
  } else if (remaining < 600) {
    trySilentRefresh();
  }
});

// ── DRIVE API HELPERS ──
async function driveRequest(url, opts = {}) {
  const token = gdToken();
  if (!token) throw new Error('No access token — reconnect Drive');
  const headers = { Authorization: 'Bearer ' + token, ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('rh-gd-token');
    updateConnectUI(false);
    setSyncStatus('Session expired — reconnect Drive', 'rgba(255,220,100,0.8)');
    throw new Error('Session expired');
  }
  return res;
}

async function findOrCreateFile() {
  const cachedId = gdFileId();
  if (cachedId) {
    try {
      const r = await driveRequest(`https://www.googleapis.com/drive/v3/files/${cachedId}?fields=id`);
      if (r.ok) return cachedId;
    } catch(e) { /* file may have been deleted */ }
    localStorage.removeItem('rh-gd-file-id');
  }

  // NOTE: with the drive.file scope this app can only see files it created
  // itself — if the main tracker created rechound-state.json first, this
  // search won't find it and a SEPARATE file of the same name gets created
  // instead. Use "Share this app's access" in Drive, or connect via the
  // main tracker first and share the file with this OAuth client, to
  // actually share one file. See README for the simplest path.
  const searchRes = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=name%3D'${STATE_FILENAME}'%20and%20trashed%3Dfalse&spaces=drive&fields=files(id,name)`
  );
  if (!searchRes.ok) throw new Error('Drive search failed: ' + searchRes.status);
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    const id = searchData.files[0].id;
    localStorage.setItem('rh-gd-file-id', id);
    return id;
  }

  const boundary = 'rh_mpboundary';
  const metadata = JSON.stringify({ name: STATE_FILENAME, mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--`;
  const createRes = await driveRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
  if (!createRes.ok) throw new Error('Failed to create Drive file: ' + createRes.status);
  const created = await createRes.json();
  localStorage.setItem('rh-gd-file-id', created.id);
  return created.id;
}

function buildMultipartBody(fileId, content) {
  const boundary = 'rh_mpboundary';
  const metadata = JSON.stringify({ name: STATE_FILENAME, mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return { boundary, body };
}

// ── TASK-LEVEL MERGE ──
// This page and the main tracker (e.g. running on localhost) can each push
// a full snapshot of tasks-nodes. A plain object-spread merge only works at
// the top-level key, so whichever device pushes LAST wins and silently
// overwrites the other device's concurrent edits. To avoid that, merge
// tasks-nodes at the individual task/subtask level, keeping whichever copy
// of each task has the newer updatedAt timestamp, and unioning tasks that
// only exist on one side (so additions from either device survive).
// Known limitation: deletions aren't tracked, so a task deleted on one
// device while the other device hasn't synced yet can reappear.
function mergeTaskArrays(remoteArr, localArr) {
  if (!Array.isArray(remoteArr)) return localArr || [];
  if (!Array.isArray(localArr)) return remoteArr || [];
  const byId = new Map();
  remoteArr.forEach(t => byId.set(t.id, t));
  localArr.forEach(t => {
    const existing = byId.get(t.id);
    if (!existing) { byId.set(t.id, t); return; }
    const localIsNewer = (t.updatedAt || 0) >= (existing.updatedAt || 0);
    const base  = localIsNewer ? t : existing;
    const other = localIsNewer ? existing : t;
    byId.set(t.id, { ...base, subtasks: mergeTaskArrays(other.subtasks, base.subtasks) });
  });
  return [...byId.values()];
}
function mergeTaskNodes(remoteNodes, localNodes) {
  if (!remoteNodes || typeof remoteNodes !== 'object') return localNodes;
  if (!localNodes  || typeof localNodes  !== 'object') return remoteNodes;
  const merged = {};
  new Set([...Object.keys(remoteNodes), ...Object.keys(localNodes)]).forEach(id => {
    const r = remoteNodes[id], l = localNodes[id];
    if (!r) { merged[id] = l; return; }
    if (!l) { merged[id] = r; return; }
    merged[id] = (l.tasks || r.tasks)
      ? { ...l, tasks: mergeTaskArrays(r.tasks, l.tasks) }
      : l; // branch node (business unit/activity) — structure rarely changes, prefer local
  });
  return merged;
}
function mergePriorityOrder(remoteOrder, localOrder) {
  if (!Array.isArray(remoteOrder)) return localOrder || [];
  if (!Array.isArray(localOrder))  return remoteOrder || [];
  const merged = [...localOrder];
  remoteOrder.forEach(id => { if (!merged.includes(id)) merged.push(id); });
  return merged;
}

// ── PUSH ──
async function statePush() {
  if (!isTokenValid()) {
    setSyncStatus('Reconnect Drive to save', 'rgba(255,220,100,0.8)');
    return;
  }
  if (isSyncing) { pendingPush = true; return; }
  isSyncing = true;
  pendingPush = false;
  setSyncStatus('Saving…');
  try {
    const fileId = await findOrCreateFile();

    const getRes = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    let cloudData = {};
    if (getRes.ok) { try { cloudData = await getRes.json(); } catch(e) {} }

    const bundle = bundleData();
    let tasksChangedByMerge = false;
    if (bundle['tasks-nodes'] !== undefined && cloudData['tasks-nodes'] !== undefined) {
      try {
        const mergedNodes = mergeTaskNodes(JSON.parse(cloudData['tasks-nodes']), JSON.parse(bundle['tasks-nodes']));
        bundle['tasks-nodes'] = JSON.stringify(mergedNodes);
        tasksChangedByMerge = true;
      } catch(e) { /* malformed JSON on either side — fall back to overwrite */ }
    }
    if (bundle['tasks-priorityOrder'] !== undefined && cloudData['tasks-priorityOrder'] !== undefined) {
      try {
        bundle['tasks-priorityOrder'] = JSON.stringify(mergePriorityOrder(JSON.parse(cloudData['tasks-priorityOrder']), JSON.parse(bundle['tasks-priorityOrder'])));
      } catch(e) {}
    }
    if (tasksChangedByMerge) {
      _store['tasks-nodes'] = bundle['tasks-nodes'];
      window.reloadTasksFromStore?.();
    }

    const merged = { ...cloudData, ...bundle };
    const content = JSON.stringify(merged, null, 2);
    const { boundary, body } = buildMultipartBody(fileId, content);

    const res = await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      { method: 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
    );
    if (!res.ok) throw new Error(await res.text());
    setSyncStatus('Saved ✓', 'rgba(100,220,100,0.9)');
    setTimeout(() => setSyncStatus(''), 3000);
  } catch(e) {
    setSyncStatus('Save failed: ' + e.message, 'rgba(255,80,80,0.9)');
  }
  isSyncing = false;
  if (pendingPush) { pendingPush = false; statePush(); }
}

// ── PULL ──
async function statePull() {
  if (!isTokenValid()) return false;
  setSyncStatus('Loading…');
  try {
    const fileId = await findOrCreateFile();
    const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    const data = await res.json();
    restoreData(data);
    setSyncStatus('Loaded ✓', 'rgba(100,220,100,0.9)');
    setTimeout(() => setSyncStatus(''), 3000);
    return true;
  } catch(e) {
    setSyncStatus('Load failed: ' + e.message, 'rgba(255,80,80,0.9)');
    return false;
  }
}

// ── CONNECT UI ──
function updateConnectUI(connected) {
  const btn = document.getElementById('gd-connect-btn');
  if (btn) {
    btn.textContent = connected ? '🟢 Drive' : '☁ Connect Drive';
    btn.style.color = connected ? 'rgba(100,220,100,0.9)' : '';
  }
}

function showDriveConnectModal() {
  const existing = document.getElementById('gd-connect-modal');
  if (existing) { existing.remove(); return; }

  const connected = isTokenValid();
  const overlay = document.createElement('div');
  overlay.id = 'gd-connect-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.65);display:flex;align-items:flex-start;justify-content:flex-end;padding:56px 20px 20px;';
  overlay.innerHTML = `
    <div style="background:var(--panel2);border:3px solid var(--ink);border-radius:4px;padding:20px;max-width:420px;width:100%;box-shadow:4px 4px 0 var(--ink);">
      <div style="font-family:'Bangers',cursive;font-size:1.2rem;letter-spacing:2px;margin-bottom:10px;">☁ GOOGLE DRIVE SYNC</div>
      ${connected
        ? `<div style="font-family:'Oswald',sans-serif;font-size:0.85rem;color:rgba(100,220,100,0.9);margin-bottom:12px;">✓ Connected — tasks sync automatically to your Drive</div>`
        : `<div style="font-family:'Oswald',sans-serif;font-size:0.82rem;color:var(--text-mid);margin-bottom:12px;">Syncs your tasks to <strong>rechound-state.json</strong> in your own Google Drive — the same file the main RecHound tracker uses, so they share the same task list.</div>`
      }
      <div style="font-family:'Oswald',sans-serif;font-size:0.78rem;color:var(--text-mid);margin-bottom:4px;">OAuth Client ID</div>
      <input id="gd-client-id-input" class="tool-input" type="text" value="${gdClientId()}" style="margin-bottom:12px;font-size:0.78rem;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="tool-btn" style="font-size:0.85rem;padding:8px 14px;" onclick="connectDrive()">⚡ AUTHORIZE</button>
        ${connected ? `<button class="tool-btn tool-btn-secondary" style="font-size:0.85rem;padding:8px 14px;" onclick="disconnectDrive()">Disconnect</button>` : ''}
        <button class="tool-btn tool-btn-secondary" style="font-size:0.85rem;padding:8px 14px;" onclick="document.getElementById('gd-connect-modal').remove()">CLOSE</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function connectDrive() {
  const input = document.getElementById('gd-client-id-input');
  if (input && input.value.trim()) localStorage.setItem('rh-gd-client-id', input.value.trim());
  document.getElementById('gd-connect-modal')?.remove();
  initTokenClient();
  if (tokenClient) {
    tokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    setSyncStatus('GIS library not loaded yet — try again in a moment', 'rgba(255,80,80,0.9)');
  }
}

function disconnectDrive() {
  localStorage.removeItem('rh-gd-token');
  localStorage.removeItem('rh-gd-token-expiry');
  localStorage.removeItem('rh-gd-file-id');
  document.getElementById('gd-connect-modal')?.remove();
  updateConnectUI(false);
  setSyncStatus('');
}

// ── DEBOUNCED AUTO-PUSH ──
function schedulePush() {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(statePush, 1500);
}
window.gdSchedulePush = () => schedulePush();

// ── INIT ──
async function initSync() {
  if (isTokenValid()) {
    updateConnectUI(true);
    const pulled = await statePull();
    if (pulled) window.reloadTasksFromStore?.();
  } else if (gdToken()) {
    updateConnectUI(false);
    setSyncStatus('Reconnecting…');
    if (tokenClient) trySilentRefresh();
  } else {
    updateConnectUI(false);
  }
}

function onGISReady() {
  initTokenClient();
  if (isTokenValid()) {
    const remaining = Math.floor((gdTokenExpiry() - Date.now()) / 1000);
    scheduleTokenRefresh(remaining);
  } else if (gdToken()) {
    trySilentRefresh();
  }
}
if (window.google?.accounts?.oauth2) {
  onGISReady();
} else {
  window.addEventListener('load', () => { if (window.google?.accounts?.oauth2) onGISReady(); });
}

document.addEventListener('DOMContentLoaded', initSync);
