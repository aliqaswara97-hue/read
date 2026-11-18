import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage,
  normalizeMessageContent, getContentType, fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import UI from "./ui.html";

const DATA = process.argv[2] || "./data";
const PORT = Number(process.argv[3] || 3000);
const TOKEN = process.argv[4] || "dev";
const logger = pino({ level: "silent" });
process.on("uncaughtException", (e) => console.log("خطأ:", e?.message));
process.on("unhandledRejection", (e) => console.log("خطأ:", e?.message || e));

const SKIP = new Set(["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo",
  "reactionMessage", "encReactionMessage", "pollUpdateMessage", "keepInChatMessage"]);
const MEDIA_RE = /^(image|video|audio|document|sticker)Message$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf" };
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4",
  ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", pdf: "application/pdf" };
const extOf = (m = "") => EXT[m.split(";")[0]] || "bin";

const isGroup = (j) => j.endsWith("@g.us") || j === "status@broadcast";
fs.mkdirSync(DATA, { recursive: true });
if (process.argv[5]) process.env.TZ = process.argv[5];
const SETTINGS_FILE = path.join(DATA, "settings.json");
const settings = { status: true };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))); } catch {}

const accounts = {};
let version;

// ---------- التخزين والفهرسة ----------
function makeAccount(id) {
  const dir = path.join(DATA, id);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  const A = { id, dir, status: "connecting", linked: false, fails: 0, timer: null, logs: [],
    stats: { open: null, close: null, closeCode: null, reconnects: 0, lastMsg: null, lastDel: null, lastEvent: null, dels: 0 }, qr: null, sock: null, me: null,
    byChat: new Map(), byId: new Map(), queue: [], dirty: new Set(), names: {}, seen: new Set(), total: 0,
    logFile: path.join(dir, "messages.jsonl"), namesFile: path.join(dir, "names.json") };
  try { A.names = JSON.parse(fs.readFileSync(A.namesFile, "utf8")); } catch {}
  if (fs.existsSync(A.logFile)) {
    for (const line of fs.readFileSync(A.logFile, "utf8").split("\n")) {
      if (!line) continue;
      try { const o = JSON.parse(line); o.ev ? applyEvent(A, o) : index(A, o); } catch {}
    }
  }
  console.log(`[${id}] رسائل محفوظة: ${A.total}`);
  return A;
}

function index(A, rec) {
  if (A.seen.has(rec.id)) return false;
  A.seen.add(rec.id);
  A.byId.set(rec.id, rec);
  A.total++;
  let arr = A.byChat.get(rec.chat);
  if (!arr) A.byChat.set(rec.chat, (arr = []));
  arr.push(rec);
  A.dirty.add(rec.chat);
  if (!rec.fromMe && rec.name && !isGroup(rec.chat) && !A.names[rec.chat]) A.names[rec.chat] = rec.name;
  return true;
}

function sorted(A, jid) {
  const arr = A.byChat.get(jid) || [];
  if (A.dirty.has(jid)) {
    arr.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    A.dirty.delete(jid);
  }
  return arr;
}

function setName(A, id, n) {
  if (!id || !n || id.startsWith("status@")) return;
  if (A.names[id] === n) return;
  A.names[id] = n;
  clearTimeout(A.nt);
  A.nt = setTimeout(() => fs.writeFile(A.namesFile, JSON.stringify(A.names), () => {}), 2000);
}

