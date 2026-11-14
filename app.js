/*
 * Ticket Board — サーバー不要のチケット管理
 *
 * データは File System Access API で選択したフォルダ(Box Drive 等の同期フォルダ)に保存する。
 *   config.json                      プロジェクト設定
 *   tickets/<id>.json                1チケット1ファイル(同時編集の競合を最小化)
 *   attachments/<id>/...             チケットの添付ファイル
 *   users/<email>.json               メンバー情報(各自が自分のファイルだけ書く)
 *   logs/<YYYY-MM>__<email>__<端末ID>.jsonl   操作ログ(ユーザー×端末ごとの追記専用)
 *
 * 共有フォルダ内のデータは他メンバーが書いたものなので、画面へは必ず
 * textContent 経由(h() ヘルパー)で出力し、innerHTML は使わない。
 */
'use strict';
(() => {

const DEFAULT_CONFIG = {
  projectName: 'マイプロジェクト',
  key: 'TK',
  statuses: ['未着手', '進行中', 'レビュー中', '完了'],
  types: ['タスク', 'バグ', '要望', '問い合わせ'],
  priorities: ['高', '中', '低'],
};
const POLL_MS = 20000;
const FIELD_LABELS = {
  title: 'タイトル', description: '説明', status: 'ステータス', type: '種別',
  priority: '優先度', assignee: '担当者', due: '期限', labels: 'ラベル', archived: 'アーカイブ',
};
const ACTION_LABELS = {
  'access': 'アクセス',
  'ticket.create': 'チケット作成',
  'ticket.update': 'チケット更新',
  'comment.add': 'コメント追加',
  'attachment.add': '添付追加',
  'attachment.remove': '添付削除',
  'link.add': 'リンク追加',
  'link.remove': 'リンク削除',
  'config.update': '設定変更',
  'profile.update': 'プロフィール変更',
};
const VIEWS = [['board', 'ボード'], ['list', 'リスト'], ['activity', '操作ログ'], ['members', 'メンバー'], ['settings', '設定']];
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|text\/plain)$/;

const state = {
  root: null,
  dirs: null,
  config: structuredClone(DEFAULT_CONFIG),
  me: null,
  tickets: new Map(),
  fileMeta: new Map(),
  users: new Map(),
  view: 'board',
  filters: { q: '', assignee: '', type: '', priority: '', mine: false, archived: false },
  sort: { col: 'updatedAt', dir: -1 },
  openId: null,
  activity: { month: '', email: '' },
};

const $ = (id) => document.getElementById(id);
const dlg = $('dlg');

/* ================= ユーティリティ ================= */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  return el;
}

function select(options, current, onchange, attrs) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (current && !opts.some(([v]) => v === current)) opts.push([current, current]);
  return h('select', { ...attrs, value: current ?? '', onchange }, opts.map(([v, l]) => h('option', { value: v }, l)));
}

const uid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const safeName = (s) => String(s).replace(/[^a-zA-Z0-9._@-]/g, '_');

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthStr() { return todayStr().slice(0, 7); }
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text ?? '').split(/(https?:\/\/[^\s<>"']+)/g)) {
    if (/^https?:\/\//.test(part)) frag.append(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part));
    else if (part) frag.append(part);
  }
  return frag;
}

function shortUA() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'その他OS';
  const m = ua.match(/Edg\/(\d+)/) ? ['Edge', RegExp.$1] : ua.match(/Chrome\/(\d+)/) ? ['Chrome', RegExp.$1] : ['ブラウザ', ''];
  return `${m[0]} ${m[1]} / ${os}`.replace('  ', ' ');
}

let toastTimer;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 2500);
}
function fail(e) {
  console.error(e);
  if (e && e.name === 'NotAllowedError') toast('フォルダへのアクセス権がありません。ページを再読み込みして再接続してください。', true);
  else toast(`エラー: ${e && e.message ? e.message : e}`, true);
}
/** イベントハンドラ用: 例外をトースト表示にする */
const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { fail(e); } };

function nameOf(email) {
  if (!email) return '未割り当て';
  const u = state.users.get(email);
  return u && u.name ? u.name : email;
}
function avatar(email) {
  const name = nameOf(email);
  let hash = 0;
  for (const c of String(email || '')) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return h('span', {
    class: 'avatar', title: email ? `${name} <${email}>` : '未割り当て',
    style: `background:${email ? `hsl(${hash % 360} 55% 42%)` : '#8590a2'}`,
  }, email ? [...name][0].toUpperCase() : '?');
}

