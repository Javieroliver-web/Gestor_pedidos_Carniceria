'use strict';
// Carta de elaborados (productos.json). Se relee en cada petición para que
// editar el archivo no requiera reiniciar el bot.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'productos.json');

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return null; }
}

/** Texto de la carta para WhatsApp, o null si el archivo falta o está vacío. */
function menuMessage() {
  const cat = loadCatalog();
  if (!cat?.categorias?.length) return null;
  const blocks = cat.categorias
    .map(c => ({ nombre: c.nombre, productos: (c.productos || []).filter(p => p.activo !== false) }))
    .filter(c => c.productos.length)
    .map(c => `*${c.nombre}*\n` + c.productos.map(p => `• ${p.nombre}`).join('\n'));
  if (!blocks.length) return null;
  return [cat.titulo, ...blocks, cat.pie].filter(Boolean).join('\n\n');
}

function productCount() {
  const cat = loadCatalog();
  return (cat?.categorias || []).reduce((n, c) => n + (c.productos || []).filter(p => p.activo !== false).length, 0);
}

module.exports = { menuMessage, productCount };