'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { esModeloRetirado, elegirGemini, elegirGroq, GestorModelo } = require('../src/services/modelUpdater');

const gen = (name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });

test('reconoce los errores de modelo retirado de Gemini y Groq', () => {
  assert.ok(esModeloRetirado({ status: 404, message: 'models/gemini-1.5-flash is not found for API version v1beta' }));
  assert.ok(esModeloRetirado({ status: 400, message: 'The model `mixtral-8x7b-32768` has been decommissioned', code: 'model_decommissioned' }));
  assert.ok(esModeloRetirado({ message: '[GoogleGenerativeAI Error]: [404 Not Found] models/gemini-1.5-flash is not found' }));
  assert.ok(!esModeloRetirado({ status: 429, message: 'Rate limit reached' }));
  assert.ok(!esModeloRetirado(new Error('AI_TIMEOUT')));
  assert.ok(!esModeloRetirado(null));
});

test('Gemini: el flash estable más nuevo, sin preview, lite ni variantes', () => {
  const lista = [
    gen('gemini-2.0-flash'), gen('gemini-2.5-flash'), gen('gemini-2.5-flash-001'),
    gen('gemini-3.0-flash-preview'), gen('gemini-2.5-flash-lite'), gen('gemini-2.5-pro'),
    gen('gemini-2.5-flash-image'), gen('gemini-2.5-flash-preview-tts'),
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ];
  assert.strictEqual(elegirGemini(lista, 'gemini-1.5-flash'), 'gemini-2.5-flash');
  // No devuelve el mismo que acaba de fallar.
  assert.strictEqual(elegirGemini(lista, 'gemini-2.5-flash'), 'gemini-2.5-flash-001');
  // Si solo queda lite, vale lite.
  assert.strictEqual(elegirGemini([gen('gemini-2.5-flash-lite')], 'x'), 'gemini-2.5-flash-lite');
  assert.strictEqual(elegirGemini([gen('gemini-2.5-pro')], 'x'), null);
});

test('Groq: sigue la preferencia y descarta modelos que no son de chat', () => {
  const lista = [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-20b' }, { id: 'meta-llama/llama-guard-4-12b' }];
  assert.strictEqual(elegirGroq(lista, 'openai/gpt-oss-120b'), 'llama-3.3-70b-versatile');
  assert.strictEqual(elegirGroq([{ id: 'nuevo-modelo-120b' }, { id: 'otro' }], 'x'), 'nuevo-modelo-120b');
  assert.strictEqual(elegirGroq([{ id: 'llama-3.3-70b-versatile', active: false }], 'x'), null);
});

function gestor(extra = {}) {
  const guardados = [], logs = [];
  let t = 1_000_000_000;
  const g = new GestorModelo({
    proveedor: 'Gemini', configurado: 'gemini-1.5-flash',
    listar: async () => [gen('gemini-2.5-flash')], elegir: elegirGemini,
    guardar: (v) => guardados.push(v), log: (tag, m) => logs.push(`${tag} ${m}`),
    ahora: () => t, ...extra,
  });
  return { g, guardados, logs, avanzar: (ms) => { t += ms; } };
}

test('si el modelo está retirado cambia, guarda, avisa y reintenta', async () => {
  const { g, guardados, logs } = gestor();
  const usados = [];
  const r = await g.ejecutar(async (m) => {
    usados.push(m);
    if (m === 'gemini-1.5-flash') throw Object.assign(new Error('models/gemini-1.5-flash is not found'), { status: 404 });
    return 'ok';
  });
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(usados, ['gemini-1.5-flash', 'gemini-2.5-flash']);
  assert.strictEqual(g.actual(), 'gemini-2.5-flash');
  assert.strictEqual(guardados[0].configurado, 'gemini-1.5-flash');
  assert.strictEqual(guardados[0].actual, 'gemini-2.5-flash');
  assert.ok(logs.some(l => l.startsWith('WARN') && l.includes('retirado')));
});

test('otros errores (cuota, timeout) no cambian de modelo', async () => {
  const { g, guardados } = gestor();
  await assert.rejects(g.ejecutar(async () => { throw Object.assign(new Error('Rate limit'), { status: 429 }); }), /Rate limit/);
  assert.strictEqual(g.actual(), 'gemini-1.5-flash');
  assert.strictEqual(guardados.length, 0);
});

test('no consulta la lista más de una vez por hora', async () => {
  let consultas = 0;
  const { g, avanzar } = gestor({ listar: async () => { consultas++; return []; } });
  const retirado = Object.assign(new Error('decommissioned'), { status: 400 });
  assert.strictEqual(await g.actualizarSiRetirado(retirado), false);
  assert.strictEqual(await g.actualizarSiRetirado(retirado), false);
  assert.strictEqual(consultas, 1);
  avanzar(61 * 60 * 1000);
  await g.actualizarSiRetirado(retirado);
  assert.strictEqual(consultas, 2);
});

test('el cambio guardado se usa al arrancar, salvo que el .env pida otro modelo', () => {
  const guardado = { configurado: 'gemini-1.5-flash', actual: 'gemini-2.5-flash' };
  assert.strictEqual(gestor({ guardado }).g.actual(), 'gemini-2.5-flash');
  assert.strictEqual(gestor({ guardado, configurado: 'gemini-3.0-flash' }).g.actual(), 'gemini-3.0-flash');
});
