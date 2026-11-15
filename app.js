/*
 * Ticket Board — サーバー不要のチケット管理
 *
 * データは File System Access API で選択したフォルダ(Box Drive 等の同期フォルダ)に保存する。
 *   config.json                      プロジェクト設定
 *   tickets/<id>.json                1チケット1ファイル(同時編集の競合を最小化)
 *   attachments/<id>/...             チケットの添付ファイル
 *   users/<利用者ID>.json             メンバー情報(各自が自分のファイルだけ書く)
 *   logs/<YYYY-MM>__<利用者ID>__<端末ID>.jsonl   操作ログ(ユーザー×端末ごとの追記専用)
 *
 * 利用者ID は初回に自動で作るランダムな文字列(u-xxxxxxxx)。以前の版でメールアドレスを
 * 登録した人は、そのメールアドレスを ID として使い続ける(担当者などの既存データと合わせるため)。
 *
 * 共有フォルダ内のデータは他メンバーが書いたものなので、画面へは必ず
 * textContent 経由(h() ヘルパー)で出力し、innerHTML は使わない。
 */
'use strict';
(() => {

const DEFAULT_CONFIG = {
  projectName: 'マイプロジェクト',
  key: 'TK',
  // 種別ごとのキー接頭辞 {種別名: 接頭辞}。無い種別は key を使う
  typeKeys: {},
  statuses: ['未着手', '進行中', 'レビュー中', '完了'],
  types: ['タスク', 'バグ', '要望', '問い合わせ'],
  priorities: ['高', '中', '低'],
  projects: [],
  // プロジェクトのステータス(最後が「完了」扱い)と、プロジェクトごとの情報 {名前: {status, description, due}}
  projectStatuses: ['計画中', '進行中', '保留', '完了'],
  projectInfo: {},
};
const POLL_MS = 20000;
const FIELD_LABELS = {
  title: 'タイトル', description: '説明', status: 'ステータス', type: '種別',
  priority: '優先度', assignee: '担当者', due: '期限', labels: 'ラベル', archived: 'アーカイブ',
  project: 'プロジェクト',
};
const ACTION_LABELS = {
  'access': 'アクセス',
  'ticket.create': 'チケット作成',
  'ticket.update': 'チケット更新',
  'comment.add': 'コメント追加',
  'comment.edit': 'コメント編集',
  'comment.remove': 'コメント削除',
  'attachment.add': '添付追加',
  'attachment.remove': '添付削除',
  'link.add': 'リンク追加',
  'link.remove': 'リンク削除',
  'config.update': '設定変更',
  'profile.update': 'プロフィール変更',
  'checklist.update': 'チェックリスト変更',
  'relation.add': '関連追加',
  'relation.remove': '関連削除',
  'ticket.renumber': 'キー振り直し',
  'data.export': 'バックアップ保存',
  'data.import': 'バックアップ読み込み',
  'template.update': 'テンプレート保存',
  'template.remove': 'テンプレート削除',
  'project.create': 'プロジェクト作成',
  'project.update': 'プロジェクト変更',
  'project.remove': 'プロジェクト削除',
};
const TEMPLATE_KINDS = { project: 'プロジェクトテンプレート', ticket: 'チケットテンプレート' };
/** 関連の種類(parent は別項目で持つ) */
const REL_TYPES = ['blocks', 'relates'];
const UI_KEY = 'tb.ui';
const SEEN_KEY = 'tb.seen';
const VIEWS = [['board', 'ボード'], ['list', 'リスト'], ['projects', 'プロジェクト'], ['activity', '操作ログ'], ['members', 'メンバー'], ['settings', '設定']];
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|text\/plain)$/;

const state = {
  root: null,
  dirs: null,
  config: structuredClone(DEFAULT_CONFIG),
  me: null,
  tickets: new Map(),
  fileMeta: new Map(),
  users: new Map(),
  /** テンプレート(templates/<id>.json)。id → テンプレート */
  templates: new Map(),
  view: 'board',
  // subs は「サブチケットを表示」。絞り込みではなく表示の切り替えなので FILTER_DEFAULTS には入れない
  filters: { q: '', project: '', assignee: '', type: '', priority: '', label: '', mine: false, unread: false, archived: false, subs: false },
  seen: {},
  seenKey: '',
  sort: { col: 'updatedAt', dir: -1 },
  openId: null,
  /** キーボード(J/K)で選んでいるチケットの id */
  cursor: null,
  /** 詳細ダイアログの表示状態(開いているチケットが変わったら戻す) */
  detail: { id: null, open: new Set(), descEditing: false, editComment: null },
  activity: { month: '', user: '' },
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
/** 今日から days 日後の日付(YYYY-MM-DD、ローカル時刻) */
function todayStr(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthStr() { return todayStr().slice(0, 7); }
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KEY_RE = /\b[A-Z0-9]+-\d+\b/g;

/** キーからチケットを探す。同じキーが複数あれば、アーカイブしていないもの → 作成が早いもの の順で選ぶ */
function findByKey(key) {
  let best = null;
  for (const t of state.tickets.values()) {
    if (t.key !== key) continue;
    if (!best || (!!best.archived - !!t.archived || String(best.createdAt).localeCompare(String(t.createdAt)) || best.id.localeCompare(t.id)) > 0) best = t;
  }
  return best;
}

/**
 * 利用者が入力したキーからチケットを探す。見つからない・形式が違う・同じキーが複数ある・
 * アーカイブ済みのときは理由を知らせて null を返す
 */
function resolveKey(key) {
  if (!/^[A-Z0-9]+-\d+$/.test(key)) { toast(`「${key}」はチケットのキーではありません。${state.config.key}-12 のように入力してください`, true); return null; }
  const all = [...state.tickets.values()].filter((t) => t.key === key);
  if (!all.length) { toast(`${key} というチケットは見つかりません`, true); return null; }
  const live = all.filter((t) => !t.archived);
  if (!live.length) { toast(`${key} はアーカイブ済みです。アーカイブから戻してから指定してください`, true); return null; }
  if (live.length > 1) { toast(`${key} というキーのチケットが ${live.length} 件あります。番号の重複が直るまで待ってから指定してください`, true); return null; }
  return live[0];
}

/** 編集できる場所に出すペンのアイコン(SVG。文字の ✎ はフォントによって細く小さく見えるため) */
function penIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function keyLink(t, label) {
  return h('button', { type: 'button', class: 'keylink', title: t.title, onclick: () => openTicket(t.id) }, label ?? t.key);
}

/** URL と、既存チケットのキー(TK-12 など)をリンクにする */
function linkify(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text ?? '').split(/(https?:\/\/[^\s<>"']+|\b[A-Z0-9]+-\d+\b)/g)) {
    if (!part) continue;
    if (/^https?:\/\//.test(part)) { frag.append(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part)); continue; }
    const t = /^[A-Z0-9]+-\d+$/.test(part) ? findByKey(part) : null;
    frag.append(t ? keyLink(t, part) : part);
  }
  return frag;
}

/** 本文中で触れている既存チケット(重複なし、自分自身は除く) */
function referencedTickets(text, selfId) {
  const out = new Map();
  for (const m of String(text ?? '').matchAll(KEY_RE)) {
    const t = findByKey(m[0]);
    if (t && t.id !== selfId) out.set(t.id, t);
  }
  return [...out.values()];
}

/** 本文中のキーのうち、この保存先のキー(接頭辞が同じもの)なのにチケットが無いもの */
function missingKeys(text) {
  // 英字で始まらない接頭辞(数字だけ)は、日付などと見分けられないので対象にしない
  const prefixes = [...allPrefixes()].filter((p) => /^[A-Z]/.test(p));
  const out = new Set();
  for (const m of String(text ?? '').matchAll(KEY_RE)) if (prefixes.includes(keyPrefix(m[0])) && !findByKey(m[0])) out.add(m[0]);
  return [...out];
}

function shortUA() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'その他OS';
  const m = ua.match(/Edg\/(\d+)/) ? ['Edge', RegExp.$1] : ua.match(/Chrome\/(\d+)/) ? ['Chrome', RegExp.$1] : ['ブラウザ', ''];
  return `${m[0]} ${m[1]} / ${os}`.replace('  ', ' ');
}

let toastTimer;
/**
 * トーストの置き場所を合わせる。モーダルのダイアログが開いている間は、ダイアログの外の要素は押せなくなる(inert)ので、
 * ダイアログの中に移す。閉じたら body に戻す
 */
function placeToast() {
  const el = $('toast');
  const parent = dlg.open ? dlg : document.body;
  if (el.parentNode !== parent) parent.append(el);
}
/** ダイアログの中身を差し替える。中に移したトーストは消さずに残す */
function setDialog(...nodes) {
  const el = $('toast');
  const keep = el.parentNode === dlg;
  dlg.replaceChildren(...nodes);
  if (keep) dlg.append(el);
}

/**
 * 画面下に短い知らせを出す。action({label, run}) を渡すと「元に戻す」などのボタンを付ける。
 * 対応ブラウザでは popover として最前面に出す(ダイアログの暗い背景に隠れないように)。
 */
function toast(msg, isError, action) {
  const el = $('toast');
  placeToast();
  const top = typeof el.showPopover === 'function';
  const hide = () => { if (top) { if (el.matches(':popover-open')) el.hidePopover(); } else el.hidden = true; };
  // replaceChildren は null を「null」という文字にするので、h() でまとめて null を落とす
  el.replaceChildren(...h('div', null, h('span', null, msg), action ? h('button', {
    type: 'button', class: 'toast-action',
    onclick: guard(async () => { hide(); await action.run(); }),
  }, action.label) : null).childNodes);
  el.className = 'toast' + (isError ? ' error' : '');
  if (top) {
    el.hidden = false;
    hide(); // 開き直して、後から開いたダイアログよりも前に出す
    el.showPopover();
  } else el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, isError ? 7000 : action ? 6000 : 2500);
}
function fail(e) {
  console.error(e);
  if (e && e.name === 'NotAllowedError') toast('フォルダへのアクセス権がありません。ページを再読み込みして再接続してください。', true);
  else toast(`エラー: ${e && e.message ? e.message : e}`, true);
}
/** イベントハンドラ用: 例外をトースト表示にする */
const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { fail(e); } };

function nameOf(id) {
  if (!id) return '未割り当て';
  const u = state.users.get(id);
  return u && u.name ? u.name : id;
}
function avatar(id) {
  const name = nameOf(id);
  let hash = 0;
  for (const c of String(id || '')) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return h('span', {
    class: 'avatar', title: id ? `${name} (ID: ${id})` : '未割り当て',
    style: `background:${id ? `hsl(${hash % 360} 55% 42%)` : '#8590a2'}`,
  }, id ? [...name][0].toUpperCase() : '?');
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
    at: nowIso(), user: me.id, name: me.name,
    device: me.device || '', deviceId: me.deviceId, ua: shortUA(),
    action, ticket: ticket || '', detail: detail || '',
  };
  const file = `${monthStr()}__${safeName(me.id)}__${me.deviceId}.jsonl`;
  logChain = logChain
    .then(() => appendLine(state.dirs.logs, file, JSON.stringify(entry)))
    .catch((e) => console.error('ログ書き込み失敗', e));
  return logChain;
}

async function loadLogs(month, userId) {
  const rows = [];
  for await (const [name, handle] of state.dirs.logs.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.jsonl') || !name.startsWith(month + '__')) continue;
    const text = await (await handle.getFile()).text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!userId || logUser(r) === userId) rows.push(r);
      } catch { /* 同期途中の欠けた行は無視 */ }
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows;
}
/** ログの利用者ID(以前の版のログは email に入っている) */
const logUser = (r) => String(r.user || r.email || '');

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
  // 他メンバー(やバックアップ)が書いた値なので、文字列として使う項目は文字列にそろえる(t.due.slice 等で落ちないように)
  for (const k of ['status', 'type', 'priority', 'project', 'assignee', 'reporter', 'due', 'createdAt', 'updatedAt', 'updatedBy']) {
    t[k] = t[k] == null ? '' : String(t[k]);
  }
  t.labels = Array.isArray(t.labels) ? t.labels.map(String) : [];
  t.links = Array.isArray(t.links) ? t.links : [];
  t.comments = Array.isArray(t.comments) ? t.comments : [];
  t.history = Array.isArray(t.history) ? t.history : [];
  t.checklist = Array.isArray(t.checklist) ? t.checklist.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id) : [];
  t.relations = Array.isArray(t.relations) ? t.relations.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id && REL_TYPES.includes(r.type)) : [];
  t.parent = typeof t.parent === 'string' ? t.parent : '';
  return t;
}

async function loadUsers() {
  const map = new Map();
  for await (const [name, handle] of state.dirs.users.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const u = JSON.parse(await (await handle.getFile()).text());
      if (!u || typeof u !== 'object') continue;
      u.id = String(u.id || u.email || '');
      if (u.id) map.set(u.id, u);
    } catch { /* 無視 */ }
  }
  state.users = map;
}

/* ================= テンプレート ================= */

/*
 * templates/<id>.json に1テンプレート1ファイルで持つ(config.json に入れると、設定画面の保存で消えるため)。
 *   kind: 'project' … プロジェクト作成時に、tickets をまとめて作る
 *   kind: 'ticket'  … チケット作成時に選ぶ。tickets は1件だけ
 * テンプレ内のチケットは普通のチケットの中身(タイトル・種別・優先度・説明・ラベル・チェックリスト)だけを持つ。
 */
const TEMPLATE_MAX_TICKETS = 100;
const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
function normalizeTemplateItem(x) {
  const o = x && typeof x === 'object' ? x : {};
  return {
    // 末尾の空白は残す(チケットテンプレートの「不具合: 」のように、続きを書く前提の書き出しがあるため)
    title: str(o.title, 200),
    type: str(o.type, 100),
    priority: str(o.priority, 100),
    description: str(o.description, 100000),
    // 共有フォルダのデータなので件数も絞る(巨大なファイルでチケットを大量に作らないように)
    labels: Array.isArray(o.labels) ? [...new Set(o.labels.slice(0, 50).map((l) => str(l, 100).trim()).filter(Boolean))] : [],
    checklist: Array.isArray(o.checklist) ? o.checklist.slice(0, 100).map((c) => str(c, 200).trim()).filter(Boolean) : [],
  };
}
function normalizeTemplate(t, id) {
  const kind = t.kind === 'ticket' ? 'ticket' : 'project';
  let tickets = Array.isArray(t.tickets) ? t.tickets.slice(0, TEMPLATE_MAX_TICKETS).map(normalizeTemplateItem) : [];
  if (kind === 'ticket') tickets = [tickets[0] || normalizeTemplateItem({})];
  return {
    id, kind, tickets,
    name: str(t.name, 100).trim() || '(名前なし)',
    updatedAt: str(t.updatedAt, 40), updatedBy: str(t.updatedBy, 200),
  };
}
/** テンプレートを名前順に返す */
function templatesOf(kind) {
  return [...state.templates.values()].filter((t) => t.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}
async function loadTemplates() {
  const map = new Map();
  for await (const [name, handle] of state.dirs.templates.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const t = JSON.parse(await (await handle.getFile()).text());
      if (!t || typeof t !== 'object') continue;
      const id = name.slice(0, -5);
      map.set(id, normalizeTemplate(t, id));
    } catch { /* 同期途中で壊れて見えるファイルは次回の読み込みに回す */ }
  }
  state.templates = map;
}
async function saveTemplate(tpl) {
  const id = tpl.id || `tp-${uid(8)}`;
  const data = normalizeTemplate({ ...tpl, updatedAt: nowIso(), updatedBy: state.me.id }, id);
  await writeJson(state.dirs.templates, id + '.json', data);
  state.templates.set(id, data);
  log('template.update', '', `${TEMPLATE_KINDS[data.kind]}「${data.name}」`);
  return data;
}
async function removeTemplate(tpl) {
  try { await state.dirs.templates.removeEntry(tpl.id + '.json'); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  state.templates.delete(tpl.id);
  log('template.remove', '', `${TEMPLATE_KINDS[tpl.kind]}「${tpl.name}」`);
}

/** キー接頭辞の入力を整える(英大文字と数字だけ・10文字まで) */
const cleanPrefix = (v) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

/** 共有データの typeKeys を {種別名: 接頭辞} に整える(fromEntries なので __proto__ も普通の値になる) */
function normalizeTypeKeys(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([k, p]) => [String(k), cleanPrefix(p)]).filter(([, p]) => p));
}

/** 種別に対応するキー接頭辞(種別ごとの設定が無ければ既定の接頭辞) */
const prefixFor = (type) => (Object.hasOwn(state.config.typeKeys, type) && state.config.typeKeys[type]) || state.config.key;

/** この保存先で使っている接頭辞すべて */
const allPrefixes = () => new Set([state.config.key, ...Object.values(state.config.typeKeys)]);

