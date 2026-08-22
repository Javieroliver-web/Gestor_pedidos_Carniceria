'use strict';
require('dotenv').config();

const { Client, LocalAuth }       = require('whatsapp-web.js');
const qrcode                      = require('qrcode-terminal');
const Groq                        = require('groq-sdk');
const express                     = require('express');
const path                        = require('path');
const fs                          = require('fs');
const { exec }                    = require('child_process');
const util                        = require('util');

const execPromise = util.promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
//  Configuración
// ─────────────────────────────────────────────────────────────────────────────

const {
  GROQ_API_KEY,
  PRINTER_INTERFACE = 'Brother TD-4000',
  SHOP_NAME         = 'CARNICERÍA RAÚL OLIVER',
  PORT              = '3000',
} = process.env;

if (!GROQ_API_KEY) {
  console.error('[ERROR] Falta GROQ_API_KEY en .env');
  console.error('[INFO]  Obtener clave gratuita en: https://console.groq.com');
  process.exit(1);
}

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${ts}] [${tag.padEnd(5)}] ${msg}`);
}

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { log('WARN', `config.json: ${e.message}`); }
  return {};
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch (e) { log('ERROR', `No se pudo guardar config.json: ${e.message}`); }
}

const config = loadConfig();
let rawPrinter = config.activePrinter || config.printerInterface || PRINTER_INTERFACE;
let currentPrinter = rawPrinter.replace(/^(printer:|tcp:\/\/)/i, '').trim();

// Diccionario que recuerda el perfil de cada impresora guardada
let printerProfiles = config.profiles || {};

function getPrinterName(iface) {
  return (iface || '').replace(/^printer:/i, '').trim();
}

function listWindowsPrinters() {
  return new Promise(resolve => {
    const cmd = 'powershell -NoProfile -Command "@(Get-Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"';
    exec(cmd, { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { resolve([]); }
    });
  });
}

const ORDER_RE = /\b(kilo|kg|gramo|gr|pechuga|pollo|ternera|cerdo|chorizo|morcilla|chuleta|filete|costill|jamón|jamon|lomo|buey|cordero|conejo|pavo|loncha|trozo|picad|entero|medio|cuarto|unidad|pieza|chuletón|secreto|solomillo|magro)\b/i;

const processedMsgIds = new Set();

// PIN 100% NUMÉRICO
function genPin() {
  const chars = '0123456789';
  return [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const ORDERS_FILE = path.join(__dirname, 'orders.json');

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      return new Map(arr.map(o => [o.id, o]));
    }
  } catch (e) { log('WARN', `orders.json: ${e.message}`); }
  return new Map();
}

const orders = loadOrders();

function saveOrders() {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify([...orders.values()], null, 2)); }
  catch (e) { log('ERROR', `No se pudo guardar orders.json: ${e.message}`); }
}

function cleanupOldOrders() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let n = 0;
  for (const [id, o] of orders) {
    if (['done', 'discarded'].includes(o.status) && new Date(o.createdAt).getTime() < cutoff) {
      orders.delete(id); n++;
    }
  }
  if (n > 0) { saveOrders(); log('CLEAN', `${n} pedido(s) antiguos eliminados.`); }
}

cleanupOldOrders();
setInterval(cleanupOldOrders, 6 * 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
//  ESTADO GLOBAL DE WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────
let waState = 'STARTING'; // STARTING, QR, CONNECTED, ERROR
let waQrUrl = '';

function broadcastWaState() {
  broadcast('wa_state', { state: waState, qr: waQrUrl });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SSE (Server-Sent Events)
// ─────────────────────────────────────────────────────────────────────────────

const sseClients = new Set();
function sseWrite(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of sseClients) sseWrite(res, event, data); }

// ═════════════════════════════════════════════════════════════════════════════
//  ENRUTADOR DE IMPRESIÓN (STRATEGY PATTERN)
// ═════════════════════════════════════════════════════════════════════════════

async function printTicket(order, pin) {
  const printerName = getPrinterName(currentPrinter);
  if (!printerName) throw new Error('No hay ninguna impresora configurada.');

  // Obtener el perfil guardado para esta impresora específica (por defecto cuadrada)
  const profile = printerProfiles[printerName] || 'label_square';

  if (profile === 'a4_paper') {
    await printA4(order, pin, printerName);
  } else {
    await printSquareLabel(order, pin, printerName);
  }
}

// ── PERFIL 1: ETIQUETA CUADRADA 76x76mm (.NET Nativo con Papel Forzado a 76x76) ─────────
async function printSquareLabel(order, pin, printerName) {
  const now       = new Date();
  const fecha     = now.toLocaleDateString('es-ES');
  const hora      = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  const separator = ' - - - - - - - - - - - - - - - - ';

  let ticketText = `   CARNICERIA RAUL OLIVER\n`;
  ticketText += `${separator}\n`;
  ticketText += `      PIN DE PEDIDO: ${pin}\n`;
  ticketText += `   Fecha: ${fecha}  ${hora}\n`;
  ticketText += `${separator}\n`;

  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') {
    ticketText += ` Cliente: ${order.cliente}\n`;
    ticketText += `${separator}\n`;
  }

  for (const item of order.articulos) {
    const cant = (item.cantidad || '').padEnd(10, ' ');
    ticketText += ` * ${cant} ${item.producto}\n`;
  }

  ticketText += `${separator}\n`;
  ticketText += `   Indica tu PIN en mostrador.`;

  const tempFilePath = path.join(__dirname, `ticket_${pin}_${Date.now()}.txt`);

  try {
    fs.writeFileSync(tempFilePath, ticketText, 'utf8');

    // Script robusto de .NET forzando el papel a 76x76mm por código
    const psScript = `
      $printerName = '${printerName}';
      $filePath = '${tempFilePath.replace(/\\/g, '\\\\')}';
      $content = Get-Content -Path $filePath -Raw -Encoding UTF8;
      
      Add-Type -AssemblyName System.Drawing;
      $printDocument = New-Object System.Drawing.Printing.PrintDocument;
      $printDocument.PrinterSettings.PrinterName = $printerName;
      
      if (-not $printDocument.PrinterSettings.IsValid) {
          throw "La impresora '$printerName' no es válida.";
      }
      
      # FORZAR TAMAÑO 76x76 mm (76mm = 2.99 pulgadas -> 100 centésimas de pulgada = 299)
      $pageSettings = New-Object System.Drawing.Printing.PageSettings;
      $customSize = New-Object System.Drawing.Printing.PaperSize('Custom-76x76', 299, 299);
      $pageSettings.PaperSize = $customSize;
      
      # Márgenes a 0 para aprovechar toda la pegatina
      $pageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 10, 10);
      $printDocument.DefaultPageSettings = $pageSettings;
      
      $printDocument.add_PrintPage({
          param($sender, $e)
          $font = New-Object System.Drawing.Font('Consolas', 10);
          $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black);
          $e.Graphics.DrawString($content, $font, $brush, 0, 0);
      }.GetNewClosure());
      
      $printDocument.Print();
    `;

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    const command = `powershell -NoProfile -EncodedCommand ${encodedCommand}`;

    await execPromise(command, { timeout: 15000 });
    log('PRINT', `Etiqueta 76x76 .NET ${pin} enviada a: ${printerName}`);
  } finally {
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  }
}

// ── PERFIL 2: FOLIO A4 ────────────────────────────────────
async function printA4(order, pin, printerName) {
  const now       = new Date();
  const fecha     = now.toLocaleDateString('es-ES');
  const hora      = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  const separator = '='.repeat(60);
  const subSeparator = '-'.repeat(60);

  let ticketText = `\n\n`;
  ticketText += `   ${SHOP_NAME}\n`;
  ticketText += `   Documento de Pedido / Recogida\n`;
  ticketText += `   ${separator}\n\n`;
  ticketText += `   >> CÓDIGO DE RECOGIDA (PIN): ${pin} <<\n\n`;
  ticketText += `   ${separator}\n`;
  ticketText += `   Fecha: ${fecha}       Hora: ${hora}\n`;

  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') {
    ticketText += `   Cliente: ${order.cliente}\n`;
  }
  
  ticketText += `   ${subSeparator}\n\n`;

  for (const item of order.articulos) {
    const cant = (item.cantidad || '').padEnd(12, ' ');
    ticketText += `   ${cant} ${item.producto}\n`;
  }

  ticketText += `\n   ${separator}\n`;
  ticketText += `   Gracias por su confianza.\n\n\n`;

  const tempFilePath = path.join(__dirname, `ticket_${pin}_A4_${Date.now()}.txt`);

  try {
    fs.writeFileSync(tempFilePath, '\ufeff' + ticketText, 'utf8');
    const command = `notepad.exe /pt "${tempFilePath}" "${printerName}"`;
    await execPromise(command, { timeout: 20000 });
    log('PRINT', `Folio A4 ${pin} enviado a: ${printerName}`);
  } finally {
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  WEB SERVER
// ═════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  sseWrite(res, 'init', {
    orders:   [...orders.values()],
    shopName: SHOP_NAME,
    printer:  currentPrinter,
    profiles: printerProfiles,
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
  saveOrders(); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → LISTO`);
  res.json(o);
});

