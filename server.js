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

let db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { messages: {}, names: {} };
let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db)), 1500);
};

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];
const unwrap = (m) => {
  for (let w = WRAPPERS.find(k => m?.[k]); w; w = WRAPPERS.find(k => m?.[k])) m = m[w].message;
  return m;
};

function markDeleted(id) {
  const r = db.messages[id];
  if (r && !r.deleted) { r.deleted = true; r.deletedAt = Date.now(); save(); console.log('🗑️ حُذفت رسالة', id); }
}

async function store(sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || !m.message) return;
  const msg = unwrap(m.message);
  if (msg.protocolMessage) {
    const p = msg.protocolMessage;
    if (p.type === 0 && p.key?.id) markDeleted(p.key.id); // REVOKE
    return;
  }
  const type = Object.keys(msg).find(k => k !== 'messageContextInfo');
  if (!type) return;
  const body = msg[type];
  const rec = {
    id: m.key.id, chat: jid, fromMe: !!m.key.fromMe,
    sender: m.key.participant || jid,
    text: msg.conversation || body?.text || body?.caption || '',
    type, ts: Number(m.messageTimestamp) * 1000 || Date.now(),
    media: null, deleted: false
  };
  if (m.pushName && !rec.fromMe) db.names[rec.sender] = m.pushName;
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
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    const phone = (process.env.PHONE || '').replace(/\D/g, '');
    if (!phone) { status.state = 'needs_phone'; console.log('أضف السر PHONE في إعدادات Codespaces أو شغّل: PHONE=9665XXXXXXXX node server.js'); return; }
    setTimeout(async () => {
      try {
        status.code = await sock.requestPairingCode(phone);
        status.state = 'pairing';
        console.log('\n🔗 كود الربط:', status.code, '\n');
      } catch (e) { console.log('تعذر طلب الكود:', e.message); }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') { status.state = 'open'; status.code = null; console.log('✅ متصل ويحفظ الرسائل'); }
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

const nameOf = (jid) => db.names[jid] || (jid === 'status@broadcast' ? 'الحالات' : jid.split('@')[0]);

app.get('/api/status', (_, res) => res.json(status));

app.get('/api/chats', (_, res) => {
  const chats = {};
  for (const m of Object.values(db.messages)) {
    const c = chats[m.chat] ||= { jid: m.chat, name: nameOf(m.chat), last: m, deleted: 0 };
    if (m.ts > c.last.ts) c.last = m;
    if (m.deleted) c.deleted++;
  }
  res.json(Object.values(chats).sort((a, b) => b.last.ts - a.last.ts));
});

app.get('/api/chat', (req, res) => {
  const list = Object.values(db.messages)
    .filter(m => m.chat === req.query.jid)
    .sort((a, b) => a.ts - b.ts)
    .map(m => ({ ...m, senderName: m.fromMe ? 'أنا' : nameOf(m.sender) }));
  res.json(list);
});

app.listen(3000, '127.0.0.1', () => console.log('🌐 افتح http://localhost:3000 في المتصفح'));
start();