async function loadConfig() {
  const c = await readJson(state.root, 'config.json');
  if (!c) return false;
  const list = (v, d) => (Array.isArray(v) && v.length ? v.map(String) : d);
  state.config = {
    projectName: String(c.projectName || DEFAULT_CONFIG.projectName),
    key: String(c.key || DEFAULT_CONFIG.key),
    typeKeys: normalizeTypeKeys(c.typeKeys),
    statuses: list(c.statuses, DEFAULT_CONFIG.statuses),
    types: list(c.types, DEFAULT_CONFIG.types),
    priorities: list(c.priorities, DEFAULT_CONFIG.priorities),
    // プロジェクトは0件でもよい(既定値で埋めない)
    projects: Array.isArray(c.projects) ? [...new Set(c.projects.map((v) => String(v).trim()).filter(Boolean))] : [],
    projectStatuses: list(c.projectStatuses, DEFAULT_CONFIG.projectStatuses),
    projectInfo: normalizeProjectInfo(c.projectInfo),
  };
  return true;
}

/* ================= プロジェクト ================= */

/*
 * プロジェクトは config.json の projects(名前の配列。以前の版との互換のためそのまま)と、
 * projectInfo({名前: {status, description, due}})で持つ。チケットは名前で参照する。
 * ステータスは projectStatuses の最後が「完了」。完了したプロジェクトのチケットはボード・リストに出さない。
 */
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeProjectInfo(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (k === '__proto__' || !x || typeof x !== 'object') continue;
    out[k] = { status: str(x.status, 100), description: str(x.description, 10000), due: DUE_RE.test(String(x.due || '')) ? String(x.due) : '' };
  }
  return out;
}
/** プロジェクトの情報(登録が無ければ既定値) */
function projectInfo(name) {
  const c = state.config;
  const i = Object.hasOwn(c.projectInfo, name) ? c.projectInfo[name] : {};
  return { status: i.status || c.projectStatuses[0], description: i.description || '', due: i.due || '' };
}
/** プロジェクト名に使えない値(__none は絞り込みの「プロジェクトなし」、__proto__ は projectInfo のキーにできない) */
const isReservedProjectName = (n) => n === '__none' || n === '__proto__';
const isProjectDone = (name) => !!name && state.config.projects.includes(name) && projectInfo(name).status === state.config.projectStatuses.at(-1);
/** 選択肢に出すプロジェクト(完了したものは除く。すでに付いている値は select() が残す) */
const activeProjects = () => state.config.projects.filter((p) => !isProjectDone(p));

/** config.json を書く直前に読み直してから mutate を当てる(他の人の設定変更を潰さない) */
async function updateConfig(mutate) {
  await loadConfig();
  const next = structuredClone(state.config);
  mutate(next);
  await writeJson(state.root, 'config.json', next);
  state.config = next;
  return next;
}

/** プロジェクトのチケット(アーカイブ済みは除く)の集計 */
function projectStats(name) {
  let total = 0, done = 0, overdue = 0;
  for (const t of state.tickets.values()) {
    if (t.archived || t.project !== name) continue;
    total++;
    if (isDone(t)) done++;
    else if (isOverdue(t)) overdue++;
  }
  return { total, done, overdue };
}

async function registerUser() {
  const me = state.me;
  const file = safeName(me.id) + '.json';
  const now = nowIso();
  const u = (await readJson(state.dirs.users, file)) || { firstSeen: now };
  u.id = me.id;
  u.name = me.name;
  u.lastSeen = now;
  u.devices = u.devices && typeof u.devices === 'object' ? u.devices : {};
  u.devices[me.deviceId] = { label: me.device || '', ua: shortUA(), lastSeen: now };
  await writeJson(state.dirs.users, file, u);
}

async function refresh(force) {
  let changed = await withLock(syncTicketsRaw);
  // 振り直しに失敗しても(読み取り専用のフォルダなど)、他の人の更新の反映は止めない
  try { if (await fixDuplicateKeys()) changed = true; } catch (e) { console.warn('キーの振り直しに失敗', e); }
  const before = JSON.stringify([state.config, [...state.users], [...state.templates]]);
  await loadConfig();
  await loadUsers();
  await loadTemplates();
  const metaChanged = before !== JSON.stringify([state.config, [...state.users], [...state.templates]]);
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

async function createTicket(item) {
  return (await createTickets([item]))[0];
}

/**
 * チケットをまとめて作る(テンプレートからの作成用)。ディレクトリの読み直しは最初の1回だけで、番号は続き番号にする。
 * item: { title, type, priority, assignee, project, parent, description, labels, checklist(文字列の配列) }
 * 途中で失敗したら、作れた件数をエラーの文に含める(作れたものは消さない)。
 */
async function createTickets(items) {
  const me = state.me;
  const created = [];
  try {
    await withLock(async () => {
      await syncTicketsRaw();
      let num = maxNum();
      for (const it of items) {
        const parent = it.parent || '';
        if (parent && !state.tickets.has(parent)) throw new Error(notFoundMsg('親チケット'));
        num++;
        // 接頭辞は作成時の種別で決める(後で種別を変えてもキーは変えない)。番号は全体の通し番号
        const key = `${prefixFor(it.type)}-${num}`;
        // 同時作成で番号が重複してもファイルが上書きされないよう、ランダムな接尾辞を付ける
        const id = `${safeName(key)}-${uid(4)}`;
        const now = nowIso();
        const ticket = {
          id, key, num, title: it.title, description: it.description || '',
          type: it.type, status: state.config.statuses[0], priority: it.priority, assignee: it.assignee || '', project: it.project || '',
          reporter: me.id, due: '', labels: [...(it.labels || [])], links: [], comments: [], history: [],
          checklist: (it.checklist || []).map((text) => ({ id: uid(6), text, done: false, by: me.id, at: now })),
          relations: [], parent,
          archived: false, createdAt: now, updatedAt: now, updatedBy: me.id,
        };
        await writeJson(state.dirs.tickets, id + '.json', ticket);
        state.tickets.set(id, normalizeTicket(ticket, id));
        created.push(ticket);
      }
    });
  } catch (e) {
    if (created.length && items.length > 1) throw new Error(`${items.length} 件中 ${created.length} 件を作成したところで失敗しました: ${e && e.message ? e.message : e}`);
    throw e;
  } finally {
    for (const t of created) log('ticket.create', t.key, t.title);
  }
  return created;
}

const ticketLabel = (id) => { const t = state.tickets.get(id); return t ? t.key : 'チケット'; };
const notFoundMsg = (label) => `${label} が見つかりません。他の人が削除したか、まだ同期されていない可能性があります`;

/**
 * 保存直前にチケットのファイルを読み直す。
 * 無いとき・読めないとき(同期の途中など)は、画面に残っている古いデータで書き戻すと
 * 削除されたチケットを復活させたり他の人の変更を消したりするので、書かずにエラーにする。
 */
async function readTicketFresh(id) {
  const label = ticketLabel(id);
  let text;
  try {
    text = await (await (await state.dirs.tickets.getFileHandle(id + '.json')).getFile()).text();
  } catch (e) {
    if (e.name === 'NotFoundError') throw new Error(notFoundMsg(label));
    throw e;
  }
  let t;
  try { t = JSON.parse(text); } catch { t = null; }
  if (!t || typeof t !== 'object') throw new Error(`${label} のファイルを読み込めませんでした(同期の途中の可能性があります)。少し待ってからやり直してください`);
  return t;
}

/** 保存直前に最新のファイルを読み直してから変更を適用する(他メンバーの変更を潰さない) */
function updateTicket(id, mutator) {
  return withLock(async () => {
    const fresh = await readTicketFresh(id);
    normalizeTicket(fresh, id);
    mutator(fresh);
    fresh.updatedAt = nowIso();
    fresh.updatedBy = state.me.id;
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

/**
 * 1項目を変更する。undo を true にすると、変更後に「元に戻す」付きのトーストを出す
 * (ドラッグで別の列に落とした・選択を誤った、を1操作で戻せるように)
 */
async function setField(id, field, value, { undo = false } = {}) {
  const cur = state.tickets.get(id);
  if (!cur) throw new Error(notFoundMsg('チケット'));
  if (JSON.stringify(cur[field] ?? '') === JSON.stringify(value)) return;
  let prev;
  const entry = { at: nowIso(), by: state.me.id, field };
  const t = await updateTicket(id, (x) => {
    if (field !== 'description') { entry.from = showValue(field, x[field]); entry.to = showValue(field, value); }
    prev = structuredClone(x[field] ?? '');
    x[field] = value;
    x.history.push(entry);
  });
  const label = FIELD_LABELS[field] || field;
  log('ticket.update', t.key, field === 'description' ? `${label}を編集` : `${label}: ${entry.from} → ${entry.to}`);
  renderMain();
  refreshHistory();
  if (undo) {
    toast(`${t.key} の${label}を「${entry.to}」にしました`, false, {
      label: '元に戻す',
      run: async () => {
        const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
        const back = { at: nowIso(), by: state.me.id, field, from: entry.to, to: entry.from };
        let changedByOther = false;
        try {
          // 保存直前に読み直して、他の人がその後に変えていたら戻さない(mutator の例外で書き込みを止める)
          await updateTicket(id, (x) => {
            if (!same(x[field], value)) { changedByOther = true; throw new Error('changed'); }
            x[field] = prev;
            x.history.push(back);
          });
        } catch (e) {
          if (!changedByOther) throw e;
          toast(`${t.key} の${label}は、その後に他の人が変更したため戻しませんでした`, true);
          return;
        }
        log('ticket.update', t.key, `${label}: ${entry.to} → ${entry.from}(元に戻す)`);
        renderMain();
        refreshHistory();
        if (state.openId) renderTicketDialog();
        toast(`${t.key} の${label}を「${entry.from}」に戻しました`);
      },
    });
  }
}

/* ================= チケット番号の重複対策 ================= */

/*
 * 2人がほぼ同時に作成すると同じキーのチケットができる(ファイルは別なのでデータは失われない)。
 * 同じキーの組は、作成が早いもの(同時刻なら id 順)がキーを持ち続け、残りは「作成者の端末だけ」が振り直す。
 * 作成者だけが直すので、複数の端末が同じチケットを取り合って番号を振り直すことはない。
 * 作成日時とタイトルが同じものは同期ドライブの競合コピーとみなし、振り直さずに ⚠ を出すだけにする。
 */
const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);
const isConflictCopy = (a, b) => a.createdAt === b.createdAt && a.title === b.title;
const keyPrefix = (key) => String(key).replace(/-\d+$/, '');
/** 振り直しに使う接頭辞(元のキーの接頭辞。共有データ由来で形式外のときは既定の接頭辞) */
const renumberPrefix = (key) => { const p = keyPrefix(key); return /^[A-Z0-9]+$/.test(p) ? p : state.config.key; };
/** 番号として使える値だけを数える(Infinity や巨大値で TK-Infinity にならないように) */
const numOf = (x) => { const n = Number(x && x.num); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const maxNum = (extra = []) => {
  let m = 0;
  for (const x of state.tickets.values()) m = Math.max(m, numOf(x));
  for (const x of extra) m = Math.max(m, numOf(x));
  return m;
};

function duplicateGroups() {
  const byKey = new Map();
  for (const t of state.tickets.values()) {
    const g = byKey.get(t.key) || [];
    g.push(t);
    byKey.set(t.key, g);
  }
  return [...byKey.values()].filter((g) => g.length > 1).map((g) => g.sort(byCreated));
}

/** 自分が作った重複チケットのキーを振り直す。振り直したら true。withLock の外から呼ぶこと */
async function fixDuplicateKeys() {
  const targets = [];
  for (const g of duplicateGroups()) {
    for (const t of g.slice(1)) {
      if (t.reporter !== state.me.id) continue;
      if (g.some((o) => o !== t && isConflictCopy(o, t))) continue;
      targets.push(t);
    }
  }
  let fixed = false;
  for (const t of targets) {
    const oldKey = t.key;
    const renamed = await withLock(async () => {
      await syncTicketsRaw();
      const fresh = await readJson(state.dirs.tickets, t.id + '.json');
      if (!fresh) return null;
      normalizeTicket(fresh, t.id);
      if (fresh.key !== oldKey) return null; // 別の端末で振り直し済み
      // 読み直した時点でも重複していて、自分が先頭(キーを持ち続ける側)でないときだけ振り直す
      const group = [...state.tickets.values()].filter((x) => x.key === oldKey).sort(byCreated);
      if (group.length < 2 || group[0].id === t.id) return null;
      const num = maxNum() + 1;
      fresh.num = num;
      fresh.key = `${renumberPrefix(oldKey)}-${num}`;
      fresh.history.push({ at: nowIso(), by: state.me.id, field: 'キー', from: oldKey, to: `${fresh.key}(番号の重複を自動で振り直し)` });
      fresh.updatedAt = nowIso();
      fresh.updatedBy = state.me.id;
      await writeJson(state.dirs.tickets, t.id + '.json', fresh);
      state.tickets.set(t.id, fresh);
      return fresh;
    });
    if (!renamed) continue;
    fixed = true;
    log('ticket.renumber', renamed.key, `${oldKey} → ${renamed.key}`);
    toast(`${oldKey} が他のチケットと重複していたため、${renamed.key} に振り直しました`);
  }
  return fixed;
}

/* ================= 関連チケット ================= */

/*
 * 関連は片方のチケットのファイルにだけ書く(2ファイル同時書き込みは同期ドライブで食い違うため)。
 *   子チケット: parent = 親の id
 *   元チケット: relations = [{ type: 'blocks' | 'relates', id }]
 * 逆向き(子・ブロックされている・相手から張られた関連)は表示時に全チケットから求める。
 */
const REL_KINDS = [
  ['parent', '親チケット'], ['child', 'サブチケット'],
  ['blocks', 'ブロックしている'], ['blockedBy', 'ブロックされている'], ['relates', '関連'],
];
const relKindLabel = (k) => (REL_KINDS.find(([v]) => v === k) || [k, k])[1];

/** a が b の祖先(親・親の親…)かどうか。壊れたデータで循環していても止まる */
function isAncestor(aId, bId) {
  const seen = new Set();
  let cur = state.tickets.get(bId);
  while (cur && cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parent === aId) return true;
    cur = state.tickets.get(cur.parent);
  }
  return false;
}

/**
 * チケットの関連を一覧にする。owner は実際にデータを持っているチケット(削除時に書き換える側)。
 * other が null のときは相手のチケットが見つからない。
 */
function relationsOf(t) {
  const out = [];
  if (t.parent) out.push({ kind: 'parent', id: t.parent, owner: t.id, rel: null });
  for (const r of t.relations) out.push({ kind: r.type, id: r.id, owner: t.id, rel: r });
  for (const o of state.tickets.values()) {
    if (o.id === t.id) continue;
    if (o.parent === t.id) out.push({ kind: 'child', id: o.id, owner: o.id, rel: null });
    for (const r of o.relations) {
      if (r.id !== t.id) continue;
      out.push({ kind: r.type === 'blocks' ? 'blockedBy' : 'relates', id: o.id, owner: o.id, rel: r });
    }
  }
  const order = REL_KINDS.map(([k]) => k);
  for (const x of out) x.other = state.tickets.get(x.id) || null;
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)
    || String(a.other ? a.other.num : '').localeCompare(String(b.other ? b.other.num : ''), 'ja', { numeric: true }));
}

/**
 * サブチケット(親を持つチケット)をボード・リストに出さないか。
 * 親が見つからないもの(削除・未同期)は迷子にならないよう出す。
 * 親とアーカイブの状態が違うもの(親だけアーカイブ、サブだけアーカイブ)も、親が同じ一覧に出ないので出す。
 * 同時編集で親子が循環したもの(A の親が B、B の親が A)も、全部消えないよう出す。
 */
function isSubHidden(t) {
  const p = t.parent && t.parent !== t.id ? state.tickets.get(t.parent) : null;
  return !!p && !!p.archived === !!t.archived && !isAncestor(t.id, t.id);
}

/** サブチケットを一覧にする(アーカイブしていないもの → キーの番号順) */
function subTicketsOf(t) {
  return [...state.tickets.values()].filter((o) => o.parent === t.id && o.id !== t.id)
    .sort((a, b) => !!a.archived - !!b.archived || (Number(a.num) || 0) - (Number(b.num) || 0));
}

/** カード表示用の集計(サブの完了数・未読、未完了のチケットにブロックされているか)。renderMain ごとに作り直す */
let relIndexCache = null;
function relIndex() {
  if (relIndexCache) return relIndexCache;
  const children = new Map();
  const blocked = new Set();
  // 未読のサブチケットを持つ親(孫以下の未読は祖先すべて)。サブは一覧に出ないので、親に ● を出して知らせる
  const unreadKids = new Set();
  const markAncestors = (o) => {
    for (let p = state.tickets.get(o.parent); p && !unreadKids.has(p.id); p = p.parent ? state.tickets.get(p.parent) : null) unreadKids.add(p.id);
  };
  for (const o of state.tickets.values()) {
    if (o.parent && o.parent !== o.id && !o.archived) {
      const c = children.get(o.parent) || { done: 0, total: 0 };
      c.total++;
      if (isDone(o)) c.done++;
      children.set(o.parent, c);
      if (isUnread(o)) markAncestors(o);
    }
    if (!o.archived && !isDone(o)) {
      for (const r of o.relations) if (r.type === 'blocks') blocked.add(r.id);
    }
  }
  // キーが重複しているもの(作成が早い1件以外)。作成者の端末で振り直されるまで ⚠ を出す
  const duplicated = new Set();
  for (const g of duplicateGroups()) for (const t of g.slice(1)) duplicated.add(t.id);
  relIndexCache = { children, blocked, duplicated, unreadKids };
  return relIndexCache;
}

/** 関連を追加する。書き込むのは1ファイルだけ */
async function addRelation(t, kind, o) {
  // 入力の誤りは例外にせず、知らせて終える(例外は想定外の失敗だけに使う)
  const reject = (msg) => { toast(msg, true); return false; };
  if (o.id === t.id) return reject('自分自身は指定できません');
  if (relationsOf(t).some((x) => x.kind === kind && x.id === o.id)) return reject('すでに登録されています');
  if (kind === 'parent' && isAncestor(t.id, o.id)) return reject('親子の関係が循環するため登録できません');
  if (kind === 'child' && isAncestor(o.id, t.id)) return reject('親子の関係が循環するため登録できません');
  const at = nowIso();
  const by = state.me.id;
  const note = (x, label, other) => x.history.push({ at, by, field: '関連', from: '', to: `追加: ${label} ${other.key}` });
  if (kind === 'parent') {
    const cur = t.parent && state.tickets.get(t.parent);
    if (cur && !confirm(`${t.key} にはすでに親チケット ${cur.key} があります。親を ${o.key} に付け替えますか?`)) return false;
    await updateTicket(t.id, (x) => { x.parent = o.id; note(x, '親', o); });
  } else if (kind === 'child') {
    if (o.parent && o.parent !== t.id && !confirm(`${o.key} にはすでに親チケットがあります。親を ${t.key} に付け替えますか?`)) return false;
    await updateTicket(o.id, (x) => { x.parent = t.id; note(x, '親', t); });
  } else if (kind === 'blockedBy') {
    await updateTicket(o.id, (x) => { x.relations.push({ type: 'blocks', id: t.id }); note(x, 'ブロック', t); });
  } else {
    await updateTicket(t.id, (x) => { x.relations.push({ type: kind, id: o.id }); note(x, relKindLabel(kind), o); });
  }
  log('relation.add', t.key, `${relKindLabel(kind)}: ${o.key}`);
  return true;
}

/** 関連を削除する。データを持っている側(owner)のファイルだけを書き換える */
async function removeRelation(t, x) {
  const otherKey = x.other ? x.other.key : x.id;
  await updateTicket(x.owner, (y) => {
    // 読み直した時点で別の親に付け替えられていたら、そちらは消さない
    if (x.kind === 'parent') { if (y.parent === x.id) y.parent = ''; }
    else if (x.kind === 'child') { if (y.parent === t.id) y.parent = ''; }
    else y.relations = y.relations.filter((r) => !(r.type === x.rel.type && r.id === x.rel.id));
    y.history.push({ at: nowIso(), by: state.me.id, field: '関連', from: '', to: `削除: ${relKindLabel(x.kind)} ${otherKey}` });
  });
  log('relation.remove', t.key, `${relKindLabel(x.kind)}: ${otherKey}`);
}

/* ================= 新着(自分宛ての更新) ================= */

/*
 * 既読はこのブラウザの localStorage にだけ持つ({チケットid: 見たときの updatedAt})。
 * 共有フォルダに書くファイルを増やさないため。保存先(フォルダ / お試し)ごとに分ける。
 */
function loadSeen(rootName) {
  state.seenKey = `${SEEN_KEY}.${rootName}`;
  const saved = lsGet(state.seenKey);
  // 空の記録は「初回」と同じに扱う(同期前の空フォルダで起動した後に、全部が新着になるのを防ぐ)
  if (saved && typeof saved === 'object' && Object.keys(saved).length) {
    // 消えたチケットの分は捨てる
    state.seen = {};
    for (const id of state.tickets.keys()) if (typeof saved[id] === 'string') state.seen[id] = saved[id];
  } else {
    // 初めて使うときは、今あるものを既読にしておく(いきなり大量の新着を出さない)
    state.seen = {};
    for (const t of state.tickets.values()) state.seen[t.id] = String(t.updatedAt || '');
  }
  lsSet(state.seenKey, state.seen);
}

/** 自分に関係するチケットか(担当・報告者・コメントした・チェック項目を足した) */
function isMine(t) {
  const me = state.me.id;
  return t.assignee === me || t.reporter === me
    || t.comments.some((c) => c && c.by === me) || t.checklist.some((c) => c.by === me);
}

function isUnread(t) {
  return !t.archived && isMine(t) && t.updatedBy !== state.me.id
    && String(t.updatedAt || '') > String(state.seen[t.id] || '');
}

/** 既読にする。変わったら true */
function markSeen(t) {
  const at = String(t.updatedAt || '');
  if (state.seen[t.id] === at) return false;
  state.seen[t.id] = at;
  lsSet(state.seenKey, state.seen);
  return true;
}

/** ヘッダーの 🔔 とタブのタイトルを更新する */
function renderUnread() {
  // 完了したプロジェクトのチケットはボード・リストに出ないので数えない(押しても何も出ないのを防ぐ)
  const n = [...state.tickets.values()].filter((t) => isUnread(t) && !isProjectDone(t.project)).length;
  const btn = $('btnUnread');
  btn.hidden = n === 0;
  btn.textContent = `🔔 ${n}`;
  document.title = `${n ? `(${n}) ` : ''}${state.config.projectName} - Ticket Board`;
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
  await withLock(() => readTicketFresh(ticket.id));
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
    await updateTicket(ticket.id, (x) => x.history.push({ at: nowIso(), by: state.me.id, field: '添付', from: '', to: `追加: ${name}` }));
    log('attachment.add', ticket.key, `${name} (${fmtSize(file.size)})`);
  }
}