/* ================= ストレージ(IndexedDB にフォルダハンドルを保持) ================= */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ticket-board', 2);
    r.onupgradeneeded = () => {
      for (const name of ['kv', 'demo']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/**
 * お試しモード用の保存先。File System Access API と同じ形のハンドルを IndexedDB 上に再現する。
 * (ブラウザ内蔵の OPFS は index.html をファイルとして直接開いた場合に使えないため)
 * キーは "/dir/file" 形式のパスで、フォルダは末尾 "/" のキーで表す。
 */
function demoFs() {
  const tx = async (mode, fn) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction('demo', mode);
      const r = fn(t.objectStore('demo'));
      t.oncomplete = () => res(r ? r.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const get = (path) => tx('readonly', (s) => s.get(path));
  const put = (path, rec) => tx('readwrite', (s) => s.put(rec, path));
  const notFound = () => new DOMException('指定されたファイルまたはフォルダがありません', 'NotFoundError');

  const fileHandle = (path, name) => ({
    kind: 'file', name,
    async getFile() {
      const rec = await get(path);
      if (!rec) throw notFound();
      return new File([rec.data], name, { type: rec.type || '', lastModified: rec.lastModified });
    },
    async createWritable(opts) {
      const old = opts && opts.keepExistingData ? await get(path) : null;
      let buf = new Blob(old ? [old.data] : []);
      let type = old ? old.type || '' : '';
      return {
        async write(d) {
          if (d && d.type === 'write') {
            const data = new Blob([d.data]);
            const pos = d.position ?? buf.size;
            buf = new Blob([buf.slice(0, pos), data, buf.slice(pos + data.size)]);
          } else {
            if (d instanceof Blob) type = d.type;
            buf = new Blob([buf, d]);
          }
        },
        async close() { await put(path, { data: await buf.arrayBuffer(), type, lastModified: Date.now() }); },
      };
    },
  });

  const dirHandle = (path, name) => ({
    kind: 'directory', name,
    async getDirectoryHandle(n, o) {
      const p = `${path}${n}/`;
      if (!(await get(p))) {
        if (!(o && o.create)) throw notFound();
        await put(p, { dir: true });
      }
      return dirHandle(p, n);
    },
    async getFileHandle(n, o) {
      const p = path + n;
      if (!(await get(p))) {
        if (!(o && o.create)) throw notFound();
        await put(p, { data: new ArrayBuffer(0), type: '', lastModified: Date.now() });
      }
      return fileHandle(p, n);
    },
    async removeEntry(n) {
      await tx('readwrite', (s) => { s.delete(path + n); return s.delete(IDBKeyRange.bound(`${path}${n}/`, `${path}${n}/\uffff`)); });
    },
    async* entries() {
      const keys = await tx('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(path, path + '\uffff')));
      for (const k of keys) {
        const rest = k.slice(path.length);
        if (!rest) continue;
        if (rest.indexOf('/') === rest.length - 1) yield [rest.slice(0, -1), dirHandle(k, rest.slice(0, -1))];
        else if (!rest.includes('/')) yield [rest, fileHandle(k, rest)];
      }
    },
  });
  return dirHandle('/', 'ticket-board-demo');
}

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 保存できなくても動作は継続 */ } }

/* ================= ファイル操作 ================= */

async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return JSON.parse(await (await fh.getFile()).text());
  } catch (e) {
    if (e.name === 'NotFoundError' || e instanceof SyntaxError) return null;
    throw e;
  }
}
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
const writeJson = (dir, name, obj) => writeFile(dir, name, JSON.stringify(obj, null, 2));

async function appendLine(dir, name, line) {
  const fh = await dir.getFileHandle(name, { create: true });
  const size = (await fh.getFile()).size;
  const w = await fh.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: size, data: line + '\n' });
  await w.close();
}

/** チケットの読み書きを直列化する(自分自身の操作同士の競合防止) */
let chain = Promise.resolve();
function withLock(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function verifyPermission(handle, request) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (request && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/* ================= 操作ログ ================= */

let logChain = Promise.resolve();
function log(action, ticket, detail) {
  const me = state.me;
  const entry = {
    at: nowIso(), email: me.email, name: me.name,
    device: me.device || '', deviceId: me.deviceId, ua: shortUA(),
    action, ticket: ticket || '', detail: detail || '',
  };
  const file = `${monthStr()}__${safeName(me.email)}__${me.deviceId}.jsonl`;
  logChain = logChain
    .then(() => appendLine(state.dirs.logs, file, JSON.stringify(entry)))
    .catch((e) => console.error('ログ書き込み失敗', e));
  return logChain;
}

async function loadLogs(month, email) {
  const rows = [];
  for await (const [name, handle] of state.dirs.logs.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.jsonl') || !name.startsWith(month + '__')) continue;
    const text = await (await handle.getFile()).text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!email || r.email === email) rows.push(r);
      } catch { /* 同期途中の欠けた行は無視 */ }
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows;
}
async function logMonths() {
  const set = new Set([monthStr()]);
  for await (const [name] of state.dirs.logs.entries()) {
    const m = name.match(/^(\d{4}-\d{2})__.*\.jsonl$/);
    if (m) set.add(m[1]);
  }
  return [...set].sort().reverse();
}

/* ================= データ読み込み ================= */

async function syncTicketsRaw() {
  const seen = new Set();
  let changed = false;
  for await (const [name, handle] of state.dirs.tickets.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    seen.add(id);
    const file = await handle.getFile();
    if (state.fileMeta.get(id) === file.lastModified) continue;
    try {
      const t = JSON.parse(await file.text());
      if (!t || typeof t !== 'object') continue;
      state.tickets.set(id, normalizeTicket(t, id));
      state.fileMeta.set(id, file.lastModified);
      changed = true;
    } catch { /* 同期途中で壊れて見えるファイルは次回の読み込みに回す */ }
  }
  for (const id of [...state.tickets.keys()]) {
    if (!seen.has(id)) { state.tickets.delete(id); state.fileMeta.delete(id); changed = true; }
  }
  return changed;
}

function normalizeTicket(t, id) {
  t.id = id; // ファイル名を正とする(Box の競合コピーも別チケットとして見える)
  t.key = String(t.key || id);
  t.title = String(t.title || '(無題)');
  t.description = String(t.description || '');
  t.labels = Array.isArray(t.labels) ? t.labels.map(String) : [];
  t.links = Array.isArray(t.links) ? t.links : [];
  t.comments = Array.isArray(t.comments) ? t.comments : [];
  t.history = Array.isArray(t.history) ? t.history : [];
  return t;
}

async function loadUsers() {
  const map = new Map();
  for await (const [name, handle] of state.dirs.users.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const u = JSON.parse(await (await handle.getFile()).text());
      if (u && u.email) map.set(String(u.email), u);
    } catch { /* 無視 */ }
  }
  state.users = map;
}

