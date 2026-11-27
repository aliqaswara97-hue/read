import makeWASocket, {
  BufferJSON, useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
  fetchLatestBaileysVersion, Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);

const log = pino({ level: 'silent' });
const status = { state: 'starting', code: null, since: Date.now(), lastMsgAt: null, lastOpenAt: null };
const DATA = './data', MEDIA = `${DATA}/media`, DB_FILE = `${DATA}/db.json`;
fs.mkdirSync(MEDIA, { recursive: true });

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
db.messages ||= {}; db.names ||= {}; db.contacts ||= {}; db.alias ||= {}; db.vcards ||= [];
// حذف كل ما يخص القنوات (newsletter) نهائيًا
for (const [id, m] of Object.entries(db.messages)) {
  if (m.chat?.endsWith('@newsletter')) {
    if (m.media) fs.rmSync(`${MEDIA}/${m.media}`, { force: true });
    delete db.messages[id];
  }
}
let sockRef = null;
let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db)), 1500);
};

const norm = (j) => (j || '').replace(/:\d+@/, '@');
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];
const unwrap = (m) => {
  for (let w = WRAPPERS.find(k => m?.[k]); w; w = WRAPPERS.find(k => m?.[k])) m = m[w].message;
  return m;
};

// ---- أسماء جهات الاتصال المحفوظة عندك ----
function setContact(c) {
  if (!c?.id) return;
  if (c.notify) db.names[norm(c.id)] ||= c.notify;
  const n = c.name || c.verifiedName;
  if (!n) return;
  for (const k of [c.id, c.lid, c.phoneNumber]) if (k) db.contacts[norm(k)] = n;
  save();
}
// فهرس أسماء ملف vCard: آخر 9 أرقام من الرقم => الاسم
const vindex = new Map();
function buildIndex() {
  vindex.clear();
  for (const c of db.vcards) for (const n of c.nums) {
    const d = String(n).replace(/\D/g, '').replace(/^00/, '').replace(/^0+/, '');
    if (d.length >= 7) vindex.set(d.slice(-9), c.name);
  }
}
buildIndex();
const nameOf = (jid) => {
  if (jid === 'status@broadcast') return 'الحالات';
  const ids = [jid, db.alias[jid]].filter(Boolean);
  for (const k of ids) if (db.contacts[k]) return db.contacts[k];
  for (const k of ids) if (k.endsWith('@s.whatsapp.net')) { const v = vindex.get(k.split('@')[0].slice(-9)); if (v) return v; }
  for (const k of ids) if (db.names[k]) return db.names[k];
  return jid.endsWith('@lid') ? 'مستخدم واتساب' : jid.split('@')[0];
};
async function learnLid(sock, jid) {
  if (!jid.endsWith('@lid') || db.alias[jid]) return;
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
    if (pn) { const p = norm(String(pn).includes('@') ? pn : pn + '@s.whatsapp.net'); db.alias[jid] = p; db.alias[p] = jid; save(); }
  } catch {}
}
const numberOf = (jid) => {
  const pn = [jid, db.alias[jid]].find(j => j?.endsWith('@s.whatsapp.net'));
  return pn ? '+' + pn.split('@')[0] : '';
};

function markDeleted(id, key) {
  let r = db.messages[id];
  if (!r && key?.remoteJid) {   // رسالة حُذفت قبل أن نلتقطها: نسجّل الحذف على الأقل
    const chat = norm(key.remoteJid);
    if (chat.endsWith('@newsletter')) return;
    r = db.messages[id] = { id, chat, fromMe: !!key.fromMe, sender: norm(key.participant || chat), text: '', type: 'revoked', ts: Date.now(), media: null, deleted: false, placeholder: true };
  }
  if (r && !r.deleted) { r.deleted = true; r.deletedAt = Date.now(); save(); console.log('🗑️ حُذفت رسالة', id); }
}