async function removeAttachment(ticket, name) {
  await withLock(() => readTicketFresh(ticket.id));
  const dir = await state.dirs.attachments.getDirectoryHandle(ticket.id);
  await dir.removeEntry(name);
  await updateTicket(ticket.id, (x) => x.history.push({ at: nowIso(), by: state.me.id, field: '添付', from: '', to: `削除: ${name}` }));
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

/* ================= バックアップ ================= */

const BACKUP_FORMAT = 'ticket-board-backup';
const SAFE_ID = /^[A-Za-z0-9._@-]+$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
/** 共有フォルダにファイル名として書いてよいか。anyChars が false なら id 用に英数字と ._@- だけ許す */
function isSafeFileName(name, anyChars) {
  return typeof name === 'string' && name.length > 0 && name.length <= 120
    && (anyChars || SAFE_ID.test(name)) && !/^\.+$/.test(name) && !/[. ]$/.test(name) && !WIN_RESERVED.test(name);
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
const base64ToBlob = (b64, type) => {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || '' });
};

/** 添付の件数と合計サイズ(保存前の表示用) */
async function attachmentStats() {
  let count = 0, size = 0;
  for (const t of state.tickets.values()) {
    for (const f of await listAttachments(t.id)) { count++; size += f.size; }
  }
  return { count, size };
}

