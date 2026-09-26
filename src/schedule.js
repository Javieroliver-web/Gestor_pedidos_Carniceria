'use strict';
// Horario, festivos y fechas de recogida. Todo se calcula en hora de Madrid,
// independientemente de la zona horaria que tenga configurada el PC.
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Madrid';
const FESTIVOS_FILE = path.join(__dirname, '..', 'festivos.json');

// 0 = domingo ... 6 = sábado. Tramos en minutos desde medianoche.
const HORARIO = {
  0: [],
  1: [[9 * 60, 14 * 60], [18 * 60, 21 * 60]],
  2: [[9 * 60, 14 * 60], [18 * 60, 21 * 60]],
  3: [[9 * 60, 14 * 60], [18 * 60, 21 * 60]],
  4: [[9 * 60, 14 * 60], [18 * 60, 21 * 60]],
  5: [[9 * 60, 14 * 60], [18 * 60, 21 * 60]],
  6: [[9 * 60, 13 * 60 + 30]],
};

const HORARIO_TEXTO =
  '🕘 *Horario de la Carnicería Raúl Oliver*\n' +
  '• Lunes a viernes: 9:00 a 14:00 y 18:00 a 21:00\n' +
  '• Sábados: 9:00 a 13:30\n' +
  '• Domingos y festivos: cerrado';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Se relee en cada consulta para que editar festivos.json no requiera reiniciar.
function loadFestivos() {
  try {
    const data = JSON.parse(fs.readFileSync(FESTIVOS_FILE, 'utf8'));
    return { ...(data.festivos || {}), ...(data.cierres || {}) };
  } catch {
    return {};
  }
}