async function loadConfig() {
  const c = await readJson(state.root, 'config.json');
  if (!c) return false;
  const list = (v, d) => (Array.isArray(v) && v.length ? v.map(String) : d);
  state.config = {
    projectName: String(c.projectName || DEFAULT_CONFIG.projectName),
    key: String(c.key || DEFAULT_CONFIG.key),
    statuses: list(c.statuses, DEFAULT_CONFIG.statuses),
    types: list(c.types, DEFAULT_CONFIG.types),
    priorities: list(c.priorities, DEFAULT_CONFIG.priorities),
  };
  return true;
}

async function registerUser() {
  const me = state.me;
  const file = safeName(me.email) + '.json';
  const now = nowIso();
  const u = (await readJson(state.dirs.users, file)) || { email: me.email, firstSeen: now };
  u.name = me.name;
  u.lastSeen = now;
  u.devices = u.devices && typeof u.devices === 'object' ? u.devices : {};
  u.devices[me.deviceId] = { label: me.device || '', ua: shortUA(), lastSeen: now };
  await writeJson(state.dirs.users, file, u);
}

async function refresh(force) {
  const changed = await withLock(syncTicketsRaw);
  const before = JSON.stringify([state.config, [...state.users]]);
  await loadConfig();
  await loadUsers();
  const metaChanged = before !== JSON.stringify([state.config, [...state.users]]);
  $('syncTime').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (metaChanged) renderChrome();
  if (changed || metaChanged || force) {
    renderMain();
    if (state.openId) {
      const a = document.activeElement;
      const editing = a && dlg.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if (!editing) renderTicketDialog();
    }
  }
}

/* ================= チケット操作 ================= */

async function createTicket({ title, type, priority, assignee }) {
  const me = state.me;
  const t = await withLock(async () => {
    await syncTicketsRaw();
    let max = 0;
    for (const x of state.tickets.values()) max = Math.max(max, Number(x.num) || 0);
    const num = max + 1;
    const key = `${state.config.key}-${num}`;
    // 同時作成で番号が重複してもファイルが上書きされないよう、ランダムな接尾辞を付ける
    const id = `${safeName(key)}-${uid(4)}`;
    const now = nowIso();
    const ticket = {
      id, key, num, title, description: '',
      type, status: state.config.statuses[0], priority, assignee,
      reporter: me.email, due: '', labels: [], links: [], comments: [], history: [],
      archived: false, createdAt: now, updatedAt: now, updatedBy: me.email,
    };
    await writeJson(state.dirs.tickets, id + '.json', ticket);
    state.tickets.set(id, ticket);
    return ticket;
  });
  log('ticket.create', t.key, t.title);
  return t;
}

/** 保存直前に最新のファイルを読み直してから変更を適用する(他メンバーの変更を潰さない) */
function updateTicket(id, mutator) {
  return withLock(async () => {
    const fresh = (await readJson(state.dirs.tickets, id + '.json')) || state.tickets.get(id);
    if (!fresh) throw new Error('チケットが見つかりません');
    normalizeTicket(fresh, id);
    mutator(fresh);
    fresh.updatedAt = nowIso();
    fresh.updatedBy = state.me.email;
    await writeJson(state.dirs.tickets, id + '.json', fresh);
    state.tickets.set(id, fresh);
    return fresh;
  });
}

function showValue(field, v) {
  if (field === 'assignee') return nameOf(v);
  if (field === 'archived') return v ? 'する' : 'しない';
  if (Array.isArray(v)) return v.join(', ') || '(なし)';
  return v === '' || v == null ? '(なし)' : String(v);
}

async function setField(id, field, value) {
  const cur = state.tickets.get(id);
  if (!cur) return;
  if (JSON.stringify(cur[field] ?? '') === JSON.stringify(value)) return;
  const entry = { at: nowIso(), by: state.me.email, field };
  const t = await updateTicket(id, (x) => {
    if (field !== 'description') { entry.from = showValue(field, x[field]); entry.to = showValue(field, value); }
    x[field] = value;
    x.history.push(entry);
  });
  const label = FIELD_LABELS[field] || field;
  log('ticket.update', t.key, field === 'description' ? `${label}を編集` : `${label}: ${entry.from} → ${entry.to}`);
  renderMain();
  refreshHistory();
}

/* ================= 添付ファイル ================= */

async function listAttachments(id) {
  let dir;
  try { dir = await state.dirs.attachments.getDirectoryHandle(id); }
  catch (e) { if (e.name === 'NotFoundError') return []; throw e; }
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || name.endsWith('.crswap')) continue;
    const f = await handle.getFile();
    out.push({ name, size: f.size, lastModified: f.lastModified, handle });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