/** チケット・設定・メンバー(・添付)を1つの JSON にまとめて保存させる。操作ログは含めない */
async function exportBackup(withAttachments) {
  const tickets = [...state.tickets.values()].sort(byCreated);
  const attachments = {};
  let files = 0;
  if (withAttachments) {
    for (const t of tickets) {
      const list = await listAttachments(t.id);
      if (!list.length) continue;
      attachments[t.id] = [];
      for (const f of list) {
        const file = await f.handle.getFile();
        attachments[t.id].push({ name: f.name, type: file.type, data: await blobToBase64(file) });
        files++;
      }
    }
  }
  const backup = {
    format: BACKUP_FORMAT, version: 1, exportedAt: nowIso(), exportedBy: state.me.id,
    config: state.config, tickets, users: [...state.users.values()], attachments,
  };
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `ticket-board-backup-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  log('data.export', '', `チケット ${tickets.length} 件、添付 ${files} 件`);
  toast(`バックアップを保存しました(チケット ${tickets.length} 件、添付 ${files} 件)`);
}

/**
 * バックアップのチケットと添付を、今の保存先に「追加」する。上書きはしない。
 * 同じ id のチケットは読み込まない。キーが重複するものは番号を振り直す。
 * 設定とメンバーは取り込まない(読み込み先の設定を壊さないため)。
 */
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.tickets)) {
    toast('Ticket Board のバックアップファイルではありません', true);
    return;
  }
  // Windows / macOS のドライブは大文字小文字を区別しないので、id の比較は小文字でそろえる(既存の上書きを防ぐ)
  const existingIds = () => new Set([...state.tickets.keys()].map((id) => id.toLowerCase()));
  await withLock(syncTicketsRaw);
  const have = existingIds();
  const toAdd = [];
  for (const t of data.tickets) {
    if (!t || typeof t !== 'object' || !isSafeFileName(t.id)) continue;
    const low = t.id.toLowerCase();
    if (have.has(low)) continue;
    have.add(low); // バックアップ内で大文字小文字だけ違う id も1件にする
    toAdd.push(t);
  }
  const skipped = data.tickets.length - toAdd.length;
  if (!toAdd.length) { toast(`読み込めるチケットがありません(${skipped} 件はすでにあるか、形式が正しくありません)`, true); return; }
  if (!confirm(`チケット ${toAdd.length} 件を今のデータに追加します。${skipped ? `(${skipped} 件はすでにあるか形式が正しくないため読み込みません)` : ''}\n今あるチケットは上書きしません。キーが重複するものは番号を振り直します。\n\nよろしいですか?`)) return;

  const added = await withLock(async () => {
    await syncTicketsRaw();
    // 振り直すのは読み込み先に既にあるキーとぶつかるものだけ。バックアップ内での重複(競合コピーなど)は
    // そのまま持ち込み、ふだんの重複対策(fixDuplicateKeys)に任せる
    const usedKeys = new Set([...state.tickets.values()].map((t) => t.key));
    const now = existingIds();
    let max = maxNum(toAdd);
    const out = [];
    let failed = 0;
    for (const src of toAdd) {
      if (now.has(src.id.toLowerCase())) continue; // 確認ダイアログの間に他の人が作った
      try {
        const t = normalizeTicket(structuredClone(src), src.id);
        if (usedKeys.has(t.key)) {
          const oldKey = t.key;
          t.num = ++max;
          t.key = `${renumberPrefix(oldKey)}-${t.num}`;
          t.history.push({ at: nowIso(), by: state.me.id, field: 'キー', from: oldKey, to: `${t.key}(バックアップの読み込み時に振り直し)` });
        }
        await writeJson(state.dirs.tickets, t.id + '.json', t);
        state.tickets.set(t.id, t);
        out.push(t);
      } catch (e) {
        console.warn('チケットの読み込みに失敗', src.id, e);
        failed++;
      }
    }
    return { out, failed };
  });

  // 添付は1件ずつ。壊れたデータがあっても残りは読み込む
  let files = 0, fileFailed = 0;
  const atts = data.attachments && typeof data.attachments === 'object' ? data.attachments : {};
  for (const t of added.out) {
    const list = Array.isArray(atts[t.id]) ? atts[t.id] : [];
    if (!list.length) continue;
    let dir;
    try { dir = await state.dirs.attachments.getDirectoryHandle(t.id, { create: true }); }
    catch (e) { console.warn('添付フォルダを作れません', t.id, e); fileFailed += list.length; continue; }
    for (const f of list) {
      try {
        const name = String(f && f.name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!isSafeFileName(name, true) || typeof f.data !== 'string') { fileFailed++; continue; }
        await writeFile(dir, name, base64ToBlob(f.data, f.type));
        files++;
      } catch (e) {
        console.warn('添付の読み込みに失敗', t.id, e);
        fileFailed++;
      }
    }
  }
  // 自分で読み込んだものなので既読にする(担当のものが全部新着に出ないように)
  for (const t of added.out) state.seen[t.id] = String(t.updatedAt || '');
  lsSet(state.seenKey, state.seen);
  backupUi.at = 0; // 添付の集計をやり直す

  log('data.import', '', `チケット ${added.out.length} 件、添付 ${files} 件` + (added.failed || fileFailed ? `(失敗: チケット ${added.failed} 件、添付 ${fileFailed} 件)` : ''));
  await refresh(true);
  if (added.failed || fileFailed) toast(`チケット ${added.out.length} 件と添付 ${files} 件を読み込みました。読み込めなかったもの: チケット ${added.failed} 件、添付 ${fileFailed} 件`, true);
  else toast(`チケット ${added.out.length} 件と添付 ${files} 件を読み込みました`);
}

/* ================= 画面: 共通部分 ================= */

function renderChrome() {
  $('projectName').textContent = state.config.projectName;
  document.title = `${state.config.projectName} - Ticket Board`;
  $('nav').replaceChildren(...VIEWS.map(([id, label]) =>
    h('button', { class: state.view === id ? 'active' : '', onclick: () => { state.view = id; renderChrome(); renderMain(); } }, label)));
  $('meChip').replaceChildren(avatar(state.me.id), state.me.name);
  renderFilters();
}

function renderFilters() {
  const bar = $('filters');
  bar.hidden = !(state.view === 'board' || state.view === 'list');
  if (bar.hidden) return;
  const f = state.filters;
  const on = (key, prop = 'value') => (e) => { f[key] = e.target[prop]; renderMain(); };
  const users = [...state.users.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  const projects = activeProjects();
  bar.replaceChildren(...[
    h('input', { type: 'search', placeholder: 'キー・タイトル・説明・ラベル・コメントで検索', value: f.q, oninput: on('q') }),
    // プロジェクトが1つもなければ出さない(記憶していた値が残っていても、select() が選択肢に残すので戻せる)
    projects.length || f.project ? select([['', 'プロジェクト: すべて'], ['__none', 'プロジェクトなし'], ...projects], f.project, on('project')) : null,
    select([['', '担当者: すべて'], ['__none', '未割り当て'], ...users.map((u) => [u.id, u.name || u.id])], f.assignee, on('assignee')),
    select([['', '種別: すべて'], ...state.config.types], f.type, on('type')),
    select([['', '優先度: すべて'], ...state.config.priorities], f.priority, on('priority')),
    // 選択肢はチケットに付いているラベルから作るので、renderMain のたびに syncFilterBar() で作り直す
    h('select', { id: 'labelFilter', title: 'ラベルで絞り込み', onchange: on('label') }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.mine, onchange: on('mine', 'checked') }), '自分の担当のみ'),
    h('label', { class: 'check', title: '自分に関係するチケットのうち、他の人が更新して未読のもの' },
      h('input', { type: 'checkbox', checked: f.unread, onchange: on('unread', 'checked') }), '新着のみ'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.archived, onchange: on('archived', 'checked') }), 'アーカイブを表示'),
    h('label', { class: 'check', title: '親チケットの中にしまわれているサブチケットも、通常のチケットと同じように並べる' },
      h('input', { type: 'checkbox', checked: f.subs, onchange: on('subs', 'checked') }), 'サブチケットを表示'),
    h('span', { class: 'filter-state', id: 'filterState' }),
    h('span', { class: 'count', id: 'count' }),
  ].filter(Boolean));
  syncFilterBar();
}

const FILTER_DEFAULTS = () => ({ q: '', project: '', assignee: '', type: '', priority: '', label: '', mine: false, unread: false, archived: false });
/** 既定と違う絞り込みがあるか(記憶された絞り込みで「チケットが消えた」と見えないよう、表示して知らせる) */
const isFiltering = () => Object.entries(FILTER_DEFAULTS()).some(([k, v]) => (k === 'q' ? state.filters.q.trim() : state.filters[k]) !== v);

function clearFilters() {
  // 「サブチケットを表示」は表示の切り替えなので残す
  state.filters = { ...FILTER_DEFAULTS(), subs: state.filters.subs };
  renderFilters();
  renderMain();
}

/** 「UI, 緊急」のような入力をラベルの配列にする(全角の読点も区切りにする) */
const parseLabels = (v) => [...new Set(String(v).split(/[,、]/).map((x) => x.trim()).filter(Boolean))];

/** すべてのチケットに付いているラベル(多い順 → 名前順) */
function allLabels() {
  const n = new Map();
  for (const t of state.tickets.values()) for (const l of t.labels) n.set(l, (n.get(l) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(([l]) => l);
}

/** 絞り込みバーのうち、チケットの中身で変わる部分(ラベルの選択肢・絞り込み中の表示)を描き直す。入力中の検索欄は触らない */
function syncFilterBar() {
  const bar = $('filters');
  if (!bar || bar.hidden) return;
  const f = state.filters;
  const sel = $('labelFilter');
  if (sel) {
    const labels = allLabels();
    if (f.label && !labels.includes(f.label)) labels.push(f.label);
    const sig = JSON.stringify(labels);
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(h('option', { value: '' }, 'ラベル: すべて'), ...labels.map((l) => h('option', { value: l }, l)));
    }
    sel.value = f.label;
    sel.hidden = !labels.length;
  }
  const st = $('filterState');
  if (st) {
    st.replaceChildren(...(isFiltering()
      ? [h('span', { class: 'note' }, '絞り込み中'), h('button', { type: 'button', class: 'btn small', title: '検索と絞り込みをすべて解除', onclick: clearFilters }, '✕ クリア')]
      : []));
  }
}

function visibleTickets() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return [...state.tickets.values()].filter((t) => {
    if (!!t.archived !== f.archived) return false;
    if (!f.subs && isSubHidden(t)) return false;
    // 完了したプロジェクトのチケットは出さない(そのプロジェクトで絞り込んだときは出す)
    if (!f.project && isProjectDone(t.project)) return false;
    if (f.project === '__none' ? !!t.project : f.project && t.project !== f.project) return false;
    if (f.mine && t.assignee !== state.me.id) return false;
    if (f.unread && !hasUnread(t)) return false;
    if (f.assignee === '__none' ? !!t.assignee : f.assignee && t.assignee !== f.assignee) return false;
    if (f.type && t.type !== f.type) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.label && !t.labels.includes(f.label)) return false;
    if (q && ![t.key, t.title, t.description, t.labels.join(' '), ...t.comments.map((c) => String(c && c.body || ''))].join('\n').toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 自分か、一覧に出ないサブチケットに新着があるか */
const hasUnread = (t) => isUnread(t) || relIndex().unreadKids.has(t.id);
const projectChip = (t) => (t.project ? h('span', { class: 'chip project', title: 'プロジェクト' }, t.project) : null);
/** サブチケットの親(「↳ TK-3」)。押すと親を開く。親が見つからないものは出さない */
function parentChip(t) {
  const p = t.parent && t.parent !== t.id ? state.tickets.get(t.parent) : null;
  if (!p) return null;
  return h('span', { class: 'chip parent', title: `親チケット: ${p.key} ${p.title}` }, '↳ ', h('button', {
    type: 'button', class: 'keylink', title: `親チケット ${p.key}「${p.title}」を開く`,
    onclick: (e) => { e.stopPropagation(); openTicket(p.id); },
  }, p.key));
}
const prioIndex = (p) => { const i = state.config.priorities.indexOf(p); return i < 0 ? 99 : i; };
const isDone = (t) => t.status === state.config.statuses[state.config.statuses.length - 1];
const isOverdue = (t) => !!t.due && t.due < todayStr() && !isDone(t);
/** 期限が今日から3日以内(過ぎたものは isOverdue) */
const isDueSoon = (t) => !!t.due && t.due >= todayStr() && t.due <= todayStr(3) && !isDone(t);
const dueClass = (t) => 'due' + (isOverdue(t) ? ' over' : isDueSoon(t) ? ' soon' : '');
const dueTitle = (t) => (isOverdue(t) ? '期限切れ' : isDueSoon(t) ? '期限が近い(3日以内)' : '期限');
const prioChip = (p) => (p ? h('span', { class: `chip p${prioIndex(p)}` }, p) : null);

/** 表示・絞り込み・並べ替えをこのブラウザに保存する(共有フォルダには書かない) */
function saveUi() {
  // 「新着のみ」は次に開いたときボードが空に見えて戸惑うので記憶しない
  lsSet(UI_KEY, { view: state.view, filters: { ...state.filters, unread: false }, sort: state.sort });
}
/** 保存した表示を戻す。壊れた値や古い形式は無視し、知っている項目だけ型を確かめて取り込む */
function restoreUi() {
  const ui = lsGet(UI_KEY);
  if (!ui || typeof ui !== 'object') return;
  if (VIEWS.some(([id]) => id === ui.view)) state.view = ui.view;
  if (ui.filters && typeof ui.filters === 'object') {
    for (const [k, v] of Object.entries(state.filters)) {
      if (typeof ui.filters[k] === typeof v) state.filters[k] = ui.filters[k];
    }
  }
  if (ui.sort && typeof ui.sort.col === 'string' && (ui.sort.dir === 1 || ui.sort.dir === -1)) {
    state.sort = { col: ui.sort.col, dir: ui.sort.dir };
  }
}

/** カード・一覧に出す小さなバッジ(チェックリスト・子チケットの進み具合、ブロック中) */
function progressBadges(t) {
  const idx = relIndex();
  const kids = idx.children.get(t.id);
  const done = t.checklist.filter((c) => c.done).length;
  return [
    idx.duplicated.has(t.id) ? h('span', { class: 'badge dup', title: '他のチケットとキーが重複しています。作成した人の画面で自動的に振り直されます。同期ドライブの競合コピーの場合は、内容を見比べて片方をアーカイブしてください' }, '⚠ 重複') : null,
    idx.blocked.has(t.id) ? h('span', { class: 'badge blocked', title: '未完了のチケットにブロックされています' }, '⛔') : null,
    t.checklist.length ? h('span', { class: 'badge' + (done === t.checklist.length ? ' ok' : ''), title: 'チェックリスト' }, `☑ ${done}/${t.checklist.length}`) : null,
    kids ? h('span', { class: 'badge' + (kids.done === kids.total ? ' ok' : ''), title: 'サブチケット(完了/全体)' }, `サブ ${kids.done}/${kids.total}`) : null,
  ];
}

function renderMain() {
  saveUi();
  relIndexCache = null;
  const main = $('main');
  const top = main.scrollTop;
  const views = { board: viewBoard, list: viewList, projects: viewProjects, activity: viewActivity, members: viewMembers, settings: viewSettings };
  main.replaceChildren(views[state.view]());
  main.scrollTop = top;
  syncFilterBar();
  renderUnread();
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
      if (id) await setField(id, 'status', status, { undo: true });
    }));
    return col;
  }));
}

const unreadDot = (t) => (isUnread(t) ? h('span', { class: 'unread-dot', title: '新着の更新があります' }, '●')
  : relIndex().unreadKids.has(t.id) ? h('span', { class: 'unread-dot', title: 'サブチケットに新着の更新があります' }, '●') : null);

function card(t) {
  const unread = hasUnread(t);
  const el = h('div', { class: 'card' + (unread ? ' unread' : '') + (state.cursor === t.id ? ' cursor' : ''), draggable: true, onclick: () => openTicket(t.id) },
    h('div', { class: 'title' }, unreadDot(t), t.title),
    t.labels.length ? h('div', { class: 'labels' }, t.labels.map((l) => h('button', {
      type: 'button', class: 'chip label', title: `ラベル「${l}」で絞り込む`,
      onclick: (e) => { e.stopPropagation(); state.filters.label = l; renderMain(); },
    }, l))) : null,
    h('div', { class: 'meta' },
      h('span', { class: 'key' }, t.key),
      parentChip(t),
      projectChip(t),
      t.type ? h('span', { class: 'chip type' }, t.type) : null,
      prioChip(t.priority),
      progressBadges(t),
      h('span', { class: 'spacer' }),
      t.comments.length ? h('span', { title: 'コメント数' }, `💬${t.comments.length}`) : null,
      t.due ? h('span', { class: dueClass(t), title: `${dueTitle(t)}: ${t.due}` }, t.due.slice(5).replace('-', '/')) : null,
      avatar(t.assignee)));
  el.dataset.id = t.id;
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
  // プロジェクトが1つも設定されておらず、どのチケットにも付いていなければ列を出さない
  const showProject = state.config.projects.length > 0 || tickets.some((t) => t.project);
  // 列が消えたのに記憶した並べ替えが残っていると、見えない列で並ぶので戻す
  if (col === 'project' && !showProject) { state.sort = { col: 'updatedAt', dir: -1 }; return viewList(); }
  const cols = [['key', 'キー'], ['title', 'タイトル'], ...(showProject ? [['project', 'プロジェクト']] : []), ['type', '種別'], ['status', 'ステータス'], ['priority', '優先度'], ['assignee', '担当者'], ['due', '期限'], ['updatedAt', '更新日時']];
  const th = ([id, label]) => h('th', {
    class: 'sortable',
    onclick: () => { state.sort = { col: id, dir: col === id ? -dir : 1 }; renderMain(); },
  }, label + (col === id ? (dir > 0 ? ' ▲' : ' ▼') : ''));

  if (!tickets.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, '該当するチケットはありません'));
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(th))),
    h('tbody', null, tickets.map((t) => h('tr', { class: 'clickable' + (state.cursor === t.id ? ' cursor' : ''), 'data-id': t.id, onclick: () => openTicket(t.id) },
      h('td', { class: 'nowrap' }, h('span', { class: 'key' }, t.key)),
      h('td', { class: 'wrap' }, parentChip(t), unreadDot(t), t.title, ' ', progressBadges(t)),
      showProject ? h('td', { class: 'nowrap' }, t.project) : null,
      h('td', { class: 'nowrap' }, t.type),
      h('td', { class: 'nowrap' }, t.status),
      h('td', { class: 'nowrap' }, prioChip(t.priority)),
      h('td', { class: 'nowrap' }, nameOf(t.assignee)),
      h('td', { class: 'nowrap' }, h('span', { class: dueClass(t), title: t.due ? dueTitle(t) : null }, t.due || '')),
      h('td', { class: 'nowrap' }, fmtDateTime(t.updatedAt)))))));
}

/* ================= 画面: 操作ログ ================= */

function viewActivity() {
  const a = state.activity;
  if (!a.month) a.month = monthStr();
  const body = h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, '読み込み中…'));
  const monthSel = select([a.month], a.month, (e) => { a.month = e.target.value; renderMain(); });
  const users = [...state.users.values()];
  const userSel = select([['', 'ユーザー: すべて'], ...users.map((u) => [u.id, u.name || u.id])], a.user, (e) => { a.user = e.target.value; renderMain(); });

  guard(async () => {
    const months = await logMonths();
    monthSel.replaceChildren(...months.map((m) => h('option', { value: m }, m)));
    monthSel.value = a.month;
    const rows = await loadLogs(a.month, a.user);
    if (!rows.length) { body.replaceChildren(h('div', { class: 'empty' }, 'ログはありません')); return; }
    const shown = rows.slice(0, 1000);
    body.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['日時', 'ユーザー', '端末', '操作', '対象', '詳細'].map((x) => h('th', null, x)))),
      h('tbody', null, shown.map((r) => h('tr', null,
        h('td', { class: 'nowrap' }, fmtDateTime(r.at)),
        h('td', { class: 'nowrap', title: `ID: ${logUser(r)}` }, r.name || logUser(r)),
        h('td', { class: 'nowrap', title: `端末ID: ${r.deviceId || ''}` }, [r.device, r.ua].filter(Boolean).join(' / ')),
        h('td', { class: 'nowrap' }, ACTION_LABELS[r.action] || r.action),
        // ログにはキーしか残らないので、今そのキーを持つチケットを開く(振り直し後は別のチケットのことがある)
        h('td', { class: 'nowrap' }, (() => { const t = r.ticket && findByKey(String(r.ticket)); return t ? keyLink(t, String(r.ticket)) : r.ticket; })()),
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
  const open = (id) => [...state.tickets.values()].filter((t) => t.assignee === id && !t.archived && !isDone(t)).length;
  return h('div', { class: 'view-pad' }, h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['名前', '利用者ID', '端末(自己申告 / ブラウザ)', '担当中', '初回アクセス', '最終アクセス'].map((x) => h('th', null, x)))),
    h('tbody', null, users.map((u) => h('tr', null,
      h('td', { class: 'nowrap' }, h('span', { class: 'me-chip' }, avatar(u.id), u.name || '', u.id === state.me.id ? h('span', { class: 'note' }, '(自分)') : null)),
      h('td', { class: 'nowrap' }, u.id),
      h('td', null, Object.values(u.devices || {}).map((d) => h('div', null, [d.label, d.ua].filter(Boolean).join(' / '), h('span', { class: 'when note' }, ` (${fmtDateTime(d.lastSeen)})`)))),
      h('td', { class: 'nowrap' }, open(u.id)),
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
  const projectStatuses = h('textarea', { rows: 4, value: c.projectStatuses.join('\n') });
  const lines = (el) => [...new Set(el.value.split('\n').map((s) => s.trim()).filter(Boolean))];

  // 種別ごとの接頭辞。種別の欄を書き換えたら表を作り直す(入力済みの値は種別名で引き継ぐ)
  const typeKeyDraft = new Map(Object.entries(c.typeKeys));
  const typeKeyTable = h('div', { class: 'type-keys' });
  const renderTypeKeys = () => {
    typeKeyTable.replaceChildren(...lines(types).map((t) => h('label', { class: 'type-key' },
      h('span', { class: 'type-key-name' }, t),
      h('input', {
        type: 'text', maxLength: 10, value: typeKeyDraft.get(t) || '', placeholder: `既定(${cleanPrefix(key.value) || DEFAULT_CONFIG.key})`,
        'data-type': t, oninput: (e) => typeKeyDraft.set(t, e.target.value),
      }))));
  };
  types.addEventListener('input', renderTypeKeys);
  key.addEventListener('input', renderTypeKeys);
  renderTypeKeys();

  const saveConfig = guard(async () => {
    const fields = {
      projectName: name.value.trim() || DEFAULT_CONFIG.projectName,
      key: cleanPrefix(key.value) || DEFAULT_CONFIG.key,
      statuses: lines(statuses), types: lines(types), projectStatuses: lines(projectStatuses),
    };
    // 今の種別にあるものだけ残す(種別名を変えた・消したものの接頭辞は捨てる)
    fields.typeKeys = Object.fromEntries(fields.types.map((t) => [t, cleanPrefix(typeKeyDraft.get(t))]).filter(([, p]) => p));
    if (fields.statuses.length < 2) { toast('チケットのステータスは2つ以上必要です', true); return; }
    if (!fields.types.length) { toast('種別は1つ以上必要です', true); return; }
    if (fields.projectStatuses.length < 2) { toast('プロジェクトのステータスは2つ以上必要です', true); return; }
    // 最後の行(完了)の名前を変えると、完了済みのプロジェクトが黙って未完了に戻るので、読み替えるか確かめる
    const oldDone = c.projectStatuses.at(-1);
    const newDone = fields.projectStatuses.at(-1);
    const doneNames = oldDone !== newDone ? c.projects.filter((p) => projectInfo(p).status === oldDone) : [];
    const remap = doneNames.length > 0 && confirm(`完了扱いのステータスが「${oldDone}」から「${newDone}」に変わります。\n\n「${oldDone}」のプロジェクト ${doneNames.length} 件を「${newDone}」に読み替えますか?\n(キャンセルすると読み替えずに保存し、それらのプロジェクトは完了扱いではなくなります)`);
    // プロジェクトの一覧・情報は別の画面で変えるので、読み直した値を残して、この画面の項目だけ差し替える
    await updateConfig((next) => {
      Object.assign(next, fields);
      if (remap) for (const i of Object.values(next.projectInfo)) if (i.status === oldDone) i.status = newDone;
    });
    log('config.update', '', 'プロジェクト設定を変更');
    renderChrome();
    renderMain();
    toast('設定を保存しました');
  });

  return h('div', { class: 'view-pad' },
    h('div', { class: 'panel' },
      h('h2', null, 'プロジェクト設定'),
      h('div', { class: 'note' }, '全メンバーに反映されます(共有フォルダの config.json)。'),
      h('label', null, 'ボード名(画面の左上とタブに表示)'), name,
      h('label', null, 'チケットのステータス(1行に1つ。左から順にボードの列になり、最後の行が「完了」扱い)'), statuses,
      h('label', null, '種別(1行に1つ)'), types,
      h('label', null, 'チケットキーの接頭辞(既定)'), key,
      h('label', null, '種別ごとの接頭辞(空欄は既定の接頭辞を使います)'), typeKeyTable,
      h('div', { class: 'note' }, '接頭辞は変更後に作成するチケットから適用します。作成後に種別を変えてもキーは変わりません。番号は種別にかかわらず通し番号です。種別の名前を変えたときは、接頭辞を設定し直してください。'),
      h('label', null, 'プロジェクトのステータス(1行に1つ。最後の行が「完了」扱いで、完了したプロジェクトのチケットはボード・リストに出なくなります)'), projectStatuses,
      h('div', { class: 'note' }, 'プロジェクトの作成・名前の変更は「プロジェクト」画面で行います。'),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: saveConfig }, '保存'))),
    templatePanel(),
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
      }), { showId: false }),
      userIdSection()),
    shortcutPanel(),
    h('div', { class: 'panel' },
      h('h2', null, 'データ保存先'),
      h('div', { class: 'path' }, lsGet('tb.mode') === 'demo' ? 'お試しモード(このブラウザ内のみ・他の人とは共有されません)' : `フォルダ: ${state.root.name}`),
      h('div', { class: 'toolbar' }, h('button', {
        class: 'btn',
        onclick: guard(async () => { await idbSet('root', null); lsSet('tb.mode', null); location.reload(); }),
      }, '保存先フォルダを切り替える'))),
    backupPanel());
}

/*
 * 設定画面は他の人の更新のたびに描き直されるので、添付の集計(全添付フォルダの走査)は
 * 60秒間は前回の結果を使い、チェック状態も覚えておく
 */
const backupUi = { withAtt: true, stats: null, at: 0 };
const BACKUP_WARN_BYTES = 200 * 1024 * 1024;

function backupPanel() {
  const withAtt = h('input', { type: 'checkbox', checked: backupUi.withAtt, onchange: (e) => { backupUi.withAtt = e.target.checked; } });
  const stats = h('span', { class: 'note' }, '(添付を数えています…)');
  const show = (s) => {
    stats.textContent = `(添付 ${s.count} 件・合計 ${fmtSize(s.size)})`
      + (s.size > BACKUP_WARN_BYTES ? ' 添付が大きいため、保存に失敗することがあります。その場合は添付を含めずに保存し、添付は attachments フォルダごとコピーしてください' : '');
  };
  if (backupUi.stats && Date.now() - backupUi.at < 60000) show(backupUi.stats);
  else {
    guard(async () => {
      backupUi.stats = await attachmentStats();
      backupUi.at = Date.now();
      show(backupUi.stats);
    })();
  }
  const picker = h('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: guard(async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) await importBackup(f);
    }),
  });
  return h('div', { class: 'panel' },
    h('h2', null, 'データのバックアップ'),
    h('div', { class: 'note' },
      'チケット・設定・メンバー・添付を1つのファイルに保存します(操作ログとテンプレートは含みません)。',
      '読み込むと、今のデータにチケットを「追加」します。今あるチケットや設定は上書きしません。'),
    h('div', { class: 'note' }, 'お試しモードのデータをチームのフォルダに移すには: お試しモードで「保存」→「保存先フォルダを切り替える」でフォルダに接続 → ここで「読み込み」。'),
    h('label', { class: 'check' }, withAtt, '添付ファイルも含める ', stats),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: guard(() => exportBackup(withAtt.checked)) }, 'バックアップを保存'),
      h('button', { class: 'btn', onclick: () => picker.click() }, 'バックアップを読み込む'),
      picker));
}

/**
 * 端末の説明を自動で作る(例: 「Edge / Windows 11」)。
 * ブラウザからは PC 名・Windows のユーザー名・MAC アドレスは取れないので、ブラウザと OS の種類だけ。
 * Windows 10 と 11 は User-Agent では見分けられないため、対応ブラウザでは Client Hints の platformVersion を使う(13 以上が 11)。
 */
async function detectDevice() {
  const base = shortUA().replace(/ \d+ \//, ' /'); // 「Edge 142 / Windows」→「Edge / Windows」
  try {
    const ua = navigator.userAgentData;
    if (ua && ua.platform === 'Windows') {
      const { platformVersion } = await ua.getHighEntropyValues(['platformVersion']);
      const major = parseInt(platformVersion, 10);
      if (major >= 13) return base.replace('Windows', 'Windows 11');
      if (major > 0) return base.replace('Windows', 'Windows 10');
    }
  } catch { /* 取れなければブラウザと OS の種類だけ */ }
  return base;
}

const newUserId = () => `u-${uid(8)}`;

/** showId: 利用者IDの注記を出すか(設定画面では下の「利用者ID」欄に出すので出さない) */
function profileForm(submitLabel, onSaved, { showId = true } = {}) {
  const me = state.me || {};
  const name = h('input', { type: 'text', value: me.name || '', required: true, maxLength: 40, placeholder: '例: 山田 太郎' });
  const device = h('input', { type: 'text', value: me.device || '', maxLength: 40, placeholder: '例: 自席の PC(任意)' });
  // 端末名が空なら、自動で取れた内容を入れておく(書き換えてよい)
  if (!me.device) detectDevice().then((v) => { if (!device.value) device.value = v; });
  return h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { toast('名前を入力してください', true); name.focus(); return; }
      let deviceId = lsGet('tb.deviceId');
      if (!deviceId) { deviceId = uid(8); lsSet('tb.deviceId', deviceId); }
      state.me = { id: me.id || newUserId(), name: n, device: device.value.trim(), deviceId };
      lsSet('tb.me', state.me);
      onSaved();
    },
  },
    h('label', null, '名前(担当者や操作ログに表示されます)'), name,
    h('label', null, '端末名(自動で入ります。分かりやすい名前に変えても構いません)'), device,
    !showId ? null : me.id ? h('div', { class: 'note' }, `利用者ID: ${me.id}`) : h('div', { class: 'note' }, '利用者IDは自動で作られます。メールアドレスなどの入力は不要です。'),
    h('div', { class: 'actions toolbar' }, h('button', { class: 'btn primary', type: 'submit' }, submitLabel)));
}

/**
 * 設定画面のプロフィール欄の中に出す「利用者ID」。表示・コピーと、
 * 別の端末・ブラウザで使っている利用者IDへの切り替え(同じ人として扱われるようにする)
 */
function userIdSection() {
  const input = h('input', { type: 'text', maxLength: 100, placeholder: '例: u-7k3m9xab' });
  const apply = guard(async () => {
    const id = input.value.trim();
    if (!id) { toast('利用者IDを入力してください', true); return; }
    if (id === state.me.id) { toast('今の利用者IDと同じです', true); return; }
    await loadUsers();
    // 小文字に直して探す(以前の版のメールアドレスの ID は小文字で保存している)
    const u = state.users.get(id) || state.users.get(id.toLowerCase());
    if (!u) { toast(`利用者ID「${id}」のメンバーは見つかりません。メンバー画面の「利用者ID」を確かめてください`, true); return; }
    if (!confirm(`この端末を「${u.name || u.id}」(${u.id})として使います。よろしいですか?`)) return;
    const old = state.me.id;
    state.me = { ...state.me, id: u.id, name: u.name || state.me.name };
    lsSet('tb.me', state.me);
    // 切り替える前の ID が、どのチケットにも使われていなければメンバー一覧から消す(自分のファイルだけ)
    await withLock(syncTicketsRaw);
    const by = (list) => list.some((x) => x && x.by === old);
    const used = [...state.tickets.values()].some((t) => [t.assignee, t.reporter, t.updatedBy].includes(old)
      || by(t.comments) || by(t.history) || by(t.checklist) || by(t.links));
    if (!used) { try { await state.dirs.users.removeEntry(safeName(old) + '.json'); } catch (e) { if (e.name !== 'NotFoundError') console.warn(e); } }
    await registerUser();
    await loadUsers();
    log('profile.update', '', `利用者IDを引き継ぎ: ${old} → ${u.id}`);
    renderChrome();
    renderMain();
    toast(`「${u.name || u.id}」として使います`);
  });
  return h('div', { class: 'user-id' },
    h('h3', null, '利用者ID'),
    h('div', { class: 'note' }, 'このブラウザでのあなたの利用者IDです。別の PC やブラウザでも同じ人として使うときは、そちらで下の欄にこの ID を入力してください。'),
    h('div', { class: 'row' }, h('div', { class: 'path', 'data-testid': 'my-id' }, state.me.id),
      h('button', { class: 'btn small', onclick: guard(async () => { await navigator.clipboard.writeText(state.me.id); toast('利用者IDをコピーしました'); }) }, 'コピー')),
    h('label', null, '別の端末で使っている利用者IDを引き継ぐ'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: apply }, '引き継ぐ')));
}

/** 担当者の選択肢。自分を先頭に、残りは名前順 */
function assigneeOptions() {
  const me = state.me.id;
  const users = [...state.users.values()]
    .sort((a, b) => (b.id === me) - (a.id === me) || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ja'));
  return [['', '未割り当て'], ...users.map((u) => [u.id, u.name || u.id])];
}

/* ================= 設定: テンプレート ================= */

const defaultPriority = () => state.config.priorities[Math.min(1, state.config.priorities.length - 1)];

function templatePanel() {
  const group = (kind) => {
    const list = templatesOf(kind);
    return [
      h('div', { class: 'section-title' }, TEMPLATE_KINDS[kind], h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => openTemplateDialog({ kind }) }, '＋ 追加')),
      list.length
        ? h('ul', { class: 'link-list tpl-list', 'data-kind': kind }, list.map((tpl) => h('li', null,
          h('span', { class: 'name' }, tpl.name, kind === 'project' ? h('span', { class: 'note' }, ` (チケット ${tpl.tickets.length} 件)`) : null),
          h('button', { class: 'btn small', type: 'button', onclick: () => openTemplateDialog(tpl) }, '編集'),
          h('button', {
            class: 'btn small danger', type: 'button',
            onclick: guard(async () => {
              if (!confirm(`${TEMPLATE_KINDS[kind]}「${tpl.name}」を削除しますか?\n\nこのテンプレートから作ったチケットはそのまま残ります。`)) return;
              await removeTemplate(tpl);
              renderMain();
              toast(`テンプレート「${tpl.name}」を削除しました`);
            }),
          }, '削除'))))
        : h('div', { class: 'note' }, kind === 'project'
          ? 'まだありません。プロジェクトを作るときに、決まったチケットをまとめて作れます。'
          : 'まだありません。チケットを作るときに選ぶと、説明・ラベル・チェックリストが入ります。'),
    ];
  };
  return h('div', { class: 'panel', id: 'templatePanel' },
    h('h2', null, 'テンプレート'),
    h('div', { class: 'note' }, '全メンバーに反映されます(共有フォルダの templates フォルダ)。同じテンプレートを2人が同時に編集すると、後から保存したほうが残ります。'),
    group('project'),
    group('ticket'));
}

/** テンプレートの編集ダイアログ。tpl に id が無ければ新規作成 */
function openTemplateDialog(tpl) {
  const c = state.config;
  const kind = tpl.kind === 'ticket' ? 'ticket' : 'project';
  const toEdit = (it) => ({
    title: it.title || '', type: it.type || c.types[0], priority: it.priority || defaultPriority(),
    labelsText: (it.labels || []).join(', '), description: it.description || '', checklistText: (it.checklist || []).join('\n'),
  });
  const items = (tpl.tickets && tpl.tickets.length ? tpl.tickets : [{}]).map(toEdit);
  const name = h('input', { type: 'text', value: tpl.name || '', maxLength: 100, placeholder: kind === 'project' ? '例: 新規案件の立ち上げ' : '例: バグ報告' });
  const list = h('div', { class: 'tpl-items' });
  state.openId = null;
  dlg.className = 'dlg';

  const renderItems = () => {
    list.replaceChildren(...items.map((it, i) => {
      const bind = (field) => (e) => { it[field] = e.target.value; };
      const move = (d) => () => { [items[i], items[i + d]] = [items[i + d], items[i]]; renderItems(); };
      return h('div', { class: 'tpl-item' },
        kind === 'project' ? h('div', { class: 'tpl-item-head' }, h('strong', null, `チケット ${i + 1}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', type: 'button', title: '上へ', disabled: i === 0, onclick: move(-1) }, '↑'),
          h('button', { class: 'btn small', type: 'button', title: '下へ', disabled: i === items.length - 1, onclick: move(1) }, '↓'),
          h('button', {
            class: 'btn small danger', type: 'button', disabled: items.length === 1,
            onclick: () => { items.splice(i, 1); renderItems(); },
          }, '削除')) : null,
        h('label', null, 'タイトル'), h('input', { type: 'text', class: 'tpl-title', value: it.title, maxLength: 200, oninput: bind('title') }),
        h('div', { class: 'row' },
          h('div', null, h('label', null, '種別'), select(c.types, it.type, bind('type'))),
          h('div', null, h('label', null, '優先度'), select(c.priorities, it.priority, bind('priority')))),
        h('label', null, 'ラベル(カンマ区切り)'), h('input', { type: 'text', value: it.labelsText, oninput: bind('labelsText') }),
        h('label', null, '説明'), h('textarea', { rows: 3, class: 'tpl-desc', value: it.description, oninput: bind('description') }),
        h('label', null, 'チェックリスト(1行に1項目)'), h('textarea', { rows: 3, class: 'tpl-check', value: it.checklistText, oninput: bind('checklistText') }));
    }));
  };
  renderItems();

  const save = guard(async () => {
    const n = name.value.trim();
    if (!n) { toast('テンプレート名を入力してください', true); name.focus(); return; }
    const empty = items.findIndex((it) => !it.title.trim());
    if (empty >= 0) {
      toast(kind === 'project' ? `チケット ${empty + 1} のタイトルを入力してください` : 'タイトルを入力してください', true);
      list.querySelectorAll('.tpl-title')[empty].focus();
      return;
    }
    const saved = await saveTemplate({
      id: tpl.id, kind, name: n,
      tickets: items.map((it) => ({
        title: it.title, type: it.type, priority: it.priority, description: it.description,
        labels: parseLabels(it.labelsText), checklist: it.checklistText.split('\n').map((s) => s.trim()).filter(Boolean),
      })),
    });
    dlg.close();
    renderMain();
    toast(`テンプレート「${saved.name}」を保存しました`);
  });

  setDialog(h('div', { class: 'tpl-dialog' },
    h('div', { class: 'dlg-head' }, h('strong', null, `${TEMPLATE_KINDS[kind]}${tpl.id ? 'の編集' : 'の作成'}`), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      h('label', null, 'テンプレート名'), name,
      kind === 'project' ? h('div', { class: 'note' }, 'このテンプレートでプロジェクトを作ると、下のチケットが上から順に作られます(担当者・期限は空、ステータスは最初の列)。') : null,
      list,
      kind === 'project' ? h('div', { class: 'toolbar' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          if (items.length >= TEMPLATE_MAX_TICKETS) { toast(`チケットは ${TEMPLATE_MAX_TICKETS} 件までです`, true); return; }
          items.push(toEdit({})); renderItems(); list.querySelectorAll('.tpl-title')[items.length - 1].focus(); },
      }, '＋ チケットを追加')) : null,
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存')))));
  if (!dlg.open) dlg.showModal();
  name.focus();
}

