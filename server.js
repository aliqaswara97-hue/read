import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
  fetchLatestBaileysVersion, Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import fs from 'fs';

const log = pino({ level: 'silent' });
const status = { state: 'starting', code: null };
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

function markDeleted(id) {
  const r = db.messages[id];
  if (r && !r.deleted) { r.deleted = true; r.deletedAt = Date.now(); save(); console.log('🗑️ حُذفت رسالة', id); }
}

async function store(sock, m) {
  const jid = norm(m.key.remoteJid);
  if (!jid || !m.message || jid.endsWith('@newsletter')) return;
  const raw = unwrap(m.message);
  const msg = raw.editedMessage ? unwrap(raw.editedMessage.message) : raw;
  if (msg.protocolMessage) {
    const p = msg.protocolMessage;
    if (p.type === 0 && p.key?.id) markDeleted(p.key.id); // REVOKE
    if (p.type === 14 && p.key?.id && db.messages[p.key.id]) { // EDIT
      const e = unwrap(p.editedMessage || {});
      const t = e?.conversation || e?.extendedTextMessage?.text || '';
      const r = db.messages[p.key.id];
      if (t && t !== r.text) { r.orig ||= r.text; r.text = t; r.edited = true; save(); }
    }
    return;
  }
  const type = Object.keys(msg).find(k => k !== 'messageContextInfo');
  if (!type) return;
  const body = msg[type];
  const sender = norm(m.key.participant || jid);
  const alt = norm(m.key.remoteJidAlt), pAlt = norm(m.key.participantAlt);
  if (alt && alt !== jid) { db.alias[jid] = alt; db.alias[alt] = jid; }
  if (pAlt && pAlt !== sender) { db.alias[sender] = pAlt; db.alias[pAlt] = sender; }
  const rec = {
    id: m.key.id, chat: jid, fromMe: !!m.key.fromMe, sender,
    text: msg.conversation || body?.text || body?.caption || '',
    type, ts: Number(m.messageTimestamp) * 1000 || Date.now(),
    media: null, deleted: false,
    bg: body?.backgroundArgb ?? null,
    quotedFrom: norm(body?.contextInfo?.participant || ''),
    quoted: (() => { const q = body?.contextInfo?.quotedMessage; const u = q && unwrap(q); return u?.conversation || u?.extendedTextMessage?.text || ''; })()
  };
  if (m.pushName && !rec.fromMe) db.names[sender] ||= m.pushName;
  await learnLid(sock, jid); if (sender !== jid) await learnLid(sock, sender);
  if (jid.endsWith('@g.us') && !db.names[jid]) {
    try { db.names[jid] = (await sock.groupMetadata(jid)).subject; } catch {}
  }
  if (/^(image|video|audio|document|sticker)Message$/.test(type)) {
    try {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
      const ext = (body.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
      rec.media = `${rec.id}.${ext}`;
      fs.writeFileSync(`${MEDIA}/${rec.media}`, buf);
    } catch (e) { console.log('تعذر حفظ الوسائط:', e.message); }
  }
  if (!db.messages[rec.id]) { db.messages[rec.id] = rec; save(); }
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
      status.state = 'open'; status.code = null; console.log('✅ متصل ويحفظ الرسائل');
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
      start();
    }
  });

  sock.ev.on('contacts.upsert', cs => cs.forEach(setContact));
  sock.ev.on('contacts.update', cs => cs.forEach(setContact));
  sock.ev.on('messaging-history.set', ({ contacts }) => (contacts || []).forEach(setContact));
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) await store(sock, m).catch(e => console.log(e.message));
  });
  sock.ev.on('messages.update', (ups) => {
    for (const u of ups) if (u.update?.messageStubType === 1) markDeleted(u.key.id); // REVOKE
  });
}

// ---- واجهة الويب ----
const app = express();
app.use(express.static('public'));
app.use('/media', express.static(MEDIA));

app.use(express.json({ limit: '20mb' }));
app.get('/api/status', (_, res) => res.json({ ...status, contacts: Object.keys(db.contacts).length, imported: db.vcards.length }));

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

app.listen(3000, '127.0.0.1', () => console.log('🌐 افتح http://localhost:3000 في المتصفح'));
start();
