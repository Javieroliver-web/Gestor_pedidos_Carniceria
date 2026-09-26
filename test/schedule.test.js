'use strict';
// Pruebas del horario y de la elección de día. Ejecutar con: npm test
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/schedule');

// Sábado 26/09/2026 a las 11:20 en Madrid (09:20 UTC)
const SAB = new Date('2026-09-26T09:20:00Z');
const days = s.getPickupDays(7, SAB);
const label = key => days.find(d => d.key === key)?.label;
const pick = (t, opts) => s.parseDayAnswer(t, days, SAB, opts);

test('7 días de apertura, sin domingo', () => {
  assert.strictEqual(days.length, 7);
  assert.ok(!days.some(d => d.key === '2026-09-27'), 'el domingo no debe salir');
  assert.match(days[0].label, /^Hoy/);
});

test('hoy desaparece si faltan menos de 30 min para cerrar', () => {
  const tarde = s.getPickupDays(7, new Date('2026-09-26T11:05:00Z')); // sábado 13:05, cierra 13:30
  assert.notStrictEqual(tarde[0].key, '2026-09-26');
});

test('festivos de Lora del Río no se ofrecen', () => {
  const vie = s.getPickupDays(7, new Date('2026-10-09T08:00:00Z'));
  assert.ok(!vie.some(d => d.key === '2026-10-12'), '12 de octubre es festivo');
});

test('número de opción en todas sus formas', () => {
  for (const t of ['3', '3️⃣', 'la 3', 'el 3', 'er 3', 'la tres', 'la tercera', 'pues la 3 porfa']) {
    assert.strictEqual(pick(t)?.key, '2026-09-29', t);
  }
});

test('días dichos en andaluz', () => {
  assert.strictEqual(pick('pal lunes')?.key, '2026-09-28');
  assert.strictEqual(pick('er marte')?.key, '2026-09-29');
  assert.strictEqual(pick('el miercole')?.key, '2026-09-30');
  assert.strictEqual(pick('pasao mañana')?.key, '2026-09-28');
  assert.strictEqual(pick('esta tarde')?.key, '2026-09-26');
});

test('"el sábado" dicho en sábado es el de la semana que viene', () => {
  assert.strictEqual(pick('er sabao')?.key, '2026-10-03');
  assert.strictEqual(pick('este sábado')?.key, '2026-09-26');
});

test('domingo y mañana (domingo) se detectan como cerrados', () => {
  assert.strictEqual(pick('domingo')?.reason, 'domingo');
  assert.strictEqual(pick('mañana por la mañana')?.closed, '2026-09-27');
});

test('"1 de albondigas" NO es una fecha', () => {
  assert.strictEqual(s.isPureDayAnswer('Tambien quiero 1 de albondigas'), false);
  assert.strictEqual(pick('Tambien quiero 1 de albondigas', { allowOptionNumber: false }), null);
  assert.strictEqual(pick('1 de octubre')?.key, '2026-10-01');
});

test('mensajes con productos no se toman como respuesta de día', () => {
  for (const t of ['dame tres filetes', 'y 6 filetes', 'ponme un cuarto de chorizo', 'hola', '¿a qué hora cerráis?']) {
    assert.strictEqual(s.isPureDayAnswer(t), false, t);
  }
});

test('respuesta de horario según el momento', () => {
  assert.match(s.hoursReply(SAB), /abiertos/);
  assert.match(s.hoursReply(new Date('2026-09-26T12:00:00Z')), /lunes 28/);
  assert.match(s.hoursReply(new Date('2026-09-28T13:00:00Z')), /Hoy abrimos a las 18:00/);
});

test('medianoche en hora de Madrid, también en el cambio de hora', () => {
  assert.strictEqual(s.nextMidnight(SAB).toISOString(), '2026-09-26T22:00:00.000Z');
  assert.strictEqual(s.nextMidnight(new Date('2026-10-24T20:00:00Z')).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.strictEqual(s.nextMidnight(new Date('2026-10-25T20:00:00Z')).toISOString(), '2026-10-25T23:00:00.000Z');
});