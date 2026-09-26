'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const {
  GROQ_API_KEY,
  GEMINI_API_KEY,
  PRINTER_INTERFACE = 'Brother TD-4000',
  SHOP_NAME         = 'CARNICERÍA RAÚL OLIVER',
  PORT              = '3000',
  HOST              = '127.0.0.1',
  GROQ_MODEL        = 'openai/gpt-oss-120b',
  GEMINI_MODEL      = 'gemini-2.5-flash',
} = process.env;

if (!GROQ_API_KEY) {
  console.error('[ERROR] Falta GROQ_API_KEY en .env');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.warn('[WARN] Falta GEMINI_API_KEY en .env. El equipo de IAs gratuitas (Fallback a Gemini) está desactivado.');
}

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${ts}] [${tag.padEnd(5)}] ${msg}`);
}

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const ORDERS_FILE = path.join(__dirname, '..', 'orders.json');

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { log('WARN', `config.json: ${e.message}`); }
  return {};
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch (e) { log('ERROR', `No se pudo guardar config.json: ${e.message}`); }
}

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      return new Map(arr.map(o => [o.id, o]));
    }
  } catch (e) { log('WARN', `orders.json: ${e.message}`); }
  return new Map();
}

function saveOrders(ordersMap) {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify([...ordersMap.values()], null, 2)); }
  catch (e) { log('ERROR', `No se pudo guardar orders.json: ${e.message}`); }
}

const config = loadConfig();
let currentPrinter = (config.activePrinter || config.printerInterface || PRINTER_INTERFACE).replace(/^(printer:|tcp:\/\/)/i, '').trim();
let printerProfiles = config.profiles || {};

function getPrinterName(iface) {
  return (iface || '').replace(/^printer:/i, '').trim();
}

// PIN de 4 cifras que no choque con ningún pedido activo (pending/ready).
function genPin(ordersMap) {
  const inUse = new Set();
  if (ordersMap) for (const o of ordersMap.values()) if (['pending', 'ready'].includes(o.status)) inUse.add(o.pin);
  for (let i = 0; i < 50; i++) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!inUse.has(pin)) return pin;
  }
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

module.exports = {
  GROQ_API_KEY, GEMINI_API_KEY, GROQ_MODEL, GEMINI_MODEL, SHOP_NAME, PORT, HOST, log,
  loadConfig, saveConfig, loadOrders, saveOrders,
  getPrinterName, genPin,
  getCurrentPrinter: () => currentPrinter,
  setCurrentPrinter: (p) => { currentPrinter = p; },
  getProfiles: () => printerProfiles,
  savePrinterConfig: (iface, profile) => {
    currentPrinter = iface;
    if (profile) printerProfiles[iface] = profile;
    config.activePrinter = currentPrinter;
    config.profiles = printerProfiles;
    saveConfig(config);
  }
};