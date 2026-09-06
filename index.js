'use strict';
require('dotenv').config();

const { Client, LocalAuth }       = require('whatsapp-web.js');
const qrcode                      = require('qrcode-terminal');
const Groq                        = require('groq-sdk');
const express                     = require('express');
const path                        = require('path');
const fs                          = require('fs');
const { exec, execFile }          = require('child_process');
const os                          = require('os');
const util                        = require('util');

const execPromise     = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
//  Configuración
// ─────────────────────────────────────────────────────────────────────────────

const {
  GROQ_API_KEY,
  PRINTER_INTERFACE = 'Brother TD-4000',
  SHOP_NAME         = 'CARNICERÍA RAÚL OLIVER',
  PORT              = '3000',
  // 0.0.0.0 expone el panel a toda la red local y NO hay autenticación.
  // Si solo se usa desde este mismo PC, poner HOST=127.0.0.1 en el .env.
  HOST              = '0.0.0.0',
} = process.env;

const SERVER_PORT = Number(PORT);
if (!Number.isInteger(SERVER_PORT) || SERVER_PORT < 1 || SERVER_PORT > 65535) {
  console.error(`[ERROR] PORT inválido en .env: "${PORT}"`);
  process.exit(1);
}

if (!GROQ_API_KEY) {
  console.error('[ERROR] Falta GROQ_API_KEY en .env');
  console.error('[INFO]  Obtener clave gratuita en: https://console.groq.com');
  process.exit(1);
}

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${ts}] [${tag.padEnd(5)}] ${msg}`);
}

function centrar(txt, ancho) {
  const t = String(txt).slice(0, ancho);
  return ' '.repeat(Math.max(0, Math.floor((ancho - t.length) / 2))) + t;
}

// Escritura atómica: se vuelca a un temporal y se renombra, así un corte de luz
// a mitad de la escritura no puede dejar el JSON truncado.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Un archivo ilegible se aparta en vez de dejar que la siguiente escritura lo pise.
function quarantineFile(file) {
  try {
    if (fs.existsSync(file)) {
      const bak = `${file}.corrupto-${Date.now()}.bak`;
      fs.renameSync(file, bak);
      log('WARN', `Copia del archivo dañado guardada en ${path.basename(bak)}`);
    }
  } catch {}
}

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    log('WARN', `config.json ilegible: ${e.message}`);
    quarantineFile(CONFIG_FILE);
  }
  return {};
}

function saveConfig(cfg) {
  try { writeJsonAtomic(CONFIG_FILE, cfg); }
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

const ORDER_RE = /\b(kilo|kg|gramo|gr|pechuga|pollo|ternera|cerdo|chorizo|morcilla|chuleta|filete|costill|jam[oó]n|lomo|buey|cordero|conejo|pavo|loncha|trozo|picad|entero|medio|cuarto|unidad|pieza|chulet[oó]n|secreto|solomillo|magro|alb[oó]ndiga|alita|bartolito|berenjena|bomba|brocheta|burrito|cachopo|carrillada|chistorra|churrasco|churrasquito|contramuslo|cordon|flamenqu[ií]n|hamburguesa|jamoncito|lagrimita|lolito|magdalena|pastel|pimiento|pincho|rotin|salchicha|san\s*jacobo|s[aá]ndwich|taquito)\b/i;

const processedMsgIds = new Set();

// PIN 100% NUMÉRICO
function randomPin() {
  const chars = '0123456789';
  return [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Dos pedidos abiertos con el mismo PIN son indistinguibles en mostrador, así que
// no se reutiliza ninguno que siga en circulación.
function genPin() {
  const enUso = new Set(
    [...orders.values()]
      .filter(o => !['done', 'discarded'].includes(o.status))
      .map(o => o.pin)
  );
  for (let i = 0; i < 50; i++) {
    const pin = randomPin();
    if (!enUso.has(pin)) return pin;
  }
  // Espacio casi lleno: barrido determinista desde un punto al azar, para no
  // depender de la suerte cuando quedan pocos PIN libres.
  const inicio = Math.floor(Math.random() * 10000);
  for (let i = 0; i < 10000; i++) {
    const pin = String((inicio + i) % 10000).padStart(4, '0');
    if (!enUso.has(pin)) return pin;
  }
  return randomPin(); // 10000 pedidos abiertos a la vez: imposible en la práctica
}

const ORDERS_FILE = path.join(__dirname, 'orders.json');

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      return new Map(arr.map(o => [o.id, o]));
    }
  } catch (e) {
    log('WARN', `orders.json ilegible: ${e.message}`);
    quarantineFile(ORDERS_FILE);
  }
  return new Map();
}

const orders = loadOrders();

function saveOrders() {
  try { writeJsonAtomic(ORDERS_FILE, [...orders.values()]); }
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
// Un cliente con el socket ya cerrado no debe cortar el envío al resto.
function broadcast(event, data) {
  for (const res of sseClients) {
    try { sseWrite(res, event, data); }
    catch { sseClients.delete(res); }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENRUTADOR DE IMPRESIÓN (STRATEGY PATTERN)
// ═════════════════════════════════════════════════════════════════════════════

// El destino se resuelve una vez y viaja explícito hacia abajo: así un pedido que
// entre durante un test de impresora no puede acabar en la impresora de prueba.
async function printTicket(order, pin, iface = currentPrinter, profileOverride = null) {
  const printerName = getPrinterName(iface);
  if (!printerName) throw new Error('No hay ninguna impresora configurada.');

  const profile = profileOverride || printerProfiles[printerName] || 'label_square';

  if (profile === 'a4_paper') {
    await printA4(order, pin, printerName);
  } else {
    await printSquareLabel(order, pin, printerName);
  }
}

// ── PERFIL 1: ETIQUETA CUADRADA 76x76mm (.NET Nativo con Papel Forzado a 76x76) ─────────
async function printSquareLabel(order, pin, printerName) {
  // La fecha sale del pedido, no del reloj: una reimpresión conserva la hora original.
  const now       = order.createdAt ? new Date(order.createdAt) : new Date();
  const fecha     = now.toLocaleDateString('es-ES');
  const hora      = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  const separator = ' - - - - - - - - - - - - - - - - ';

  const cliente    = order.cliente == null ? '' : String(order.cliente);
  const horaRec    = order.hora    == null ? '' : String(order.hora);
  const hayCliente = cliente && cliente.toLowerCase() !== 'cliente';
  const hayHora    = horaRec && horaRec.toLowerCase() !== 'null';

  let ticketText = `${centrar(SHOP_NAME, 30)}\n`;
  ticketText += `${separator}\n`;
  ticketText += `      PIN DE PEDIDO: ${pin}\n`;
  ticketText += `   Fecha: ${fecha}  ${hora}\n`;
  ticketText += `${separator}\n`;

  if (hayCliente) ticketText += ` Cliente: ${cliente}\n`;
  if (hayHora)    ticketText += ` HORA RECOGIDA: ${horaRec}\n`;
  if (hayCliente || hayHora) ticketText += `${separator}\n`;

  for (const item of order.articulos) {
    const cant = String(item?.cantidad ?? '').padEnd(10, ' ');
    ticketText += ` * ${cant} ${String(item?.producto ?? '')}\n`;
  }

  ticketText += `${separator}\n`;
  ticketText += `   Indica tu PIN en mostrador.`;

  const tempFilePath = path.join(os.tmpdir(), `ticket_${pin}_${Date.now()}.txt`);

  try {
    fs.writeFileSync(tempFilePath, ticketText, 'utf8');

    // El nombre de impresora y la ruta llegan por variables de entorno en vez de
    // interpolarse en el script: un nombre con comillas ya no puede inyectar PowerShell.
    const psScript = `
      $printerName = $env:CARN_PRINTER;
      $filePath = $env:CARN_TICKET_FILE;
      $content = Get-Content -Path $filePath -Raw -Encoding UTF8;

      Add-Type -AssemblyName System.Drawing;
      $printDocument = New-Object System.Drawing.Printing.PrintDocument;
      $printDocument.PrinterSettings.PrinterName = $printerName;

      if (-not $printDocument.PrinterSettings.IsValid) {
          throw "La impresora '$printerName' no es válida.";
      }

      $pageSettings = New-Object System.Drawing.Printing.PageSettings;
      $customSize = New-Object System.Drawing.Printing.PaperSize('Custom-76x76', 299, 299);
      $pageSettings.PaperSize = $customSize;

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

    await execPromise(command, {
      timeout: 15000,
      env: { ...process.env, CARN_PRINTER: printerName, CARN_TICKET_FILE: tempFilePath },
    });
    log('PRINT', `Etiqueta 76x76 .NET ${pin} enviada a: ${printerName}`);
  } finally {
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  }
}

