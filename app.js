/*
 * 문서 뷰어 — 휴대폰 웹 앱
 * PC 뷰어와 구글 드라이브 '앱 전용 숨김 폴더'(appDataFolder)로 읽던 위치·북마크를 맞춘다.
 *   library.json : {version, books: {책ID: {title, chars, pos, pct, device, updated, bookmarks, bm_updated}}}
 * 책 본문은 어디에도 올리지 않는다(저작권). 휴대폰에 있는 txt 를 한 번 고르면 이 휴대폰 안(IndexedDB)에만 저장한다.
 * 책ID = 본문(줄바꿈 \n 으로 맞춘 글) UTF-8 SHA-1 앞 16자리 — PC 와 같은 방법으로 읽어 같은 ID 가 나온다.
 * 위치는 그 글의 UTF-16 글자 번호(자바스크립트 문자열 번호 = PC Qt 글자 번호).
 * 위치·북마크는 '마지막으로 바꾼 쪽'(updated 밀리초)이 이긴다. 받은 것 뒤에 한 일은 늘 그보다 나중 시각으로 적는다.
 */
(() => {
"use strict";

const CFG = Object.assign({}, window.NV_CONFIG || {}, window.NV_TEST || {});
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const API = CFG.api || "https://www.googleapis.com/drive/v3";
const UPLOAD = CFG.upload || "https://www.googleapis.com/upload/drive/v3";
const PUSH_DELAY = CFG.pushDelay ?? 4000;
const POLL = CFG.poll ?? 120000;
const CHUNK_LINES = 150;

const $ = (s) => document.querySelector(s);
const now = () => Date.now();

// ------------------------------------------------------------ 저장(이 휴대폰)

const ls = {
  get(k, d) { try { const v = localStorage.getItem("nv." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem("nv." + k, JSON.stringify(v)); },
};

const DEFAULT_STYLE = { fs: 18, lh: 1.8, ls: 0, mg: 20, theme: "light", font: "sans", zone: 30 };
let style = Object.assign({}, DEFAULT_STYLE, ls.get("style", {}));
// books: {책ID: {pos, updated, bookmarks, bm_updated, dirty}}, lib: 마지막으로 받은 library.json(오프라인 목록용)
let state = Object.assign({ books: {}, lib: null, lastSync: 0 }, ls.get("state", {}));
const saveState = () => ls.set("state", state);

const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("nv", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("texts");
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = db.transaction("texts").objectStore("texts").get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  async put(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("texts", "readwrite");
      t.objectStore("texts").put(v, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  async del(k) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("texts", "readwrite");
      t.objectStore("texts").delete(k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  async keys() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = db.transaction("texts").objectStore("texts").getAllKeys();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
};

// ------------------------------------------------------------ 구글 로그인 (Google Identity Services)

class NeedAuth extends Error {}
let tok = ls.get("token", null);         // {token, exp}
let tokenClient = null;
let tokenWaiters = [];

function tokenValid() { return CFG.testToken || (tok && tok.exp > now() + 60000); }

function loadGis() {
  if (CFG.testToken || !CFG.clientId) return Promise.resolve();
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  });
}

function initTokenClient() {
  if (tokenClient || CFG.testToken || !window.google?.accounts?.oauth2) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: SCOPE,
    callback: (r) => {
      const ws = tokenWaiters; tokenWaiters = [];
      if (r.error) { ws.forEach((w) => w.rej(new NeedAuth(r.error))); return; }
      tok = { token: r.access_token, exp: now() + (r.expires_in || 3600) * 1000 };
      ls.set("token", tok); ls.set("consented", true);
      ws.forEach((w) => w.res(tok.token));
      showAccount();
    },
    error_callback: (e) => {
      const ws = tokenWaiters; tokenWaiters = [];
      ws.forEach((w) => w.rej(new NeedAuth(e?.type || "popup")));
    },
  });
}

/** 버튼 누름(사용자 동작) 안에서 바로 불러야 팝업이 막히지 않는다. */
function connect() {
  if (!CFG.clientId && !CFG.testToken) { toast("config.js 에 clientId 를 넣어 주세요."); return; }
  if (!tokenClient) { initTokenClient(); }
  if (!tokenClient) { toast("구글 로그인을 불러오지 못했어요. 인터넷을 확인해 주세요."); return; }
  const p = new Promise((res, rej) => tokenWaiters.push({ res, rej }));
  tokenClient.requestAccessToken({ prompt: ls.get("consented", false) ? "" : "consent" });
  p.then(() => syncAll("connect")).catch(() => toast("구글 연결이 취소됐어요."));
}

function token() {
  if (CFG.testToken) return CFG.testToken;
  if (tokenValid()) return tok.token;
  throw new NeedAuth("token");
}

// ------------------------------------------------------------ 드라이브

async function api(url, opt = {}) {
  const r = await fetch(url, Object.assign({}, opt, {
    headers: Object.assign({ Authorization: "Bearer " + token() }, opt.headers || {}),
  }));
  if (r.status === 401) { tok = null; ls.set("token", null); showAccount(); throw new NeedAuth("401"); }
  if (!r.ok) throw new Error("드라이브 오류 " + r.status);
  return r;
}

async function findFile(name) {
  const q = new URLSearchParams({ spaces: "appDataFolder", q: `name = '${name}' and trashed = false`,
                                  fields: "files(id,name,modifiedTime)", pageSize: "10" });
  const j = await (await api(`${API}/files?${q}`)).json();
  return (j.files || [])[0] || null;
}

async function readLibrary() {
  const f = await findFile("library.json");
  if (!f) return { file: null, lib: { version: 1, books: {} } };
  const lib = await (await api(`${API}/files/${f.id}?alt=media`)).json();
  lib.books = lib.books || {};
  return { file: f, lib };
}

async function writeLibrary(file, lib) {
  const body = JSON.stringify(lib);
  if (file) {
    await api(`${UPLOAD}/files/${file.id}?uploadType=media`, { method: "PATCH", body,
      headers: { "Content-Type": "application/json" } });
  } else {
    const b = "nv" + Math.random().toString(16).slice(2);
    const meta = JSON.stringify({ name: "library.json", parents: ["appDataFolder"] });
    const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\n` +
                      `Content-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", body: multipart,
      headers: { "Content-Type": "multipart/related; boundary=" + b } });
  }
}

// ------------------------------------------------------------ 휴대폰의 txt 읽기 (PC 와 똑같이)

/** BOM → UTF-8 → CP949(euc-kr) 순서. PC 뷰어 decode_bytes 와 같은 규칙. 줄바꿈은 \n 으로. */
function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  let text;
  if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder("utf-16le").decode(b);
  else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder("utf-16be").decode(b);
  else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(b); }   // BOM 은 알아서 뺀다
    catch { text = new TextDecoder("euc-kr").decode(b); }                // 웹 표준 euc-kr = CP949
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function bookIdOf(text) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ------------------------------------------------------------ 동기화