const SKIP = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'albumMessage', 'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage', 'secretEncryptedMessage']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'application/pdf': 'pdf' };
const extOf = (mime, fname) => {
  const b = (mime || '').split(';')[0].trim().toLowerCase();
  if (EXT[b]) return EXT[b];
  if (fname && /\.[A-Za-z0-9]{1,6}$/.test(fname)) return fname.split('.').pop().toLowerCase();
  return (b.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
};
async function saveMedia(sock, m, body, rec, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise(r => setTimeout(r, i * 3000));
    try {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
      rec.media = `${rec.id}.${extOf(body?.mimetype, body?.fileName)}`;
      fs.writeFileSync(`${MEDIA}/${rec.media}`, buf);
      delete rec.mediaError; delete rec.raw; save();
      return true;
    } catch (e) { err = e; }
  }
  rec.mediaError = err?.message || 'خطأ';
  rec.raw = JSON.parse(JSON.stringify(m, BufferJSON.replacer)); save();
  console.log('تعذر حفظ الوسائط:', rec.mediaError);
  return false;
}
const gmTried = new Map();
function ensureGroupName(sock, jid) {
  if (db.names[jid] || Date.now() - (gmTried.get(jid) || 0) < 600000) return;
  gmTried.set(jid, Date.now());
  sock.groupMetadata(jid).then(g => { db.names[jid] = g.subject; save(); }).catch(() => {});
}