async function addAttachments(ticket, files) {
  const dir = await state.dirs.attachments.getDirectoryHandle(ticket.id, { create: true });
  const existing = new Set();
  for await (const [name] of dir.entries()) existing.add(name);
  for (const file of files) {
    let name = file.name.replace(/[\\/:*?"<>|]/g, '_');
    if (existing.has(name)) {
      const dot = name.lastIndexOf('.');
      const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let i = 2;
      while (existing.has(`${base} (${i})${ext}`)) i++;
      name = `${base} (${i})${ext}`;
    }
    await writeFile(dir, name, file);
    existing.add(name);
    await updateTicket(ticket.id, (x) => x.history.push({ at: nowIso(), by: state.me.email, field: '添付', from: '', to: `追加: ${name}` }));
    log('attachment.add', ticket.key, `${name} (${fmtSize(file.size)})`);
  }
}

async function removeAttachment(ticket, name) {
  const dir = await state.dirs.attachments.getDirectoryHandle(ticket.id);
  await dir.removeEntry(name);
  await updateTicket(ticket.id, (x) => x.history.push({ at: nowIso(), by: state.me.email, field: '添付', from: '', to: `削除: ${name}` }));
  log('attachment.remove', ticket.key, name);
}

async function openAttachment(handle) {
  const file = await handle.getFile();
  const url = URL.createObjectURL(file);
  // HTML 等をアプリと同じオリジンで開くと危険なので、画像・PDF・テキスト以外はダウンロードにする
  const a = h('a', INLINE_TYPES.test(file.type) ? { href: url, target: '_blank', rel: 'noopener' } : { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ================= 画面: 共通部分 ================= */

function renderChrome() {
  $('projectName').textContent = state.config.projectName;
  document.title = `${state.config.projectName} - Ticket Board`;
  $('nav').replaceChildren(...VIEWS.map(([id, label]) =>
    h('button', { class: state.view === id ? 'active' : '', onclick: () => { state.view = id; renderChrome(); renderMain(); } }, label)));
  $('meChip').replaceChildren(avatar(state.me.email), state.me.name);
  renderFilters();
}

function renderFilters() {
  const bar = $('filters');
  bar.hidden = !(state.view === 'board' || state.view === 'list');
  if (bar.hidden) return;
  const f = state.filters;
  const on = (key, prop = 'value') => (e) => { f[key] = e.target[prop]; renderMain(); };
  const users = [...state.users.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  bar.replaceChildren(
    h('input', { type: 'search', placeholder: 'キー・タイトル・説明・ラベルで検索', value: f.q, oninput: on('q') }),
    select([['', '担当者: すべて'], ['__none', '未割り当て'], ...users.map((u) => [u.email, u.name || u.email])], f.assignee, on('assignee')),
    select([['', '種別: すべて'], ...state.config.types], f.type, on('type')),
    select([['', '優先度: すべて'], ...state.config.priorities], f.priority, on('priority')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.mine, onchange: on('mine', 'checked') }), '自分の担当のみ'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.archived, onchange: on('archived', 'checked') }), 'アーカイブを表示'),
    h('span', { class: 'count', id: 'count' }),
  );
}

function visibleTickets() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return [...state.tickets.values()].filter((t) => {
    if (!!t.archived !== f.archived) return false;
    if (f.mine && t.assignee !== state.me.email) return false;
    if (f.assignee === '__none' ? !!t.assignee : f.assignee && t.assignee !== f.assignee) return false;
    if (f.type && t.type !== f.type) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (q && ![t.key, t.title, t.description, t.labels.join(' ')].join('\n').toLowerCase().includes(q)) return false;
    return true;
  });
}

const prioIndex = (p) => { const i = state.config.priorities.indexOf(p); return i < 0 ? 99 : i; };
const isDone = (t) => t.status === state.config.statuses[state.config.statuses.length - 1];
const isOverdue = (t) => !!t.due && t.due < todayStr() && !isDone(t);
const prioChip = (p) => (p ? h('span', { class: `chip p${prioIndex(p)}` }, p) : null);

function renderMain() {
  const main = $('main');
  const top = main.scrollTop;
  const views = { board: viewBoard, list: viewList, activity: viewActivity, members: viewMembers, settings: viewSettings };
  main.replaceChildren(views[state.view]());
  main.scrollTop = top;
}

/* ================= 画面: ボード ================= */

function viewBoard() {
  const tickets = visibleTickets();
  const count = $('count');
  if (count) count.textContent = `${tickets.length} 件`;
  const statuses = [...state.config.statuses];
  for (const t of tickets) if (!statuses.includes(t.status)) statuses.push(t.status);

  return h('div', { class: 'board' }, statuses.map((status) => {
    const items = tickets.filter((t) => t.status === status)
      .sort((a, b) => prioIndex(a.priority) - prioIndex(b.priority) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const col = h('div', { class: 'column' },
      h('h3', null, h('span', null, status), h('span', null, items.length)),
      items.map(card));
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', guard(async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/ticket-id');
      if (id) await setField(id, 'status', status);
    }));
    return col;
  }));
}

