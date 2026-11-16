'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { crearFrenoPanel } = require('../src/csrf');

async function conServidor(opciones, fn) {
  const app = express();
  let port;
  app.use((req, res, next) => crearFrenoPanel({ port, ...opciones })(req, res, next));
  app.get('/x', (_q, r) => r.send('ok'));
  app.post('/x', (_q, r) => r.send('ok'));
  const s = app.listen(0, '127.0.0.1');
  await new Promise(ok => s.once('listening', ok));
  port = s.address().port;
  try { await fn(port); } finally { s.close(); }
}

// fetch no deja cambiar Host: para simular el DNS rebinding se usa http directamente.
function peticion(port, { method = 'GET', host, headers = {} } = {}) {
  return new Promise((ok, mal) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/x', method, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, r => { r.resume(); ok(r.statusCode); });
    req.on('error', mal);
    req.end();
  });
}

test('POST sin la cabecera del panel se rechaza; con ella pasa; GET siempre pasa', async () => {
  await conServidor({ soloLocal: true }, async (port) => {
    assert.strictEqual(await peticion(port), 200);
    assert.strictEqual(await peticion(port, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 403);
    assert.strictEqual(await peticion(port, { method: 'POST', headers: { 'x-panel': '1' } }), 200);
    assert.strictEqual(await peticion(port, { host: `localhost:${port}` }), 200);
  });
});

test('DNS rebinding: con Host de otro dominio se rechaza todo, también la lectura', async () => {
  await conServidor({ soloLocal: true }, async (port) => {
    assert.strictEqual(await peticion(port, { host: `atacante.example:${port}` }), 403);
    assert.strictEqual(await peticion(port, { method: 'POST', host: `atacante.example:${port}`, headers: { 'x-panel': '1' } }), 403);
  });
});

test('panel abierto a la red (con contraseña): se acepta la IP de la tienda como Host', async () => {
  await conServidor({ soloLocal: false }, async (port) => {
    assert.strictEqual(await peticion(port, { host: `192.168.1.50:${port}` }), 200);
  });
});