let syncing = null;
let pushTimer = 0;

function localOf(bid, e) {
  // 처음 보는 책이면 드라이브 값으로 시작한다
  if (!state.books[bid]) {
    state.books[bid] = { pos: e?.pos || 0, updated: e?.updated || 0, bookmarks: e?.bookmarks || [],
                         bm_updated: e?.bm_updated || 0, dirty: false };
  }
  return state.books[bid];
}

/** library.json 하나로 모든 책을 맞춘다. 돌려주는 값: {책ID: {pos, device}} — 다른 기기에서 더 나중에 읽어 받은 위치 */
function syncAll(reason) {
  if (syncing) return syncing.then(() => syncAll(reason));
  syncing = (async () => {
    const pulled = {};
    try {
      setStatus("동기화 중...");
      const { file, lib } = await readLibrary();
      let changed = false;
      for (const [bid, when] of Object.entries(state.deletes || {})) {   // 서재에서 지운 책
        // 지운 뒤에 다른 기기에서 읽었으면(그쪽이 더 나중) 남긴다
        if (lib.books[bid] && (lib.books[bid].updated || 0) <= when) { delete lib.books[bid]; changed = true; }
      }
      for (const [bid, info] of Object.entries(state.adds || {})) {      // 휴대폰에서 먼저 연 책
        if (!lib.books[bid]) {
          const st = state.books[bid] || {};
          lib.books[bid] = { title: info.title, chars: info.chars, pos: st.pos || 0, device: "phone",
                             updated: st.updated || now(), bookmarks: st.bookmarks || [], bm_updated: st.bm_updated || 0 };
          changed = true;
        }
      }
      for (const [bid, e] of Object.entries(lib.books)) {
        const st = state.books[bid];
        if (!st) continue;
        if ((st.updated || 0) > (e.updated || 0)) {
          Object.assign(e, { pos: st.pos, updated: st.updated, device: "phone",
                             pct: Math.round(st.pos * 1000 / Math.max(1, e.chars)) / 10 });
          changed = true;
        } else if ((e.updated || 0) > (st.updated || 0)) {
          pulled[bid] = { pos: e.pos, device: e.device, before: st.pos };
          st.pos = e.pos; st.updated = e.updated;
        }
        if ((st.bm_updated || 0) > (e.bm_updated || 0)) {
          e.bookmarks = st.bookmarks; e.bm_updated = st.bm_updated; changed = true;
        } else if ((e.bm_updated || 0) > (st.bm_updated || 0)) {
          st.bookmarks = e.bookmarks || []; st.bm_updated = e.bm_updated;
          if (pulled[bid]) pulled[bid].marks = true; else pulled[bid] = { marks: true };
        }
      }
      if (changed) await writeLibrary(file, lib);
      state.adds = {};
      state.deletes = {};
      for (const st of Object.values(state.books)) st.dirty = false;
      state.lib = lib; state.lastSync = now(); saveState();
      setStatus("");
      return pulled;
    } catch (err) {
      if (err instanceof NeedAuth) { showAccount(); setStatus("구글 연결이 필요해요 — 위 버튼을 눌러 주세요."); }
      else setStatus(navigator.onLine ? "동기화 실패: " + err.message : "오프라인 — 연결되면 올려요.");
      return {};
    } finally {
      syncing = null;
      if (!$("#library").hidden) renderLibrary();
    }
  })();
  return syncing;
}