const recent = [];
const note = (k, jid, extra = '') => { recent.unshift({ t: Date.now(), k, jid, name: nameOf(jid), extra: String(extra).slice(0, 80) }); if (recent.length > 60) recent.length = 60; };
async function store(sock, m) {
  const jid = norm(m.key.remoteJid);
  if (!jid || jid.endsWith('@newsletter')) return;
  if (!m.message) {
    if (m.messageStubType === 2 && m.key.id && jid !== 'status@broadcast') {   // CIPHERTEXT: تعذّر فك التشفير
      if (!db.messages[m.key.id]) {
        db.messages[m.key.id] = { id: m.key.id, chat: jid, fromMe: !!m.key.fromMe, sender: norm(m.key.participant || jid), text: '', type: 'undecrypted', ts: Number(m.messageTimestamp) * 1000 || Date.now(), media: null, deleted: false, placeholder: true };
        save();
      }
      note('undecrypted', jid, m.messageStubParameters?.[0] || '');
      console.log('رسالة لم تُفك تشفيرها من', jid);
    } else note('stub', jid, 'stub ' + (m.messageStubType ?? ''));
    return;
  }
  const raw = unwrap(m.message);
  const msg = raw.editedMessage ? unwrap(raw.editedMessage.message) : raw;
  if (msg.protocolMessage) {
    const p = msg.protocolMessage;
    if (p.type === 0 && p.key?.id) markDeleted(p.key.id, { ...p.key, remoteJid: p.key.remoteJid || m.key.remoteJid, participant: p.key.participant || m.key.participant }); // REVOKE
    if (p.type === 14 && p.key?.id && db.messages[p.key.id]) { // EDIT
      const e = unwrap(p.editedMessage || {});
      const t = e?.conversation || e?.extendedTextMessage?.text || '';
      const r = db.messages[p.key.id];
      if (t && t !== r.text) { r.orig ||= r.text; r.text = t; r.edited = true; save(); }
    }
    return;
  }
  if (msg.reactionMessage) {
    const rm = msg.reactionMessage, t = db.messages[rm.key?.id];
    if (t) {
      t.reactions ||= {};
      const who = m.key.fromMe ? 'me' : norm(m.key.participant || jid);
      if (rm.text) t.reactions[who] = rm.text; else delete t.reactions[who];
      save();
    }
    return;
  }
  const type = Object.keys(msg).find(k => !SKIP.has(k));
  if (!type) { note('skipped', jid, Object.keys(msg).join(',')); return; }
  const body = msg[type];
  const sender = norm(m.key.participant || jid);
  const alt = norm(m.key.remoteJidAlt), pAlt = norm(m.key.participantAlt);
  if (alt && alt !== jid) { db.alias[jid] = alt; db.alias[alt] = jid; }
  if (pAlt && pAlt !== sender) { db.alias[sender] = pAlt; db.alias[pAlt] = sender; }
  const rec = {
    id: m.key.id, chat: jid, fromMe: !!m.key.fromMe, sender,
    text: msg.conversation || body?.text || body?.caption || '',
    type, ts: Number(m.messageTimestamp) * 1000 || Date.now(),
    media: null, deleted: false, fileName: body?.fileName || null,
    bg: body?.backgroundArgb ?? null,
    quotedFrom: norm(body?.contextInfo?.participant || ''),
    quoted: (() => { const q = body?.contextInfo?.quotedMessage; const u = q && unwrap(q); return u?.conversation || u?.extendedTextMessage?.text || ''; })()
  };
  if (m.pushName && !rec.fromMe) db.names[sender] ||= m.pushName;
  await learnLid(sock, jid); if (sender !== jid) await learnLid(sock, sender);
  if (jid.endsWith('@g.us')) ensureGroupName(sock, jid);
  const ex = db.messages[rec.id];
  if (ex && !ex.placeholder) return;
  if (ex?.deleted) { rec.deleted = true; rec.deletedAt = ex.deletedAt; }
  db.messages[rec.id] = rec; save();
  note('stored', jid, type);
  status.lastMsgAt = Date.now();
  if (/^(image|video|audio|document|sticker)Message$/.test(type)) saveMedia(sock, m, body, rec).catch(e => console.log('media:', e.message));
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(`${DATA}/auth`);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger: log,
    browser: Browsers.ubuntu('Chrome'), syncFullHistory: false
  });
  sockRef = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    const phone = (process.env.PHONE || '').replace(/\D/g, '');
    if (!phone) { status.state = 'needs_phone'; console.log('شغّل: PHONE=رقمك node server.js'); return; }
    setTimeout(async () => {
      try {
        status.code = await sock.requestPairingCode(phone);
        status.state = 'pairing';
        console.log('\n🔗 كود الربط:', status.code, '\n');
      } catch (e) { console.log('تعذر طلب الكود:', e.message); }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      status.state = 'open'; status.code = null; status.lastOpenAt = Date.now(); console.log('✅ متصل ويحفظ الرسائل');
      setTimeout(() => sock.resyncAppState(
        ['critical_unblock_low', 'regular_low', 'regular_high', 'regular', 'critical_block'], true
      ).catch(e => console.log('مزامنة الأسماء:', e.message)), 5000);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('تم تسجيل الخروج، سيُطلب ربط جديد.');
        fs.rmSync(`${DATA}/auth`, { recursive: true, force: true });
        process.exit(1);
      }
      status.state = 'starting';
      console.log('انقطع الاتصال، إعادة المحاولة...', code || '');
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('contacts.upsert', cs => cs.forEach(setContact));
  sock.ev.on('contacts.update', cs => cs.forEach(setContact));
  sock.ev.on('messaging-history.set', ({ contacts }) => (contacts || []).forEach(setContact));
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) await store(sock, m).catch(e => console.log(e.message));
  });
  sock.ev.on('messages.update', (ups) => {
    for (const u of ups) if (u.update?.messageStubType === 1 || u.update?.message === null) markDeleted(u.key.id, u.key); // REVOKE
  });
}

