'use strict';
/**
 * Contraseña del panel (HTTP Basic, usuario «panel»). El navegador la pide una
 * vez y la reenvía sola, también en /events (SSE).
 *
 * Por qué (revisión de seguridad del 23/09/2026): el panel escuchaba en toda
 * la red de la tienda sin autenticación. Se vuelve a poner aquí porque la
 * reorganización en src/ del 19/09 dejó otra vez `app.listen(PORT, '0.0.0.0')`.
 */
const crypto = require('crypto');

/** Middleware que exige la contraseña, o null si no hay contraseña configurada. */
function protegerPanel(password) {
  if (!password) return null;
  const esperada = Buffer.from(`panel:${password}`);
  return (req, res, next) => {
    const [tipo, valor] = String(req.headers.authorization || '').split(' ');
    const dada = Buffer.from(tipo === 'Basic' && valor ? Buffer.from(valor, 'base64').toString() : '');
    // timingSafeEqual: comparar sin filtrar por tiempo cuánto se ha acertado.
    if (dada.length === esperada.length && crypto.timingSafeEqual(dada, esperada)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Panel de pedidos", charset="UTF-8"');
    res.status(401).send('Contraseña del panel necesaria (usuario: panel).');
  };
}

module.exports = { protegerPanel };