function schedulePush(delay = PUSH_DELAY) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncAll("push").then(applyPulled), delay);
}

function anyDirty() { return Object.values(state.books).some((b) => b.dirty); }

/** 받은 위치가 지금 읽는 책이면 옮기고 되돌리기를 띄운다. */
function applyPulled(pulled) {
  if (!cur) return;
  const p = pulled[cur.bid];
  if (!p) return;
  if (p.marks && !$("#sheet").hidden && sheetKind === "marks") openMarks();
  if (p.pos == null || Math.abs(p.pos - topOffset()) < 3) return;
  const before = topOffset();
  scrollToOffset(p.pos);
  const who = p.device === "pc" ? "PC" : "다른 기기";
  toast(`${who}에서 읽던 위치로 이동했어요 (${pctOf(p.pos)}%)`, "되돌리기", () => {
    scrollToOffset(before).then(() => markRead(topOffset()));
  });
}

// ------------------------------------------------------------ 서재

function ago(t) {
  if (!t) return "";
  const s = Math.max(0, (now() - t) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}

let cachedIds = new Set();

async function renderLibrary() {
  try { cachedIds = new Set(await idb.keys()); } catch { /* 저장소를 못 쓰는 브라우저 */ }
  const lib = state.lib || { books: {} };
  const items = Object.entries(lib.books).map(([bid, e]) => {
    const st = state.books[bid];
    const mine = st && (st.updated || 0) >= (e.updated || 0);
    return { bid, e, pos: mine ? st.pos : e.pos, when: mine ? st.updated : e.updated,
             device: mine ? "phone" : e.device };
  }).sort((a, b) => (b.when || 0) - (a.when || 0));
  const ul = $("#books");
  ul.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.dataset.bid = it.bid;
    const left = document.createElement("div");
    left.className = "grow";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = it.e.title.replace(/\.txt$/i, "");
    const sub = document.createElement("div");
    sub.className = "s";
    sub.textContent = `${it.device === "phone" ? "이 폰" : "PC"} · ${ago(it.when)}` +
                      (cachedIds.has(it.bid) ? "" : " · 처음 열 때 파일 고르기");
    left.append(t, sub);
    const p = document.createElement("div");
    p.className = "p";
    p.textContent = (Math.round(it.pos * 1000 / Math.max(1, it.e.chars)) / 10).toFixed(1) + "%";
    const more = document.createElement("button");
    more.className = "icon more";
    more.textContent = "⋮";
    more.title = "지우기";
    more.addEventListener("click", (ev) => { ev.stopPropagation(); bookMenu(it.bid); });
    li.append(left, p, more);
    li.addEventListener("click", () => openBook(it.bid));
    li.addEventListener("contextmenu", (ev) => { ev.preventDefault(); bookMenu(it.bid); });   // 길게 누르기
    ul.append(li);
  }
  $("#empty").hidden = items.length > 0;
}