// ── PERFIL 2: FOLIO A4 ────────────────────────────────────
async function printA4(order, pin, printerName) {
  // La fecha sale del pedido, no del reloj: una reimpresión conserva la hora original.
  const now       = order.createdAt ? new Date(order.createdAt) : new Date();
  const fecha     = now.toLocaleDateString('es-ES');
  const hora      = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  const separator = '='.repeat(60);
  const subSeparator = '-'.repeat(60);

  const cliente    = order.cliente == null ? '' : String(order.cliente);
  const horaRec    = order.hora    == null ? '' : String(order.hora);
  const hayCliente = cliente && cliente.toLowerCase() !== 'cliente';
  const hayHora    = horaRec && horaRec.toLowerCase() !== 'null';

  let ticketText = `\n\n`;
  ticketText += `   ${SHOP_NAME}\n`;
  ticketText += `   Documento de Pedido / Recogida\n`;
  ticketText += `   ${separator}\n\n`;
  ticketText += `   >> CÓDIGO DE RECOGIDA (PIN): ${pin} <<\n\n`;
  ticketText += `   ${separator}\n`;
  ticketText += `   Fecha: ${fecha}      Hora: ${hora}\n`;

  if (hayCliente) ticketText += `   Cliente: ${cliente}\n`;
  if (hayHora)    ticketText += `   HORA RECOGIDA: ${horaRec}\n`;

  ticketText += `   ${subSeparator}\n\n`;

  for (const item of order.articulos) {
    const cant = String(item?.cantidad ?? '').padEnd(12, ' ');
    ticketText += `   ${cant} ${String(item?.producto ?? '')}\n`;
  }

  ticketText += `\n   ${separator}\n`;
  ticketText += `   Gracias por su confianza.\n\n\n`;

  const tempFilePath = path.join(os.tmpdir(), `ticket_${pin}_A4_${Date.now()}.txt`);

  try {
    fs.writeFileSync(tempFilePath, '\ufeff' + ticketText, 'utf8');
    // execFile no pasa por el shell: un nombre de impresora con comillas o & se
    // trata como argumento literal, no como comando.
    await execFilePromise('notepad.exe', ['/pt', tempFilePath, printerName], { timeout: 20000 });
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
  const raw = req.body?.interface ?? currentPrinter;
  if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'Interfaz inválida' });

  // Mismo normalizado que POST /api/printer, para buscar el perfil con la misma clave.
  const iface   = raw.replace(/^(printer:|tcp:\/\/)/i, '').trim();
  const profile = req.body?.profile ?? printerProfiles[iface] ?? 'label_square';

  try {
    const mockOrder = { cliente: 'Prueba', articulos: [{ cantidad: '1 ud', producto: 'TEST IMPRESORA OK' }] };
    await printTicket(mockOrder, 'TEST', iface, profile);
    log('WEB', `Test impresora OK: ${getPrinterName(iface)} (${profile})`);
    res.json({ ok: true });
  } catch (err) {
    log('ERROR', `Test impresora: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
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

const server = app.listen(SERVER_PORT, HOST, () => {
  log('WEB', `Panel disponible en http://localhost:${SERVER_PORT}`);
  if (HOST === '0.0.0.0') {
    log('WARN', 'El panel escucha en toda la red local y no tiene autenticación.');
    log('WARN', 'Si solo lo abres en este PC, añade HOST=127.0.0.1 a tu .env.');
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') log('ERROR', `El puerto ${SERVER_PORT} ya está ocupado. ¿Hay otra instancia del bot abierta?`);
  else log('ERROR', `Servidor web: ${err.message}`);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GROQ
// ─────────────────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: GROQ_API_KEY });

async function extractOrder(text) {
  const response = await groq.chat.completions.create({
    model:       'openai/gpt-oss-120b',
    temperature: 0.1,
    max_tokens:  1000,
    messages: [{
      role:    'user',
      content:
        'Eres el sistema de una carnicería española. Extrae los datos del pedido del siguiente mensaje de WhatsApp.\n' +
        'Devuelve ÚNICAMENTE un objeto JSON válido, sin markdown ni texto extra, con este formato exacto:\n' +
        '{"cliente":"nombre o Cliente si no lo dice","hora":"hora especificada o null","articulos":[{"cantidad":"X kg/g/uds","producto":"nombre del producto"}]}\n' +
        `Mensaje: ${text}`,
    }],
  });

  const raw   = response.choices[0]?.message?.content?.trim() ?? '';
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*?\}/); return m ? JSON.parse(m[0]) : null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WHATSAPP Y BUFFER DE MENSAJES (SALA DE ESPERA)
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

// Mapa temporal para agrupar mensajes de una misma persona
const userBuffers = new Map();

client.on('message', async msg => {
  if (msg.fromMe || msg.from.includes('@g.us') || msg.from.includes('@broadcast') || !msg.body?.trim()) return;
  if (processedMsgIds.has(msg.id._serialized)) return;
  
  processedMsgIds.add(msg.id._serialized);
  // Se descartan solo los más antiguos: vaciar el Set entero permitiría reprocesar
  // un mensaje reenviado y duplicar el pedido.
  while (processedMsgIds.size > 1000) {
    processedMsgIds.delete(processedMsgIds.values().next().value);
  }

  const senderId = msg.from;
  const text     = msg.body.trim();

  // Si el usuario no tiene una "sala de espera" creada, se la creamos
  if (!userBuffers.has(senderId)) {
    userBuffers.set(senderId, { texts: [], msgs: [], timer: null });
  }

  const buffer = userBuffers.get(senderId);
  buffer.texts.push(text);
  buffer.msgs.push(msg); // Guardamos el mensaje original para poder responderle luego

  // Si ya había una cuenta atrás, la paramos
  if (buffer.timer) clearTimeout(buffer.timer);

  // Iniciamos una nueva cuenta atrás de 5 segundos (5000 milisegundos)
  buffer.timer = setTimeout(async () => {
    // Si pasan 5 segundos sin que escriba nada más, unimos todo
    const combinedText = buffer.texts.join('. ');
    const lastMsg = buffer.msgs[buffer.msgs.length - 1]; // Para responder citando su último mensaje
    
    userBuffers.delete(senderId); // Limpiamos la sala de espera
    
    await processOrder(senderId, combinedText, lastMsg);
  }, 5000);
});

// Función que manda todo a la IA de golpe
async function processOrder(senderId, text, msg) {
  const sender = senderId.split('@')[0];
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

  if (!Array.isArray(order?.articulos) || !order.articulos.length) return;

  const pin    = genPin();
  const id     = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id, pin,
    cliente:    order.cliente == null ? 'Cliente' : String(order.cliente),
    hora:       order.hora    == null ? null      : String(order.hora),
    // La IA a veces devuelve la cantidad como número; se normaliza aquí, en la
    // frontera, para que ni el ticket ni el panel tengan que suponer el tipo.
    articulos:  order.articulos.map(a => ({
      cantidad: String(a?.cantidad ?? ''),
      producto: String(a?.producto ?? ''),
    })),
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
    const lista = record.articulos.map(a => `• ${a.cantidad} ${a.producto}`).join('\n');
    await msg.reply(`✅ ¡Pedido recibido!\n\n${lista}\n\nCódigo de recogida: *${pin}*\nIndícalo al llegar al mostrador.`);
  } catch (e) { log('ERROR', `Reply WhatsApp: ${e.message}`); }
}

// Sin esto, una promesa rechazada sin capturar tumba el proceso en Node 18+.
process.on('unhandledRejection', err => {
  log('ERROR', `Promesa sin capturar: ${err?.message ?? err}`);
});

process.on('SIGINT', async () => {
  log('SYS', 'Cerrando servicio...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

log('BOOT', `Iniciando ${SHOP_NAME}...`);
client.initialize();