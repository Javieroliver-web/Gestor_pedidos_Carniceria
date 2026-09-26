'use strict';
// Dos registros en logs/ (formato JSON Lines, una incidencia por línea):
//   fallos_bot.jsonl -> mensajes que el bot no supo atender (relevos, pedidos dudosos,
//                       días no entendidos). Sirve para mejorar el bot.
//   errores.jsonl    -> fallos técnicos (IA caída, impresora, WhatsApp).
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const FILES = {
  fallos: path.join(LOG_DIR, 'fallos_bot.jsonl'),
  errores: path.join(LOG_DIR, 'errores.jsonl'),
};
const MAX_BYTES = 5 * 1024 * 1024; // al pasar de 5 MB se rota a .1

function append(kind, entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = FILES[kind];
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch {}
    fs.appendFileSync(file, JSON.stringify({ fecha: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (e) {
    console.error(`[incidentLog] No se pudo escribir ${kind}: ${e.message}`);
  }
}

// Categorías fijas (las decide el código, no la IA) para poder contar por tipo.
const CATEGORIAS_WARNING = {
  consulta: 'Consulta que el bot no sabe responder',
  pedido_dudoso: 'Pedido para revisar',
  dia_no_entendido: 'Día de recogida no entendido',
  sin_respuesta_dia: 'Cliente no eligió día',
  multimedia: 'Audio, foto u otro no texto',
  mensaje_largo: 'Mensaje demasiado largo',
  ia_caida: 'IA no disponible',
  error_interno: 'Error interno',
};
const CATEGORIAS_ERROR = { ia: 'IA', impresora: 'Impresora', whatsapp: 'WhatsApp', sistema: 'Sistema' };

/** Warning: mensaje que el bot no supo resolver y pasó a una persona. */
function logFallo({ categoria = 'consulta', motivo, cliente, mensaje, detalle }) {
  append('fallos', { nivel: 'warning', categoria, motivo, cliente, mensaje, detalle });
}

/** Error técnico. origen: 'ia' | 'impresora' | 'whatsapp' | 'sistema' */
function logError({ origen, error, cliente, mensaje }) {
  append('errores', { nivel: 'error', origen, error: error?.message ?? String(error), cliente, mensaje });
}

/** Últimas `limit` entradas, de la más reciente a la más antigua. */
function readRecent(kind, limit = 200) {
  const file = FILES[kind];
  if (!file) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

const summaryCache = {};

/** Contadores de warnings y errores, en total y de hoy, desglosados por categoría. */
function logSummary() {
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(iso));
  const count = (kind, field, labels) => {
    // El panel lo pide cada 5 s: solo se relee el archivo si ha cambiado (o si cambia el día).
    let mtime = 0;
    try { mtime = fs.statSync(FILES[kind]).mtimeMs; } catch {}
    const c = summaryCache[kind];
    if (c && c.mtime === mtime && c.day === todayKey) return c.value;
    const out = { total: 0, hoy: 0, ultima: null, categorias: {} };
    for (const [k, label] of Object.entries(labels)) out.categorias[k] = { etiqueta: label, total: 0, hoy: 0 };
    let lines = [];
    try { lines = fs.readFileSync(FILES[kind], 'utf8').split('\n').filter(Boolean); } catch {}
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      const cat = e[field] || 'otros';
      if (!out.categorias[cat]) out.categorias[cat] = { etiqueta: cat, total: 0, hoy: 0 };
      const isToday = e.fecha && dayOf(e.fecha) === todayKey;
      out.total++; out.categorias[cat].total++;
      if (isToday) { out.hoy++; out.categorias[cat].hoy++; }
      out.ultima = e.fecha || out.ultima;
    }
    summaryCache[kind] = { mtime, day: todayKey, value: out };
    return out;
  };
  return {
    errores: count('errores', 'origen', CATEGORIAS_ERROR),
    warnings: count('fallos', 'categoria', CATEGORIAS_WARNING),
  };
}

module.exports = { logFallo, logError, readRecent, logSummary };