// Carga los scripts del navegador en un contexto de Node para probar el simulador.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['js/vendor/js-yaml.min.js', 'js/core.js', 'js/sim.js', 'js/kubectl.js', 'js/shell.js', 'js/content.js', 'js/tasks.js', 'js/coach.js', 'js/quiz.js', 'js/plan.js'];

export function load(files = FILES) {
  const ctx = { console, Buffer, setTimeout, clearTimeout };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  return ctx.CKA;
}

export function sh(CKA, S, line) {
  const r = CKA.shell.runLine(S, line);
  return { text: r.chunks.map((c) => (c.t === 'err' ? '[ERR] ' : '') + c.s).join('\n'), r };
}