/** 책 하나 지우기: 이 휴대폰의 파일만 / 서재에서(드라이브의 위치·북마크까지) */
function bookMenu(bid) {
  const e = (state.lib?.books || {})[bid];
  if (!e) return;
  sheetKind = "book";
  const body = $("#sheet-body");
  body.textContent = "";
  const h = document.createElement("h2");
  h.textContent = e.title.replace(/\.txt$/i, "");
  body.append(h);
  const add = (label, note, fn, danger) => {
    const b = document.createElement("button");
    b.className = "wide" + (danger ? " danger" : "");
    b.textContent = label;
    const n = document.createElement("div");
    n.className = "muted small";
    n.textContent = note;
    b.append(n);
    b.addEventListener("click", fn);
    body.append(b);
  };
  if (cachedIds.has(bid)) {
    add("휴대폰에 저장된 파일만 지우기", "목록·읽던 위치는 남아요. 다시 열 때 파일을 한 번 더 고르면 돼요.", async () => {
      try { await idb.del(bid); } catch { /* 이미 없음 */ }
      closeSheet();
      toast("휴대폰에 저장된 파일을 지웠어요");
      renderLibrary();
    });
  }
  add("서재에서 지우기", "목록·읽던 위치·북마크를 PC 쪽까지 지워요. (PC에서 이 txt를 다시 열면 새로 생겨요)", () => {
    if (!confirm(`'${h.textContent}'을(를) 서재에서 지울까요?\n읽던 위치와 북마크도 지워져요.`)) return;
    removeBook(bid);
    closeSheet();
    toast("서재에서 지웠어요");
  }, true);
  const cancel = document.createElement("button");
  cancel.className = "wide";
  cancel.textContent = "취소";
  cancel.addEventListener("click", closeSheet);
  body.append(cancel);
  $("#sheet").hidden = false;
}

async function removeBook(bid) {
  delete state.lib.books[bid];
  delete state.books[bid];
  if (state.adds) delete state.adds[bid];
  state.deletes = Object.assign(state.deletes || {}, { [bid]: now() });
  saveState();
  try { await idb.del(bid); } catch { /* 이미 없음 */ }
  renderLibrary();
  if (tokenValid()) syncAll("delete");
}

function showAccount() {
  const need = !tokenValid();
  $("#account").hidden = !need;
  $("#account-msg").textContent = ls.get("consented", false)
    ? "구글 연결 시간이 지났어요. 눌러서 다시 연결해 주세요. (읽기는 계속할 수 있어요)"
    : "구글 드라이브에 연결하면 PC에서 읽던 위치·북마크를 맞춰요. (책 파일은 올리지 않아요)";
}

function setStatus(msg) {
  const el = $("#lib-status");
  el.textContent = msg || (state.lastSync ? "마지막 동기화: " + ago(state.lastSync) : "");
}

// ------------------------------------------------------------ 읽기

let cur = null;     // {bid, text, chunks:[{el, start, len}], chars, title}
const textEl = $("#text");

let wantBid = null;        // 파일을 고르면 이 책이어야 한다

async function openBook(bid) {
  const e = (state.lib?.books || {})[bid];
  if (!e) return;
  let text = null;
  try { text = await idb.get(bid); } catch { /* 저장소 없음 */ }
  if (text == null) { askFile(bid, e); return; }
  showBook(bid, text, e);
}

/** 이 휴대폰에 아직 없는 책 — 휴대폰에 있는 같은 txt 를 고르게 한다(버튼 누름 안에서 파일 창을 연다) */
function askFile(bid, e) {
  sheetKind = "file";
  const body = $("#sheet-body");
  body.textContent = "";
  const h = document.createElement("h2");
  h.textContent = e.title.replace(/\.txt$/i, "");
  const p = document.createElement("p");
  p.style.lineHeight = "1.6";
  p.textContent = "이 책은 휴대폰에 아직 없어요. 휴대폰에 있는 같은 txt 파일을 골라 주세요. " +
                  "한 번 고르면 이 앱 안에 저장돼서 다음부터는 바로 열려요. (어디에도 올리지 않아요)";
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = "파일 고르기";
  b.addEventListener("click", () => { wantBid = bid; closeSheet(); $("#file").click(); });
  body.append(h, p, b);
  $("#sheet").hidden = false;
}