const dn = (A, jid) => jid === "status@broadcast" ? "الحالات" : A.names[jid] || (isGroup(jid) ? "مجموعة" : "+" + jid.split("@")[0].split(":")[0]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsOf = (m) => { const t = m.messageTimestamp; return t && typeof t === "object" ? (t.toNumber ? t.toNumber() : t.low) : Number(t || 0); };

// أحداث الحذف والوسائط تُضاف كسطور منفصلة في الملف (لا يُعدَّل أو يُحذف أي سطر قديم)
function alog(A, t) {
  A.logs.push(new Date().toISOString().slice(11, 19) + " " + t);
  if (A.logs.length > 80) A.logs.shift();
  console.log(`[${A.id}] ${t}`);
}

function applyEvent(A, e) {
  if (e.ev === "media") { const r = A.byId.get(e.id); if (r) r.media = e.media; return; }
  if (e.ev === "edit") { const r = A.byId.get(e.id); if (r) (r.edits ||= []).push({ text: e.text, at: e.at }); return; }
  if (e.ev === "del") {
    let r = A.byId.get(e.id);
    if (!r) {
      if (!e.chat || e.me) return;
      r = { id: e.id, chat: e.chat, sender: e.sender || e.chat, fromMe: !!e.fromMe, name: null, time: e.at,
        type: "deletedPlaceholder", text: "", media: null, mime: null, fileName: null, eph: false, thumb: null, q: null, pre: !!e.pre };
      index(A, r);
    }
    if (!r.del) { r.del = e.at; r.delMe = !!e.me; }
  }
}

function markDeleted(A, id, chat, fromMe, sender, ts, pre, me) {
  const old = A.byId.get(id);
  if (old?.del) return;
  if (!old && me) return;
  const e = { ev: "del", id, chat, sender: sender || chat, fromMe: !!fromMe,
    at: new Date((ts || Date.now() / 1000) * 1000).toISOString(), pre: !!pre, me: !!me };
  applyEvent(A, e);
  fs.appendFileSync(A.logFile, JSON.stringify(e) + "\n");
  A.stats.lastDel = e.at; A.stats.dels++;
  alog(A, `🚫 ${me ? "حذف من الهاتف" : "حذف للجميع"} (${old ? "كانت محفوظة" : "غير محفوظة"})`);
}

function addEdit(A, id, text, ts) {
  const r = A.byId.get(id);
  if (!r || r.text === text || r.edits?.some((x) => x.text === text)) return;
  const e = { ev: "edit", id, text, at: new Date((ts || Date.now() / 1000) * 1000).toISOString() };
  applyEvent(A, e);
  fs.appendFileSync(A.logFile, JSON.stringify(e) + "\n");
  alog(A, "✏️ تعديل رسالة محفوظ");
}

function isRevoke(A, msg) {
  const p = normalizeMessageContent(msg.message)?.protocolMessage;
  if (!p || !(((p.type ?? 0) === 0) || p.type === "REVOKE") || !p.key?.id) return false;
  markDeleted(A, p.key.id, p.key.remoteJid || msg.key.remoteJid, p.key.fromMe ?? msg.key.fromMe,
    p.key.participant || msg.key.participant, tsOf(msg), false);
  return true;
}

async function fetchMedia(A, rec, msg, reup) {
  try {
    const buf = await downloadMediaMessage(msg, "buffer", {}, reup ? { logger, reuploadRequest: A.sock.updateMediaMessage } : { logger });
    const file = `${rec.id.replace(/\W/g, "")}.${extOf(rec.mime)}`;
    fs.writeFileSync(path.join(A.dir, "media", file), buf);
    rec.media = file;
    fs.appendFileSync(A.logFile, JSON.stringify({ ev: "media", id: rec.id, media: file }) + "\n");
    return true;
  } catch { return false; }
}

// تنزيل وسائط السجل القديم في الخلفية (قد تفشل إن انتهت صلاحيتها على خوادم واتساب)
async function pump(A) {
  if (A.pumping) return;
  A.pumping = true;
  while (A.queue.length) {
    const { rec, msg } = A.queue.shift();
    await fetchMedia(A, rec, msg, false);
    await sleep(250);
  }
  A.pumping = false;
}

function quoted(body) {
  const ci = body.contextInfo;
  const qm = ci?.quotedMessage && normalizeMessageContent(ci.quotedMessage);
  if (!qm) return null;
  const qt = getContentType(qm);
  const qb = typeof qm[qt] === "object" && qm[qt] ? qm[qt] : {};
  return { text: (qm.conversation || qb.text || qb.caption || "").slice(0, 200), type: qt, who: ci.participant || null };
}

function extract(msg) {
  const content = normalizeMessageContent(msg.message);
  const jid = msg.key?.remoteJid;
  if (!content || !jid || (jid === "status@broadcast" && !settings.status)) return null;
  const type = getContentType(content);
  if (!type || SKIP.has(type)) return null;
  const body = typeof content[type] === "object" && content[type] ? content[type] : {};
  const t = msg.messageTimestamp;
  const ts = t && typeof t === "object" ? (t.toNumber ? t.toNumber() : t.low) : Number(t || 0);
  return {
    id: msg.key.id, chat: jid, sender: msg.key.participant || jid, fromMe: !!msg.key.fromMe,
    name: msg.pushName || null, time: new Date((ts || Date.now() / 1000) * 1000).toISOString(),
    type, text: content.conversation || body.text || body.caption || body.displayName || "",
    media: null, mime: body.mimetype || null, fileName: body.fileName || null,
    eph: !!(msg.message?.ephemeralMessage || body.contextInfo?.expiration),
    thumb: null, _thumb: body.jpegThumbnail || null, q: quoted(body),
  };
}

async function save(A, msg, live) {
  const rec = extract(msg);
  if (!rec || A.seen.has(rec.id)) return null;
  const th = rec._thumb; delete rec._thumb;
  if (th && th.length) {
    try {
      const f = `t_${rec.id.replace(/\W/g, "")}.jpg`;
      fs.writeFileSync(path.join(A.dir, "media", f), Buffer.from(th));
      rec.thumb = f;
    } catch {}
  }
  if (!index(A, rec)) return null;
  fs.appendFileSync(A.logFile, JSON.stringify(rec) + "\n");
  if (A.total % 25 === 0) console.log(`[${A.id}] المحفوظ: ${A.total}`);
  if (live && MEDIA_RE.test(rec.type)) await fetchMedia(A, rec, msg, true);
  return rec;
}

// ---------- الاتصال بواتساب ----------
async function connect(A) {
  A.timer = null;
  const old = A.sock; A.sock = null;
  try { old?.end(undefined); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(path.join(A.dir, "auth"));
  A.linked = !!state.creds.registered;
  const sock = makeWASocket({ version, auth: state, logger, browser: Browsers.macOS("Desktop"),
    syncFullHistory: true, markOnlineOnConnect: false });
  A.sock = sock;
  sock.ev.process(() => { A.stats.lastEvent = new Date().toISOString(); });
  sock.ev.on("creds.update", () => { saveCreds(); A.linked = !!sock.authState.creds.registered; });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (A.sock !== sock) return;
    if (qr) { A.qr = qr; A.status = "qr"; }
    if (connection === "open") {
      A.status = "open"; A.qr = null; A.linked = true; A.fails = 0; A.me = sock.user?.id || null;
      A.stats.open = new Date().toISOString();
      alog(A, "✅ متصل");
      try {
        const g = await sock.groupFetchAllParticipating();
        for (const id in g) setName(A, id, g[id].subject);
      } catch {}
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === code) || String(code);
      A.status = "closed"; A.qr = null;
      A.stats.close = new Date().toISOString(); A.stats.closeCode = reason; A.stats.reconnects++;
      alog(A, `انقطع الاتصال: ${reason}`);
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(path.join(A.dir, "auth"), { recursive: true, force: true });
        A.linked = false;
        alog(A, "فصل واتساب هذا الجهاز — أعد الربط");
      }
      A.fails++;
      if (!A.timer) A.timer = setTimeout(() => connect(A), Math.min(30000, 2000 * A.fails));
    }
  });

  const names = (cs) => (cs || []).forEach((c) => setName(A, c.id, c.name || c.notify || c.verifiedName));
  sock.ev.on("contacts.upsert", names);
  sock.ev.on("contacts.update", names);
  sock.ev.on("chats.upsert", names);
  sock.ev.on("chats.update", names);
  sock.ev.on("groups.upsert", (gs) => gs.forEach((g) => setName(A, g.id, g.subject)));
  sock.ev.on("groups.update", (gs) => gs.forEach((g) => setName(A, g.id, g.subject)));

  sock.ev.on("messaging-history.set", async ({ messages, chats, contacts }) => {
    names(contacts); names(chats);
    for (const m of messages || []) {
      if (m.messageStubType === 1 && m.key?.id) {
        markDeleted(A, m.key.id, m.key.remoteJid, m.key.fromMe, m.key.participant, tsOf(m), true);
        continue;
      }
      const rec = await save(A, m, false);
      if (rec && MEDIA_RE.test(rec.type) && A.queue.length < 3000 && Date.now() - Date.parse(rec.time) < 60 * 864e5) {
        A.queue.push({ rec, msg: m });
      }
    }
    console.log(`[${A.id}] مزامنة السجل: ${A.total}`);
    pump(A);
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      if (m.messageStubType === 1 && m.key?.id) {
        markDeleted(A, m.key.id, m.key.remoteJid, m.key.fromMe, m.key.participant, null, false, false);
        continue;
      }
      if (isRevoke(A, m)) continue;
      A.stats.lastMsg = new Date().toISOString();
      await save(A, m, type === "notify");
    }
  });
  sock.ev.on("messages.update", (ups) => {
    for (const u of ups) {
      if (!u.key?.id) continue;
      if (u.update?.messageStubType === 1) {
        markDeleted(A, u.key.id, u.key.remoteJid, u.key.fromMe, u.key.participant, null, false, false);
      }
      const em = u.update?.message?.editedMessage?.message;
      if (em) {
        const c = normalizeMessageContent(em);
        const t = c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || "";
        if (t) addEdit(A, u.key.id, t, tsOf(u.update || {}));
      }
    }
  });
  sock.ev.on("messages.delete", (d) => {
    if (d.keys) for (const k of d.keys) markDeleted(A, k.id, k.remoteJid, k.fromMe, k.participant, null, false, true);
    else alog(A, "مسح/حذف دردشة كاملة من الهاتف (الأرشيف لم يتأثر)");
  });
}