/* ================= 画面: プロジェクト ================= */

/** プロジェクト画面の表示状態(このブラウザの間だけ) */
const projectUi = { showDone: false };

/** プロジェクトで絞り込んだボードを開く(完了したプロジェクトでも、絞り込めばチケットが出る) */
function openProjectBoard(name) {
  state.filters = { ...state.filters, project: name };
  state.view = 'board';
  renderChrome();
  renderMain();
}

async function setProjectStatus(name, status) {
  const from = projectInfo(name).status;
  if (from === status) return;
  await updateConfig((c) => {
    if (!c.projects.includes(name)) throw new Error(`プロジェクト「${name}」が見つかりません。他の人が名前を変えたか削除した可能性があります`);
    c.projectInfo[name] = { description: '', due: '', ...(Object.hasOwn(c.projectInfo, name) ? c.projectInfo[name] : {}), status };
  });
  log('project.update', '', `${name}: ステータス ${from} → ${status}`);
  renderChrome();
  renderMain();
  toast(status === state.config.projectStatuses.at(-1)
    ? `プロジェクト「${name}」を${status}にしました。このプロジェクトのチケットはボード・リストに出なくなります`
    : `プロジェクト「${name}」を${status}にしました`);
}

function viewProjects() {
  const c = state.config;
  const doneCount = c.projects.filter(isProjectDone).length;
  // 完了していないもの → 完了したもの の順(それぞれは登録順)
  const shown = [...c.projects.filter((p) => !isProjectDone(p)), ...(projectUi.showDone ? c.projects.filter(isProjectDone) : [])];
  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary', type: 'button', onclick: openProjectCreateDialog }, '＋ プロジェクトを作成'),
    h('label', { class: 'check inline-check' }, h('input', {
      type: 'checkbox', checked: projectUi.showDone,
      onchange: (e) => { projectUi.showDone = e.target.checked; renderMain(); },
    }), `完了したプロジェクトも表示(${doneCount} 件)`));
  if (!shown.length) {
    return h('div', { class: 'view-pad' }, toolbar, h('div', { class: 'table-wrap' }, h('div', { class: 'empty' },
      c.projects.length ? '完了していないプロジェクトはありません' : 'プロジェクトはまだありません。「＋ プロジェクトを作成」から作れます')));
  }
  const today = todayStr();
  return h('div', { class: 'view-pad' }, toolbar, h('div', { class: 'table-wrap' }, h('table', { class: 'project-table' },
    h('thead', null, h('tr', null, ['プロジェクト', 'ステータス', '期限', '進み具合', '期限切れ', '説明', ''].map((x) => h('th', null, x)))),
    h('tbody', null, shown.map((name) => {
      const info = projectInfo(name);
      const st = projectStats(name);
      const done = isProjectDone(name);
      const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
      const over = !!info.due && info.due < today && !done;
      return h('tr', { class: done ? 'project-done' : '', 'data-project': name },
        h('td', { class: 'nowrap' }, h('button', {
          type: 'button', class: 'project-link', title: `「${name}」のボードを開く`, onclick: () => openProjectBoard(name),
        }, name)),
        h('td', { class: 'nowrap' }, select(c.projectStatuses, info.status, guard(async (e) => {
          try { await setProjectStatus(name, e.target.value); } catch (err) { renderMain(); throw err; }
        }), { class: 'project-status', title: 'ステータス' })),
        h('td', { class: 'nowrap' }, h('span', { class: 'due' + (over ? ' over' : ''), title: over ? '期限切れ' : null }, info.due || '')),
        h('td', { class: 'nowrap' },
          h('div', { class: 'progress', title: `${pct}%` }, h('div', { class: 'progress-bar' + (st.total && st.done === st.total ? ' ok' : ''), style: `width:${pct}%` })),
          h('span', { class: 'note' }, st.total ? `完了 ${st.done} / ${st.total} 件` : 'チケットなし')),
        h('td', { class: 'nowrap' }, st.overdue ? h('span', { class: 'due over' }, `${st.overdue} 件`) : ''),
        h('td', { class: 'project-desc', title: info.description || null }, info.description),
        h('td', { class: 'nowrap' }, h('button', { class: 'btn small', type: 'button', onclick: () => openProjectEditDialog(name) }, '編集')));
    })))));
}