async function onFile(f) {
  const want = wantBid;
  wantBid = null;
  let text;
  try { text = decodeBytes(await f.arrayBuffer()); }
  catch (err) { toast("파일을 읽지 못했어요: " + err.message); return; }
  const bid = await bookIdOf(text);
  const lib = state.lib?.books || {};
  if (want && bid !== want) {
    const t = (lib[want]?.title || "").replace(/\.txt$/i, "");
    toast(`고른 파일이 '${t}'와(과) 내용이 달라요. PC에서 연 파일과 같은 파일인지 확인해 주세요.`,
          "새 책으로 열기", () => addAndOpen(bid, text, f.name));
    return;
  }
  await addAndOpen(bid, text, f.name);
}

async function addAndOpen(bid, text, name) {
  try { await idb.put(bid, text); } catch { /* 저장 못 해도 이번에는 읽는다 */ }
  state.lib = state.lib || { version: 1, books: {} };
  let e = state.lib.books[bid];
  if (!e) {   // 처음 보는 책 — 위치·북마크만 드라이브에 등록한다(본문은 안 올린다)
    e = state.lib.books[bid] = { title: name, chars: text.length, pos: 0, device: "phone", updated: 0, bookmarks: [], bm_updated: 0 };
    state.adds = Object.assign(state.adds || {}, { [bid]: { title: name, chars: text.length } });
    saveState();
  }
  showBook(bid, text, e);
}

async function showBook(bid, text, e) {
  $("#library").hidden = true;
  $("#reader").hidden = false;
  $("#loading").hidden = false;
  textEl.textContent = "";
  history.pushState({ view: "reader" }, "");
  await new Promise((r) => setTimeout(r, 0));          // '여는 중' 을 먼저 보여 준다
  $("#loading").hidden = true;
  localOf(bid, e);
  cur = { bid, text, title: e.title, chars: text.length, chunks: [] };
  $("#title").textContent = e.title.replace(/\.txt$/i, "");
  render(text);
  textEl.focus();
  await scrollToOffset(state.books[bid].pos);         // 열기만 한 것은 '읽음'이 아니다
  syncAll("open").then(applyPulled);
}

function closeReader(fromCode) {
  if (cur && !restoring) markRead(topOffset());
  cur = null;
  hideBars();
  closeSheet();
  $("#reader").hidden = true;
  $("#library").hidden = false;
  textEl.textContent = "";
  renderLibrary();
  if (anyDirty()) syncAll("close");
  if (!fromCode && history.state?.view === "reader") history.back();
}

/** 큰 책도 빨리: 줄 묶음마다 글 덩어리 하나. 화면 밖 덩어리는 브라우저가 그리지 않는다(content-visibility). */
function render(text) {
  const frag = document.createDocumentFragment();
  const chunks = [];
  let start = 0;
  let lines = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || (text.charCodeAt(i) === 10 && ++lines >= CHUNK_LINES)) {
      const end = i === text.length ? i : i + 1;
      if (end > from) {
        const el = document.createElement("div");
        el.className = "chunk";
        el.textContent = text.slice(from, end);
        el.dataset.start = String(from);
        chunks.push({ el, start: from, len: end - from });
        frag.append(el);
      }
      from = end; lines = 0;
    }
  }
  if (!chunks.length) {   // 빈 책
    const el = document.createElement("div");
    el.className = "chunk"; el.dataset.start = "0";
    chunks.push({ el, start: 0, len: 0 }); frag.append(el);
  }
  textEl.append(frag);
  cur.chunks = chunks;
  void start;
}

function chunkAt(off) {
  const cs = cur.chunks;
  let lo = 0, hi = cs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cs[mid].start <= off) lo = mid; else hi = mid - 1;
  }
  return cs[lo];
}

function lineHeightPx() { return style.fs * style.lh; }

