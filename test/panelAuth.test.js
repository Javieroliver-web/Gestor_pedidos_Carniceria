'use strict';
// Tests de la contraseña del panel (src/panelAuth.js), con el runner de Node
// (node --test): sin dependencias nuevas. Monta un servidor Express mínimo.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { protegerPanel } = require('../src/panelAuth');

async function conPanel(password, fn) {
  const app = express();
  const proteccion = protegerPanel(password);
  if (proteccion) app.use(proteccion);
  app.get('/', (_req, res) => res.send('pedidos'));
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const url = `http://127.0.0.1:${servidor.address().port}/`;
  try {
    await fn(url);
  } finally {
    servidor.close();
  }
}

const basic = (usuario, clave) => ({ authorization: 'Basic ' + Buffer.from(`${usuario}:${clave}`).toString('base64') });

test('sin contraseña configurada no hay protección (solo se permite en este PC)', () => {
  assert.strictEqual(protegerPanel(''), null);
});

test('con contraseña: sin clave o con la mala, 401; con la buena, 200', async () => {
  await conPanel('clave-de-la-tienda', async (url) => {
    assert.strictEqual((await fetch(url)).status, 401);
    assert.strictEqual((await fetch(url, { headers: basic('panel', 'otra') })).status, 401);
    assert.strictEqual((await fetch(url, { headers: basic('otro', 'clave-de-la-tienda') })).status, 401);
    const bien = await fetch(url, { headers: basic('panel', 'clave-de-la-tienda') });
    assert.strictEqual(bien.status, 200);
    assert.strictEqual(await bien.text(), 'pedidos');
  });
});

test('el navegador recibe el aviso para pedir la contraseña', async () => {
  await conPanel('x', async (url) => {
    const r = await fetch(url);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic realm="Panel de pedidos"/);
  });
});

test('abrir a la red sin contraseña se queda en este PC', () => {
  // Se carga config.js con un entorno controlado, en un proceso aparte para
  // no arrastrar el .env de la tienda.
  const { execFileSync } = require('node:child_process');
  const leer = (entorno) => JSON.parse(execFileSync(process.execPath, ['-e',
    "const c=require('./src/config');console.log(JSON.stringify({host:c.HOST}))"],
    { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, GROQ_API_KEY: 'x', ...entorno } }).toString().trim().split('\n').pop());
  assert.strictEqual(leer({ HOST: '0.0.0.0', PANEL_PASSWORD: '' }).host, '127.0.0.1');
  assert.strictEqual(leer({ HOST: '0.0.0.0', PANEL_PASSWORD: 'clave' }).host, '0.0.0.0');
  assert.strictEqual(leer({ HOST: '', PANEL_PASSWORD: '' }).host, '127.0.0.1');
});