/** プロジェクトの名前・ステータス・期限・説明を変える。名前を変えたら、付いているチケットも書き換える */
function openProjectEditDialog(oldName) {
  const c = state.config;
  const info = projectInfo(oldName);
  const name = h('input', { type: 'text', value: oldName, maxLength: 100 });
  const status = select(c.projectStatuses, info.status);
  const due = h('input', { type: 'date', value: info.due });
  const desc = h('textarea', { rows: 4, maxLength: 10000, value: info.description });
  const usedBy = () => [...state.tickets.values()].filter((t) => t.project === oldName);
  state.openId = null;
  dlg.className = 'dlg narrow';

  let busy = false;
  const save = guard(async (e) => {
    e.preventDefault();
    if (busy) return;
    const n = name.value.trim();
    if (!n) { toast('プロジェクト名を入力してください', true); name.focus(); return; }
    if (isReservedProjectName(n)) { toast(`「${n}」はプロジェクト名に使えません`, true); return; }
    if (due.value && !DUE_RE.test(due.value)) { toast('期限の日付が正しくありません', true); return; }
    const renamed = n !== oldName;
    if (renamed && state.config.projects.includes(n)) { toast(`プロジェクト「${n}」はすでにあります`, true); return; }
    busy = true;
    try {
      if (renamed) await withLock(syncTicketsRaw); // 付いているチケットを最新の状態で数える
      const tickets = renamed ? usedBy() : [];
      if (renamed && tickets.length && !confirm(`プロジェクト名を「${oldName}」から「${n}」に変えます。\n\nこのプロジェクトのチケット ${tickets.length} 件(アーカイブ済みを含む)のプロジェクトも書き換えます。よろしいですか?`)) return;
      const nextInfo = { status: status.value, due: due.value, description: desc.value };
      await updateConfig((cfg) => {
        const i = cfg.projects.indexOf(oldName);
        if (i < 0) throw new Error(`プロジェクト「${oldName}」が見つかりません。他の人が名前を変えたか削除した可能性があります`);
        if (renamed && cfg.projects.includes(n)) throw new Error(`プロジェクト「${n}」はすでにあります`);
        // 読み直した最新の情報に、このダイアログで変えた項目だけを当てる
        const cur = { status: '', description: '', due: '', ...(Object.hasOwn(cfg.projectInfo, oldName) ? cfg.projectInfo[oldName] : {}) };
        for (const k of ['status', 'due', 'description']) if (nextInfo[k] !== info[k]) cur[k] = nextInfo[k];
        cfg.projects[i] = n;
        delete cfg.projectInfo[oldName];
        cfg.projectInfo[n] = cur;
      });
      const changes = [renamed ? `名前 ${oldName} → ${n}` : null, nextInfo.status !== info.status ? `ステータス ${info.status} → ${nextInfo.status}` : null,
        nextInfo.due !== info.due ? `期限 ${info.due || '(なし)'} → ${nextInfo.due || '(なし)'}` : null, nextInfo.description !== info.description ? '説明を編集' : null].filter(Boolean);
      if (changes.length) log('project.update', '', `${n}: ${changes.join('、')}`);
      // チケットは1件ずつ updateTicket で書き換える(読み直した時点で別のプロジェクトに付け替えられていたら触らない)
      const failed = [];
      for (const t of tickets) {
        try {
          await updateTicket(t.id, (x) => {
            if (x.project !== oldName) return;
            x.project = n;
            x.history.push({ at: nowIso(), by: state.me.id, field: 'project', from: oldName, to: n });
          });
          log('ticket.update', t.key, `${FIELD_LABELS.project}: ${oldName} → ${n}(プロジェクト名の変更)`);
        } catch (err) {
          console.error(err);
          failed.push(t.key);
        }
      }
      if (state.filters.project === oldName) state.filters = { ...state.filters, project: n };
      dlg.close();
      renderChrome();
      renderMain();
      if (failed.length) toast(`プロジェクトを保存しましたが、チケット ${failed.join(', ')} のプロジェクトを書き換えられませんでした。チケットの詳細画面で付け替えてください`, true);
      else toast(renamed && tickets.length ? `プロジェクトを保存し、チケット ${tickets.length} 件のプロジェクトを書き換えました` : 'プロジェクトを保存しました');
    } finally {
      busy = false;
    }
  });

  // 削除はチケットが1件も付いていないときだけ(付いているチケットが「一覧にないプロジェクト」になるのを防ぐ)
  const remove = guard(async () => {
    const used = usedBy();
    if (used.length) { toast(`このプロジェクトにはチケットが ${used.length} 件あります(アーカイブ済みを含む)。削除するには、先にチケットのプロジェクトを付け替えてください。使わなくなったプロジェクトは、ステータスを「${c.projectStatuses.at(-1)}」にすると一覧から隠れます`, true); return; }
    if (!confirm(`プロジェクト「${oldName}」を削除しますか?`)) return;
    await updateConfig((cfg) => {
      cfg.projects = cfg.projects.filter((p) => p !== oldName);
      delete cfg.projectInfo[oldName];
    });
    log('project.remove', '', oldName);
    if (state.filters.project === oldName) state.filters = { ...state.filters, project: '' };
    dlg.close();
    renderChrome();
    renderMain();
    toast(`プロジェクト「${oldName}」を削除しました`);
  });

  setDialog(h('form', { onsubmit: save },
    h('div', { class: 'dlg-head' }, h('strong', null, 'プロジェクトの編集'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      h('label', null, 'プロジェクト名'), name,
      h('div', { class: 'note' }, '名前を変えると、このプロジェクトのチケットのプロジェクトも書き換えます。'),
      h('label', null, 'ステータス'), status,
      h('label', null, '期限'), due,
      h('label', null, '説明'), desc,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'submit' }, '保存'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn danger', type: 'button', onclick: remove }, '削除')))));
  if (!dlg.open) dlg.showModal();
  name.focus();
}

/* ================= ダイアログ: プロジェクト作成 ================= */

function openProjectCreateDialog() {
  const name = h('input', { type: 'text', required: true, maxLength: 100, placeholder: '例: Webサイト改修' });
  const due = h('input', { type: 'date' });
  const desc = h('textarea', { rows: 3, maxLength: 10000, placeholder: '目的やゴールなど(任意)' });
  const tpls = templatesOf('project');
  const tplSel = select([['', '(テンプレートなし)'], ...tpls.map((t) => [t.id, `${t.name}(チケット ${t.tickets.length} 件)`])], '');
  const preview = h('div', { class: 'tpl-preview' });
  const showPreview = () => {
    const tpl = state.templates.get(tplSel.value);
    preview.replaceChildren(...(tpl && tpl.tickets.length
      ? [h('div', { class: 'note' }, '作られるチケット:'), h('ol', null, tpl.tickets.map((it) => h('li', null, it.title || '(無題)')))]
      : []));
  };
  tplSel.addEventListener('change', showPreview);
  state.openId = null;
  dlg.className = 'dlg narrow';

  let busy = false;
  const submit = guard(async (e) => {
    e.preventDefault();
    if (busy) return;
    const n = name.value.trim();
    if (!n) { toast('プロジェクト名を入力してください', true); name.focus(); return; }
    if (isReservedProjectName(n)) { toast(`「${n}」はプロジェクト名に使えません`, true); return; }
    if (due.value && !DUE_RE.test(due.value)) { toast('期限の日付が正しくありません', true); return; }
    const tpl = tplSel.value ? state.templates.get(tplSel.value) : null;
    if (tplSel.value && !tpl) { toast('選んだテンプレートが見つかりません。他の人が削除した可能性があります', true); return; }
    busy = true;
    try {
      // 他の人が直前に変えた設定を上書きしないよう、書く直前に読み直す
      await loadConfig();
      // すでにあるプロジェクトには、テンプレートのチケットだけを足せる(途中で失敗したときの作り直しにも使う)
      const exists = state.config.projects.includes(n);
      if (exists && !(tpl && tpl.tickets.length)) { toast(`プロジェクト「${n}」はすでにあります`, true); return; }
      if (exists && !confirm(`プロジェクト「${n}」はすでにあります。テンプレート「${tpl.name}」のチケット ${tpl.tickets.length} 件だけを追加しますか?`)) return;
      if (!exists) {
        const info = { status: state.config.projectStatuses[0], description: desc.value, due: due.value };
        await updateConfig((c) => {
          if (!c.projects.includes(n)) c.projects.push(n);
          c.projectInfo[n] = info;
        });
      }
      let created = [];
      if (tpl && tpl.tickets.length) {
        const c = state.config;
        // 設定から消えた種別・優先度は既定値に戻す(チケット作成ダイアログと同じ扱い)
        created = await createTickets(tpl.tickets.map((it) => ({
          ...it, title: it.title.trim() || '(無題)', project: n,
          type: c.types.includes(it.type) ? it.type : c.types[0],
          priority: c.priorities.includes(it.priority) ? it.priority : defaultPriority(),
        })));
      }
      if (!exists) log('project.create', '', tpl ? `${n}(テンプレート「${tpl.name}」・チケット ${created.length} 件)` : n);
      // 作ったプロジェクトに絞り込んでボードを開く
      state.filters = { ...state.filters, project: n };
      state.view = 'board';
      dlg.close();
      renderChrome();
      renderMain();
      toast(exists ? `プロジェクト「${n}」にチケット ${created.length} 件を追加しました`
        : created.length ? `プロジェクト「${n}」とチケット ${created.length} 件を作成しました` : `プロジェクト「${n}」を作成しました`);
    } finally {
      busy = false;
    }
  });

  setDialog(h('form', { onsubmit: submit },
    h('div', { class: 'dlg-head' }, h('strong', null, 'プロジェクト作成'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      h('label', null, 'プロジェクト名'), name,
      h('label', null, '期限(任意)'), due,
      h('label', null, '説明(任意)'), desc,
      h('label', null, 'テンプレート'), tplSel,
      tpls.length ? null : h('div', { class: 'note' }, 'プロジェクトテンプレートは、設定画面の「テンプレート」で作れます。'),
      preview,
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'submit' }, '作成')))));
  if (!dlg.open) dlg.showModal();
  name.focus();
}

/* ================= ダイアログ: チケット作成 ================= */

function openCreateDialog() {
  const c = state.config;
  const title = h('input', { type: 'text', required: true, maxLength: 200, placeholder: '何をしますか?' });
  const type = select(c.types, c.types[0]);
  const prio = select(c.priorities, c.priorities[Math.min(1, c.priorities.length - 1)]);
  const assignee = select(assigneeOptions(), '');
  // 絞り込み中のプロジェクトがあれば、それを初期値にする(作った直後に一覧から消えないように)
  const pf = state.filters.project;
  const project = select([['', '(なし)'], ...activeProjects()], pf && pf !== '__none' ? pf : '');
  // チケットテンプレート: 選ぶとタイトル・種別・優先度を埋め、説明・ラベル・チェックリストは作成時に入れる
  const tpls = templatesOf('ticket');
  let tplItem = null;
  const tplNote = h('div', { class: 'note tpl-note' });
  const tplSel = tpls.length ? select([['', '(テンプレートなし)'], ...tpls.map((t) => [t.id, t.name])], '', () => {
    const tpl = state.templates.get(tplSel.value);
    tplItem = tpl ? tpl.tickets[0] : null;
    if (tplItem) {
      title.value = tplItem.title;
      if (tplItem.type) type.value = c.types.includes(tplItem.type) ? tplItem.type : type.value;
      if (tplItem.priority) prio.value = c.priorities.includes(tplItem.priority) ? tplItem.priority : prio.value;
    }
    const parts = tplItem ? [
      tplItem.description ? '説明' : null,
      tplItem.labels.length ? `ラベル(${tplItem.labels.join(', ')})` : null,
      tplItem.checklist.length ? `チェックリスト ${tplItem.checklist.length} 項目` : null,
    ].filter(Boolean) : [];
    tplNote.textContent = parts.length ? `${parts.join('・')}はテンプレートから入ります` : '';
    title.focus();
  }) : null;
  state.openId = null;
  dlg.className = 'dlg narrow';
  const create = async (text) => {
    const extra = tplItem ? { description: tplItem.description, labels: tplItem.labels, checklist: tplItem.checklist } : {};
    const t = await createTicket({ ...extra, title: text, type: type.value, priority: prio.value, assignee: assignee.value, project: project.value });
    renderMain();
    return t;
  };
  const takeTitle = () => {
    const text = title.value.trim();
    if (!text) { toast('タイトルを入力してください', true); title.focus(); }
    return text;
  };
  // 続けて何件も登録するとき用。詳細を開かず、種別・担当者などはそのまま残してタイトルだけ空にする。
  // 押した時点でタイトルを取り出して空にするので、素早く2回押しても同じチケットが2枚できない
  const createAndContinue = guard(async () => {
    const text = takeTitle();
    if (!text) return;
    // テンプレートを選んでいれば、次のチケットもその書き出しから始める
    const blank = tplItem ? tplItem.title : '';
    title.value = blank;
    title.focus();
    try {
      const t = await create(text);
      toast(`${t.key}「${t.title}」を作成しました`);
    } catch (e) {
      if (title.value === blank) title.value = text; // 失敗したら入力を戻す
      throw e;
    }
  });
  setDialog(h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const text = takeTitle();
      if (!text) return;
      openTicket((await create(text)).id);
    }),
  },
    h('div', { class: 'dlg-head' }, h('strong', null, 'チケット作成'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      tplSel ? [h('label', null, 'テンプレート'), tplSel, tplNote] : null,
      h('label', null, 'タイトル'), title,
      h('div', { class: 'row' },
        h('div', null, h('label', null, '種別'), type),
        h('div', null, h('label', null, '優先度'), prio)),
      h('label', null, '担当者'), assignee,
      activeProjects().length || project.value ? [h('label', null, 'プロジェクト'), project] : null,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'submit' }, '作成'),
        h('button', { class: 'btn', type: 'button', title: '作成して、続けて次のチケットを入力する', onclick: createAndContinue }, '作成して続ける')))));
  if (!dlg.open) dlg.showModal();
  title.focus();
}

/* ================= ダイアログ: チケット詳細 ================= */