/** 화면 맨 위 줄의 첫 글자 번호 */
function topOffset() {
  if (!cur) return 0;
  const box = textEl.getBoundingClientRect();
  const x = box.left + style.mg + 2;
  // 위 메뉴·설정 판·알림이 글을 덮고 있어도 글을 찍도록 잠깐 비켜 둔다
  document.body.classList.add("measuring");
  try {
    for (let dy = 2; dy < lineHeightPx() * 3; dy += lineHeightPx() / 3) {
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, box.top + dy) : null;
      const n = r?.startContainer;
      if (n && n.nodeType === 3 && n.parentElement?.classList.contains("chunk")) {
        return Number(n.parentElement.dataset.start) + r.startOffset;
      }
    }
  } finally {
    document.body.classList.remove("measuring");
  }
  // 그래도 못 찾으면 스크롤 비율로 짐작
  const max = textEl.scrollHeight - textEl.clientHeight;
  return Math.round(cur.chars * (max > 0 ? textEl.scrollTop / max : 0));
}

function rectOf(off) {
  const ch = chunkAt(off);
  const node = ch.el.firstChild;
  if (!node) return ch.el.getBoundingClientRect();
  const i = Math.max(0, Math.min(off - ch.start, node.length));
  const r = document.createRange();
  r.setStart(node, i);
  r.setEnd(node, Math.min(i + 1, node.length));
  return r.getClientRects()[0] || r.getBoundingClientRect();
}

let restoreSeq = 0;
let restoring = false;
let restoreTarget = 0;    // 맞추는 중인 글자 번호
let restoredTop = -1;     // 맞추기를 끝낸 스크롤 위치 — 여기서 움직여야 읽은 것

/**
 * 글자 번호가 있는 줄을 화면 맨 위로. 화면 밖 덩어리는 높이를 짐작해 두었다가 보일 때 실제로 그리므로
 * 이동한 뒤 몇 프레임 동안 글이 밀린다 — 목표 줄이 맨 위에 머물 때까지 맞춘다. 그동안의 스크롤은 '읽음'이 아니다.
 */
function scrollToOffset(off) {
  if (!cur) return Promise.resolve();
  off = Math.max(0, Math.min(off | 0, Math.max(0, cur.chars - 1)));
  const seq = ++restoreSeq;
  restoring = true;
  restoreTarget = off;
  chunkAt(off).el.scrollIntoView({ block: "start" });   // 그 덩어리를 실제로 그리게 한다
  const adjust = () => {
    // 목표 줄을 화면 맨 위에 딱 맞춘다(위 줄이 걸쳐 보이면 그 줄이 '맨 위'로 잡힌다)
    const d = rectOf(off).top - textEl.getBoundingClientRect().top;
    if (Math.abs(d) >= 1) textEl.scrollTop += d;
    return Math.abs(d);
  };
  adjust();
  return new Promise((res) => {
    let stable = 0, frames = 0;
    const step = () => {
      if (seq !== restoreSeq) return res();              // 그 사이 다른 이동이 시작됐다
      stable = adjust() < 1 ? stable + 1 : 0;
      if (stable >= 3 || ++frames > 60) {
        restoring = false;
        restoredTop = textEl.scrollTop;
        updatePct();
        res();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

function pctOf(off) { return (Math.round(off * 1000 / Math.max(1, cur?.chars || 1)) / 10).toFixed(1); }

function updatePct() {
  if (!cur) return;
  const off = topOffset();
  $("#pct").textContent = pctOf(off) + "%";
  if (!seeking) $("#seek").value = String(Math.round(off * 1000 / Math.max(1, cur.chars)));
}

/** 이 폰에서 읽은 위치를 적는다(받은 것보다 늘 나중 시각) */
function markRead(off) {
  if (!cur) return;
  const st = state.books[cur.bid];
  if (st.pos === off) return;
  st.pos = off;
  st.updated = Math.max(now(), (st.updated || 0) + 1);
  st.dirty = true;
  saveState();
  schedulePush();
}

let scrollTimer = 0;
textEl.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!cur) return;
    updatePct();
    // 이동 맞추기 중·맞춘 그 자리의 스크롤은 읽은 것이 아니다
    if (!restoring && Math.abs(textEl.scrollTop - restoredTop) >= 1) markRead(topOffset());
  }, 350);
  if (!$("#bottom").hidden) updatePct();
}, { passive: true });

function page(d) {
  textEl.scrollTop += d * Math.max(lineHeightPx(), textEl.clientHeight - lineHeightPx() * 1.2);
}