function card(t) {
  const el = h('div', { class: 'card', draggable: true, onclick: () => openTicket(t.id) },
    h('div', { class: 'title' }, t.title),
    t.labels.length ? h('div', { class: 'labels' }, t.labels.map((l) => h('span', { class: 'chip' }, l))) : null,
    h('div', { class: 'meta' },
      h('span', { class: 'key' }, t.key),
      t.type ? h('span', { class: 'chip type' }, t.type) : null,
      prioChip(t.priority),
      h('span', { class: 'spacer' }),
      t.comments.length ? h('span', { title: 'コメント数' }, `💬${t.comments.length}`) : null,
      t.due ? h('span', { class: 'due' + (isOverdue(t) ? ' over' : ''), title: '期限' }, t.due.slice(5).replace('-', '/')) : null,
      avatar(t.assignee)));
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ticket-id', t.id); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

/* ================= 画面: リスト ================= */

function viewList() {
  const tickets = visibleTickets();
  const count = $('count');
  if (count) count.textContent = `${tickets.length} 件`;
  const { col, dir } = state.sort;
  const val = (t) => {
    if (col === 'key') return Number(t.num) || 0;
    if (col === 'priority') return prioIndex(t.priority);
    if (col === 'status') return state.config.statuses.indexOf(t.status);
    if (col === 'assignee') return nameOf(t.assignee);
    return String(t[col] ?? '');
  };
  tickets.sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'number' ? x - y : x.localeCompare(y, 'ja')) * dir;
  });
  const cols = [['key', 'キー'], ['title', 'タイトル'], ['type', '種別'], ['status', 'ステータス'], ['priority', '優先度'], ['assignee', '担当者'], ['due', '期限'], ['updatedAt', '更新日時']];
  const th = ([id, label]) => h('th', {
    class: 'sortable',
    onclick: () => { state.sort = { col: id, dir: col === id ? -dir : 1 }; renderMain(); },
  }, label + (col === id ? (dir > 0 ? ' ▲' : ' ▼') : ''));

  if (!tickets.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, '該当するチケットはありません'));
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(th))),
    h('tbody', null, tickets.map((t) => h('tr', { class: 'clickable', onclick: () => openTicket(t.id) },
      h('td', { class: 'nowrap' }, h('span', { class: 'key' }, t.key)),
      h('td', { class: 'wrap' }, t.title),
      h('td', { class: 'nowrap' }, t.type),
      h('td', { class: 'nowrap' }, t.status),
      h('td', { class: 'nowrap' }, prioChip(t.priority)),
      h('td', { class: 'nowrap' }, nameOf(t.assignee)),
      h('td', { class: 'nowrap' }, h('span', { class: 'due' + (isOverdue(t) ? ' over' : '') }, t.due || '')),
      h('td', { class: 'nowrap' }, fmtDateTime(t.updatedAt)))))));
}

/* ================= 画面: 操作ログ ================= */

function viewActivity() {
  const a = state.activity;
  if (!a.month) a.month = monthStr();
  const body = h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, '読み込み中…'));
  const monthSel = select([a.month], a.month, (e) => { a.month = e.target.value; renderMain(); });
  const users = [...state.users.values()];
  const userSel = select([['', 'ユーザー: すべて'], ...users.map((u) => [u.email, u.name || u.email])], a.email, (e) => { a.email = e.target.value; renderMain(); });

  guard(async () => {
    const months = await logMonths();
    monthSel.replaceChildren(...months.map((m) => h('option', { value: m }, m)));
    monthSel.value = a.month;
    const rows = await loadLogs(a.month, a.email);
    if (!rows.length) { body.replaceChildren(h('div', { class: 'empty' }, 'ログはありません')); return; }
    const shown = rows.slice(0, 1000);
    body.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['日時', 'ユーザー', '端末', '操作', '対象', '詳細'].map((x) => h('th', null, x)))),
      h('tbody', null, shown.map((r) => h('tr', null,
        h('td', { class: 'nowrap' }, fmtDateTime(r.at)),
        h('td', { class: 'nowrap', title: r.email }, r.name || r.email),
        h('td', { class: 'nowrap', title: `端末ID: ${r.deviceId || ''}` }, [r.device, r.ua].filter(Boolean).join(' / ')),
        h('td', { class: 'nowrap' }, ACTION_LABELS[r.action] || r.action),
        h('td', { class: 'nowrap' }, r.ticket),
        h('td', { class: 'wrap' }, r.detail))))));
    if (rows.length > shown.length) body.append(h('div', { class: 'empty' }, `${rows.length} 件中、新しい ${shown.length} 件を表示しています`));
  })();

  return h('div', null,
    h('div', { class: 'toolbar' }, monthSel, userSel,
      h('span', { class: 'note' }, '名前・端末名は自己申告です。厳密な監査には Box 側のアクセスログを併用してください。')),
    body);
}

/* ================= 画面: メンバー ================= */

function viewMembers() {
  const users = [...state.users.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  const open = (email) => [...state.tickets.values()].filter((t) => t.assignee === email && !t.archived && !isDone(t)).length;
  return h('div', { class: 'view-pad' }, h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['名前', 'メールアドレス', '端末(自己申告 / ブラウザ)', '担当中', '初回アクセス', '最終アクセス'].map((x) => h('th', null, x)))),
    h('tbody', null, users.map((u) => h('tr', null,
      h('td', { class: 'nowrap' }, h('span', { class: 'me-chip' }, avatar(u.email), u.name || '')),
      h('td', { class: 'nowrap' }, u.email),
      h('td', null, Object.values(u.devices || {}).map((d) => h('div', null, [d.label, d.ua].filter(Boolean).join(' / '), h('span', { class: 'when note' }, ` (${fmtDateTime(d.lastSeen)})`)))),
      h('td', { class: 'nowrap' }, open(u.email)),
      h('td', { class: 'nowrap' }, fmtDateTime(u.firstSeen)),
      h('td', { class: 'nowrap' }, fmtDateTime(u.lastSeen))))))));
}

/* ================= 画面: 設定 ================= */