// ---- واجهة الويب ----
const app = express();
const OK_HOSTS = new Set(['localhost:3000', '127.0.0.1:3000']);
app.use((req, res, next) => {   // حماية: لا يقبل إلا طلبات هذه الصفحة نفسها
  if (!OK_HOSTS.has(req.headers.host)) return res.status(403).end();
  const o = req.headers.origin;
  if (o && !OK_HOSTS.has(o.replace(/^https?:\/\//, ''))) return res.status(403).end();
  if (req.method !== 'GET' && req.headers['x-archive'] !== '1') return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
});
// ---- قفل بالرمز (PIN) ----
const sessions = new Map();
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(a => a[0]));
const IDLE = 5 * 60e3;
const authed = (req) => {
  const t = cookieOf(req).sess, e = sessions.get(t) || 0;
  if (e <= Date.now()) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + IDLE); return true;
};
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const checkPin = (pin) => {
  if (!db.pin) return true;
  return crypto.timingSafeEqual(Buffer.from(hashPin(pin, db.pin.salt), 'hex'), Buffer.from(db.pin.hash, 'hex'));
};
const startSession = (res) => {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + IDLE);
  res.setHeader('Set-Cookie', `sess=${t}; HttpOnly; SameSite=Strict; Path=/`);
};
let fails = 0, lockedUntil = 0;
app.use((req, res, next) => {
  const p = req.path;
  if (!db.pin || p === '/api/lock-status' || p === '/api/unlock' || !(p.startsWith('/api') || p.startsWith('/media')) || authed(req)) return next();
  res.status(401).json({ ok: false, error: 'locked' });
});
app.use(express.static('public'));
app.use('/media', express.static(MEDIA));