textEl.addEventListener("click", (ev) => {
  if (String(window.getSelection() || "").length) return;    // 글을 고른 것
  if (!$("#top").hidden) { hideBars(); return; }
  const w = textEl.clientWidth;
  const zone = w * Math.max(10, Math.min(45, style.zone)) / 100;
  const x = ev.clientX - textEl.getBoundingClientRect().left;
  if (x < zone) page(-1);
  else if (x > w - zone) page(1);
  else showBars();
});

document.addEventListener("keydown", (ev) => {
  if (!cur || !$("#sheet").hidden) return;
  if (ev.key === "ArrowRight" || ev.key === "PageDown" || ev.key === " ") { page(1); ev.preventDefault(); }
  if (ev.key === "ArrowLeft" || ev.key === "PageUp") { page(-1); ev.preventDefault(); }
});

function showBars() { $("#top").hidden = false; $("#bottom").hidden = false; updatePct(); }
function hideBars() { $("#top").hidden = true; $("#bottom").hidden = true; }

let seeking = false;
$("#seek").addEventListener("input", () => {
  seeking = true;
  const off = Math.round(cur.chars * Number($("#seek").value) / 1000);
  $("#pct").textContent = pctOf(off) + "%";
});
$("#seek").addEventListener("change", () => {
  const off = Math.round(cur.chars * Number($("#seek").value) / 1000);
  seeking = false;
  scrollToOffset(off).then(() => markRead(topOffset()));
});

// ------------------------------------------------------------ 북마크

let sheetKind = "";

function bookmarks() { return state.books[cur.bid].bookmarks || (state.books[cur.bid].bookmarks = []); }

function marksChanged() {
  const st = state.books[cur.bid];
  st.bm_updated = Math.max(now(), (st.bm_updated || 0) + 1);
  st.dirty = true;
  saveState();
  schedulePush(1000);
}

