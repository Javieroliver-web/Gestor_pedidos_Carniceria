'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const {
  SHOP_NAME, PORT, HOST, log,
  loadOrders, saveOrders,
  getCurrentPrinter, getProfiles, savePrinterConfig,
  isPrintingEnabled, setPrintingEnabled, getPrintingChangedAt,
  genPin, getPrinterName
} = require('./src/config');

const { classifyMessage, getAiStats } = require('./src/services/aiService');
const { printTicket, listWindowsPrinters } = require('./src/services/printService');
const { logFallo, logError, readRecent, logSummary } = require('./src/services/incidentLog');
const schedule = require('./src/schedule');
const catalog = require('./src/catalog');

// ── Textos fijos que recibe el cliente (la IA nunca redacta respuestas) ──────
const MSG = {
  saludo:
    '¡Hola! 👋 Soy el asistente de la Carnicería Raúl Oliver.\n\n' +
    'Puedes hacerme tu pedido por aquí (por ejemplo: _1 kg de lomo y 6 filetes de pollo_) ' +
    'o preguntarme por el horario.',
  agradecimiento: '¡Gracias a ti! 😊',
  relevo:
    '🙋 Esta consulta tiene que verla una persona de la carnicería. ' +
    'Te contestaremos por aquí lo antes posible.',
  relevoPedido:
    '🙋 Hay algo de tu pedido que tiene que revisar una persona de la carnicería. ' +
    'Te escribiremos por aquí para confirmarlo.',
  diaNoEntendido: 'No he entendido el día. Responde solo con el número de la opción, por favor.',
};

// ── Pedidos ───────────────────────────────────────────────────────────────────
const orders = loadOrders();

function cleanupOldOrders() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let n = 0;
  for (const [id, o] of orders) {
    if (['done', 'discarded'].includes(o.status) && new Date(o.createdAt).getTime() < cutoff) {
      orders.delete(id); n++;
    }
  }
  if (n > 0) { saveOrders(orders); log('CLEAN', `${n} pedido(s) antiguos eliminados.`); }
}
cleanupOldOrders();
setInterval(cleanupOldOrders, 6 * 60 * 60 * 1000);

// ── Relevo a persona: el bot deja de contestar a ese cliente hasta medianoche ─
const HANDOFFS_FILE = path.join(__dirname, 'handoffs.json');
const handoffs = new Map(); // clave cliente -> { sender, telefono, desde, hasta, motivo, mensaje }

(function loadHandoffs() {
  try {
    if (fs.existsSync(HANDOFFS_FILE)) {
      for (const h of JSON.parse(fs.readFileSync(HANDOFFS_FILE, 'utf8'))) handoffs.set(h.sender, h);
    }
  } catch (e) { log('WARN', `handoffs.json: ${e.message}`); }
})();

function saveHandoffs() {
  try { fs.writeFileSync(HANDOFFS_FILE, JSON.stringify([...handoffs.values()], null, 2)); }
  catch (e) { log('ERROR', `No se pudo guardar handoffs.json: ${e.message}`); }
}

function activeHandoffs() {
  const now = Date.now();
  let changed = false;
  for (const [k, h] of handoffs) if (new Date(h.hasta).getTime() <= now) { handoffs.delete(k); changed = true; }
  if (changed) { saveHandoffs(); broadcast('handoffs', [...handoffs.values()]); }
  return [...handoffs.values()];
}
setInterval(activeHandoffs, 60 * 1000);

function isInHandoff(sender) {
  const h = handoffs.get(sender);
  return Boolean(h && new Date(h.hasta).getTime() > Date.now());
}