// ---------- الخادم المحلي للواجهة ----------
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const cookie = /(?:^|;\s*)tk=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  if (cookie !== TOKEN && u.searchParams.get("t") !== TOKEN) { res.writeHead(403); return res.end("forbidden"); }
  const send = (o, c = 200) => {
    res.writeHead(c, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(o));
  };
  try {
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Set-Cookie": `tk=${TOKEN}; Path=/; SameSite=Strict` });
      return res.end(UI);
    }
    if (u.pathname === "/api/state") {
      const o = {};
      for (const id in accounts) {
        const A = accounts[id];
        o[id] = { status: A.status, linked: A.linked, total: A.total, me: A.me ? A.me.split(":")[0].split("@")[0] : null };
      }
      return send({ accounts: o });
    }
    if (u.pathname.startsWith("/media/")) {
      const [, , accId, file] = u.pathname.split("/");
      const A = accounts[accId];
      const fp = A && path.join(A.dir, "media", path.basename(decodeURIComponent(file || "")));
      if (!fp || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
      const size = fs.statSync(fp).size;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      let s = 0, e = size - 1;
      if (m) { if (m[1]) s = +m[1]; if (m[2]) e = Math.min(+m[2], e); }
      const h = { "Content-Type": MIME[path.extname(fp).slice(1)] || "application/octet-stream",
        "Accept-Ranges": "bytes", "Content-Length": e - s + 1 };
      if (m) h["Content-Range"] = `bytes ${s}-${e}/${size}`;
      res.writeHead(m ? 206 : 200, h);
      return fs.createReadStream(fp, { start: s, end: e }).pipe(res);
    }

    const accId = u.searchParams.get("acc");
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (u.pathname === "/api/settings") {
      if (req.method === "POST") {
        if (typeof body.status === "boolean") settings.status = body.status;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
      }
      return send(settings);
    }
    const A = accounts[accId || body.acc];
    if (!A) return send({ error: "حساب غير معروف" }, 404);

    if (u.pathname === "/api/qr") {
      return send(A.qr ? { svg: await QRCode.toString(A.qr, { type: "svg", margin: 1 }) } : {});
    }
    if (u.pathname === "/api/pair") {
      const phone = String(body.phone || "").replace(/\D/g, "");
      if (phone.length < 8) return send({ error: "أدخل الرقم بصيغة دولية" });
      try {
        const code = await A.sock.requestPairingCode(phone);
        return send({ code: code.match(/.{1,4}/g).join("-") });
      } catch (e) { return send({ error: "تعذّر الآن، انتظر ثوانٍ وأعد المحاولة" }); }
    }
    if (u.pathname === "/api/logout") {
      try { await A.sock.logout(); } catch {}
      return send({ ok: true });
    }
    if (u.pathname === "/api/diag") {
      let bytes = 0, files = 0;
      try {
        for (const f of fs.readdirSync(path.join(A.dir, "media"))) { bytes += fs.statSync(path.join(A.dir, "media", f)).size; files++; }
      } catch {}
      return send({ status: A.status, linked: A.linked, total: A.total, chats: A.byChat.size, mediaFiles: files,
        mediaMB: Math.round(bytes / 1048576), stats: A.stats, logs: A.logs, saveStatus: settings.status });
    }
    if (u.pathname === "/api/export") {
      const jid = u.searchParams.get("jid");
      const pad = (n) => String(n).padStart(2, "0");
      const lines = sorted(A, jid).map((r) => {
        const d = new Date(r.time);
        const ts = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const who = r.fromMe ? "أنا" : A.names[r.sender] || r.name || dn(A, r.sender);
        let t = r.text || (r.media ? `<مرفق: ${r.media}>` : `<${r.type}>`);
        for (const e of r.edits || []) t += `\n   ✏️ عُدّلت إلى: ${e.text}`;
        if (r.del) t += `\n   🚫 ${r.delMe ? "حُذفت من الهاتف" : "حُذفت للجميع"} بتاريخ ${r.del}`;
        return `[${ts}] ${who}: ${t}`;
      });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="chat-${Date.now()}.txt"` });
      return res.end(lines.join("\n"));
    }
    if (u.pathname === "/api/chats") {
      const out = [];
      for (const [jid, arr] of A.byChat) {
        sorted(A, jid);
        const l = arr[arr.length - 1];
        out.push({ jid, name: dn(A, jid), group: isGroup(jid), n: arr.length,
          last: { text: l.text, type: l.type, fromMe: l.fromMe, time: l.time, del: l.del || null } });
      }
      out.sort((a, b) => (b.last.time || "").localeCompare(a.last.time || ""));
      return send(out);
    }
    if (u.pathname === "/api/messages") {
      const jid = u.searchParams.get("jid");
      const limit = Math.min(Number(u.searchParams.get("limit") || 300), 2000);
      const arr = sorted(A, jid).slice(-limit);
      return send(arr.map((r) => ({ id: r.id, fromMe: r.fromMe, time: r.time, type: r.type, text: r.text,
        media: r.media, fileName: r.fileName, del: r.del || null, delMe: !!r.delMe, pre: !!r.pre, eph: !!r.eph, thumb: r.thumb || null,
        edits: r.edits || null,
        q: r.q ? { text: r.q.text, type: r.q.type, n: r.q.who ? A.names[r.q.who] || dn(A, r.q.who) : "" } : null,
        sn: r.fromMe ? "أنا" : A.names[r.sender] || r.name || dn(A, r.sender) })));
    }
    if (u.pathname === "/api/search") {
      const q = (u.searchParams.get("q") || "").toLowerCase();
      const out = [];
      if (u.searchParams.get("del")) {
        for (const [jid, arr] of A.byChat) {
          for (const r of arr) if (r.del) out.push({ jid, name: dn(A, jid), group: isGroup(jid), text: r.text, time: r.del, fromMe: r.fromMe });
        }
        out.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
        return send(out.slice(0, 200));
      }
      for (const [jid, arr] of A.byChat) {
        for (const r of arr) {
          if (r.text && r.text.toLowerCase().includes(q)) out.push({ jid, name: dn(A, jid), group: isGroup(jid), text: r.text, time: r.time, fromMe: r.fromMe });
        }
      }
      out.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
      return send(out.slice(0, 60));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.log("خطأ خادم:", e?.message);
    try { send({ error: String(e?.message) }, 500); } catch {}
  }
}).listen(PORT, "127.0.0.1", () => console.log("الواجهة على المنفذ", PORT));

(async () => {
  try { version = (await fetchLatestBaileysVersion()).version; } catch {}
  for (const id of ["wa", "biz"]) {
    accounts[id] = makeAccount(id);
    connect(accounts[id]);
  }
})();