app.use(express.json({ limit: '20mb' }));
app.get('/api/lock-status', (req, res) => res.json({ hasPin: !!db.pin, unlocked: !db.pin || authed(req) }));
app.post('/api/unlock', (req, res) => {
  if (Date.now() < lockedUntil) return res.json({ ok: false, error: 'محاولات كثيرة، انتظر ' + Math.ceil((lockedUntil - Date.now()) / 1000) + ' ثانية' });
  if (!checkPin(req.body?.pin ?? '')) {
    if (++fails >= 5) { fails = 0; lockedUntil = Date.now() + 60000; }
    return res.json({ ok: false, error: 'الرمز غير صحيح' });
  }
  fails = 0; startSession(res); res.json({ ok: true });
});
app.post('/api/lock', (req, res) => {
  sessions.delete(cookieOf(req).sess);
  res.setHeader('Set-Cookie', 'sess=; Max-Age=0; Path=/');
  res.json({ ok: true });
});
app.post('/api/setpin', (req, res) => {
  const { pin = '', old = '' } = req.body || {};
  if (db.pin && !checkPin(old)) return res.json({ ok: false, error: 'الرمز الحالي غير صحيح' });
  if (!pin) { delete db.pin; sessions.clear(); save(); return res.json({ ok: true, removed: true }); }
  if (String(pin).length < 4) return res.json({ ok: false, error: 'الرمز 4 خانات على الأقل' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.pin = { salt, hash: hashPin(pin, salt) }; save(); startSession(res);
  res.json({ ok: true });
});
app.get('/api/status', (_, res) => res.json({ ...status, now: Date.now(), messages: Object.keys(db.messages).length, contacts: Object.keys(db.contacts).length, imported: db.vcards.length }));

app.post('/api/contacts', (req, res) => {
  const list = Array.isArray(req.body?.list) ? req.body.list : [];
  db.vcards = list.slice(0, 30000)
    .map(c => ({ name: String(c.name || '').slice(0, 100), nums: (Array.isArray(c.nums) ? c.nums : []).map(String).slice(0, 10) }))
    .filter(c => c.name && c.nums.length);
  buildIndex(); save();
  res.json({ count: db.vcards.length });
});

app.post('/api/resync', async (_, res) => {
  try {
    await sockRef?.resyncAppState(['critical_unblock_low', 'regular_low', 'regular_high', 'regular', 'critical_block'], true);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---- الإرسال والرد والتفاعل ----
const online = () => { if (!sockRef || status.state !== 'open') throw new Error('غير متصل بواتساب الآن'); return sockRef; };
const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};
const keyOf = (r) => ({ remoteJid: r.chat, fromMe: r.fromMe, id: r.id, participant: r.chat.endsWith('@g.us') && !r.fromMe ? r.sender : undefined });
const quotedOf = (id) => {
  const r = db.messages[id]; if (!r) return undefined;
  const k = keyOf(r);
  if (r.fromMe && r.chat.endsWith('@g.us')) k.participant = norm(sockRef?.user?.id);
  return { key: k, message: { conversation: r.text || '📎' } };
};
const TMP = `${DATA}/tmp`; fs.mkdirSync(TMP, { recursive: true });

app.post('/api/send', wrap(async (req) => {
  const { jid, text, replyTo } = req.body || {};
  if (!jid || !text?.trim()) throw new Error('رسالة فارغة');
  await online().sendMessage(jid, { text }, { quoted: quotedOf(replyTo) });
  return {};
}));

app.post('/api/send-media', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req) => {
  const { jid, kind, caption, filename, mimetype, seconds, replyTo } = req.query;
  let buf = req.body;
  if (!jid || !Buffer.isBuffer(buf) || !buf.length) throw new Error('ملف فارغ');
  let content;
  if (kind === 'voice') {
    const id = Date.now(), inp = `${TMP}/${id}.in`, out = `${TMP}/${id}.ogg`;
    fs.writeFileSync(inp, buf);
    try {
      await run('ffmpeg', ['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', out]);
      buf = fs.readFileSync(out);
    } catch (e) { throw new Error(e.code === 'ENOENT' ? 'ثبّت ffmpeg أولًا: pkg install ffmpeg' : 'فشل تحويل الصوت'); }
    finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
    content = { audio: buf, ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: Math.max(1, +seconds || 1) };
  } else if (kind === 'image') content = { image: buf, caption: caption || undefined };
  else if (kind === 'video') content = { video: buf, caption: caption || undefined, mimetype };
  else if (kind === 'audio') content = { audio: buf, mimetype: mimetype || 'audio/mpeg' };
  else content = { document: buf, fileName: filename || 'file', mimetype: mimetype || 'application/octet-stream', caption: caption || undefined };
  await online().sendMessage(jid, content, { quoted: quotedOf(replyTo) });
  return {};
}));

app.post('/api/delete', wrap(async (req) => {
  const r = db.messages[req.body?.id];
  if (!r || !r.fromMe) throw new Error('يمكنك حذف رسائلك فقط');
  await online().sendMessage(r.chat, { delete: keyOf(r) });
  return {};
}));
app.post('/api/edit', wrap(async (req) => {
  const { id, text } = req.body || {}, r = db.messages[id];
  if (!r || !r.fromMe || !text?.trim()) throw new Error('تعذّر التعديل');
  await online().sendMessage(r.chat, { text, edit: keyOf(r) });
  return {};
}));
app.post('/api/react', wrap(async (req) => {
  const { id, emoji } = req.body || {}, r = db.messages[id];
  if (!r) throw new Error('الرسالة غير موجودة');
  await online().sendMessage(r.chat, { react: { text: emoji || '', key: keyOf(r) } });
  return {};
}));
app.post('/api/status-seen', wrap(async (req) => {
  const r = db.messages[req.body?.id];
  if (!r || r.chat !== 'status@broadcast' || r.fromMe) throw new Error('حالة غير صالحة');
  await online().readMessages([{ remoteJid: 'status@broadcast', id: r.id, participant: r.sender, fromMe: false }]);
  r.seenSent = true; r.seenAt = Date.now(); save();
}));
app.get('/api/diag', (_, res) => res.json({
  state: status.state, lastMsgAt: status.lastMsgAt, now: Date.now(), messages: Object.keys(db.messages).length,
  undecrypted: Object.values(db.messages).filter(m => m.type === 'undecrypted').length, recent: recent.slice(0, 40)
}));
app.post('/api/retry-media', wrap(async (req) => {
  const r = db.messages[req.body?.id];
  if (!r?.raw) throw new Error('لا يمكن إعادة المحاولة لهذه الرسالة');
  const m = JSON.parse(JSON.stringify(r.raw), BufferJSON.reviver);
  const msg = unwrap(m.message), type = Object.keys(msg).find(k => !SKIP.has(k));
  const ok = await saveMedia(online(), m, msg[type], r);
  save();
  if (!ok) throw new Error(r.mediaError);
  return {};
}));

app.get('/api/chats', (req, res) => {
  const chats = {};
  for (const m of Object.values(db.messages)) {
    if (m.chat === 'status@broadcast') continue;
    const c = chats[m.chat] ||= { jid: m.chat, name: nameOf(m.chat), number: numberOf(m.chat), last: m, deleted: 0, lastDeleted: null };
    if (m.ts > c.last.ts) c.last = m;
    if (m.deleted) {
      c.deleted++;
      if (!c.lastDeleted || m.deletedAt > c.lastDeleted.deletedAt) c.lastDeleted = m;
    }
  }
  let list = Object.values(chats);
  for (const c of list) {
    c.last = { ...c.last, senderName: c.last.fromMe ? 'أنا' : nameOf(c.last.sender) };
    if (c.lastDeleted) c.lastDeleted = { ...c.lastDeleted, senderName: c.lastDeleted.fromMe ? 'أنا' : nameOf(c.lastDeleted.sender) };
  }
  if (req.query.deleted === '1') list = list.filter(c => c.deleted).sort((a, b) => b.lastDeleted.deletedAt - a.lastDeleted.deletedAt);
  else list.sort((a, b) => b.last.ts - a.last.ts);
  res.json(list);
});

app.get('/api/statuses', (req, res) => {
  const only = req.query.deleted === '1';
  const g = {};
  for (const m of Object.values(db.messages)) {
    if (m.chat !== 'status@broadcast' || (only && !m.deleted)) continue;
    const k = m.fromMe ? 'me' : m.sender;
    (g[k] ||= { sender: k, name: m.fromMe ? 'حالتي' : nameOf(m.sender), items: [] }).items.push(m);
  }
  const out = Object.values(g).map(x => {
    x.items.sort((a, b) => a.ts - b.ts);
    x.last = x.items[x.items.length - 1];
    x.deleted = x.items.filter(i => i.deleted).length;
    return x;
  }).sort((a, b) => b.last.ts - a.last.ts);
  res.json(out);
});

app.get('/api/chat', (req, res) => {
  const list = Object.values(db.messages)
    .filter(m => m.chat === req.query.jid)
    .sort((a, b) => a.ts - b.ts)
    .map(m => ({ ...m, senderName: m.fromMe ? 'أنا' : nameOf(m.sender), quotedName: m.quotedFrom ? nameOf(m.quotedFrom) : '' }));
  res.json(list);
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const only = req.query.deleted === '1';
  const out = Object.values(db.messages)
    .filter(m => m.chat !== 'status@broadcast' && m.text && (!only || m.deleted) && m.text.toLowerCase().includes(q))
    .sort((a, b) => b.ts - a.ts).slice(0, 50)
    .map(m => ({ id: m.id, jid: m.chat, name: nameOf(m.chat), number: numberOf(m.chat), text: m.text, ts: m.ts, deleted: m.deleted, deletedAt: m.deletedAt, senderName: m.fromMe ? 'أنا' : nameOf(m.sender) }));
  res.json(out);
});

app.get('/api/export', (req, res) => {
  const f = d => new Date(d).toLocaleString('ar-EG');
  const lines = Object.values(db.messages).filter(m => m.chat === req.query.jid).sort((a, b) => a.ts - b.ts)
    .map(m => `[${f(m.ts)}] ${m.fromMe ? 'أنا' : nameOf(m.sender)}: ${m.text || (m.media ? '[' + m.type.replace('Message', '') + '] ' + m.media : m.type === 'revoked' ? '(رسالة لم تُلتقط قبل حذفها)' : '')}${m.deleted ? '   ❌ حُذفت ' + f(m.deletedAt) : ''}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="chat.txt"');
  res.send(lines.join('\n'));
});

app.listen(3000, '127.0.0.1', () => console.log('🌐 افتح http://localhost:3000 في المتصفح'));
start();