function openTicket(id) {
  if (!state.tickets.has(id)) { toast(notFoundMsg('チケット'), true); return; }
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
  // 開いて見えている = 既読。カードの ● を消すため一覧も描き直す
  if (markSeen(t)) renderMain();
  // 描き直すと入力欄が新しくなるので、同じチケットなら書きかけの内容(コメント・リンク・関連・チェック項目)を引き継ぐ
  const drafts = dlg.dataset.ticket === t.id
    ? Object.fromEntries([...dlg.querySelectorAll('[data-draft]')].map((el) => [el.dataset.draft, el.value]))
    : {};
  const c = state.config;
  // 開いているチケットが変わったら、セクションの開閉・編集中の状態を戻す
  if (state.detail.id !== t.id) state.detail = { id: t.id, open: new Set(), descEditing: false, editComment: null };
  const D = state.detail;
  /*
   * 中身が0件のセクションは見出しと「＋ 追加」だけにして、ダイアログを短くする。
   * 押すと入力欄を出す(描き直さないので、他の欄の書きかけは消えない)。書きかけがあれば最初から開く。
   */
  const section = (name, label, count, list, addRow, draftKeys = []) => {
    const open = count > 0 || D.open.has(name) || draftKeys.some((k) => drafts[k]);
    const body = h('div', { class: 'section-body', hidden: !open }, list, addRow);
    const btn = open ? null : h('button', {
      type: 'button', class: 'btn small',
      onclick: () => {
        D.open.add(name);
        body.hidden = false;
        btn.remove();
        const input = addRow.querySelector('input:not([type=file])');
        if (input) input.focus();
      },
    }, '＋ 追加');
    return h('div', { class: 'section', 'data-section': name }, h('div', { class: 'section-title' }, label, btn), body);
  };
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
  const linkTitle = h('input', { type: 'text', placeholder: '表示名(省略可)', maxLength: 100, 'data-draft': 'linkTitle' });
  const linkUrl = h('input', { type: 'url', placeholder: 'https://app.box.com/s/...', 'data-draft': 'linkUrl' });
  const addLink = guard(async () => {
    const url = linkUrl.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('http(s):// で始まるURLを入力してください', true); return; }
    const link = { id: uid(6), title: linkTitle.value.trim() || url, url, by: state.me.id, at: nowIso() };
    await updateTicket(t.id, (x) => { x.links.push(link); x.history.push({ at: link.at, by: link.by, field: 'リンク', from: '', to: `追加: ${link.title}` }); });
    log('link.add', t.key, url);
    linkTitle.value = linkUrl.value = '';
    rerender();
  });
  const links = t.links.filter((l) => l && /^https?:\/\//i.test(String(l.url)));

  /* --- コメント --- */
  const commentBox = h('textarea', { rows: 3, placeholder: 'コメントを入力(Ctrl+Enter で送信)', 'data-draft': 'comment' });
  const addComment = guard(async () => {
    const body = commentBox.value.trim();
    if (!body) return;
    await updateTicket(t.id, (x) => x.comments.push({ id: uid(6), by: state.me.id, at: nowIso(), body }));
    log('comment.add', t.key, body.slice(0, 80));
    commentBox.value = '';
    rerender();
  });
  commentBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(); });
  // 自分のコメントだけ直せる。id で当てるので、他の人が同時に足したコメントは消さない
  const commentGone = () => new Error('コメントが見つかりません。他の端末で削除された可能性があります');
  const saveCommentEdit = (cm, box) => guard(async () => {
    const body = box.value.trim();
    if (!body) { toast('コメントが空です。消すときは「削除」を押してください', true); box.focus(); return; }
    await updateTicket(t.id, (x) => {
      const it = x.comments.find((y) => y && y.id === cm.id);
      if (!it) throw commentGone();
      it.body = body;
      it.editedAt = nowIso();
      x.history.push({ at: it.editedAt, by: state.me.id, field: 'コメント', from: '', to: `編集: ${body.slice(0, 40)}` });
    });
    log('comment.edit', t.key, body.slice(0, 80));
    D.editComment = null;
    box.value = '';
    rerender();
  });
  const deleteComment = (cm) => guard(async () => {
    if (!confirm('このコメントを削除しますか?')) return;
    const head = String(cm.body ?? '').slice(0, 40);
    await updateTicket(t.id, (x) => {
      if (!x.comments.some((y) => y && y.id === cm.id)) throw commentGone();
      x.comments = x.comments.filter((y) => !(y && y.id === cm.id));
      x.history.push({ at: nowIso(), by: state.me.id, field: 'コメント', from: '', to: `削除: ${head}` });
    });
    log('comment.remove', t.key, head);
    if (D.editComment === cm.id) D.editComment = null;
    rerender();
  });
  const commentView = (cm) => {
    const mine = !!(cm && cm.id && cm.by === state.me.id);
    const editing = mine && D.editComment === cm.id;
    const box = editing ? h('textarea', { rows: 3, value: String(cm.body ?? ''), 'data-draft': `cedit-${cm.id}` }) : null;
    if (box) {
      box.addEventListener('keydown', (e) => {
        if (e.isComposing) return; // 変換中の Esc・Enter は変換の操作
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveCommentEdit(cm, box)();
        // Esc はダイアログを閉じずに編集だけやめる
        if (e.key === 'Escape') { e.preventDefault(); D.editComment = null; box.value = ''; rerender(); }
      });
    }
    return h('div', { class: 'comment' }, avatar(cm.by),
      h('div', { class: 'body' },
        h('span', { class: 'who' }, nameOf(cm.by)), h('span', { class: 'when' }, fmtDateTime(cm.at)),
        cm.editedAt ? h('span', { class: 'when', title: `編集: ${fmtDateTime(cm.editedAt)}` }, '(編集済み)') : null,
        mine && !editing ? h('span', { class: 'comment-actions' },
          h('button', { type: 'button', class: 'btn small ghost', disabled: !!D.editComment, title: D.editComment ? '編集中のコメントを保存かキャンセルしてから押してください' : null, onclick: () => { D.editComment = cm.id; rerender(); const b = dlg.querySelector(`[data-draft="cedit-${cm.id}"]`); if (b) b.focus(); } }, '編集'),
          h('button', { type: 'button', class: 'btn small ghost danger', onclick: deleteComment(cm) }, '削除')) : null,
        editing
          ? [box, h('div', { class: 'toolbar' },
            h('button', { type: 'button', class: 'btn primary small', onclick: saveCommentEdit(cm, box) }, '保存'),
            h('button', { type: 'button', class: 'btn small', onclick: () => { D.editComment = null; box.value = ''; rerender(); } }, 'キャンセル'))]
          : h('div', { class: 'pre' }, linkify(cm.body))));
  };

  /* --- チェックリスト --- */
  const clInput = h('input', { type: 'text', placeholder: '項目を追加(Enter で追加)', maxLength: 200, 'data-draft': 'check' });
  const checkNote = (x, to) => x.history.push({ at: nowIso(), by: state.me.id, field: 'チェックリスト', from: '', to });
  const addCheck = guard(async () => {
    const text = clInput.value.trim();
    if (!text) return;
    const item = { id: uid(6), text, done: false, by: state.me.id, at: nowIso() };
    await updateTicket(t.id, (x) => { x.checklist.push(item); checkNote(x, `追加: ${text}`); });
    log('checklist.update', t.key, `追加: ${text}`);
    clInput.value = '';
    rerender();
    const next = dlg.querySelector('.checklist-add input');
    if (next) next.focus();
  });
  clInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCheck(); } });
  // id で対象を探して当てるので、読み直した最新のデータに対して他のメンバーの操作を消さない
  const toggleCheck = (item) => guard(async (e) => {
    const done = e.target.checked;
    await updateTicket(t.id, (x) => {
      const it = x.checklist.find((c) => c.id === item.id);
      if (it) { it.done = done; checkNote(x, `${done ? '完了' : '未完了に戻す'}: ${it.text}`); }
    });
    log('checklist.update', t.key, `${done ? '完了' : '未完了に戻す'}: ${item.text}`);
    rerender();
  });
  const removeCheck = (item) => guard(async () => {
    await updateTicket(t.id, (x) => { x.checklist = x.checklist.filter((c) => c.id !== item.id); checkNote(x, `削除: ${item.text}`); });
    log('checklist.update', t.key, `削除: ${item.text}`);
    rerender();
  });
  const checkDone = t.checklist.filter((x) => x.done).length;

  /* --- サブチケット --- */
  const subs = subTicketsOf(t);
  const subActive = subs.filter((x) => !x.archived);
  const subDone = subActive.filter(isDone).length;
  const subInput = h('input', { type: 'text', placeholder: 'サブチケットのタイトル(Enter で追加)', maxLength: 200, 'data-draft': 'sub' });
  const addSub = guard(async () => {
    const title = subInput.value.trim();
    if (!title) { toast('サブチケットのタイトルを入力してください', true); return; }
    // 親のファイルは書かない(サブの parent に親の id を持たせるだけ)。プロジェクトは親から引き継ぐ
    const s = await createTicket({
      title, type: c.types[0], priority: c.priorities[Math.min(1, c.priorities.length - 1)], assignee: '',
      project: (state.tickets.get(t.id) || t).project, parent: t.id, // 他の人が直前に変えていれば最新の値を使う
    });
    log('relation.add', t.key, `${relKindLabel('child')}: ${s.key}`);
    subInput.value = '';
    rerender();
    const next = dlg.querySelector('.sub-add input');
    if (next) next.focus();
  });
  subInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addSub(); } });
  const parentTicket = t.parent && t.parent !== t.id ? state.tickets.get(t.parent) : null;

  /* --- 関連チケット(サブチケットは上の欄に出すので除く) --- */
  const rels = relationsOf(t).filter((x) => x.kind !== 'child');
  const relKind = select(REL_KINDS, 'relates');
  const listId = `rel-candidates-${t.id}`;
  const relInput = h('input', { type: 'text', placeholder: `キー(例: ${c.key}-12)`, maxLength: 40, 'data-draft': 'rel' });
  relInput.setAttribute('list', listId); // input.list は読み取り専用プロパティなので h() では渡せない
  const candidates = h('datalist', { id: listId }, [...state.tickets.values()]
    .filter((o) => o.id !== t.id && !o.archived)
    .sort((a, b) => (Number(b.num) || 0) - (Number(a.num) || 0))
    .map((o) => h('option', { value: o.key }, o.title)));
  const addRel = guard(async () => {
    const key = relInput.value.trim().split(/\s+/)[0].toUpperCase();
    if (!key) { toast('関連づけるチケットのキーを入力してください', true); return; }
    const o = resolveKey(key);
    if (!o) return;
    if (await addRelation(t, relKind.value, o)) { relInput.value = ''; rerender(); }
  });
  relInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addRel(); } });

  historyBox = h('ul', { class: 'history' });

  /* --- 説明: ふだんはリンク付きで表示し、押すと編集。欄の外を押す・Ctrl+Enter・Esc で保存 --- */
  const descBox = h('div', { class: 'desc' });
  const descView = (desc) => [
    h('div', {
      class: 'desc-view pre' + (desc ? '' : ' empty'), tabIndex: 0, title: 'クリックで編集 (E)',
      onclick: (e) => { if (!e.target.closest('a, button')) startDescEdit(); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); startDescEdit(); } },
    }, h('span', { class: 'edit-pen', 'aria-hidden': 'true' }, penIcon()), desc ? linkify(desc) : '説明を追加…(クリックで編集)'),
    (() => {
      const refs = referencedTickets(desc, t.id);
      const missing = missingKeys(desc);
      return refs.length || missing.length ? h('div', { class: 'refs' },
        refs.length ? [h('span', { class: 'note' }, '参照:'), refs.map((r) => keyLink(r, `${r.key} ${r.title}`))] : null,
        missing.length ? h('span', { class: 'warn', title: 'このキーのチケットはありません。キーの書き間違いか、削除された可能性があります' }, `⚠ 見つからないキー: ${missing.join(', ')}`) : null) : null;
    })(),
  ].filter(Boolean); // replaceChildren は null を「null」という文字にするので落とす
  // 保存後はダイアログ全体を描き直さず、この欄だけ差し替える(閉じるボタンなどを押した瞬間に要素が消えないように)
  const descEditor = () => {
    // data-draft があるので、編集中にダイアログが描き直されても書きかけは引き継がれる
    const ta = h('textarea', { class: 'desc-edit', rows: 8, value: (state.tickets.get(t.id) || t).description, placeholder: `説明を入力。${c.key}-12 のようにキーを書くとリンクになります`, 'data-draft': 'desc' });
    let saving = false;
    const finish = guard(async () => {
      if (saving) return;
      saving = true;
      const v = ta.value;
      try {
        if (v !== (state.tickets.get(t.id) || t).description) {
          await setField(t.id, 'description', v);
          toast('説明を保存しました');
        }
      } catch (e) {
        // 保存できなかったら編集欄を残す(書きかけを消さない)
        saving = false;
        throw e;
      }
      D.descEditing = false;
      if (descBox.isConnected) descBox.replaceChildren(...descView((state.tickets.get(t.id) || t).description));
    });
    // 別のウィンドウに切り替えただけ(ページ自体がフォーカスを失った)のときは保存しない
    ta.addEventListener('blur', () => { if (document.hasFocus() || !dlg.open) finish(); });
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // 変換中の Esc は変換の取り消し
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); }
    });
    return [ta, h('div', { class: 'note' }, '欄の外を押す・Ctrl+Enter・Esc で保存します')];
  };
  const startDescEdit = () => {
    D.descEditing = true;
    descBox.replaceChildren(...descEditor());
    const ta = descBox.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  descBox.replaceChildren(...(D.descEditing ? descEditor() : descView(t.description)));

  /* --- ラベル: 他のチケットで使っているラベルを候補に出し、押すと足す --- */
  const labelInput = h('input', {
    type: 'text', value: t.labels.join(', '),
    onchange: change('labels', (v) => parseLabels(v)),
  });
  const labelSuggest = allLabels().filter((l) => !t.labels.includes(l)).slice(0, 8);
  const addLabel = (l) => guard(async () => {
    // 入力欄を書き換えていればその内容に、そうでなければ保存直前に読み直したラベルに足す(他の人が足した分を消さない)
    const typed = parseLabels(labelInput.value);
    const edited = typed.join(', ') !== t.labels.join(', ');
    const entry = { at: nowIso(), by: state.me.id, field: 'labels' };
    const saved = await updateTicket(t.id, (x) => {
      const next = [...new Set([...(edited ? typed : x.labels), l])];
      entry.from = showValue('labels', x.labels);
      entry.to = showValue('labels', next);
      x.labels = next;
      x.history.push(entry);
    });
    log('ticket.update', saved.key, `${FIELD_LABELS.labels}: ${entry.from} → ${entry.to}`);
    renderMain();
    renderTicketDialog();
  });

  /* --- タイトル: 枠が見えないので、右にペンマークを出して編集できることを示す --- */
  const titleInput = h('input', {
    type: 'text', class: 'title-input', value: t.title, maxLength: 200, title: 'クリックで編集',
    onchange: guard(async (e) => {
      const v = e.target.value.trim();
      if (!v) { e.target.value = t.title; return; }
      await setField(t.id, 'title', v);
    }),
  });
  const titleWrap = h('div', { class: 'title-wrap' }, titleInput, h('button', {
    type: 'button', class: 'edit-pen', title: 'タイトルを編集', tabIndex: -1,
    onclick: () => { titleInput.focus(); titleInput.select(); },
  }, penIcon()));

  dlg.className = 'dlg';
  setDialog(
    h('div', { class: 'dlg-head' },
      parentTicket ? h('span', { class: 'parent-link' }, keyLink(parentTicket, `${parentTicket.key} ${parentTicket.title}`), ' ›')
        : t.parent ? h('span', { class: 'warn', title: '親チケットのファイルがありません。関連チケット欄から親を外すか、付け直してください' }, '⚠ 親チケットが見つかりません') : null,
      h('span', { class: 'key' }, t.key),
      h('button', {
        type: 'button', class: 'btn small ghost', title: 'キーとタイトルをコピー(チャットなどに貼る用)',
        onclick: guard(async () => { await navigator.clipboard.writeText(`${t.key} ${t.title}`); toast(`「${t.key} ${t.title}」をコピーしました`); }),
      }, 'コピー'),
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
        titleWrap,
        h('div', { class: 'section-title' }, '説明'),
        descBox,

        section('checklist', `チェックリスト${t.checklist.length ? ` (${checkDone}/${t.checklist.length})` : ''}`, t.checklist.length,
          h('ul', { class: 'checklist' }, t.checklist.map((item) => h('li', { class: item.done ? 'done' : '' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!item.done, onchange: toggleCheck(item) }), h('span', null, String(item.text ?? ''))),
            h('button', { class: 'btn small danger', title: '削除', onclick: removeCheck(item) }, '削除')))),
          h('div', { class: 'row checklist-add' }, clInput, h('button', { class: 'btn', onclick: addCheck }, '追加')), ['check']),

        section('sub', `サブチケット${subActive.length ? ` (${subDone}/${subActive.length})` : ''}`, subs.length,
        h('ul', { class: 'link-list sub-list' }, subs.map((x) => h('li', { class: x.archived ? 'archived' : '' },
          unreadDot(x),
          h('span', { class: 'name' }, keyLink(x), ' ', x.title, x.archived ? h('span', { class: 'note' }, ' (アーカイブ済み)') : null),
          h('span', { class: 'note nowrap' }, nameOf(x.assignee)),
          select(c.statuses, x.status, async (e) => {
            try { await setField(x.id, 'status', e.target.value, { undo: true }); } catch (err) { fail(err); }
            renderTicketDialog(); // 失敗したときも、保存されている値に戻す
          }, { title: 'ステータス' })))),
        h('div', { class: 'row sub-add' }, subInput, h('button', { class: 'btn', onclick: addSub }, '追加')), ['sub']),

        section('rel', '関連チケット', rels.length,
        h('ul', { class: 'link-list rel-list' }, rels.map((x) => h('li', null,
          h('span', { class: 'chip' }, relKindLabel(x.kind)),
          x.other
            ? h('span', { class: 'name' }, keyLink(x.other), ' ', x.other.title, isDone(x.other) ? h('span', { class: 'note' }, ` (${x.other.status})`) : null)
            : h('span', { class: 'name warn' }, '⚠ 見つかりません(削除されたか、まだ同期されていません)'),
          h('button', {
            class: 'btn small danger',
            onclick: guard(async () => {
              // 親を外すとサブチケットでなくなり、ボード・リストに出るようになるので確かめる
              if (x.kind === 'parent') {
                const p = x.other ? `${x.other.key}「${x.other.title}」` : '親チケット(見つかりません)';
                if (!confirm(`${t.key} の親チケット ${p} を外しますか?\n\n外すと ${t.key} はサブチケットではなくなり、ボードとリストに通常のチケットとして表示されます。親のサブチケットの数からも外れます。`)) return;
              }
              await removeRelation(t, x);
              rerender();
            }),
          }, '削除')))),
        h('div', { class: 'row rel-add' }, relKind, relInput, candidates, h('button', { class: 'btn', onclick: addRel }, '追加')), ['rel']),

        h('div', { class: 'section-title' }, '添付ファイル', h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => picker.click() }, '＋ ファイルを追加'), picker),
        zone,

        section('link', '関連リンク(Box 共有リンクなど)', links.length,
        h('ul', { class: 'link-list' }, links.map((l) => h('li', null,
          h('a', { class: 'name', href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.title || l.url),
          h('button', {
            class: 'btn small danger',
            onclick: guard(async () => {
              await updateTicket(t.id, (x) => {
                x.links = x.links.filter((y) => y.id !== l.id);
                x.history.push({ at: nowIso(), by: state.me.id, field: 'リンク', from: '', to: `削除: ${l.title}` });
              });
              log('link.remove', t.key, l.url);
              rerender();
            }),
          }, '削除')))),
        h('div', { class: 'row link-add' }, linkTitle, linkUrl, h('button', { class: 'btn', onclick: addLink }, '追加')), ['linkTitle', 'linkUrl']),

        h('div', { class: 'section-title' }, `コメント (${t.comments.length})`),
        t.comments.filter((cm) => cm && typeof cm === 'object').map(commentView),
        commentBox,
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: addComment }, 'コメントする')),

        h('details', null, h('summary', { class: 'section-title' }, '変更履歴'), historyBox)),

      h('div', { class: 'ticket-side' },
        h('label', null, 'ステータス'), select(c.statuses, t.status, guard((e) => setField(t.id, 'status', e.target.value, { undo: true }))),
        h('label', null, '担当者'), select(assigneeOptions(), t.assignee || '', change('assignee')),
        t.assignee !== state.me.id ? h('button', {
          type: 'button', class: 'btn small assign-me',
          onclick: guard(async () => { await setField(t.id, 'assignee', state.me.id); renderTicketDialog(); }),
        }, '自分に割り当て') : null,
        h('label', null, '種別'), select(c.types, t.type, change('type')),
        h('label', null, '優先度'), select(c.priorities, t.priority, change('priority')),
        h('label', null, '期限'), h('input', { type: 'date', value: t.due || '', onchange: change('due') }),
        activeProjects().length || t.project ? [h('label', null, 'プロジェクト'), select([['', '(なし)'], ...activeProjects()], t.project, change('project'))] : null,
        h('label', null, 'ラベル(カンマ区切り)'),
        labelInput,
        labelSuggest.length ? h('div', { class: 'label-suggest' }, h('span', { class: 'note' }, '候補:'),
          // mousedown で入力欄のフォーカスを外さない(外すと書きかけの内容が先に保存され、二重に書き込むため)
          labelSuggest.map((l) => h('button', { type: 'button', class: 'chip label', title: `「${l}」を追加`, onmousedown: (e) => e.preventDefault(), onclick: addLabel(l) }, `＋${l}`))) : null,
        h('div', { class: 'side-meta' },
          h('div', null, `報告者: ${nameOf(t.reporter)}`),
          h('div', null, `作成: ${fmtDateTime(t.createdAt)}`),
          h('div', null, `更新: ${fmtDateTime(t.updatedAt)} (${nameOf(t.updatedBy)})`)))));

  dlg.dataset.ticket = t.id;
  for (const el of dlg.querySelectorAll('[data-draft]')) if (drafts[el.dataset.draft]) el.value = drafts[el.dataset.draft];
  refreshHistory();
  loadFiles();
  dlg.scrollTop = scroll[0];
  const newMain = dlg.querySelector('.ticket-main');
  if (newMain) newMain.scrollTop = scroll[1];
}

