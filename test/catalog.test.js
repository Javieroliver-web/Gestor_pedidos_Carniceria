'use strict';
// Pruebas del reconocimiento de productos. Ejecutar con: npm test
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/catalog');

const check = list => c.checkItems(list.map(p => ({ cantidad: '1', producto: p })));

test('elaborados de la carta, escritos como escribe la gente', () => {
  const r = check(['albondigas', 'armondigas', '4 flamenquines', 'San Jacobos', 'pollo taki taki', 'burrito barbacoa']);
  assert.deepStrictEqual(r.desconocidos, []);
  assert.strictEqual(r.articulos[0].enCarta, 'Albóndigas');
  assert.strictEqual(r.articulos[1].enCarta, 'Albóndigas');
});

test('gana el producto más concreto de la carta', () => {
  const r = check(['flamenquin de pollo y huevo']);
  assert.strictEqual(r.articulos[0].enCarta, 'Flamenquín de pollo y huevo');
});

test('carne fresca al corte se reconoce aunque no esté en la carta', () => {
  const r = check(['un kilo de carne', '2 kg lomo', 'chuletas de cordero', 'pringá', 'carne pa guisar', 'contramuslos', 'carrillá']);
  assert.deepStrictEqual(r.desconocidos, []);
});

test('lo que no es de carnicería queda dudoso', () => {
  const r = check(['pizza', 'croquetas', 'queso', 'huevos', 'lo de siempre']);
  assert.strictEqual(r.desconocidos.length, 5);
  assert.ok(r.articulos.every(a => a.dudoso));
});

test('la carta no incluye productos agotados', () => {
  const menu = c.menuMessage();
  assert.ok(menu && menu.includes('Albóndigas'));
});