function viewSettings() {
  const c = state.config;
  const name = h('input', { type: 'text', value: c.projectName, maxLength: 60 });
  const key = h('input', { type: 'text', value: c.key, maxLength: 10 });
  const statuses = h('textarea', { rows: 5, value: c.statuses.join('\n') });
  const types = h('textarea', { rows: 4, value: c.types.join('\n') });
  const lines = (el) => [...new Set(el.value.split('\n').map((s) => s.trim()).filter(Boolean))];

  const saveConfig = guard(async () => {
    const next = {
      projectName: name.value.trim() || DEFAULT_CONFIG.projectName,
      key: (key.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || DEFAULT_CONFIG.key),
      statuses: lines(statuses), types: lines(types), priorities: c.priorities,
    };
    if (next.statuses.length < 2) { toast('ステータスは2つ以上必要です', true); return; }
    if (!next.types.length) { toast('種別は1つ以上必要です', true); return; }
    await writeJson(state.root, 'config.json', next);
    state.config = next;
    log('config.update', '', 'プロジェクト設定を変更');
    renderChrome();
    renderMain();
    toast('設定を保存しました');
  });

  return h('div', { class: 'view-pad' },
    h('div', { class: 'panel' },
      h('h2', null, 'プロジェクト設定'),
      h('div', { class: 'note' }, '全メンバーに反映されます(共有フォルダの config.json)。'),
      h('label', null, 'プロジェクト名'), name,
      h('label', null, 'チケットキーの接頭辞(変更後に作成するチケットから適用)'), key,
      h('label', null, 'ステータス(1行に1つ。左から順にボードの列になり、最後の行が「完了」扱い)'), statuses,
      h('label', null, '種別(1行に1つ)'), types,
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: saveConfig }, '保存'))),
    h('div', { class: 'panel' },
      h('h2', null, 'プロフィール'),
      h('div', { class: 'note' }, 'このブラウザに保存され、操作ログに記録されます。'),
      profileForm('保存', guard(async () => {
        await registerUser();
        await loadUsers();
        log('profile.update', '', `${state.me.name} / ${state.me.device || '端末名なし'}`);
        renderChrome();
        renderMain();
        toast('プロフィールを保存しました');
      }))),
    h('div', { class: 'panel' },
      h('h2', null, 'データ保存先'),
      h('div', { class: 'path' }, lsGet('tb.mode') === 'demo' ? 'お試しモード(このブラウザ内のみ・他の人とは共有されません)' : `フォルダ: ${state.root.name}`),
      h('div', { class: 'toolbar' }, h('button', {
        class: 'btn',
        onclick: guard(async () => { await idbSet('root', null); lsSet('tb.mode', null); location.reload(); }),
      }, '保存先フォルダを切り替える'))));
}

function profileForm(submitLabel, onSaved) {
  const me = state.me || {};
  const name = h('input', { type: 'text', value: me.name || '', required: true, maxLength: 40, placeholder: '例: 山田 太郎' });
  const email = h('input', { type: 'email', value: me.email || '', required: true, maxLength: 100, placeholder: 'taro.yamada@example.com' });
  const device = h('input', { type: 'text', value: me.device || '', maxLength: 40, placeholder: '例: PC-12345(任意)' });
  return h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      let deviceId = lsGet('tb.deviceId');
      if (!deviceId) { deviceId = uid(8); lsSet('tb.deviceId', deviceId); }
      state.me = { name: name.value.trim(), email: email.value.trim().toLowerCase(), device: device.value.trim(), deviceId };
      lsSet('tb.me', state.me);
      onSaved();
    },
  },
    h('label', null, '名前'), name,
    h('label', null, 'メールアドレス(ユーザーの識別に使います)'), email,
    h('label', null, '端末名(ブラウザからは自動取得できないため手入力)'), device,
    h('div', { class: 'actions toolbar' }, h('button', { class: 'btn primary', type: 'submit' }, submitLabel)));
}

/* ================= ダイアログ: チケット作成 ================= */

function openCreateDialog() {
  const c = state.config;
  const title = h('input', { type: 'text', required: true, maxLength: 200, placeholder: '何をしますか?' });
  const type = select(c.types, c.types[0]);
  const prio = select(c.priorities, c.priorities[Math.min(1, c.priorities.length - 1)]);
  const users = [...state.users.values()];
  const assignee = select([['', '未割り当て'], ...users.map((u) => [u.email, u.name || u.email])], '');
  state.openId = null;
  dlg.className = 'dlg narrow';
  dlg.replaceChildren(h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      if (!title.value.trim()) return;
      const t = await createTicket({ title: title.value.trim(), type: type.value, priority: prio.value, assignee: assignee.value });
      renderMain();
      openTicket(t.id);
    }),
  },
    h('div', { class: 'dlg-head' }, h('strong', null, 'チケット作成'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      h('label', null, 'タイトル'), title,
      h('div', { class: 'row' },
        h('div', null, h('label', null, '種別'), type),
        h('div', null, h('label', null, '優先度'), prio)),
      h('label', null, '担当者'), assignee,
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'submit' }, '作成')))));
  if (!dlg.open) dlg.showModal();
  title.focus();
}

/* ================= ダイアログ: チケット詳細 ================= */

function openTicket(id) {
  state.openId = id;
  renderTicketDialog();
  if (!dlg.open) dlg.showModal();
}

let historyBox = null;
function refreshHistory() {
  const t = state.tickets.get(state.openId);
  if (!t || !historyBox || !historyBox.isConnected) return;
  historyBox.replaceChildren(...[...t.history].reverse().map((x) => h('li', null,
    h('strong', null, nameOf(x.by)), ' が ', FIELD_LABELS[x.field] || x.field,
    x.field === 'description' ? ' を編集' : x.from ? ` を変更: ${x.from} → ${x.to}` : `: ${x.to ?? ''}`,
    h('span', { class: 'when' }, fmtDateTime(x.at)))));
  if (!t.history.length) historyBox.append(h('li', null, '変更履歴はありません'));
}

