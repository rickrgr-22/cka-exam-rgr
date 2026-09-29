// Ejecuta la solución de referencia de cada tarea y verifica que todas las comprobaciones pasen.
import { load } from './load.mjs';
const CKA = load();
const only = process.argv[2];
let pass = 0; let fail = 0;
for (const t of CKA.tasks.list) {
  if (only && t.id !== only) continue;
  const S = CKA.tasks.build(t);
  const before = CKA.tasks.evaluate(t, S);
  const trivially = before.every((c) => c.ok);
  const log = [];
  const steps = ['ssh ' + t.host].concat(t.solution);
  for (const step of steps) {
    const r = CKA.shell.runLine(S, step);
    log.push('$ ' + step.split('\n')[0] + (step.includes('\n') ? ' …' : '') + '\n' + r.chunks.map((c) => (c.t === 'err' ? '[ERR] ' : '') + c.s).join('\n') + (r.why ? '\n[why] ' + r.why : '') + (r.editor ? '\n[EDITOR ABIERTO]' : ''));
  }
  const after = CKA.tasks.evaluate(t, S);
  const bad = after.filter((c) => !c.ok);
  if (bad.length || trivially) {
    fail++;
    console.log('✗ ' + t.id + ' — ' + t.title + (trivially ? '  (¡pasa sin hacer nada!)' : ''));
    for (const b of bad) console.log('    falla: ' + b.t);
    if (process.env.V || only) console.log(log.join('\n').split('\n').map((l) => '      ' + l).join('\n'));
  } else { pass++; console.log('✓ ' + t.id); }
}
console.log('\n' + pass + ' OK, ' + fail + ' con fallos, total ' + CKA.tasks.list.length);
process.exit(fail ? 1 : 0);
