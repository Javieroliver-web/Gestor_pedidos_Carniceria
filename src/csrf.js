'use strict';
/**
 * Freno a peticiones que vienen de otras webs (CSRF y DNS rebinding).
 *
 * Por qué (16/11/2026): el panel escucha en localhost sin contraseña, y
 * cualquier página abierta en el navegador de la tienda podía mandar un
 * <form method=post> a http://localhost:3000/api/whatsapp/reset y desvincular
 * WhatsApp, o a /restart y tirar el bot.
 *
 * 1) Cabecera X-Panel en todo lo que no sea lectura: un formulario o un fetch
 *    de otra web no puede ponerla sin que el navegador pregunte antes (CORS),
 *    y este servidor no responde a esa pregunta.
 * 2) Host: una web maliciosa puede hacer que SU dominio apunte a 127.0.0.1
 *    («DNS rebinding»). Entonces el navegador la trata como del mismo sitio y
 *    sí podría poner la cabecera, pero la petición llega con Host: su-dominio.
 *    Si el panel es solo de este PC, se aceptan únicamente localhost/127.0.0.1.
 *    Con contraseña (panel abierto a la red) no hace falta: el navegador no
 *    le daría la contraseña a otro dominio.
 */
const METODOS_LECTURA = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostsLocales(port) {
  return new Set(['localhost', '127.0.0.1', '[::1]'].flatMap(h => [h, `${h}:${port}`]));
}

function crearFrenoPanel({ port, soloLocal }) {
  const permitidos = hostsLocales(port);
  return function frenoPanel(req, res, next) {
    if (soloLocal && !permitidos.has(String(req.headers.host || '').toLowerCase())) {
      return res.status(403).json({ error: 'Petición rechazada: el panel solo se abre como localhost.' });
    }
    if (METODOS_LECTURA.has(req.method) || req.get('x-panel') === '1') return next();
    res.status(403).json({ error: 'Petición rechazada: solo se acepta desde el panel.' });
  };
}

module.exports = { crearFrenoPanel };