/** Pasa el cliente a una persona. Si replyText es null no se envía nada al cliente. */
async function startHandoff(who, target, motivo, texto, replyText = MSG.relevo, categoria = 'consulta') {
  const h = { sender: who.key, telefono: who.phone, desde: new Date().toISOString(), hasta: schedule.nextMidnight().toISOString(), motivo, categoria, mensaje: texto };
  handoffs.set(who.key, h);
  saveHandoffs();
  cancelPendingDay(who.key);
  broadcast('handoffs', [...handoffs.values()]);
  logFallo({ categoria, motivo, cliente: who.phone, mensaje: texto });
  log('RELEVO', `${who.phone}: ${motivo}`);
  if (replyText) await reply(target, replyText, who);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let waState = 'STARTING';
let waQrUrl = '';
function broadcastWaState() { broadcast('wa_state', { state: waState, qr: waQrUrl }); }

const sseClients = new Set();
function sseWrite(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of sseClients) sseWrite(res, event, data); }

// ── Endpoints Express ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  sseWrite(res, 'init', {
    orders:   [...orders.values()],
    shopName: SHOP_NAME,
    printer:  getCurrentPrinter(),
    profiles: getProfiles(),
    waState:  waState,
    waQrUrl:  waQrUrl,
    handoffs: activeHandoffs(),
    printing: { enabled: isPrintingEnabled(), changedAt: getPrintingChangedAt() },
  });

  const hb = setInterval(() => res.write(':\n\n'), 15000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

app.get('/api/orders', (_req, res) => res.json([...orders.values()].reverse()));

app.post('/api/orders/:id/ready', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.status = 'ready';
  saveOrders(orders); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → LISTO`);
  res.json(o);
});

app.post('/api/orders/:id/done', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.status = 'done';
  saveOrders(orders); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → RECOGIDO`);
  res.json(o);
});

app.post('/api/orders/:id/discard', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  if (['done', 'discarded'].includes(o.status)) return res.status(400).json({ error: 'Estado no permite descartar' });
  o.status = 'discarded';
  o.discardedAt = new Date().toISOString();
  saveOrders(orders); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → DESCARTADO`);
  res.json(o);
});

// Quitar la marca "Revisar" cuando ya se ha confirmado con el cliente
app.post('/api/orders/:id/reviewed', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.revisar = false;
  saveOrders(orders); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → revisado`);
  res.json(o);
});