function addMark() {
  const off = topOffset();
  const text = cur.text.slice(off, off + 40).replace(/\s+/g, " ").trim();
  const d = new Date();
  const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
               `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  bookmarks().push({ pos: off, text, pct: Number(pctOf(off)), time });
  bookmarks().sort((a, b) => a.pos - b.pos);
  marksChanged();
  toast(`북마크 추가 (${pctOf(off)}%)`);
}

function openMarks() {
  sheetKind = "marks";
  bookmarks().sort((a, b) => a.pos - b.pos);   // 다른 기기에서 받은 것도 위치 순서로
  const body = $("#sheet-body");
  body.textContent = "";
  const h = document.createElement("h2");
  h.textContent = "북마크";
  const ul = document.createElement("ul");
  ul.className = "marks";
  bookmarks().forEach((b, i) => {
    const li = document.createElement("li");
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = `${pctOf(b.pos)}%  ${b.name || b.text || ""}`;
    t.addEventListener("click", () => { closeSheet(); scrollToOffset(b.pos).then(() => markRead(topOffset())); });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "삭제";
    del.addEventListener("click", () => { bookmarks().splice(i, 1); marksChanged(); openMarks(); });
    li.append(t, del);
    ul.append(li);
  });
  if (!bookmarks().length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "북마크가 없어요."; ul.append(p); }
  body.append(h, ul);
  $("#sheet").hidden = false;
}

// ------------------------------------------------------------ 글자 설정

function applyStyle() {
  const r = document.documentElement.style;
  r.setProperty("--fs", style.fs + "px");
  r.setProperty("--lh", String(style.lh));
  r.setProperty("--ls", style.ls + "em");
  r.setProperty("--mg", style.mg + "px");
  document.body.className = [style.theme !== "light" ? style.theme : "", style.font === "serif" ? "serif" : ""].join(" ").trim();
  const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]').content = bg || "#f7f7f5";
}

function changeStyle(fn) {
  const keep = cur ? (restoring ? restoreTarget : topOffset()) : 0;   // 맞추는 중이면 그 목표를 그대로
  fn();
  ls.set("style", style);
  applyStyle();
  if (cur) scrollToOffset(keep);
  openStyle();
}

function openStyle() {
  sheetKind = "style";
  const body = $("#sheet-body");
  body.textContent = "";
  const h = document.createElement("h2");
  h.textContent = "글자 설정";
  body.append(h);
  const num = (label, key, step, min, max, fmt) => {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    const minus = document.createElement("button"); minus.textContent = "−";
    const v = document.createElement("span"); v.className = "v"; v.textContent = fmt(style[key]);
    const plus = document.createElement("button"); plus.textContent = "+";
    const set = (d) => changeStyle(() => { style[key] = Math.round(Math.max(min, Math.min(max, style[key] + d)) * 100) / 100; });
    minus.addEventListener("click", () => set(-step));
    plus.addEventListener("click", () => set(step));
    row.append(k, minus, v, plus);
    body.append(row);
  };
  const pick = (label, key, opts) => {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    row.append(k);
    for (const [val, name] of opts) {
      const b = document.createElement("button");
      b.textContent = name;
      if (style[key] === val) b.className = "on";
      b.addEventListener("click", () => changeStyle(() => { style[key] = val; }));
      row.append(b);
    }
    body.append(row);
  };
  num("글자 크기", "fs", 1, 12, 36, (x) => x + "px");
  num("줄 간격", "lh", 0.1, 1.2, 3, (x) => x.toFixed(1));
  num("자간", "ls", 0.02, -0.1, 0.4, (x) => x.toFixed(2));
  num("여백", "mg", 4, 4, 60, (x) => x + "px");
  num("탭 영역", "zone", 5, 10, 45, (x) => x + "%");
  pick("테마", "theme", [["light", "밝게"], ["sepia", "세피아"], ["dark", "어둡게"], ["green", "녹색"]]);
  pick("글꼴", "font", [["sans", "고딕"], ["serif", "명조"]]);
  const reset = document.createElement("button");
  reset.textContent = "기본값으로";
  reset.addEventListener("click", () => changeStyle(() => { style = Object.assign({}, DEFAULT_STYLE); }));
  body.append(reset);
  $("#sheet").hidden = false;
}

function closeSheet() { $("#sheet").hidden = true; sheetKind = ""; }
$("#sheet").addEventListener("click", (ev) => { if (ev.target.id === "sheet") closeSheet(); });

// ------------------------------------------------------------ 알림

let toastTimer = 0;
function toast(msg, btn, fn) {
  $("#toast-msg").textContent = msg;
  const b = $("#toast-btn");
  b.hidden = !btn;
  b.textContent = btn || "";
  b.onclick = () => { $("#toast").hidden = true; fn && fn(); };
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, btn ? 8000 : 2500);
}

// ------------------------------------------------------------ 시작

$("#btn-connect").addEventListener("click", connect);
$("#btn-add").addEventListener("click", () => { wantBid = null; $("#file").click(); });
$("#file").addEventListener("change", () => {
  const f = $("#file").files[0];
  $("#file").value = "";
  if (f) onFile(f);
});
$("#btn-sync").addEventListener("click", () => {
  if (!tokenValid()) { connect(); return; }
  syncAll("manual").then((p) => { applyPulled(p); toast("동기화했어요"); });
});
$("#btn-back").addEventListener("click", () => closeReader(false));
$("#btn-mark").addEventListener("click", addMark);
$("#btn-marks").addEventListener("click", openMarks);
$("#btn-style").addEventListener("click", openStyle);
window.addEventListener("popstate", () => { if (cur) closeReader(true); });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (cur && !restoring) markRead(topOffset());
    if (anyDirty() && tokenValid()) { clearTimeout(pushTimer); syncAll("hide"); }
  } else if (tokenValid()) {
    syncAll("show").then(applyPulled);
  } else {
    showAccount();
  }
});
window.addEventListener("online", () => { if (tokenValid()) syncAll("online").then(applyPulled); });
setInterval(() => { if (document.visibilityState === "visible" && tokenValid()) syncAll("poll").then(applyPulled); }, POLL);

// 시험·문제 확인용
window.NV = { syncAll, topOffset, scrollToOffset, state: () => state, cur: () => cur, page, style: () => style,
              show: () => syncAll("show").then(applyPulled), restoring: () => restoring, bookIdOf, decodeBytes,
              removeBook };

applyStyle();
showAccount();
renderLibrary();
setStatus("");
loadGis().then(() => {
  initTokenClient();
  if (tokenValid()) syncAll("start");
});
if ("serviceWorker" in navigator && location.protocol !== "file:" && !CFG.noServiceWorker) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
})();