function renderTicketDialog() {
  const t = state.tickets.get(state.openId);
  if (!t) { if (dlg.open) dlg.close(); return; }
  const c = state.config;
  const oldMain = dlg.querySelector('.ticket-main');
  const scroll = [dlg.scrollTop, oldMain ? oldMain.scrollTop : 0];
  const change = (field, conv = (v) => v) => guard((e) => setField(t.id, field, conv(e.target.value)));
  const rerender = () => { renderMain(); renderTicketDialog(); };

  /* --- 添付 --- */
  const fileList = h('ul', { class: 'file-list' }, h('li', { class: 'note' }, '読み込み中…'));
  const loadFiles = guard(async () => {
    const files = await listAttachments(t.id);
    fileList.replaceChildren(...files.map((f) => h('li', null,
      h('button', { class: 'name', title: f.name, onclick: guard(() => openAttachment(f.handle)) }, f.name),
      h('span', { class: 'note' }, `${fmtSize(f.size)} ・ ${fmtDateTime(f.lastModified)}`),
      h('button', {
        class: 'btn small danger',
        onclick: guard(async () => {
          if (!confirm(`「${f.name}」を削除しますか?`)) return;
          await removeAttachment(t, f.name);
          await loadFiles();
          refreshHistory();
        }),
      }, '削除'))));
    if (!files.length) fileList.append(h('li', { class: 'note' }, 'ファイルはありません。ここにドラッグ&ドロップでも追加できます。'));
  });
  const upload = guard(async (files) => {
    if (!files.length) return;
    toast(`${files.length} 件のファイルを保存中…`);
    await addAttachments(t, files);
    await loadFiles();
    refreshHistory();
    toast('添付しました');
  });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { upload([...e.target.files]); e.target.value = ''; } });
  const attachPath = `attachments/${t.id}/`;
  const zone = h('div', { class: 'dropzone' }, fileList,
    h('div', { class: 'path' }, `保存先: ${state.root.name}/${attachPath}`,
      ' ', h('button', { class: 'btn small', onclick: guard(async () => { await navigator.clipboard.writeText(attachPath); toast('パスをコピーしました'); }) }, 'コピー')),
    h('div', { class: 'note' }, 'このフォルダに Box Drive 上で直接置いたファイルも一覧に表示されます。'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drop'); upload([...e.dataTransfer.files]); });

  /* --- リンク --- */
  const linkTitle = h('input', { type: 'text', placeholder: '表示名(省略可)', maxLength: 100 });
  const linkUrl = h('input', { type: 'url', placeholder: 'https://app.box.com/s/...' });
  const addLink = guard(async () => {
    const url = linkUrl.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('http(s):// で始まるURLを入力してください', true); return; }
    const link = { id: uid(6), title: linkTitle.value.trim() || url, url, by: state.me.email, at: nowIso() };
    await updateTicket(t.id, (x) => { x.links.push(link); x.history.push({ at: link.at, by: link.by, field: 'リンク', from: '', to: `追加: ${link.title}` }); });
    log('link.add', t.key, url);
    rerender();
  });
  const links = t.links.filter((l) => l && /^https?:\/\//i.test(String(l.url)));

  /* --- コメント --- */
  const commentBox = h('textarea', { rows: 3, placeholder: 'コメントを入力(Ctrl+Enter で送信)' });
  const addComment = guard(async () => {
    const body = commentBox.value.trim();
    if (!body) return;
    await updateTicket(t.id, (x) => x.comments.push({ id: uid(6), by: state.me.email, at: nowIso(), body }));
    log('comment.add', t.key, body.slice(0, 80));
    rerender();
  });
  commentBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(); });

  historyBox = h('ul', { class: 'history' });
  const users = [...state.users.values()];

  dlg.className = 'dlg';
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' },
      h('span', { class: 'key' }, t.key),
      t.archived ? h('span', { class: 'chip' }, 'アーカイブ済み') : null,
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn small',
        onclick: guard(async () => {
          if (!t.archived && !confirm('このチケットをアーカイブしますか?(「アーカイブを表示」からいつでも戻せます)')) return;
          await setField(t.id, 'archived', !t.archived);
          dlg.close();
        }),
      }, t.archived ? 'アーカイブから戻す' : 'アーカイブ'),
      h('button', { class: 'btn ghost', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'ticket' },
      h('div', { class: 'ticket-main' },
        h('input', {
          type: 'text', class: 'title-input', value: t.title, maxLength: 200,
          onchange: guard(async (e) => {
            const v = e.target.value.trim();
            if (!v) { e.target.value = t.title; return; }
            await setField(t.id, 'title', v);
          }),
        }),
        h('div', { class: 'section-title' }, '説明'),
        h('textarea', { rows: 6, value: t.description, placeholder: '説明を入力(フォーカスを外すと保存されます)', onchange: change('description') }),

        h('div', { class: 'section-title' }, '添付ファイル', h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => picker.click() }, '＋ ファイルを追加'), picker),
        zone,

        h('div', { class: 'section-title' }, '関連リンク(Box 共有リンクなど)'),
        h('ul', { class: 'link-list' }, links.map((l) => h('li', null,
          h('a', { class: 'name', href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.title || l.url),
          h('button', {
            class: 'btn small danger',
            onclick: guard(async () => {
              await updateTicket(t.id, (x) => {
                x.links = x.links.filter((y) => y.id !== l.id);
                x.history.push({ at: nowIso(), by: state.me.email, field: 'リンク', from: '', to: `削除: ${l.title}` });
              });
              log('link.remove', t.key, l.url);
              rerender();
            }),
          }, '削除')))),
        h('div', { class: 'row' }, linkTitle, linkUrl, h('button', { class: 'btn', onclick: addLink }, '追加')),

        h('div', { class: 'section-title' }, `コメント (${t.comments.length})`),
        t.comments.map((cm) => h('div', { class: 'comment' }, avatar(cm.by),
          h('div', { class: 'body' },
            h('span', { class: 'who' }, nameOf(cm.by)), h('span', { class: 'when' }, fmtDateTime(cm.at)),
            h('div', { class: 'pre' }, linkify(cm.body))))),
        commentBox,
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: addComment }, 'コメントする')),

        h('details', null, h('summary', { class: 'section-title' }, '変更履歴'), historyBox)),

      h('div', { class: 'ticket-side' },
        h('label', null, 'ステータス'), select(c.statuses, t.status, change('status')),
        h('label', null, '担当者'), select([['', '未割り当て'], ...users.map((u) => [u.email, u.name || u.email])], t.assignee || '', change('assignee')),
        h('label', null, '種別'), select(c.types, t.type, change('type')),
        h('label', null, '優先度'), select(c.priorities, t.priority, change('priority')),
        h('label', null, '期限'), h('input', { type: 'date', value: t.due || '', onchange: change('due') }),
        h('label', null, 'ラベル(カンマ区切り)'),
        h('input', {
          type: 'text', value: t.labels.join(', '),
          onchange: change('labels', (v) => [...new Set(v.split(/[,、]/).map((s) => s.trim()).filter(Boolean))]),
        }),
        h('div', { class: 'side-meta' },
          h('div', null, `報告者: ${nameOf(t.reporter)}`),
          h('div', null, `作成: ${fmtDateTime(t.createdAt)}`),
          h('div', null, `更新: ${fmtDateTime(t.updatedAt)} (${nameOf(t.updatedBy)})`)))));

  refreshHistory();
  loadFiles();
  dlg.scrollTop = scroll[0];
  const newMain = dlg.querySelector('.ticket-main');
  if (newMain) newMain.scrollTop = scroll[1];
}

