'use strict';
// Comprueba que todos los archivos del proyecto están en su sitio, no están vacíos
// y son la versión actual. Uso: npm run verificar
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARCHIVOS = {
  'index.js': 'message_create',
  'dashboard.html': 'openCatModal',
  'package.json': 'node --test',
  'festivos.json': 'festivos',
  'productos.json': 'frescos',
  'ecosystem.config.js': 'carniceria-bot',
  'src/config.js': 'AUDIO_MAX_SECONDS',
  'src/schedule.js': 'MARGEN_HOY_MIN',
  'src/catalog.js': 'checkItems',
  'src/storage.js': 'writeJsonAtomic',
  'src/services/aiService.js': 'transcribeAudio',
  'src/services/incidentLog.js': 'summaryCache',
  'src/services/printService.js': 'fitLabel',
  'test/schedule.test.js': 'albondigas',
  'test/catalog.test.js': 'checkItems',
};

let fallos = 0;
for (const [rel, marca] of Object.entries(ARCHIVOS)) {
  const file = path.join(ROOT, rel);
  let estado;
  if (!fs.existsSync(file)) estado = 'FALTA';
  else {
    // En Windows "incidentlog.js" también existiría: se comprueba el nombre exacto.
    const real = fs.readdirSync(path.dirname(file)).find(n => n.toLowerCase() === path.basename(file).toLowerCase());
    const txt = fs.readFileSync(file, 'utf8');
    if (real !== path.basename(file)) estado = `MAYÚSCULAS MAL (se llama ${real})`;
    else if (!txt.trim()) estado = 'VACÍO';
    else if (!txt.includes(marca)) estado = 'VERSIÓN ANTIGUA';
    else estado = 'OK';
  }
  if (estado !== 'OK') fallos++;
  console.log(`${estado === 'OK' ? '✔' : '✖'} ${rel.padEnd(32)} ${estado}`);
}

// .env con la clave de Groq
const env = path.join(ROOT, '.env');
const envOk = fs.existsSync(env) && /^GROQ_API_KEY=\S+/m.test(fs.readFileSync(env, 'utf8'));
if (!envOk) fallos++;
console.log(`${envOk ? '✔' : '✖'} ${'.env'.padEnd(32)} ${envOk ? 'OK (GROQ_API_KEY configurada)' : 'FALTA o sin GROQ_API_KEY'}`);

// JSON válidos
for (const rel of ['festivos.json', 'productos.json', 'config.json', 'orders.json', 'handoffs.json', 'pending.json']) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fallos++; console.log(`✖ ${rel.padEnd(32)} JSON DAÑADO: ${e.message}`); }
}

console.log(fallos ? `\n${fallos} problema(s). Corrígelos antes de arrancar el bot.` : '\nTodo correcto. Siguiente paso: npm test');
process.exit(fallos ? 1 : 0);