'use strict';
// Guardado seguro de archivos JSON: se escribe en un temporal y se renombra.
// Si el PC se apaga a mitad de escritura, el archivo anterior queda intacto
// en lugar de quedar vacío o cortado (lo que haría perder todos los pedidos).
const fs = require('fs');
const path = require('path');

function writeJsonAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // En Windows el renombrado puede fallar si otro programa (antivirus, editor) tiene el
    // archivo abierto. Se reintenta con copia directa antes de rendirse.
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
    catch { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
}

/** Lee un JSON; si está corrupto lo aparta como .corrupto-<fecha> y devuelve fallback. */
function readJson(file, fallback, log) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    const bad = `${file}.corrupto-${Date.now()}`;
    try { fs.renameSync(file, bad); } catch {}
    if (log) log('ERROR', `${path.basename(file)} estaba dañado (${e.message}); guardado como ${path.basename(bad)}`);
    return fallback;
  }
}

module.exports = { writeJsonAtomic, readJson };