dlg.addEventListener('close', () => { state.openId = null; });
dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.close(); });

/* ================= 起動 ================= */

function gate(...content) {
  $('app').hidden = true;
  const g = $('gate');
  g.hidden = false;
  g.replaceChildren(h('div', { class: 'gate-card' }, content));
}

function gateProfile() {
  gate(
    h('h1', null, 'はじめに'),
    h('p', null, 'あなたの情報を登録してください。チケットの担当者表示と操作ログに使われます。'),
    profileForm('次へ', boot));
}

function gateConnect(savedHandle) {
  const hasPicker = 'showDirectoryPicker' in window;
  const pick = guard(async () => {
    let handle;
    try { handle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
    await idbSet('root', handle);
    lsSet('tb.mode', 'folder');
    await start(handle);
  });
  const reconnect = guard(async () => {
    if (await verifyPermission(savedHandle, true)) await start(savedHandle);
  });
  const demo = guard(async () => {
    lsSet('tb.mode', 'demo');
    await start(demoFs());
  });

  gate(
    h('h1', null, 'データ保存先フォルダに接続'),
    hasPicker
      ? h('p', null, 'チーム共有の同期フォルダ(Box Drive など)の中にある、このチケットボード用のフォルダを選んでください。全員が同じフォルダを選ぶことでデータが共有されます。')
      : h('p', null, 'このブラウザはフォルダへの直接読み書き(File System Access API)に対応していません。Chrome または Edge の最新版で開いてください。'),
    h('div', { class: 'actions' },
      savedHandle ? h('button', { class: 'btn primary', onclick: reconnect }, `「${savedHandle.name}」に再接続`) : null,
      hasPicker ? h('button', { class: savedHandle ? 'btn' : 'btn primary', onclick: pick }, savedHandle ? '別のフォルダを選ぶ' : 'フォルダを選ぶ') : null,
      h('button', { class: 'btn ghost', onclick: demo }, 'お試しモード(このブラウザ内だけに保存)')),
    h('p', { class: 'note' }, '初回は空のフォルダを選ぶと、必要なファイルが自動で作成されます。ブラウザを開き直したときは、確認のため再接続ボタンを押す必要があります。'));
}

async function start(root) {
  state.root = root;
  const sub = (name) => root.getDirectoryHandle(name, { create: true });
  state.dirs = { tickets: await sub('tickets'), attachments: await sub('attachments'), users: await sub('users'), logs: await sub('logs') };
  if (!(await loadConfig())) await writeJson(root, 'config.json', state.config);
  await registerUser();
  await loadUsers();
  await withLock(syncTicketsRaw);
  log('access', '', `保存先: ${root.name}`);

  $('gate').hidden = true;
  $('app').hidden = false;
  renderChrome();
  await refresh(true);

  const tick = () => { if (!document.hidden) refresh().catch((e) => console.error(e)); };
  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', tick);
}

async function boot() {
  try {
    state.me = lsGet('tb.me');
    if (!state.me || !state.me.email || !state.me.name || !state.me.deviceId) { gateProfile(); return; }

    if (lsGet('tb.mode') === 'demo') { await start(demoFs()); return; }
    const saved = 'showDirectoryPicker' in window ? await idbGet('root').catch(() => null) : null;
    if (saved && (await verifyPermission(saved, false))) { await start(saved); return; }
    gateConnect(saved || null);
  } catch (e) {
    fail(e);
    gateConnect(null);
  }
}

$('btnCreate').addEventListener('click', openCreateDialog);
$('btnSync').addEventListener('click', guard(() => refresh(true)));
boot();

})();