app.post('/api/orders/:id/done', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.status = 'done';
  saveOrders(); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → RECOGIDO`);
  res.json(o);
});

app.post('/api/orders/:id/discard', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  if (['done', 'discarded'].includes(o.status)) return res.status(400).json({ error: 'Estado no permite descartar' });
  o.status = 'discarded';
  o.discardedAt = new Date().toISOString();
  saveOrders(); broadcast('order_updated', o);
  log('WEB', `Pedido ${o.pin} → DESCARTADO`);
  res.json(o);
});

app.post('/api/orders/:id/retry-print', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  try {
    await printTicket(o, o.pin);
    o.printError = null;
    saveOrders(); broadcast('order_updated', o);
    log('PRINT', `Reimpresión ${o.pin} OK`);
    res.json({ ok: true, order: o });
  } catch (err) {
    o.printError = { message: err.message, timestamp: new Date().toISOString(), retries: (o.printError?.retries ?? 0) + 1 };
    saveOrders(); broadcast('order_updated', o);
    log('ERROR', `Reimpresión ${o.pin}: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/printer', (_req, res) => res.json({ interface: currentPrinter, profile: printerProfiles[currentPrinter] }));

app.get('/api/printers', async (_req, res) => {
  const printers = await listWindowsPrinters();
  res.json({ printers, current: currentPrinter, profiles: printerProfiles });
});

app.post('/api/printer', (req, res) => {
  const { interface: iface, profile } = req.body;
  if (!iface || typeof iface !== 'string' || !iface.trim()) return res.status(400).json({ error: 'Interfaz inválida' });
  
  currentPrinter = iface.replace(/^(printer:|tcp:\/\/)/i, '').trim();
  
  if (profile) {
    printerProfiles[currentPrinter] = profile; 
  }

  config.activePrinter = currentPrinter;
  config.profiles = printerProfiles;
  saveConfig(config);
  
  broadcast('printer_changed', { interface: currentPrinter, profile: printerProfiles[currentPrinter] });
  log('WEB', `Impresora activa → ${getPrinterName(currentPrinter)} | Perfil: ${printerProfiles[currentPrinter]}`);
  res.json({ ok: true, interface: currentPrinter, profile: printerProfiles[currentPrinter] });
});

app.post('/api/printer/test', async (req, res) => {
  const ifaceRaw = (req.body?.interface ?? currentPrinter).trim();
  const profileRaw = req.body?.profile ?? printerProfiles[currentPrinter] ?? 'label_square';
  
  const prevPrinter = currentPrinter;
  const prevProfiles = { ...printerProfiles };
  
  currentPrinter = ifaceRaw;
  printerProfiles[ifaceRaw] = profileRaw;
  
  try {
    const mockOrder = { cliente: 'Prueba', articulos: [{ cantidad: '1 ud', producto: 'TEST IMPRESORA OK' }] };
    await printTicket(mockOrder, 'TEST');
    log('WEB', `Test impresora OK: ${getPrinterName(ifaceRaw)} (${profileRaw})`);
    res.json({ ok: true });
  } catch (err) {
    log('ERROR', `Test impresora: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    currentPrinter = prevPrinter; 
    printerProfiles = prevProfiles;
  }
});

// ── Endpoints de WhatsApp ────────────────────────────────────────────────────
app.post('/api/whatsapp/restart', (req, res) => {
  log('SYS', 'Petición de reinicio de WhatsApp desde Panel...');
  res.json({ ok: true });
  setTimeout(() => process.exit(1), 1000); 
});

app.post('/api/whatsapp/reset', async (req, res) => {
  log('SYS', 'Petición de desvinculación completa de WhatsApp...');
  res.json({ ok: true });
  try { await client.destroy(); } catch {}
  try { fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(1), 1000);
});

app.listen(Number(PORT), '0.0.0.0', () => log('WEB', `Panel disponible en http://localhost:${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
//  GROQ
// ─────────────────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: GROQ_API_KEY });

async function extractOrder(text) {
  const response = await groq.chat.completions.create({
    model:       'llama3-8b-8192',
    temperature: 0.1,
    max_tokens:  400,
    messages: [{
      role:    'user',
      content:
        'Eres el sistema de una carnicería española. Extrae los datos del pedido del siguiente mensaje de WhatsApp.\n' +
        'Devuelve ÚNICAMENTE un objeto JSON válido, sin markdown ni texto extra, con este formato exacto:\n' +
        '{"cliente":"nombre o Cliente si no lo dice","articulos":[{"cantidad":"X kg/g/uds","producto":"nombre del producto"}]}\n' +
        `Mensaje: ${text}`,
    }],
  });

  const raw   = response.choices[0]?.message?.content?.trim() ?? '';
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*?\}/); return m ? JSON.parse(m[0]) : null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────

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
  puppeteer: {
    headless: true,
    executablePath: browserPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
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

client.on('loading_screen', pct => {
  waState = 'STARTING';
  broadcastWaState();
  log('WA', `Cargando... ${pct}%`);
});

client.on('ready', () => { 
  waState = 'CONNECTED';
  waQrUrl = '';
  broadcastWaState();
  log('OK',   `WhatsApp conectado — ${SHOP_NAME}`); 
});

client.on('auth_failure', msg => { 
  waState = 'ERROR';
  broadcastWaState();
  log('ERROR', `Auth: ${msg}`); 
  process.exit(1); 
});

client.on('disconnected', why => { 
  waState = 'ERROR';
  broadcastWaState();
  log('WARN',  `Desconectado (${why}). Reiniciando...`); 
  process.exit(1); 
});

client.on('message', async msg => {
  if (msg.fromMe || msg.from.includes('@g.us') || msg.from.includes('@broadcast') || !msg.body?.trim()) return;
  if (processedMsgIds.has(msg.id._serialized)) return;
  processedMsgIds.add(msg.id._serialized);

  const text   = msg.body.trim();
  const sender = msg.from.split('@')[0];
  log('MSG', `${sender}: "${text.substring(0, 60)}${text.length > 60 ? '…' : ''}"`);

  if (!ORDER_RE.test(text)) return;
  
  let order;
  try {
    order = await extractOrder(text);
  } catch (e) {
    log('ERROR', `Groq: ${e.message}`);
    const isRateLimit = e.status === 429 || e.message?.includes('[429]') || e.message?.includes('RESOURCE_EXHAUSTED');
    if (isRateLimit) {
      try {
        await msg.reply('⚠️ El sistema de recepción automática está saturado temporalmente.\nUn trabajador confirmará tu pedido en breve.');
      } catch {}
    }
    return;
  }

  if (!order?.articulos?.length) return;

  const pin    = genPin();
  const id     = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const record = {
    id, pin,
    cliente:    order.cliente  ?? 'Cliente',
    articulos:  order.articulos,
    createdAt:  new Date().toISOString(),
    status:     'pending',
    printError: null,
    sender,
  };

  orders.set(id, record);
  saveOrders();
  broadcast('new_order', record);

  try {
    await printTicket(record, pin);
  } catch (err) {
    log('ERROR', `Impresora: ${err.message}`);
    record.printError = { message: err.message, timestamp: new Date().toISOString(), retries: 0 };
    saveOrders(); broadcast('order_updated', record);
  }

  try {
    const lista = order.articulos.map(a => `• ${a.cantidad} ${a.producto}`).join('\n');
    await msg.reply(`✅ ¡Pedido recibido!\n\n${lista}\n\nCódigo de recogida: *${pin}*\nIndícalo al llegar al mostrador.`);
  } catch (e) { log('ERROR', `Reply WhatsApp: ${e.message}`); }
});

process.on('SIGINT', async () => {
  log('SYS', 'Cerrando servicio...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

log('BOOT', `Iniciando ${SHOP_NAME}...`);
client.initialize();