'use strict';
// Carga el aiService REAL en un proceso aparte (claves falsas, sin internet).
// Existe porque el 16/11 un error de sintaxis en el servicio de IA pasó todas
// las pruebas: la simulación sustituía este archivo y nadie lo cargaba.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
function enProceso(codigo, entorno = {}) {
  const salida = execFileSync(process.execPath, ['-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, GROQ_API_KEY: 'x', GEMINI_API_KEY: '', GROQ_MODEL: '', GEMINI_MODEL: '', ...entorno },
  }).toString().trim().split('\n');
  return JSON.parse(salida.pop());
}

test('el servicio de IA carga y usa los modelos por defecto (aunque el .env los deje vacíos)', () => {
  const r = enProceso(`
    const ai = require('./src/services/aiService');
    console.log(JSON.stringify({ groq: ai.modeloGroq.actual(), gemini: ai.modeloGemini }));
  `);
  assert.deepStrictEqual(r, { groq: 'openai/gpt-oss-120b', gemini: null });
  const g = enProceso(`console.log(JSON.stringify(require('./src/services/aiService').modeloGemini.actual()))`, { GEMINI_API_KEY: 'y' });
  assert.strictEqual(g, 'gemini-2.5-flash');
});

test('si Groq retira el modelo, classifyMessage cambia al sucesor, lo guarda y responde', () => {
  const r = enProceso(`
    const Module = require('module');
    const usados = [];
    class FakeGroq {
      constructor() {
        this.models = { list: async () => ({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }] }) };
        this.chat = { completions: { create: ({ model }) => {
          usados.push(model);
          const p = model === 'openai/gpt-oss-120b'
            ? Promise.reject(Object.assign(new Error('The model openai/gpt-oss-120b has been decommissioned'), { status: 400 }))
            : Promise.resolve();
          return { withResponse: async () => { await p; return {
            data: { choices: [{ message: { content: '{"tipo":"saludo"}' } }], usage: { total_tokens: 1 } },
            response: { headers: new Headers() } }; } };
        } } };
      }
    }
    FakeGroq.toFile = async () => null;
    const cargar = Module._load;
    Module._load = function (req) { return req === 'groq-sdk' ? FakeGroq : cargar.apply(this, arguments); };
    const config = require('./src/config');
    const guardados = [];
    config.guardarModelo = (p, v) => guardados.push([p, v.actual]); // no tocar el config.json real
    config.log = () => {};
    const ai = require('./src/services/aiService');
    ai.classifyMessage('hola').then(res => console.log(JSON.stringify({
      tipo: res.tipo, usados, guardados, actual: ai.modeloGroq.actual(), stats: ai.getAiStats().groq.modelo,
    })));
  `);
  assert.strictEqual(r.tipo, 'saludo');
  assert.deepStrictEqual(r.usados, ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
  assert.deepStrictEqual(r.guardados, [['groq', 'llama-3.3-70b-versatile']]);
  assert.strictEqual(r.actual, 'llama-3.3-70b-versatile');
  assert.strictEqual(r.stats, 'llama-3.3-70b-versatile', 'el panel de desarrolladores enseña el modelo nuevo');
});
