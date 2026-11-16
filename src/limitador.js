'use strict';
/**
 * Limita cuántas veces puede hacer algo cada cliente en una ventana de tiempo
 * (p. ej. 20 mensajes cada 10 minutos). Sin dependencias, en memoria.
 */
function crearLimitador(max, ventanaMs, ahora = Date.now) {
  const marcas = new Map();
  return function permitir(clave) {
    const t = ahora();
    const recientes = (marcas.get(clave) || []).filter(m => t - m < ventanaMs);
    if (recientes.length >= max) { marcas.set(clave, recientes); return false; }
    recientes.push(t);
    marcas.set(clave, recientes);
    // Tope de memoria: se olvidan los clientes sin actividad reciente.
    if (marcas.size > 5000) {
      for (const [k, v] of marcas) if (!v.some(m => t - m < ventanaMs)) marcas.delete(k);
    }
    return true;
  };
}

module.exports = { crearLimitador };