// ── Utilidades de fecha (claves 'YYYY-MM-DD' en hora de Madrid) ────────────
function madridNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { key: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function keyToUTC(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addDays(key, n) { const d = keyToUTC(key); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(key) { return keyToUTC(key).getUTCDay(); }
function dayNumber(key) { return Number(key.slice(8, 10)); }
function monthIndex(key) { return Number(key.slice(5, 7)) - 1; }
function fmtMin(m) { return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function closedReason(key) {
  const festivos = loadFestivos();
  if (festivos[key]) return festivos[key];
  if (weekday(key) === 0) return 'domingo';
  return null;
}

function slotsFor(key) { return closedReason(key) ? [] : HORARIO[weekday(key)]; }

// "sábado 27 de septiembre"
function formatDay(key) { return `${DIAS[weekday(key)]} ${dayNumber(key)} de ${MESES[monthIndex(key)]}`; }
// "Sáb 27/09" para el ticket
function formatShort(key) { return `${cap(DIAS[weekday(key)].slice(0, 3))} ${key.slice(8, 10)}/${key.slice(5, 7)}`; }

// Los N próximos días en los que se puede recoger. Hoy cuenta solo si aún no ha cerrado.
function getPickupDays(n = 7, date = new Date()) {
  const now = madridNow(date);
  const days = [];
  let key = now.key;
  for (let i = 0; days.length < n && i < 60; i++, key = addDays(key, 1)) {
    const slots = slotsFor(key);
    if (!slots.length) continue;
    if (key === now.key && now.minutes >= slots[slots.length - 1][1]) continue;
    const offset = Math.round((keyToUTC(key) - keyToUTC(now.key)) / 86400000);
    const prefix = offset === 0 ? 'Hoy, ' : offset === 1 ? 'Mañana, ' : '';
    days.push({ key, label: prefix + (prefix ? formatDay(key) : cap(formatDay(key))) });
  }
  return days;
}

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
function pickupDaysMessage(days) {
  return '📅 ¿Qué día quieres pasar a recogerlo?\n\n' +
    days.map((d, i) => `${NUM_EMOJI[i]} ${d.label}`).join('\n') +
    '\n\n*Responde con el número de la opción.*';
}

// ── Interpretación de la respuesta del cliente (sin IA, determinista) ───────
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¡!¿?.,;]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const DIAS_NORM = DIAS.map(normalize);
const MESES_NORM = MESES.map(normalize);

/**
 * Devuelve { key } si el texto identifica una de las opciones,
 * { closed: key, reason } si nombra un día válido pero cerrado o fuera de la lista,
 * o null si no se entiende.
 */
function parseDayAnswer(text, days, date = new Date(), { allowOptionNumber = true } = {}) {
  const raw = String(text || '').trim();
  const t = normalize(raw);
  if (!t) return null;
  const today = madridNow(date).key;

  // Número de opción: "3", "3️⃣", "la 3", "opcion 3", "el 3." (solo si es 1..N y no parece una fecha)
  // (desactivado al leer el día escrito dentro del propio pedido: ahí "el 3" es una fecha)
  const emojiIdx = allowOptionNumber ? NUM_EMOJI.findIndex(e => raw.startsWith(e)) : -1;
  if (emojiIdx >= 0 && emojiIdx < days.length) return { key: days[emojiIdx].key };
  const opt = allowOptionNumber && t.match(/^(?:la |el |opcion |numero |n )?(\d{1,2})$/);
  if (opt) {
    const n = Number(opt[1]);
    if (n >= 1 && n <= days.length) return { key: days[n - 1].key };
  }

  let target = null;
  if (/\bpasado manana\b/.test(t)) target = addDays(today, 2);
  else if (/\bmanana\b/.test(t) && !/\bpor la manana\b|\bde manana\b/.test(t)) target = addDays(today, 1);
  else if (/\bhoy\b/.test(t)) target = today;

  if (!target) {
    // "28 de septiembre", "28/09", "el 28"
    const dm = t.match(/\b(\d{1,2})\s*(?:de\s+([a-z]+)|\/(\d{1,2}))?\b/);
    const wd = DIAS_NORM.findIndex(d => new RegExp(`\\b${d}\\b`).test(t));
    if (dm && (dm[2] || dm[3] || wd >= 0 || /\bel \d/.test(t))) {
      const day = Number(dm[1]);
      let month = dm[3] ? Number(dm[3]) - 1 : dm[2] ? MESES_NORM.indexOf(dm[2]) : -1;
      // Sin mes: la primera fecha futura con ese número de día
      for (let i = 0; i < 62 && !target; i++) {
        const k = addDays(today, i);
        if (dayNumber(k) === day && (month < 0 || monthIndex(k) === month)) target = k;
      }
    } else if (wd >= 0) {
      for (let i = 0; i < 7 && !target; i++) {
        const k = addDays(today, i);
        if (weekday(k) === wd) target = k;
      }
    }
  }

  if (!target) return null;
  if (days.some(d => d.key === target)) return { key: target };
  const reason = closedReason(target);
  return { closed: target, reason: reason || (target < today ? 'pasado' : 'fuera de plazo') };
}

// ── Respuesta a preguntas de horario (texto fijo, nunca generado por IA) ────
function hoursReply(date = new Date()) {
  const now = madridNow(date);
  const todaySlots = slotsFor(now.key);
  const reasonToday = closedReason(now.key);
  let status;

  const current = todaySlots.find(([a, b]) => now.minutes >= a && now.minutes < b);
  const later = todaySlots.find(([a]) => now.minutes < a);
  if (current) {
    status = `✅ Ahora mismo estamos *abiertos*, hasta las ${fmtMin(current[1])}.`;
    const next = todaySlots.find(([a]) => a > current[1]);
    if (next) status += ` Por la tarde volvemos a abrir de ${fmtMin(next[0])} a ${fmtMin(next[1])}.`;
  } else if (later) {
    status = `🔒 Ahora estamos cerrados. Hoy abrimos a las ${fmtMin(later[0])} (hasta las ${fmtMin(later[1])}).`;
  } else {
    let k = addDays(now.key, 1);
    for (let i = 0; i < 30 && !slotsFor(k).length; i++) k = addDays(k, 1);
    const why = reasonToday && reasonToday !== 'domingo' ? ` Hoy es festivo (${reasonToday}).` : '';
    const when = k === addDays(now.key, 1) ? `mañana, ${formatDay(k)}` : `el ${formatDay(k)}`;
    status = `🔒 Ahora estamos cerrados.${why} Volvemos a abrir ${when} a las ${fmtMin(slotsFor(k)[0][0])}.`;
  }
  return `${status}\n\n${HORARIO_TEXTO}`;
}

// Medianoche del día siguiente (Madrid), para el relevo "hasta mañana".
function nextMidnight(date = new Date()) {
  const tomorrow = addDays(madridNow(date).key, 1);
  // Buscar el instante UTC cuya hora en Madrid es 00:00 de ese día (maneja cambio de hora).
  for (const offset of [-1, -2, 0]) {
    const guess = new Date(keyToUTC(tomorrow).getTime() + offset * 3600000);
    const m = madridNow(guess);
    if (m.key === tomorrow && m.minutes === 0) return guess;
  }
  return new Date(keyToUTC(tomorrow).getTime() - 2 * 3600000);
}

function missingLocalHolidaysWarning(date = new Date()) {
  const year = madridNow(date).key.slice(0, 4);
  const f = loadFestivos();
  const locals = Object.entries(f).filter(([k, v]) => k.startsWith(year) && /local/i.test(v));
  return locals.length ? null : `festivos.json no tiene festivos locales de Lora del Río para ${year}.`;
}

module.exports = {
  HORARIO_TEXTO, getPickupDays, pickupDaysMessage, parseDayAnswer, hoursReply,
  formatDay, formatShort, closedReason, nextMidnight, madridNow, missingLocalHolidaysWarning,
};