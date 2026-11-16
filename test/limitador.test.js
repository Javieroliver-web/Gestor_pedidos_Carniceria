'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { crearLimitador } = require('../src/limitador');

test('corta al pasar del máximo y se recupera al pasar la ventana', () => {
  let t = 0;
  const permitir = crearLimitador(2, 1000, () => t);
  assert.ok(permitir('a'));
  assert.ok(permitir('a'));
  assert.ok(!permitir('a'));
  assert.ok(permitir('b'), 'otro cliente no se ve afectado');
  t = 1500;
  assert.ok(permitir('a'));
});

test('limpiar memoria no le quita el límite a quien está activo', () => {
  let t = 0;
  const permitir = crearLimitador(1, 1000, () => t);
  assert.ok(permitir('spam'));
  for (let i = 0; i < 6000; i++) permitir(`otro${i}`);
  assert.ok(!permitir('spam'));
});
