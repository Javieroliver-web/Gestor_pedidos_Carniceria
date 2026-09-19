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

function genPin() {
  const chars = '0123456789';
  return [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = {
  GROQ_API_KEY, GEMINI_API_KEY, SHOP_NAME, PORT, log,
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