'use strict';
/**
 * Cambio automático de modelo de IA cuando el proveedor lo retira.
 *
 * Por qué (16/11/2026): el respaldo usaba gemini-1.5-flash, que Google retiró,
 * y nadie se enteró: el respaldo fallaba siempre en silencio. Ahora, si una
 * llamada falla porque el modelo ya no existe, se pide al proveedor la lista
 * de modelos, se elige el sucesor, se guarda en config.json y se reintenta.
 */

// ¿El error dice que el modelo ya no existe o está retirado?
function esModeloRetirado(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  const texto = `${err.code ?? ''} ${err.error?.error?.code ?? ''} ${err.message ?? ''}`;
  if (/decommission|deprecat|model[_ ]not[_ ]found|no longer (available|supported)|does not exist|is not found|not supported for generateContent/i.test(texto)) return true;
  // Groq contesta 404 cuando el modelo no existe; Gemini también.
  return status === 404;
}

const versionGemini = (nombre) => parseFloat((nombre.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);

/**
 * Sucesor de Gemini: el «flash» estable de versión más alta. Sin preview,
 * experimentales ni variantes especiales (voz, imagen...). Si no hay ninguno,
 * vale un «flash-lite».
 */
function elegirGemini(modelos, actual) {
  const nombres = modelos
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(n => /^gemini-\d/.test(n) && /flash/.test(n) && n !== actual)
    .filter(n => !/(preview|exp|tts|image|live|audio|embedding|thinking|learnlm|native)/.test(n));
  const ordenar = (lista) => lista.sort((a, b) =>
    versionGemini(b) - versionGemini(a) || a.length - b.length || a.localeCompare(b));
  const normales = ordenar(nombres.filter(n => !/lite/.test(n)));
  return normales[0] || ordenar(nombres)[0] || null;
}

// Por orden de preferencia para leer pedidos (calidad y cuota gratuita).
const PREFERENCIA_GROQ = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];

/** Sucesor en Groq: el primero disponible de la lista; si no, uno de chat cualquiera. */
function elegirGroq(modelos, actual) {
  const ids = modelos
    .filter(m => m.active !== false)
    .map(m => String(m.id || ''))
    .filter(id => id && id !== actual)
    .filter(id => !/(whisper|guard|tts|playai|orpheus|compound|distil|embed)/i.test(id));
  return PREFERENCIA_GROQ.find(p => ids.includes(p)) || ids.find(id => /120b|70b/.test(id)) || ids[0] || null;
}

/**
 * Lleva el modelo de un proveedor. `guardado` es lo que había en config.json
 * ({ configurado, actual }): solo se usa si el .env sigue pidiendo el mismo
 * modelo que se sustituyó; si alguien cambia el .env a mano, manda el .env.
 */
class GestorModelo {
  constructor({ proveedor, configurado, guardado, listar, elegir, guardar, log, ahora = Date.now }) {
    Object.assign(this, { proveedor, configurado, listar, elegir, guardar, log, ahora });
    this.modelo = guardado?.configurado === configurado && guardado?.actual ? guardado.actual : configurado;
    this.ultimaRevision = 0;
  }

  actual() { return this.modelo; }

  /**
   * Si `err` es de modelo retirado, busca sucesor y lo pone. Devuelve true si
   * ha cambiado de modelo (y por tanto merece la pena reintentar).
   */
  async actualizarSiRetirado(err) {
    if (!esModeloRetirado(err)) return false;
    // Como mucho una consulta por hora: si el proveedor está caído no se le
    // martillea con cada mensaje de cliente.
    if (this.ahora() - this.ultimaRevision < 60 * 60 * 1000) return false;
    this.ultimaRevision = this.ahora();
    try {
      const nuevo = this.elegir(await this.listar(), this.modelo);
      if (!nuevo) {
        this.log('ERROR', `${this.proveedor}: el modelo ${this.modelo} está retirado y no encuentro sucesor. Revisa el .env.`);
        return false;
      }
      this.log('WARN', `${this.proveedor}: el modelo ${this.modelo} está retirado → cambio a ${nuevo} (guardado en config.json).`);
      this.modelo = nuevo;
      this.guardar({ configurado: this.configurado, actual: nuevo, cambiadoEl: new Date(this.ahora()).toISOString() });
      return true;
    } catch (e) {
      this.log('ERROR', `${this.proveedor}: no pude consultar los modelos disponibles (${e.message}).`);
      return false;
    }
  }

  /** Ejecuta `llamada(modelo)`; si falla por modelo retirado, cambia y reintenta una vez. */
  async ejecutar(llamada) {
    try {
      return await llamada(this.modelo);
    } catch (err) {
      if (await this.actualizarSiRetirado(err)) return llamada(this.modelo);
      throw err;
    }
  }
}

module.exports = { esModeloRetirado, elegirGemini, elegirGroq, GestorModelo, PREFERENCIA_GROQ };