app.post('/api/orders/:id/retry-print', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  try {
    await printTicket(o, o.pin);  // la reimpresión manual funciona aunque la automática esté apagada
    o.printError = null;
    o.printSkipped = false;
    saveOrders(orders); broadcast('order_updated', o);
    log('PRINT', `Reimpresión ${o.pin} OK`);
    res.json({ ok: true, order: o });
  } catch (err) {
    o.printError = { message: err.message, timestamp: new Date().toISOString(), retries: (o.printError?.retries ?? 0) + 1 };
    saveOrders(orders); broadcast('order_updated', o);
    log('ERROR', `Reimpresión ${o.pin}: ${err.message}`);
    logError({ origen: 'impresora', error: err, cliente: o.sender });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Relevos activos y devolver un cliente al bot antes de medianoche
app.get('/api/handoffs', (_req, res) => res.json(activeHandoffs()));
app.post('/api/handoffs/:sender/release', (req, res) => {
  if (!handoffs.delete(req.params.sender)) return res.status(404).json({ error: 'No encontrado' });
  saveHandoffs(); broadcast('handoffs', [...handoffs.values()]);
  log('WEB', `Cliente ${req.params.sender} devuelto al bot`);
  res.json({ ok: true });
});

// Registros para mejorar el bot: /api/incidencias?tipo=fallos|errores
app.get('/api/incidencias', (req, res) => {
  const tipo = req.query.tipo === 'errores' ? 'errores' : 'fallos';
  res.json(readRecent(tipo, Math.min(Number(req.query.limit) || 200, 1000)));
});

// Información para desarrolladores: estado de la IA, registros y proceso
const BOOT_TIME = Date.now();
app.get('/api/dev', (_req, res) => {
  const all = [...orders.values()];
  res.json({
    ia: getAiStats(),
    logs: logSummary(),
    whatsapp: { estado: waState },
    pedidos: {
      total: all.length,
      pendientes: all.filter(o => o.status === 'pending').length,
      paraRevisar: all.filter(o => o.revisar && !['done', 'discarded'].includes(o.status)).length,
      esperandoDia: pendingDay.size,
    },
    relevosActivos: activeHandoffs().length,
    impresionActiva: isPrintingEnabled(),
    productosEnCarta: catalog.productCount(),
    festivos: schedule.missingLocalHolidaysWarning(),
    sistema: {
      uptimeSeg: Math.round((Date.now() - BOOT_TIME) / 1000),
      arranque: new Date(BOOT_TIME).toISOString(),
      ahora: new Date().toISOString(),
      memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      host: HOST, puerto: Number(PORT),
    },
  });
});

// Activar o desactivar la impresión automática de tickets
app.post('/api/printing', (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled debe ser true o false' });
  setPrintingEnabled(req.body.enabled);
  const state = { enabled: isPrintingEnabled(), changedAt: getPrintingChangedAt() };
  broadcast('printing', state);
  log('WEB', `Impresión automática → ${state.enabled ? 'ACTIVADA' : 'DESACTIVADA'}`);
  res.json(state);
});

app.get('/api/printer', (_req, res) => res.json({ interface: getCurrentPrinter(), profile: getProfiles()[getCurrentPrinter()] }));

app.get('/api/printers', async (_req, res) => {
  const printers = await listWindowsPrinters();
  res.json({ printers, current: getCurrentPrinter(), profiles: getProfiles() });
});

const VALID_PROFILES = ['label_square', 'a4_paper'];

// Solo se aceptan impresoras que Windows tenga realmente instaladas.
async function resolvePrinter(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.replace(/^(printer:|tcp:\/\/)/i, '').trim();
  const installed = await listWindowsPrinters();
  return installed.includes(clean) ? clean : null;
}

app.post('/api/printer', async (req, res) => {
  const { interface: iface, profile } = req.body ?? {};
  const cleanPrinter = await resolvePrinter(iface);
  if (!cleanPrinter) return res.status(400).json({ error: 'Impresora no encontrada en Windows' });
  if (profile && !VALID_PROFILES.includes(profile)) return res.status(400).json({ error: 'Perfil inválido' });
  savePrinterConfig(cleanPrinter, profile);

  broadcast('printer_changed', { interface: cleanPrinter, profile: getProfiles()[cleanPrinter] });
  log('WEB', `Impresora activa → ${getPrinterName(cleanPrinter)} | Perfil: ${getProfiles()[cleanPrinter]}`);
  res.json({ ok: true, interface: cleanPrinter, profile: getProfiles()[cleanPrinter] });
});

app.post('/api/printer/test', async (req, res) => {
  const ifaceRaw = await resolvePrinter(req.body?.interface ?? getCurrentPrinter());
  if (!ifaceRaw) return res.status(400).json({ ok: false, error: 'Impresora no encontrada en Windows' });
  const profileRaw = VALID_PROFILES.includes(req.body?.profile) ? req.body.profile : (getProfiles()[ifaceRaw] ?? 'label_square');

  try {
    const mockOrder = { cliente: 'Prueba', diaCorto: schedule.formatShort(schedule.madridNow().key), articulos: [{ cantidad: '1 ud', producto: 'TEST IMPRESORA OK' }] };
    await printTicket(mockOrder, 'TEST', { printerName: ifaceRaw, profile: profileRaw });
    log('WEB', `Test impresora OK: ${getPrinterName(ifaceRaw)} (${profileRaw})`);
    res.json({ ok: true });
  } catch (err) {
    log('ERROR', `Test impresora: ${err.message}`);
    logError({ origen: 'impresora', error: err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/whatsapp/restart', (_req, res) => {
  log('SYS', 'Petición de reinicio de WhatsApp desde Panel...');
  res.json({ ok: true });
  setTimeout(() => process.exit(1), 1000);
});

app.post('/api/whatsapp/reset', async (_req, res) => {
  log('SYS', 'Petición de desvinculación completa de WhatsApp...');
  res.json({ ok: true });
  try { await client.destroy(); } catch {}
  try { fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(1), 1000);
});

// Antes escuchaba siempre en 0.0.0.0 aunque .env dijera HOST=127.0.0.1.
app.listen(Number(PORT), HOST, () => log('WEB', `Panel disponible en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (expuesto a la red local, sin contraseña)' : ''}`));

// ── WhatsApp ─────────────────────────────────────────────────────────────────
const BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const browserPath = BROWSER_PATHS.find(p => fs.existsSync(p));
if (!browserPath) {
  console.error('[ERROR] No se encontró Chrome ni Edge instalado.');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: { headless: true, executablePath: browserPath, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', qr => {
  waState = 'QR';
  waQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qr)}`;
  broadcastWaState();
  console.log('\n══════════════════════════════════════════════');
  console.log('   Escanea este QR con WhatsApp para vincular  ');
  console.log('══════════════════════════════════════════════\n');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', pct => { waState = 'STARTING'; broadcastWaState(); log('WA', `Cargando... ${pct}%`); });
client.on('ready', () => {
  waState = 'CONNECTED'; waQrUrl = ''; broadcastWaState(); log('OK', `WhatsApp conectado — ${SHOP_NAME}`);
  if (!restoredPending) { restoredPending = true; restorePending(); }
});
let restoredPending = false;
client.on('auth_failure', msg => { waState = 'ERROR'; broadcastWaState(); log('ERROR', `Auth: ${msg}`); logError({ origen: 'whatsapp', error: `auth_failure: ${msg}` }); process.exit(1); });
client.on('disconnected', why => { waState = 'ERROR'; broadcastWaState(); log('WARN', `Desconectado (${why}). Reiniciando...`); logError({ origen: 'whatsapp', error: `disconnected: ${why}` }); process.exit(1); });

const processedMsgIds = new Set();
const userBuffers = new Map();

// ── Elección de día pendiente ────────────────────────────────────────────────
// clave cliente -> { who, chatId, order, days, attempts, since, expiry, target }
// Se guarda en disco para que un reinicio del bot no deje la conversación a medias.
const PENDING_FILE = path.join(__dirname, 'pending.json');
const pendingDay = new Map();
const PENDING_DAY_TTL_MS = 10 * 60 * 1000;
const MAX_DAY_ATTEMPTS = 2;

function savePending() {
  try {
    const data = [...pendingDay.values()].map(({ who, chatId, order, days, attempts, since }) => ({ who, chatId, order, days, attempts, since }));
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
  } catch (e) { log('ERROR', `No se pudo guardar pending.json: ${e.message}`); }
}

function cancelPendingDay(key) {
  const item = pendingDay.get(key);
  if (item) { clearTimeout(item.expiry); pendingDay.delete(key); savePending(); }
  return item;
}

// Si el cliente no elige día, el pedido no se pierde: se registra marcado para revisar.
function setPendingDay(key, item, ttl = PENDING_DAY_TTL_MS) {
  const prev = pendingDay.get(key);
  if (prev && prev !== item) clearTimeout(prev.expiry);
  if (item.expiry) clearTimeout(item.expiry);
  item.since = item.since || Date.now();
  item.expiry = setTimeout(async () => {
    if (pendingDay.get(key) !== item) return;
    cancelPendingDay(key);
    log('WARN', `${item.who.phone} no eligió día; pedido registrado para revisar.`);
    markForReview(item.order, 'El cliente no eligió día de recogida');
    await finalizeAndPrintOrder(item.order, item.target || { chatId: item.chatId }, item.who, { categoria: 'sin_respuesta_dia' });
  }, Math.max(ttl, 1000));
  pendingDay.set(key, item);
  savePending();
}

// Al arrancar, recupera los pedidos que esperaban día antes del reinicio.
function restorePending() {
  let data = [];
  try { if (fs.existsSync(PENDING_FILE)) data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); }
  catch (e) { log('WARN', `pending.json: ${e.message}`); }
  for (const it of data) {
    if (!it?.who?.key || pendingDay.has(it.who.key)) continue;
    const left = PENDING_DAY_TTL_MS - (Date.now() - (it.since || 0));
    setPendingDay(it.who.key, { ...it, target: { chatId: it.chatId } }, left);
  }
  if (data.length) log('SYS', `${data.length} pedido(s) esperando día recuperados tras el reinicio.`);
}

function markForReview(order, motivo) {
  order.revisar = true;
  order.motivoRevision = order.motivoRevision ? `${order.motivoRevision} · ${motivo}` : motivo;
}

function setOrderDay(order, key) {
  order.dia = key;
  order.diaLargo = schedule.formatDay(key);
  order.diaCorto = schedule.formatShort(key);
}

function closedDayText(r) {
  const why = r.reason === 'domingo' ? 'cerramos los domingos'
    : r.reason === 'pasado' ? 'ese día ya ha pasado'
    : r.reason === 'fuera de plazo' ? 'solo cogemos pedidos para los próximos 7 días de apertura'
    : `estamos cerrados (${r.reason})`;
  return `El ${schedule.formatDay(r.closed)} no puede ser: ${why}.`;
}

// ── Mensajes entrantes ───────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: sin respuesta en ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(t));
}

// WhatsApp puede identificar al cliente con su número (…@c.us) o con un id interno (…@lid).
// Se usa el número real siempre que se pueda, para que los mensajes de una misma
// persona se reconozcan como la misma conversación y el panel muestre su teléfono.
const lidToPhone = new Map();
async function identify(msg) {
  const chatId = msg.from;
  const raw = chatId.split('@')[0];
  let phone = chatId.endsWith('@c.us') ? raw : lidToPhone.get(raw);
  if (!phone) {
    try {
      const contact = await withTimeout(msg.getContact(), 4000, 'getContact');
      const n = String(contact?.number || '').replace(/\D/g, '');
      if (n && n !== raw) phone = n;
    } catch (e) { log('WARN', `No se pudo obtener el teléfono de ${raw}: ${e.message}`); }
    if (phone) lidToPhone.set(raw, phone);
  }
  return { key: phone || raw, phone: phone || raw, chatId };
}

/** Envía un texto. target es el mensaje al que se responde o { chatId } si no hay mensaje (tras un reinicio). */
async function reply(target, text, who) {
  const chatId = target?.from || target?.chatId;
  const to = who?.phone || String(chatId || '').split('@')[0];
  try {
    if (typeof target?.reply === 'function') await withTimeout(target.reply(text), 20000, 'reply');
    else await withTimeout(client.sendMessage(chatId, text), 20000, 'sendMessage');
    log('OUT', `${to}: "${text.split('\n')[0].slice(0, 60)}"`);
    return true;
  } catch (e) {
    // Segundo intento sin citar el mensaje: a veces reply() falla y sendMessage() no.
    try {
      await withTimeout(client.sendMessage(chatId, text), 20000, 'sendMessage');
      log('OUT', `${to}: "${text.split('\n')[0].slice(0, 60)}" (reintento)`);
      return true;
    } catch (e2) {
      log('ERROR', `No se pudo enviar a ${to}: ${e2.message}`);
      logError({ origen: 'whatsapp', error: e2, cliente: to, mensaje: text.slice(0, 200) });
      return false;
    }
  }
}

client.on('message', async msg => {
  if (msg.fromMe || msg.from.includes('@g.us') || msg.from.includes('@broadcast') || msg.from === 'status@broadcast') return;
  if (processedMsgIds.has(msg.id._serialized)) return;
  processedMsgIds.add(msg.id._serialized);
  if (processedMsgIds.size > 1000) processedMsgIds.clear();

  const who = await identify(msg);
  const body = msg.body?.trim() || '';
  log('IN', `${who.phone}${who.phone !== msg.from.split('@')[0] ? ` (${msg.from})` : ''} [${msg.type}] "${body.slice(0, 60)}"${pendingDay.has(who.key) ? ' · esperando día' : ''}${isInHandoff(who.key) ? ' · en relevo, no se responde' : ''}`);
  if (isInHandoff(who.key)) return; // lo está atendiendo una persona

  // Audios, fotos, ubicaciones... el bot no los entiende: pasan a una persona.
  if (!body) {
    if (msg.hasMedia || ['ptt', 'audio', 'image', 'video', 'document', 'location', 'vcard', 'sticker'].includes(msg.type)) {
      await startHandoff(who, msg, `Mensaje no de texto (${msg.type})`, `[${msg.type}]`, MSG.relevo, 'multimedia');
    }
    return; // reacciones, avisos de cifrado, etc.: no son mensajes del cliente
  }
  if (body.length > 1500) {
    await startHandoff(who, msg, 'Mensaje demasiado largo', body.slice(0, 300) + '…', MSG.relevo, 'mensaje_largo');
    return;
  }

  if (!userBuffers.has(who.key)) userBuffers.set(who.key, { texts: [], msgs: [], timer: null });
  const buffer = userBuffers.get(who.key);
  buffer.texts.push(body);
  buffer.msgs.push(msg);
  if (buffer.timer) clearTimeout(buffer.timer);

  // Espera un poco por si el cliente manda el pedido en varios mensajes seguidos.
  buffer.timer = setTimeout(async () => {
    userBuffers.delete(who.key);
    const text = buffer.texts.join('. ');
    const lastMsg = buffer.msgs[buffer.msgs.length - 1];
    try {
      if (isInHandoff(who.key)) return;
      if (pendingDay.has(who.key)) await handleDayAnswer(who, text, lastMsg);
      else await handleMessage(who, text, lastMsg);
    } catch (e) {
      // Nunca se deja al cliente sin respuesta: si algo falla, pasa a una persona.
      log('ERROR', `Procesando mensaje de ${who.phone}: ${e.message}`);
      logError({ origen: 'sistema', error: e, cliente: who.phone, mensaje: text });
      await startHandoff(who, lastMsg, 'Error interno procesando el mensaje', text, MSG.relevo, 'error_interno');
    }
  }, 2500);
});

async function handleMessage(who, text, msg) {
  let res;
  try {
    res = await classifyMessage(text);
  } catch (e) {
    log('ERROR', `IA: ${e.message}`);
    logError({ origen: 'ia', error: e, cliente: who.phone, mensaje: text });
    await startHandoff(who, msg, 'IA no disponible', text, MSG.relevo, 'ia_caida');
    return;
  }
  if (res.invalid) logError({ origen: 'ia', error: 'Respuesta de la IA con formato no válido', cliente: who.phone, mensaje: text });
  log('IA', `${who.phone} → ${res.tipo}${res.motivo ? ` (${res.motivo})` : ''}`);

  switch (res.tipo) {
    case 'saludo':         return reply(msg, MSG.saludo, who);
    case 'agradecimiento': return reply(msg, MSG.agradecimiento, who);
    case 'horario':        return reply(msg, schedule.hoursReply(), who);
    case 'carta': {
      const menu = catalog.menuMessage();
      if (menu) return reply(msg, menu, who);
      logError({ origen: 'sistema', error: 'productos.json falta o está vacío', cliente: who.phone });
      return startHandoff(who, msg, 'Pide la carta y productos.json no está disponible', text);
    }
    case 'pedido':         return startOrder(who, res, text, msg);
    default:               return startHandoff(who, msg, res.motivo || 'La IA no sabe responder', text);
  }
}

async function startOrder(who, res, text, msg) {
  const order = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pin: genPin(orders),
    cliente: res.pedido.cliente ?? 'Cliente',
    dia: null, diaLargo: null, diaCorto: null,
    articulos: res.pedido.articulos,
    revisar: false, motivoRevision: null,
    mensajeOriginal: text,
    createdAt: new Date().toISOString(),
    status: 'pending',
    printError: null,
    sender: who.phone,
  };
  // El registro en fallos_bot.jsonl lo hace startHandoff al finalizar el pedido.
  if (res.revisar) markForReview(order, res.motivo || 'Revisar pedido');

  const days = schedule.getPickupDays(7);
  let prefix = '';
  // Si ya dijo el día en el propio pedido ("para el lunes"), no se le pregunta.
  if (res.pedido.dia_texto) {
    const r = schedule.parseDayAnswer(res.pedido.dia_texto, days, new Date(), { allowOptionNumber: false });
    if (r?.key) {
      setOrderDay(order, r.key);
      return finalizeAndPrintOrder(order, msg, who);
    }
    if (r?.closed) prefix = closedDayText(r) + '\n\n';
  }

  setPendingDay(who.key, { who, chatId: msg.from, order, days, attempts: 0, target: msg });
  log('DIA', `${who.phone}: pedido a la espera de elegir día`);
  await reply(msg, prefix + schedule.pickupDaysMessage(days), who);
}

async function handleDayAnswer(who, text, msg) {
  const item = pendingDay.get(who.key);
  item.target = msg;
  item.chatId = msg.from;
  const again = () => schedule.pickupDaysMessage(item.days);

  // Solo se toma directamente como día si el mensaje no trae nada más.
  // "También quiero 1 de albóndigas" pasa por la IA aunque contenga un número.
  const pure = schedule.isPureDayAnswer(text);
  let r = pure ? schedule.parseDayAnswer(text, item.days) : null;

  if (r?.key) {
    cancelPendingDay(who.key);
    setOrderDay(item.order, r.key);
    log('DIA', `${who.phone}: "${text}" → ${item.order.diaLargo}`);
    return finalizeAndPrintOrder(item.order, msg, who);
  }

  if (!r) {
    // El cliente puede escribir otra cosa mientras elige día: se le responde y se sigue esperando el día.
    let res = null;
    try { res = await classifyMessage(text); } catch (e) { logError({ origen: 'ia', error: e, cliente: who.phone, mensaje: text }); }
    log('DIA', `${who.phone}: "${text}" no es solo un día → ${res?.tipo ?? 'IA no disponible'}`);

    if (res?.tipo === 'pedido' && res.pedido?.articulos?.length) {
      // Añade al pedido en curso lo que pida de más.
      item.order.articulos.push(...res.pedido.articulos);
      item.order.mensajeOriginal += `\n${text}`;
      if (res.revisar) markForReview(item.order, res.motivo || 'Revisar pedido');
      savePending();
      log('DIA', `${who.phone}: añadidos ${res.pedido.articulos.map(a => `${a.cantidad} ${a.producto}`).join(', ')}`);
      const added = res.pedido.articulos.map(a => `• ${a.cantidad ? a.cantidad + ' ' : ''}${a.producto}`).join('\n');
      // "También 1 de albóndigas para el martes": añade y cierra con ese día.
      const diaDirecto = res.pedido.dia_texto && schedule.parseDayAnswer(res.pedido.dia_texto, item.days, new Date(), { allowOptionNumber: false });
      if (diaDirecto?.key) {
        cancelPendingDay(who.key);
        setOrderDay(item.order, diaDirecto.key);
        return finalizeAndPrintOrder(item.order, msg, who);
      }
      const resumen = item.order.articulos.map(a => `• ${a.cantidad ? a.cantidad + ' ' : ''}${a.producto}`).join('\n');
      const cierre = diaDirecto?.closed ? `${closedDayText(diaDirecto)}\n\n` : '';
      return reply(msg, `➕ Añadido a tu pedido:\n${added}\n\n🧾 Tu pedido ahora:\n${resumen}\n\n${cierre}${again()}`, who);
    }
    if (res?.tipo === 'horario') { await reply(msg, schedule.hoursReply(), who); return reply(msg, again(), who); }
    if (res?.tipo === 'carta' && catalog.menuMessage()) { await reply(msg, catalog.menuMessage(), who); return reply(msg, again(), who); }
    if (res?.tipo === 'saludo' || res?.tipo === 'agradecimiento') {
      return reply(msg, `Tu pedido está casi listo, solo falta el día de recogida.\n\n${again()}`, who);
    }
    // Ni pedido ni pregunta conocida: puede que sí sea un día escrito con más palabras.
    if (!pure) r = schedule.parseDayAnswer(text, item.days, new Date(), { allowOptionNumber: false });
    if (r?.key) {
      cancelPendingDay(who.key);
      setOrderDay(item.order, r.key);
      log('DIA', `${who.phone}: "${text}" → ${item.order.diaLargo}`);
      return finalizeAndPrintOrder(item.order, msg, who);
    }
    if (!r && (res?.tipo === 'relevo' || !res)) {
      // No sabe responder (o la IA está caída): se registra el pedido y pasa a una persona.
      cancelPendingDay(who.key);
      markForReview(item.order, 'Falta confirmar el día de recogida');
      await finalizeAndPrintOrder(item.order, msg, who, { handoffMotivo: res?.motivo || 'Pregunta durante la elección de día', handoffTexto: text, categoria: res ? 'consulta' : 'ia_caida' });
      return;
    }
  }

  item.attempts++;
  savePending();
  if (item.attempts >= MAX_DAY_ATTEMPTS) {
    cancelPendingDay(who.key);
    markForReview(item.order, 'No se entendió el día de recogida');
    await finalizeAndPrintOrder(item.order, msg, who, { handoffMotivo: 'No se entendió el día de recogida', handoffTexto: text, categoria: 'dia_no_entendido' });
    return;
  }
  const head = r?.closed ? closedDayText(r) : MSG.diaNoEntendido;
  await reply(msg, `${head}\n\n${again()}`, who);
}

async function finalizeAndPrintOrder(record, target, who, { handoffMotivo, handoffTexto, categoria = 'pedido_dudoso' } = {}) {
  orders.set(record.id, record);
  saveOrders(orders);
  broadcast('new_order', record);
  log('PEDIDO', `PIN ${record.pin} · ${record.sender} · ${record.diaLargo || 'sin día'}${record.revisar ? ' · REVISAR' : ''}`);

  // Primero se confirma al cliente y después se imprime: una impresora lenta,
  // sin papel o atascada nunca debe dejar al cliente sin respuesta.
  const lista = record.articulos.map(a => `• ${a.cantidad ? a.cantidad + ' ' : ''}${a.producto}`).join('\n');
  const diaTexto = record.dia ? `\n\n📅 Recogida: *${record.diaLargo}*` : '';
  let texto = `✅ ¡Pedido recibido!\n\n${lista}${diaTexto}\n\nCódigo de recogida: *${record.pin}*\nIndícalo al llegar al mostrador.`;
  if (record.revisar) texto += `\n\n${MSG.relevoPedido}`;
  const sent = await reply(target, texto, who);

  // Un pedido marcado para revisar, o cuya confirmación no llegó, pasa a una persona.
  if (record.revisar || !sent) {
    await startHandoff(who, target, handoffMotivo || record.motivoRevision || (sent ? 'Pedido para revisar' : 'No se pudo enviar la confirmación del pedido'),
      handoffTexto || record.mensajeOriginal, null, sent ? categoria : 'error_interno');
  }

  printOrder(record); // en segundo plano
}

async function printOrder(record) {
  if (!isPrintingEnabled()) {
    // Modo pruebas: no se gasta papel. El pedido queda marcado para poder imprimirlo luego a mano.
    record.printSkipped = true;
    saveOrders(orders); broadcast('order_updated', record);
    log('PRINT', `Impresión desactivada: ticket ${record.pin} NO impreso`);
    return;
  }
  try {
    await printTicket(record, record.pin);
    log('PRINT', `Ticket ${record.pin} enviado a la impresora`);
  } catch (err) {
    log('ERROR', `Impresora (${record.pin}): ${err.message}`);
    logError({ origen: 'impresora', error: err, cliente: record.sender });
    record.printError = { message: err.message, timestamp: new Date().toISOString(), retries: 0 };
    saveOrders(orders); broadcast('order_updated', record);
  }
}

process.on('SIGINT', async () => {
  log('SYS', 'Cerrando servicio...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

process.on('unhandledRejection', err => {
  log('ERROR', `Promesa no controlada: ${err?.message ?? err}`);
  logError({ origen: 'sistema', error: err });
});

log('BOOT', `Iniciando ${SHOP_NAME}...`);
if (!isPrintingEnabled()) log('WARN', 'La impresión automática está DESACTIVADA (modo pruebas). Actívala desde el panel.');
const festivosWarn = schedule.missingLocalHolidaysWarning();
if (festivosWarn) log('WARN', festivosWarn);
client.initialize();