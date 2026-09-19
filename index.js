'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const {
  SHOP_NAME, PORT, log,
  loadOrders, saveOrders,
  getCurrentPrinter, setCurrentPrinter, getProfiles, savePrinterConfig,
  genPin, getPrinterName
} = require('./src/config');

const { extractOrder, extractTimeOnly } = require('./src/services/aiService');
const { printTicket, listWindowsPrinters } = require('./src/services/printService');

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
    waQrUrl:  waQrUrl
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

app.post('/api/orders/:id/retry-print', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  try {
    await printTicket(o, o.pin);
    o.printError = null;
    saveOrders(orders); broadcast('order_updated', o);
    log('PRINT', `Reimpresión ${o.pin} OK`);
    res.json({ ok: true, order: o });
  } catch (err) {
    o.printError = { message: err.message, timestamp: new Date().toISOString(), retries: (o.printError?.retries ?? 0) + 1 };
    saveOrders(orders); broadcast('order_updated', o);
    log('ERROR', `Reimpresión ${o.pin}: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/printer', (_req, res) => res.json({ interface: getCurrentPrinter(), profile: getProfiles()[getCurrentPrinter()] }));

app.get('/api/printers', async (_req, res) => {
  const printers = await listWindowsPrinters();
  res.json({ printers, current: getCurrentPrinter(), profiles: getProfiles() });
});

app.post('/api/printer', (req, res) => {
  const { interface: iface, profile } = req.body;
  if (!iface || typeof iface !== 'string' || !iface.trim()) return res.status(400).json({ error: 'Interfaz inválida' });
  
  const cleanPrinter = iface.replace(/^(printer:|tcp:\/\/)/i, '').trim();
  savePrinterConfig(cleanPrinter, profile);
  
  broadcast('printer_changed', { interface: cleanPrinter, profile: getProfiles()[cleanPrinter] });
  log('WEB', `Impresora activa → ${getPrinterName(cleanPrinter)} | Perfil: ${getProfiles()[cleanPrinter]}`);
  res.json({ ok: true, interface: cleanPrinter, profile: getProfiles()[cleanPrinter] });
});

app.post('/api/printer/test', async (req, res) => {
  const ifaceRaw = (req.body?.interface ?? getCurrentPrinter()).trim();
  const profileRaw = req.body?.profile ?? getProfiles()[getCurrentPrinter()] ?? 'label_square';
  
  const prevPrinter = getCurrentPrinter();
  
  setCurrentPrinter(ifaceRaw);
  
  try {
    const mockOrder = { cliente: 'Prueba', articulos: [{ cantidad: '1 ud', producto: 'TEST IMPRESORA OK' }] };
    await printTicket(mockOrder, 'TEST');
    log('WEB', `Test impresora OK: ${getPrinterName(ifaceRaw)} (${profileRaw})`);
    res.json({ ok: true });
  } catch (err) {
    log('ERROR', `Test impresora: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    setCurrentPrinter(prevPrinter);
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

app.listen(Number(PORT), '0.0.0.0', () => log('WEB', `Panel disponible en http://localhost:${PORT}`));

// ── WhatsApp & Buffer de Mensajes ────────────────────────────────────────────
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
client.on('ready', () => { waState = 'CONNECTED'; waQrUrl = ''; broadcastWaState(); log('OK', `WhatsApp conectado — ${SHOP_NAME}`); });
client.on('auth_failure', msg => { waState = 'ERROR'; broadcastWaState(); log('ERROR', `Auth: ${msg}`); process.exit(1); });
client.on('disconnected', why => { waState = 'ERROR'; broadcastWaState(); log('WARN', `Desconectado (${why}). Reiniciando...`); process.exit(1); });

const processedMsgIds = new Set();
const userBuffers = new Map();
const pendingHourClients = new Map();

client.on('message', async msg => {
  if (msg.fromMe || msg.from.includes('@g.us') || msg.from.includes('@broadcast') || !msg.body?.trim()) return;
  if (msg.body.length > 1500) return;
  if (processedMsgIds.has(msg.id._serialized)) return;
  
  processedMsgIds.add(msg.id._serialized);
  if (processedMsgIds.size > 1000) processedMsgIds.clear();

  const senderId = msg.from;
  const text     = msg.body.trim();

  if (!userBuffers.has(senderId)) {
    userBuffers.set(senderId, { texts: [], msgs: [], timer: null });
  }

  const buffer = userBuffers.get(senderId);
  buffer.texts.push(text);
  buffer.msgs.push(msg);

  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(async () => {
    const combinedText = buffer.texts.join('. ');
    const lastMsg = buffer.msgs[buffer.msgs.length - 1];
    userBuffers.delete(senderId);

    // ── GESTIÓN DE HORA PENDIENTE ──────────────────────────────────────────
    if (pendingHourClients.has(senderId)) {
      const item = pendingHourClients.get(senderId);
      pendingHourClients.delete(senderId); // Lo extraemos de inmediato para evitar bloqueos

      try {
        let selectedTime = null;
        const cleanText = combinedText.trim();

        if (item.options && item.options[cleanText]) {
          selectedTime = item.options[cleanText];
        } else if (['4', 'sin hora', 'no sé', 'no lo sé', 'da igual'].some(kw => cleanText.toLowerCase().includes(kw))) {
          selectedTime = null;
        } else {
          const extractedResponse = await extractTimeOnly(cleanText);
          if (extractedResponse === 'ES_PREGUNTA') {
            const resp = await extractOrder(cleanText);
            if (resp?.tipo === 'chat' && resp.respuesta_chat) {
               try { await lastMsg.reply(resp.respuesta_chat); } catch {}
               pendingHourClients.set(senderId, item); // Devolvemos el estado al pendiente
               return; 
            } else {
               try { await lastMsg.reply('Por favor, selecciona una opción del 1 al 4 o dime tu hora de recogida.'); } catch {}
               pendingHourClients.set(senderId, item);
               return;
             }
          }
          selectedTime = (extractedResponse === 'SIN_HORA' || !extractedResponse) ? cleanText : extractedResponse;
        }

        const pendingOrder = item.order;
        pendingOrder.hora = selectedTime;
        await finalizeAndPrintOrder(pendingOrder, lastMsg);

      } catch (error) {
        log('ERROR', `SISTEMA IA (Hora): ${error.message}`);
        // Fallback robusto: si la IA falla, guardamos el texto literal como hora para que el pedido no se pierda
        const pendingOrder = item.order;
        pendingOrder.hora = combinedText; 
        await finalizeAndPrintOrder(pendingOrder, lastMsg);
      }
    } else {
      // ── FLUJO GENERAL DE PEDIDOS Y CHAT ──────────────────────────────────
      await processOrder(senderId, combinedText, lastMsg);
    }
  }, 1000);
});

async function processOrder(senderId, text, msg) {
  const sender = senderId.split('@')[0];
  log('MSG', `${sender}: "${text.substring(0, 60)}${text.length > 60 ? '…' : ''}"`);
  
  let responseObj;
  try {
    responseObj = await extractOrder(text);
  } catch (e) {
    log('ERROR', `SISTEMA IA: ${e.message}`);
    try { await msg.reply('⚠️ El asistente virtual está teniendo problemas temporales. Un trabajador confirmará tu mensaje pronto.'); } catch {}
    return;
  }

  if (responseObj?.tipo === 'chat' && responseObj.respuesta_chat) {
    try { await msg.reply(responseObj.respuesta_chat); } catch {}
    return; 
  }

  const order = responseObj?.pedido;
  if (!order?.articulos?.length) {
    try { await msg.reply('¡Hola! Soy el asistente virtual de la Carnicería Raúl Oliver. ¿En qué puedo ayudarte hoy o qué te gustaría pedir?'); } catch {}
    return;
  }

  const pin    = genPin();
  const id     = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const record = {
    id, pin,
    cliente:    order.cliente  ?? 'Cliente',
    hora:       order.hora     ?? null,
    articulos:  order.articulos,
    createdAt:  new Date().toISOString(),
    status:     'pending',
    printError: null,
    sender,
  };

  if (!record.hora || String(record.hora).toLowerCase() === 'null' || record.hora === 'no sé' || String(record.hora).toLowerCase() === 'sin_hora') {
    const options = {
      '1': 'Mañana (09:30 - 11:00)',
      '2': 'Mediodía (12:00 - 13:30)',
      '3': 'Tarde (18:00 - 20:00)',
      '4': 'Sin hora fija'
    };

    pendingHourClients.set(senderId, { order: record, options });

    try {
      await msg.reply(
        `🕒 ¿A qué hora te gustaría pasar a recoger tu pedido?\n\n` +
        `*Responde con el número de opción:* \n` +
        `1️⃣ Mañana (09:30 - 11:00)\n` +
        `2️⃣ Mediodía (12:00 - 13:30)\n` +
        `3️⃣ Tarde (18:00 - 20:00)\n` +
        `4️⃣ Sin hora fija\n\n` +
        `_(O escribe directamente tu hora exacta, ej: 18:00)_`
      );
    } catch {}
    return;
  }

  await finalizeAndPrintOrder(record, msg);
}

async function finalizeAndPrintOrder(record, msg) {
  orders.set(record.id, record);
  saveOrders(orders);
  broadcast('new_order', record);

  try {
    await printTicket(record, record.pin);
  } catch (err) {
    log('ERROR', `Impresora: ${err.message}`);
    record.printError = { message: err.message, timestamp: new Date().toISOString(), retries: 0 };
    saveOrders(orders); broadcast('order_updated', record);
  }

  try {
    const lista = record.articulos.map(a => `• ${a.cantidad} ${a.producto}`).join('\n');
    const horaTexto = record.hora ? `\nHora de recogida: *${record.hora}*` : '';
    await msg.reply(`✅ ¡Pedido recibido!\n\n${lista}${horaTexto}\n\nCódigo de recogida: *${record.pin}*\nIndícalo al llegar al mostrador.`);
  } catch (e) { log('ERROR', `Reply WhatsApp: ${e.message}`); }
}

process.on('SIGINT', async () => {
  log('SYS', 'Cerrando servicio...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

log('BOOT', `Iniciando ${SHOP_NAME}...`);
client.initialize();