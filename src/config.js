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
  WHISPER_MODEL     = 'whisper-large-v3-turbo',
  // Transcribir notas de voz (on/off) y duración máxima en segundos
  AUDIO_TRANSCRIPTION = 'on',
  AUDIO_MAX_SECONDS   = '120',
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

const { writeJsonAtomic, readJson } = require('./storage');

function loadConfig() {
  return readJson(CONFIG_FILE, {}, log);
}

function saveConfig(cfg) {
  try { writeJsonAtomic(CONFIG_FILE, cfg); }
  catch (e) { log('ERROR', `No se pudo guardar config.json: ${e.message}`); }
}

function loadOrders() {
  const arr = readJson(ORDERS_FILE, [], log);
  return new Map((Array.isArray(arr) ? arr : []).map(o => [o.id, o]));
}

function saveOrders(ordersMap) {
  try { writeJsonAtomic(ORDERS_FILE, [...ordersMap.values()]); }
  catch (e) { log('ERROR', `No se pudo guardar orders.json: ${e.message}`); }
}

const config = loadConfig();
let currentPrinter = (config.activePrinter || config.printerInterface || PRINTER_INTERFACE).replace(/^(printer:|tcp:\/\/)/i, '').trim();
let printerProfiles = config.profiles || {};
// Impresión automática de tickets. Se puede apagar desde el panel para hacer pruebas sin gastar papel.
let printingEnabled = config.printingEnabled !== false;

function getPrinterName(iface) {
  return (iface || '').replace(/^printer:/i, '').trim();
}

// PIN de 4 cifras que no choque con ningún pedido activo (pending/ready).
function genPin(ordersMap, extraInUse = []) {
  const inUse = new Set(extraInUse);
  if (ordersMap) for (const o of ordersMap.values()) if (['pending', 'ready'].includes(o.status)) inUse.add(o.pin);
  for (let i = 0; i < 50; i++) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!inUse.has(pin)) return pin;
  }
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

module.exports = {
  GROQ_API_KEY, GEMINI_API_KEY, GROQ_MODEL, GEMINI_MODEL, WHISPER_MODEL,
  AUDIO_TRANSCRIPTION: AUDIO_TRANSCRIPTION !== 'off', AUDIO_MAX_SECONDS: Number(AUDIO_MAX_SECONDS) || 120,
  SHOP_NAME, PORT, HOST, log,
  loadConfig, saveConfig, loadOrders, saveOrders,
  getPrinterName, genPin,
  getCurrentPrinter: () => currentPrinter,
  setCurrentPrinter: (p) => { currentPrinter = p; },
  getProfiles: () => printerProfiles,
  isPrintingEnabled: () => printingEnabled,
  setPrintingEnabled: (on) => {
    printingEnabled = Boolean(on);
    config.printingEnabled = printingEnabled;
    config.printingChangedAt = new Date().toISOString();
    saveConfig(config);
  },
  getPrintingChangedAt: () => config.printingChangedAt || null,
  savePrinterConfig: (iface, profile) => {
    currentPrinter = iface;
    if (profile) printerProfiles[iface] = profile;
    config.activePrinter = currentPrinter;
    config.profiles = printerProfiles;
    saveConfig(config);
  }
};