dlg.addEventListener('close', () => { placeToast(); state.openId = null; dlg.dataset.ticket = ''; state.detail = { id: null, open: new Set(), descEditing: false, editComment: null }; });
/** ダイアログを閉じる前に、編集中の説明を blur させて保存を走らせる(ブラウザによっては閉じても blur が起きないため) */
function flushDialogEdits() {
  const a = document.activeElement;
  if (a && dlg.contains(a) && a.classList.contains('desc-edit')) a.blur();
}
dlg.addEventListener('cancel', flushDialogEdits);
dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) { flushDialogEdits(); dlg.close(); } });

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
  state.dirs = { tickets: await sub('tickets'), attachments: await sub('attachments'), users: await sub('users'), logs: await sub('logs'), templates: await sub('templates') };
  if (!(await loadConfig())) await writeJson(root, 'config.json', state.config);
  await registerUser();
  await loadUsers();
  await loadTemplates();
  await withLock(syncTicketsRaw);
  loadSeen(lsGet('tb.mode') === 'demo' ? '(demo)' : root.name);
  log('access', '', `保存先: ${root.name}`);

  $('gate').hidden = true;
  $('app').hidden = false;
  restoreUi();
  renderChrome();
  await refresh(true);

  const tick = () => { if (!document.hidden) refresh().catch((e) => console.error(e)); };
  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', tick);
}

async function boot() {
  try {
    state.me = lsGet('tb.me');
    // 以前の版で登録した人は、メールアドレスを利用者IDとして使い続ける
    if (state.me && !state.me.id && state.me.email) { state.me = { ...state.me, id: state.me.email }; delete state.me.email; lsSet('tb.me', state.me); }
    if (!state.me || !state.me.id || !state.me.name || !state.me.deviceId) { gateProfile(); return; }

    if (lsGet('tb.mode') === 'demo') { await start(demoFs()); return; }
    const saved = 'showDirectoryPicker' in window ? await idbGet('root').catch(() => null) : null;
    if (saved && (await verifyPermission(saved, false))) { await start(saved); return; }
    gateConnect(saved || null);
  } catch (e) {
    fail(e);
    gateConnect(null);
  }
}

/* ================= キーボードショートカット ================= */

/*
 * 割り当ては利用者ごとの好みなので、このブラウザの localStorage(tb.keys = {操作id: キー})にだけ持つ。
 * 既定と違うものだけを保存し、'' は「割り当てなし」。キーは keyName() の形(英字は大文字)。
 * 操作を足すときは SHORTCUT_ACTIONS に足す(設定画面とヘルプの一覧は、ここから作る)。
 */
const KEYS_STORE = 'tb.keys';
const inListView = () => state.view === 'board' || state.view === 'list';
const goView = (id) => { state.view = id; renderChrome(); renderMain(); };

/**
 * scope: 'dialog' はダイアログが開いているときだけ、それ以外はダイアログが閉じているときだけ動く。
 * when(a): 動かせる状況か(a はフォーカスのある要素)。false のときはキーをブラウザに任せる
 */
const SHORTCUT_ACTIONS = [
  { id: 'create', label: 'チケット作成', def: 'C', run: () => openCreateDialog() },
  {
    id: 'search', label: '検索欄へ移動', def: '/', run: () => {
      if (!inListView()) goView('board');
      const q = $('filters').querySelector('input[type=search]');
      if (q) q.focus();
    },
  },
  { id: 'next', label: '次のチケットを選ぶ(ボード・リスト)', def: 'J', when: inListView, run: () => moveCursor(1) },
  { id: 'prev', label: '前のチケットを選ぶ(ボード・リスト)', def: 'K', when: inListView, run: () => moveCursor(-1) },
  {
    id: 'open', label: '選んだチケットを開く(ボード・リスト)', def: 'Enter',
    // ボタン・リンクにフォーカスがあるときの Enter は、そちらを押す操作に譲る
    when: (a) => inListView() && state.cursor && !(a && /^(BUTTON|A)$/.test(a.tagName))
      && !!$('main').querySelector(`[data-id="${CSS.escape(state.cursor)}"]`),
    run: () => openTicket(state.cursor),
  },
  {
    id: 'editDesc', label: '説明を編集(チケットの詳細で)', def: 'E', scope: 'dialog',
    when: () => !!(state.openId && dlg.querySelector('.desc-view')),
    run: () => dlg.querySelector('.desc-view').click(),
  },
  ...VIEWS.map(([id, label], i) => ({ id: `view.${id}`, label: `「${label}」画面へ`, def: String(i + 1), run: () => goView(id) })),
  { id: 'refresh', label: '今すぐ再読み込み', def: 'R', run: guard(() => refresh(true)) },
  { id: 'unread', label: '新着のみ表示(新着があるとき)', def: 'N', when: () => !$('btnUnread').hidden, run: () => $('btnUnread').click() },
  { id: 'clearFilters', label: '検索・絞り込みを解除(ボード・リスト)', def: '', when: () => inListView() && isFiltering(), run: () => clearFilters() },
  { id: 'help', label: 'ショートカットの一覧', def: '?', run: () => openHelp() },
];

/** 変更できないもの(入力欄の中でも動く) */
const FIXED_SHORTCUTS = [
  ['Ctrl+Enter', 'コメントを送信・説明を保存'],
  ['Esc', 'ダイアログを閉じる(編集中は編集を終える)'],
];

/** 単体では押されても無視するキー(修飾キーそのもの・IME の切り替えなど。Shift を押してから ? を押す、などのため) */
const IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock',
  'Process', 'Unidentified', 'Dead', 'Compose', 'KanaMode', 'KanjiMode', 'Convert', 'NonConvert', 'HiraganaKatakana', 'Hankaku', 'Zenkaku', 'Romaji', 'Eisu']);
/** 割り当てられないキー(フォーカス移動・ダイアログを閉じる・ブラウザの機能キー) */
const isReservedKey = (k) => ['Escape', 'Tab', ' ', 'ContextMenu', 'Backspace'].includes(k) || /^F\d+$/.test(k);

/** キーの名前(英字は大文字にそろえる。Shift の有無は区別しない) */
const keyName = (e) => (e.key.length === 1 ? e.key.toUpperCase() : e.key);

const keyLabel = (k) => k || 'なし';

/** 今の割り当て {操作id: キー}('' は割り当てなし) */
function shortcutKeys() {
  const saved = lsGet(KEYS_STORE);
  const obj = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(SHORTCUT_ACTIONS.map((x) => [x.id, Object.hasOwn(obj, x.id) ? String(obj[x.id]) : x.def]));
}

/** 割り当てを保存する(既定と同じものは保存しない) */
function saveShortcutKeys(keys) {
  const diff = Object.fromEntries(SHORTCUT_ACTIONS.filter((x) => keys[x.id] !== x.def).map((x) => [x.id, keys[x.id]]));
  lsSet(KEYS_STORE, Object.keys(diff).length ? diff : null);
  updateShortcutTitles();
}

/** ボタンのツールチップに今のキーを出す */
function updateShortcutTitles() {
  const k = shortcutKeys().create;
  $('btnCreate').title = k ? `チケット作成 (${k})` : 'チケット作成';
}

function openHelp() {
  state.openId = null;
  dlg.className = 'dlg narrow';
  const keys = shortcutKeys();
  const rows = [
    ...SHORTCUT_ACTIONS.filter((x) => keys[x.id]).map((x) => [keys[x.id], x.label]),
    ...FIXED_SHORTCUTS,
  ];
  setDialog(
    h('div', { class: 'dlg-head' }, h('strong', null, 'キーボードショートカット'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' },
      h('table', { class: 'shortcuts' }, h('tbody', null, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))))),
      h('div', { class: 'note' }, '入力欄にカーソルがあるときは、Ctrl+Enter と Esc 以外は反応しません。'),
      h('div', { class: 'note' }, 'キーの割り当ては「設定」画面の「キーボードショートカット」で変えられます。')));
  if (!dlg.open) dlg.showModal();
}

/** 設定画面: ショートカットの割り当て(このブラウザだけ) */
function shortcutPanel() {
  const panel = h('div', { class: 'panel', 'data-testid': 'shortcut-panel' });
  let stopCapture = null;
  const render = () => {
    if (stopCapture) stopCapture();
    const keys = shortcutKeys();
    const assign = (id, k) => {
      const next = { ...keys };
      const other = k && SHORTCUT_ACTIONS.find((x) => x.id !== id && next[x.id] === k);
      if (other && !confirm(`「${k}」は「${other.label}」に割り当てられています。\n「${other.label}」の割り当てを外して、こちらに割り当てますか?`)) return;
      if (other) next[other.id] = '';
      next[id] = k;
      saveShortcutKeys(next);
      render();
    };
    // 「変更」を押したら、次に押されたキーを取り込む(Esc で取り消し)
    const capture = (x, btn) => {
      if (stopCapture) stopCapture();
      btn.textContent = 'キーを押す…';
      btn.title = '割り当てるキーを押してください(Esc で取り消し)';
      btn.classList.add('primary');
      const onKey = (e) => {
        // 設定画面が描き直されて、この欄が無くなっていたら取り込みをやめる
        if (!panel.isConnected) { stop(); return; }
        if (e.isComposing || IGNORED_KEYS.has(e.key)) return;
        // 他のショートカットやボタンの操作として動かないよう、ここで止める
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { render(); return; }
        if (e.ctrlKey || e.altKey || e.metaKey) { toast('Ctrl・Alt などを押しながらのキーは使えません。1つのキーを押してください', true); return; }
        if (isReservedKey(e.key)) { toast(`「${e.key === ' ' ? 'スペース' : e.key}」は割り当てられません`, true); return; }
        assign(x.id, keyName(e));
      };
      const stop = () => { window.removeEventListener('keydown', onKey, true); btn.removeEventListener('blur', onBlur); stopCapture = null; };
      const onBlur = () => { stop(); btn.textContent = '変更'; btn.title = ''; btn.classList.remove('primary'); };
      window.addEventListener('keydown', onKey, true);
      btn.addEventListener('blur', onBlur);
      stopCapture = stop;
    };
    panel.replaceChildren(
      h('h2', null, 'キーボードショートカット'),
      h('div', { class: 'note' }, 'このブラウザだけに保存されます(他のメンバーには影響しません)。入力欄にカーソルがあるときは反応しません。'),
      h('table', { class: 'shortcuts shortcut-edit' }, h('tbody', null,
        SHORTCUT_ACTIONS.map((x) => {
          const btn = h('button', { type: 'button', class: 'btn small', 'data-action': x.id }, '変更');
          btn.addEventListener('click', () => capture(x, btn));
          return h('tr', null,
            h('td', null, x.label),
            h('td', { class: 'nowrap' }, h('kbd', { class: keys[x.id] ? '' : 'none' }, keyLabel(keys[x.id]))),
            h('td', { class: 'nowrap' }, btn,
              h('button', { type: 'button', class: 'btn small ghost', disabled: !keys[x.id], onclick: () => assign(x.id, '') }, 'なし')));
        }),
        FIXED_SHORTCUTS.map(([k, d]) => h('tr', null, h('td', null, d), h('td', { class: 'nowrap' }, h('kbd', null, k)), h('td', { class: 'note' }, '変更できません'))))),
      h('div', { class: 'toolbar' }, h('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          if (!confirm('ショートカットをすべて既定の割り当てに戻しますか?')) return;
          saveShortcutKeys(Object.fromEntries(SHORTCUT_ACTIONS.map((x) => [x.id, x.def])));
          render();
          toast('ショートカットを既定に戻しました');
        },
      }, '既定に戻す')));
  };
  render();
  return panel;
}

/** J/K でボード・リストのチケットを順に選ぶ(ボードは列ごとに上から) */
function moveCursor(step) {
  const els = [...$('main').querySelectorAll('[data-id]')];
  if (!els.length) return;
  let i = els.findIndex((el) => el.dataset.id === state.cursor);
  i = i < 0 ? (step > 0 ? 0 : els.length - 1) : Math.min(els.length - 1, Math.max(0, i + step));
  state.cursor = els[i].dataset.id;
  for (const el of els) el.classList.toggle('cursor', el === els[i]);
  els[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if ($('app').hidden || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  const k = keyName(e);
  // ボタン・リンクにフォーカスがあるときの Enter は、そちらを押す操作に譲る
  if (k === 'Enter' && a && /^(BUTTON|A)$/.test(a.tagName)) return;
  const keys = shortcutKeys();
  const scope = dlg.open ? 'dialog' : 'main';
  const x = SHORTCUT_ACTIONS.find((y) => keys[y.id] === k && (y.scope || 'main') === scope);
  if (!x || (x.when && !x.when(a))) return;
  // 押しっぱなしで連続して動いてよいのは、チケットを順に選ぶ操作だけ
  if (e.repeat && x.id !== 'next' && x.id !== 'prev') { e.preventDefault(); return; }
  e.preventDefault();
  x.run();
});

updateShortcutTitles();
$('btnCreate').addEventListener('click', openCreateDialog);
$('btnSync').addEventListener('click', guard(() => refresh(true)));
$('btnUnread').addEventListener('click', () => {
  state.filters.unread = true;
  if (state.view !== 'board' && state.view !== 'list') state.view = 'board';
  renderChrome();
  renderMain();
});
boot();

})();
