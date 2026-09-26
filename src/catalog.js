'use strict';
// Carta de elaborados y productos reconocidos (productos.json). Se relee en cada
// petición para que editar el archivo no requiera reiniciar el bot.
//
// Además de enviar la carta, comprueba cada producto de un pedido SIN IA:
//   - si coincide con un elaborado de la carta o con un producto fresco conocido → reconocido
//   - si coincide con un elaborado marcado como agotado → se avisa y se quita del pedido
//   - si no coincide con nada → se marca dudoso para que lo revise una persona
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./storage');

const FILE = path.join(__dirname, '..', 'productos.json');

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return null; }
}

function saveCatalog(cat) { writeJsonAtomic(FILE, cat); }

function allProducts(cat = loadCatalog()) {
  return (cat?.categorias || []).flatMap(c => (c.productos || []).map(p => ({ ...p, categoria: c.nombre })));
}

/** Texto de la carta para WhatsApp (sin productos ocultos ni agotados), o null si falta el archivo. */
function menuMessage() {
  const cat = loadCatalog();
  if (!cat?.categorias?.length) return null;
  const blocks = cat.categorias
    .map(c => ({ nombre: c.nombre, productos: (c.productos || []).filter(p => p.activo !== false && !p.agotado) }))
    .filter(c => c.productos.length)
    .map(c => `*${c.nombre}*\n` + c.productos.map(p => `• ${p.nombre}`).join('\n'));
  if (!blocks.length) return null;
  const agotados = allProducts(cat).filter(p => p.activo !== false && p.agotado).map(p => p.nombre);
  const aviso = agotados.length ? `_Hoy no nos quedan: ${agotados.join(', ')}._` : null;
  return [cat.titulo, ...blocks, aviso, cat.pie].filter(Boolean).join('\n\n');
}

function productCount() {
  return allProducts().filter(p => p.activo !== false).length;
}

/** Cambia el estado de agotado de un producto. Devuelve el producto o null si no existe. */
function setAgotado(nombre, agotado) {
  const cat = loadCatalog();
  if (!cat) return null;
  for (const c of cat.categorias || []) {
    for (const p of c.productos || []) {
      if (p.nombre === nombre) { p.agotado = Boolean(agotado); saveCatalog(cat); return { ...p, categoria: c.nombre }; }
    }
  }
  return null;
}

// ── Reconocimiento de productos ─────────────────────────────────────────────
const STOP = new Set(['de', 'del', 'con', 'y', 'e', 'a', 'al', 'la', 'las', 'el', 'los', 'en', 'un', 'una', 'unos', 'unas',
  'para', 'pa', 'por', 'o', 'u', 'mi', 'tu', 'su', 'lo', 'le', 'me', 'que']);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Singular aproximado y variantes escritas de oído ("flamenquine", "empanao", "armondigas").
function stem(w) {
  let t = w;
  if (t.length > 4 && t.endsWith('es')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
  t = t.replace(/ao$/, 'ado').replace(/ia$/, 'ia');
  if (t.endsWith('e') && t.length > 5) t = t.slice(0, -1); // flamenquine -> flamenquin
  return t;
}

function tokens(s) {
  return norm(s).split(/[\s-]+/).filter(w => w && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Dos palabras "son la misma" si coinciden, o si son largas y difieren en poco
// (1 letra desde 6 letras, 2 desde 9). Las cortas deben ser exactas: "queso" ≠ "hueso".
function same(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 6) return false;
  return lev(a, b) <= (n >= 9 ? 2 : 1);
}

/**
 * Busca el elaborado de la carta que mejor encaja con lo que pide el cliente.
 * Todas las palabras clave del producto de la carta deben aparecer en la petición;
 * gana el que más palabras encaja ("flamenquín de pollo y huevo" antes que "flamenquín").
 */
function bestCatalogMatch(requested, products) {
  const req = tokens(requested);
  let best = null;
  for (const p of products) {
    if (p.activo === false) continue;
    const keys = tokens(p.nombre);
    if (!keys.length) continue;
    if (keys.every(k => req.some(r => same(r, k)))) {
      if (!best || keys.length > best.score) best = { product: p, score: keys.length };
    }
  }
  return best?.product || null;
}

function isFresh(requested, frescos) {
  const req = tokens(requested);
  return frescos.some(f => {
    const keys = tokens(f);
    return keys.length && keys.every(k => req.some(r => same(r, k)));
  });
}

/**
 * Revisa los artículos de un pedido contra la carta.
 * Devuelve { articulos, agotados: [nombres], desconocidos: [productos] }.
 * - Los agotados se quitan del pedido.
 * - Los desconocidos se quedan pero con dudoso: true.
 */
function checkItems(articulos) {
  const cat = loadCatalog();
  if (!cat) return { articulos, agotados: [], desconocidos: [] };
  const products = allProducts(cat);
  const frescos = cat.frescos || [];
  const out = [], agotados = [], desconocidos = [];
  for (const a of articulos) {
    const match = bestCatalogMatch(a.producto, products);
    if (match?.agotado) { agotados.push(match.nombre); continue; }
    if (match || isFresh(a.producto, frescos)) { out.push({ ...a, ...(match ? { enCarta: match.nombre } : {}) }); continue; }
    desconocidos.push(a.producto);
    out.push({ ...a, dudoso: true });
  }
  return { articulos: out, agotados, desconocidos };
}

module.exports = { menuMessage, productCount, allProducts, setAgotado, checkItems, _tokens: tokens, _bestCatalogMatch: bestCatalogMatch };