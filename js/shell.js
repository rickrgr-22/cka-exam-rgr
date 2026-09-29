/* Kubelab CKA — shell (bash reducido) y herramientas de nodo:
   ssh, sudo, systemctl, journalctl, kubeadm, apt, dpkg, etcdctl/etcdutl, helm, crictl, sysctl, curl… */
(function (CKA) {
  'use strict';
  const C = CKA.core;
  const X = CKA.sim;
  const { clone, find, list } = C;

  // ================================================================ tokenizador
  function tokenize(line, S, depth) {
    const toks = [];
    let cur = null; // palabra en construcción
    let i = 0;
    const env = (S && S.env) || {};
    const push = () => { if (cur !== null) { toks.push(cur); cur = null; } };
    const addText = (t) => { cur = (cur || '') + t; };
    const expandVar = (name) => {
      if (name === 'HOME') return S && S.user === 'root' ? '/root' : '/home/candidate';
      if (name === 'PWD') return S ? S.cwd : '';
      if (name === 'USER') return S ? S.user : '';
      if (name === 'HOSTNAME') return S ? S.host : '';
      if (name === '?') return String(S && S.lastCode || 0);
      return env[name] !== undefined ? env[name] : '';
    };
    const readVar = (j) => {
      if (line[j] === '{') { const e = line.indexOf('}', j); return { name: line.slice(j + 1, e), end: e + 1 }; }
      if (line[j] === '?') return { name: '?', end: j + 1 };
      let k = j; while (k < line.length && /[A-Za-z0-9_]/.test(line[k])) k++;
      return { name: line.slice(j, k), end: k };
    };
    const cmdSubst = (j) => {
      let d = 1; let k = j + 2;
      for (; k < line.length; k++) { if (line[k] === '(') d++; if (line[k] === ')') { d--; if (d === 0) break; } }
      const inner = line.slice(j + 2, k);
      let out = '';
      if (S && (depth || 0) < 3) { const r = runLine(S, inner, { depth: (depth || 0) + 1, capture: true }); out = (r.stdout || '').replace(/\n+$/, ''); }
      return { out, end: k + 1 };
    };
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') { push(); i++; continue; }
      if (ch === '#' && cur === null) break;
      if (ch === "'") { const e = line.indexOf("'", i + 1); addText(e < 0 ? line.slice(i + 1) : line.slice(i + 1, e)); i = e < 0 ? line.length : e + 1; continue; }
      if (ch === '"') {
        let j = i + 1; let s = '';
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) { s += line[j + 1]; j += 2; continue; }
          if (line[j] === '$' && line[j + 1] === '(') { const r = cmdSubst(j); s += r.out; j = r.end; continue; }
          if (line[j] === '$' && /[A-Za-z_{?]/.test(line[j + 1] || '')) { const v = readVar(j + 1); s += expandVar(v.name); j = v.end; continue; }
          s += line[j]; j++;
        }
        addText(s); i = j + 1; continue;
      }
      if (ch === '\\' && i + 1 < line.length) { addText(line[i + 1]); i += 2; continue; }
      if (ch === '$' && line[i + 1] === '(') { const r = cmdSubst(i); const parts = r.out.split(/\s+/).filter(Boolean); parts.forEach((p, idx) => { if (idx) push(); addText(p); }); i = r.end; continue; }
      if (ch === '$' && /[A-Za-z_{?]/.test(line[i + 1] || '')) {
        const v = readVar(i + 1);
        const val = expandVar(v.name);
        const parts = val.split(/\s+/);
        parts.forEach((p, idx) => { if (idx) push(); if (p) addText(p); else if (idx === 0 && cur === null && parts.length === 1) { /* vacío */ } });
        i = v.end; continue;
      }
      // operadores
      const two = line.slice(i, i + 2); const three = line.slice(i, i + 4);
      if (three === '2>&1') { push(); toks.push({ op: '2>&1' }); i += 4; continue; }
      if (line.startsWith('<<__HEREDOC', i)) { push(); const e = line.indexOf('__', i + 11); toks.push({ op: 'heredoc', id: line.slice(i + 11, e) }); i = e + 2; continue; }
      if (two === '&&' || two === '||' || two === '>>' || two === '2>' || two === '&>') { push(); toks.push({ op: two }); i += 2; continue; }
      if (ch === '|' || ch === ';' || ch === '>' || ch === '<') { push(); toks.push({ op: ch }); i++; continue; }
      if (ch === '&') { push(); i++; continue; }
      addText(ch); i++;
    }
    push();
    return toks;
  }

  // ================================================================ salida
  function Res(out, err, code) { return { out: out || '', err: err || '', code: code || 0 }; }

  // ================================================================ utilidades de texto
  function lines(t) { if (!t) return []; const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }
  function readFileFor(S, path, cmd) {
    const p = X.norm(path, S.cwd);
    if (X.fsIsDir(S, S.host, p)) return { err: cmd + ': ' + path + ': Is a directory' };
    const t = X.fsRead(S, S.host, p);
    if (t == null) return { err: cmd + ': ' + path + ': No such file or directory' };
    if (!X.canRead(S, p)) return { err: cmd + ': ' + path + ': Permission denied' };
    return { text: t };
  }

  function globExpand(S, word) {
    if (typeof word !== 'string' || !word.includes('*') || /^['"]/.test(word)) return [word];
    const p = X.norm(word, S.cwd);
    const dir = X.parentOf(p);
    const pat = p.slice(dir.length).replace(/^\//, '');
    if (pat.includes('/')) return [word];
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const m = X.fsList(S, S.host, dir).filter((e) => re.test(e.name)).map((e) => (word.startsWith('/') ? (dir === '/' ? '' : dir) + '/' + e.name : (word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '') + e.name));
    return m.length ? m : [word];
  }

  // ================================================================ builtins de texto
  function cmdGrep(S, argv, stdin) {
    let flags = { i: false, v: false, c: false, E: false, w: false, o: false, n: false, q: false, l: false, r: false, A: 0, B: 0 };
    const pats = []; const files = [];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-e') { pats.push(argv[++k]); continue; }
      if (a === '-A' || a === '-B' || a === '-C') { const n = +argv[++k]; if (a === '-C') { flags.A = n; flags.B = n; } else flags[a[1]] = n; continue; }
      if (/^-[A-Za-z]+$/.test(a) && !pats.length && !files.length || /^-[ivcEwonqlrPFh]+$/.test(a)) { for (const ch of a.slice(1)) { if (ch === 'P' || ch === 'F') continue; flags[ch] = true; } continue; }
      if (/^--(ignore-case|invert-match|count)$/.test(a)) { flags[{ '--ignore-case': 'i', '--invert-match': 'v', '--count': 'c' }[a]] = true; continue; }
      if (!pats.length) pats.push(a); else files.push(a);
    }
    if (!pats.length) return Res('', 'Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
    let re;
    try {
      const src = pats.map((p) => (flags.E ? p : p.replace(/\\\|/g, '|').replace(/[+?(){}]/g, (m) => '\\' + m).replace(/\\\\([+?(){}|])/g, '$1'))).join('|');
      re = new RegExp(flags.w ? '\\b(?:' + src + ')\\b' : src, flags.i ? 'gi' : 'g');
    } catch (e) { return Res('', 'grep: Unmatched ( or \\(', 2); }
    const run = (text, label) => {
      const L = lines(text);
      const outL = []; let count = 0;
      const keep = new Set();
      L.forEach((l, idx) => {
        re.lastIndex = 0;
        const hit = re.test(l) !== flags.v;
        if (hit) { count++; for (let b = Math.max(0, idx - flags.B); b <= Math.min(L.length - 1, idx + flags.A); b++) keep.add(b); }
      });
      if (flags.c) return [(label ? label + ':' : '') + count];
      if (flags.l) return count ? [label || '(standard input)'] : [];
      L.forEach((l, idx) => {
        if (!keep.has(idx)) return;
        if (flags.o) { re.lastIndex = 0; const m = l.match(re) || []; m.forEach((x) => outL.push((label ? label + ':' : '') + x)); return; }
        outL.push((label ? label + ':' : '') + (flags.n ? (idx + 1) + ':' : '') + l);
      });
      return outL;
    };
    let outL = []; let errs = [];
    if (!files.length) outL = run(stdin || '');
    else for (const f of files) { const r = readFileFor(S, f, 'grep'); if (r.err) errs.push(r.err); else outL = outL.concat(run(r.text, files.length > 1 ? f : null)); }
    const matched = flags.c ? outL.some((x) => !/(^|:)0$/.test(x)) : outL.length > 0;
    return Res(flags.q ? '' : outL.join('\n'), errs.join('\n'), errs.length ? 2 : matched ? 0 : 1);
  }

  function inputOf(S, argv, stdin, cmd) {
    const files = argv.slice(1).filter((x) => !x.startsWith('-') || x === '-');
    if (!files.length || files[0] === '-') return { text: stdin || '' };
    let t = '';
    for (const f of files) { const r = readFileFor(S, f, cmd); if (r.err) return r; t += r.text; }
    return { text: t };
  }

  function cmdHeadTail(S, argv, stdin, isHead) {
    let n = 10; let fromStart = false; const rest = [argv[0]];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-n' || a === '-c') { const v = argv[++k]; if (String(v).startsWith('+')) { fromStart = true; n = +v.slice(1); } else n = +v; continue; }
      if (/^-n\d+$/.test(a)) { n = +a.slice(2); continue; }
      if (/^-\d+$/.test(a)) { n = +a.slice(1); continue; }
      if (a === '-f' || a === '-F') continue;
      rest.push(a);
    }
    const inp = inputOf(S, rest, stdin, isHead ? 'head' : 'tail');
    if (inp.err) return Res('', inp.err, 1);
    const L = lines(inp.text);
    const out = isHead ? L.slice(0, n) : fromStart ? L.slice(Math.max(0, n - 1)) : L.slice(-n || L.length);
    return Res(n === 0 && !isHead && !fromStart ? '' : out.join('\n'));
  }

  function cmdWc(S, argv, stdin) {
    const opts = argv.filter((x) => x.startsWith('-')).join('');
    const inp = inputOf(S, argv, stdin, 'wc');
    if (inp.err) return Res('', inp.err, 1);
    const t = inp.text || '';
    const l = (t.match(/\n/g) || []).length + (t && !t.endsWith('\n') ? 1 : 0);
    const w = t.split(/\s+/).filter(Boolean).length;
    if (opts.includes('l')) return Res(String(l));
    if (opts.includes('w')) return Res(String(w));
    if (opts.includes('c')) return Res(String(t.length));
    return Res('      ' + l + '      ' + w + '     ' + t.length);
  }

  function cmdSort(S, argv, stdin) {
    let num = false; let rev = false; let key = 0; let sep = null; let uniq = false; let human = false;
    const rest = [argv[0]];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-k') { key = parseInt(argv[++k], 10); continue; }
      if (a === '-t') { sep = argv[++k]; continue; }
      if (/^-k\d/.test(a)) { key = parseInt(a.slice(2), 10); continue; }
      if (/^-[nrhuk]+$/.test(a)) { num = num || a.includes('n'); rev = rev || a.includes('r'); uniq = uniq || a.includes('u'); human = human || a.includes('h'); continue; }
      rest.push(a);
    }
    const inp = inputOf(S, rest, stdin, 'sort');
    if (inp.err) return Res('', inp.err, 1);
    let L = lines(inp.text);
    const kf = (l) => (key ? (sep ? l.split(sep) : l.trim().split(/\s+/))[key - 1] || '' : l);
    const hv = (s) => { const m = String(s).match(/^([\d.]+)\s*([KMGTkmi]*)/); if (!m) return 0; const mult = { '': 1, m: 0.001, K: 1e3, Ki: 1024, M: 1e6, Mi: 1048576, G: 1e9, Gi: 1073741824 }; return parseFloat(m[1]) * (mult[m[2]] || 1); };
    L.sort((x, y) => { const a = kf(x); const b = kf(y); if (num || human) return (human ? hv(a) - hv(b) : parseFloat(a) - parseFloat(b)) || x.localeCompare(y); return a.localeCompare(b); });
    if (rev) L.reverse();
    if (uniq) L = L.filter((x, idx) => L.indexOf(x) === idx);
    return Res(L.join('\n'));
  }

  function cmdUniq(S, argv, stdin) {
    const c = argv.includes('-c');
    const L = lines(stdin);
    const out = [];
    for (const l of L) { if (out.length && out[out.length - 1].l === l) out[out.length - 1].n++; else out.push({ l, n: 1 }); }
    return Res(out.map((o) => (c ? String(o.n).padStart(7) + ' ' : '') + o.l).join('\n'));
  }

  function cmdCut(S, argv, stdin) {
    let d = '\t'; let fields = null; let chars = null; const rest = [argv[0]];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-d') { d = argv[++k]; continue; }
      if (a.startsWith('-d')) { d = a.slice(2); continue; }
      if (a === '-f') { fields = argv[++k]; continue; }
      if (a.startsWith('-f')) { fields = a.slice(2); continue; }
      if (a === '-c') { chars = argv[++k]; continue; }
      rest.push(a);
    }
    const inp = inputOf(S, rest, stdin, 'cut');
    if (inp.err) return Res('', inp.err, 1);
    const rng = (spec, n) => { const out = []; for (const part of spec.split(',')) { const [a, b] = part.split('-'); const s = a ? +a : 1; const e = part.includes('-') ? (b ? +b : n) : s; for (let q = s; q <= e; q++) out.push(q); } return out; };
    return Res(lines(inp.text).map((l) => {
      if (chars) return rng(chars, l.length).map((q) => l[q - 1] || '').join('');
      const parts = l.split(d);
      if (parts.length === 1) return l;
      return rng(fields || '1', parts.length).map((q) => parts[q - 1]).filter((x) => x !== undefined).join(d);
    }).join('\n'));
  }

  function cmdTr(S, argv, stdin) {
    const del = argv[1] === '-d'; const sq = argv[1] === '-s';
    const a = del || sq ? argv[2] : argv[1]; const b = argv[2];
    const exp = (s) => String(s || '').replace(/\[:upper:\]/g, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').replace(/\[:lower:\]/g, 'abcdefghijklmnopqrstuvwxyz').replace(/\[:space:\]/g, ' \t\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/([a-z0-9])-([a-z0-9])/gi, (m, x, y) => { let r = ''; for (let c = x.charCodeAt(0); c <= y.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
    const A = exp(a); const B = exp(b);
    let out = '';
    for (const ch of stdin || '') {
      const idx = A.indexOf(ch);
      if (del) { if (idx < 0) out += ch; continue; }
      if (sq) { if (idx >= 0 && out.endsWith(ch)) continue; out += ch; continue; }
      out += idx >= 0 ? (B[Math.min(idx, B.length - 1)] || '') : ch;
    }
    return Res(out.replace(/\n$/, ''));
  }

  function cmdAwk(S, argv, stdin) {
    let sep = null; let prog = null; const files = [];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-F') { sep = argv[++k]; continue; }
      if (a.startsWith('-F')) { sep = a.slice(2); continue; }
      if (prog === null) prog = a; else files.push(a);
    }
    if (prog === null) return Res('', 'usage: awk [-F fs] \'prog\' [file ...]', 2);
    let text = stdin || '';
    if (files.length) { const r = readFileFor(S, files[0], 'awk'); if (r.err) return Res('', 'awk: ' + r.err, 2); text = r.text; }
    const m = prog.trim().match(/^([^{]*)(?:\{(.*)\})?\s*$/s);
    const pattern = (m && m[1] || '').trim();
    const action = m && m[2] !== undefined ? m[2].trim() : 'print $0';
    const out = [];
    const L = lines(text);
    L.forEach((l, idx) => {
      const F = sep ? l.split(sep === '\\t' ? '\t' : sep) : l.trim().split(/\s+/);
      const field = (s) => {
        s = s.trim();
        if (s === '$0') return l;
        if (s === '$NF') return F[F.length - 1];
        if (s === 'NR') return String(idx + 1);
        if (s === 'NF') return String(F.length);
        const fm = s.match(/^\$(\d+)$/);
        if (fm) return F[+fm[1] - 1] || '';
        if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\t/g, '\t').replace(/\\n/g, '\n');
        return s;
      };
      let ok = true;
      if (pattern) {
        let pm;
        if ((pm = pattern.match(/^NR\s*(==|>|<|>=|<=|!=)\s*(\d+)$/))) { const n = idx + 1; const v = +pm[2]; ok = { '==': n === v, '>': n > v, '<': n < v, '>=': n >= v, '<=': n <= v, '!=': n !== v }[pm[1]]; }
        else if ((pm = pattern.match(/^\/(.*)\/$/))) ok = new RegExp(pm[1]).test(l);
        else if ((pm = pattern.match(/^!\/(.*)\/$/))) ok = !new RegExp(pm[1]).test(l);
        else if ((pm = pattern.match(/^(\$\w+)\s*(==|!=)\s*"(.*)"$/))) ok = (field(pm[1]) === pm[3]) === (pm[2] === '==');
        else if ((pm = pattern.match(/^(\$\w+)\s*(!?~)\s*\/(.*)\/$/))) ok = new RegExp(pm[3]).test(field(pm[1])) === (pm[2] === '~');
        else if ((pm = pattern.match(/^(\$\w+)\s*(>|<|>=|<=)\s*(\d+)$/))) { const n = parseFloat(field(pm[1])); const v = +pm[3]; ok = { '>': n > v, '<': n < v, '>=': n >= v, '<=': n <= v }[pm[2]]; }
      }
      if (!ok) return;
      for (const stmt of action.split(';').map((s) => s.trim()).filter(Boolean)) {
        const pm = stmt.match(/^print\s*(.*)$/);
        if (!pm) continue;
        const args = pm[1] ? pm[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/) : ['$0'];
        out.push(args.map((a) => a.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(field).join('')).join(' '));
      }
    });
    return Res(out.join('\n'));
  }

  function cmdSed(S, argv, stdin) {
    let inPlace = false; let quiet = false; const exprs = []; const files = [];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-i' || a.startsWith('-i')) { inPlace = true; continue; }
      if (a === '-n') { quiet = true; continue; }
      if (a === '-e') { exprs.push(argv[++k]); continue; }
      if (a === '-E' || a === '-r') continue;
      if (!exprs.length) exprs.push(a); else files.push(a);
    }
    const apply = (text) => {
      let L = lines(text);
      for (const ex of exprs) {
        let m;
        if ((m = ex.match(/^s(.)(.*?)\1(.*?)\1([gI]*)$/))) {
          const re = new RegExp(m[2].replace(/\\\//g, '/'), m[4].includes('g') ? 'g' : '' + (m[4].includes('I') ? 'i' : ''));
          L = L.map((l) => l.replace(re, m[3].replace(/\\\//g, '/').replace(/&/g, '$&')));
        } else if ((m = ex.match(/^(\d+)(?:,(\d+|\$))?p$/))) {
          const a = +m[1]; const b = m[2] === '$' ? L.length : m[2] ? +m[2] : a;
          return L.slice(a - 1, b).join('\n');
        } else if ((m = ex.match(/^\/(.*)\/d$/))) { const re = new RegExp(m[1]); L = L.filter((l) => !re.test(l)); }
        else if ((m = ex.match(/^(\d+)d$/))) { L.splice(+m[1] - 1, 1); }
        else return null;
      }
      return quiet ? '' : L.join('\n') + (text.endsWith('\n') ? '\n' : '');
    };
    if (!files.length) { const r = apply(stdin || ''); return r === null ? Res('', 'sed: -e expression #1, char 1: unknown command', 1) : Res(r.replace(/\n$/, '')); }
    const outs = [];
    for (const f of files) {
      const p = X.norm(f, S.cwd);
      const r = readFileFor(S, f, 'sed');
      if (r.err) return Res('', 'sed: can\'t read ' + f + ': No such file or directory', 2);
      const res = apply(r.text);
      if (res === null) return Res('', 'sed: -e expression #1, char 1: unknown command', 1);
      if (inPlace) { if (!X.canWrite(S, p)) return Res('', 'sed: couldn\'t open temporary file ' + X.parentOf(p) + '/sedXYZ: Permission denied', 4); X.fsWrite(S, S.host, p, res); } else outs.push(res.replace(/\n$/, ''));
    }
    return Res(outs.join('\n'));
  }

  function b64enc(s) { return CKA.kubectl.b64(s); }
  function b64dec(s) { return CKA.kubectl.unb64(String(s).replace(/\s+/g, '')); }

  // ================================================================ archivos
  function cmdLs(S, argv) {
    const opts = argv.filter((x) => x.startsWith('-')).join('');
    const long = opts.includes('l'); const all = opts.includes('a');
    const paths = argv.slice(1).filter((x) => !x.startsWith('-'));
    if (!paths.length) paths.push('.');
    const out = []; const errs = [];
    for (const pth of paths) {
      const p = X.norm(pth, S.cwd);
      if (!X.fsExists(S, S.host, p)) { errs.push("ls: cannot access '" + pth + "': No such file or directory"); continue; }
      if (!X.fsIsDir(S, S.host, p)) { out.push(long ? '-rw-r--r-- 1 root root ' + String((X.fsRead(S, S.host, p) || '').length).padStart(6) + ' Oct  3 14:00 ' + pth : pth); continue; }
      if (!X.canRead(S, p + '/x') && p.startsWith('/root')) { errs.push("ls: cannot open directory '" + pth + "': Permission denied"); continue; }
      let ents = X.fsList(S, S.host, p);
      if (!all) ents = ents.filter((e) => !e.name.startsWith('.'));
      if (paths.length > 1) out.push(pth + ':');
      if (long) { out.push('total ' + ents.length * 4); for (const e of ents) out.push((e.dir ? 'drwxr-xr-x 2' : '-rw-r--r-- 1') + ' root root ' + String(e.dir ? 4096 : (X.fsRead(S, S.host, p.replace(/\/$/, '') + '/' + e.name) || '').length).padStart(6) + ' Oct  3 14:00 ' + e.name); }
      else if (ents.length) out.push(ents.map((e) => e.name + (e.dir ? '/' : '')).join('  '));
    }
    return Res(out.join('\n'), errs.join('\n'), errs.length ? 2 : 0);
  }

  function cmdCat(S, argv, stdin) {
    const files = argv.slice(1).filter((x) => x !== '-n');
    if (!files.length) return Res((stdin || '').replace(/\n$/, ''));
    let out = ''; const errs = [];
    for (const f of files) { const r = readFileFor(S, f, 'cat'); if (r.err) errs.push(r.err); else out += r.text; }
    if (argv.includes('-n')) out = lines(out).map((l, i) => String(i + 1).padStart(6) + '  ' + l).join('\n');
    return Res(out.replace(/\n$/, ''), errs.join('\n'), errs.length ? 1 : 0);
  }

  function cmdCpMv(S, argv, move) {
    const args = argv.slice(1).filter((x) => !x.startsWith('-'));
    if (args.length < 2) return Res('', argv[0] + ': missing destination file operand', 1);
    const dst = X.norm(args[args.length - 1], S.cwd);
    for (const src of args.slice(0, -1)) {
      const sp = X.norm(src, S.cwd);
      const t = X.fsRead(S, S.host, sp);
      if (t == null && !X.fsIsDir(S, S.host, sp)) return Res('', argv[0] + ": cannot stat '" + src + "': No such file or directory", 1);
      if (!X.canRead(S, sp)) return Res('', argv[0] + ": cannot open '" + src + "' for reading: Permission denied", 1);
      if (X.fsIsDir(S, S.host, sp)) {
        const target = X.fsIsDir(S, S.host, dst) ? dst + '/' + sp.split('/').pop() : dst;
        if (!X.canWrite(S, target)) return Res('', argv[0] + ": cannot create directory '" + target + "': Permission denied", 1);
        const fs = X.fsOf(S, S.host);
        for (const f of Object.keys(fs.files)) if (f.startsWith(sp + '/')) X.fsWrite(S, S.host, target + f.slice(sp.length), fs.files[f]);
        for (const d of Object.keys(fs.dirs)) if (d === sp || d.startsWith(sp + '/')) X.mkdirp(fs, target + d.slice(sp.length));
        if (move) X.fsRemove(S, S.host, sp, true);
        continue;
      }
      const target = X.fsIsDir(S, S.host, dst) ? dst + '/' + sp.split('/').pop() : dst;
      if (!X.canWrite(S, target)) return Res('', argv[0] + ": cannot create regular file '" + target + "': Permission denied", 1);
      if (!X.fsIsDir(S, S.host, X.parentOf(target))) return Res('', argv[0] + ": cannot create regular file '" + target + "': No such file or directory", 1);
      X.fsWrite(S, S.host, target, t);
      const sk = X.hostKey(S, S.host) + ':' + sp;
      if (S.snapshots[sk]) S.snapshots[X.hostKey(S, S.host) + ':' + target] = S.snapshots[sk];
      if (move) { X.fsRemove(S, S.host, sp); if (!X.canWrite(S, sp)) return Res('', "mv: cannot remove '" + src + "': Permission denied", 1); }
    }
    return Res();
  }

  function cmdMkdir(S, argv) {
    const p = argv.includes('-p');
    for (const d of argv.slice(1).filter((x) => !x.startsWith('-'))) {
      const dp = X.norm(d, S.cwd);
      if (!X.canWrite(S, dp)) return Res('', "mkdir: cannot create directory '" + d + "': Permission denied", 1);
      if (X.fsExists(S, S.host, dp) && !p) return Res('', "mkdir: cannot create directory '" + d + "': File exists", 1);
      if (!p && !X.fsIsDir(S, S.host, X.parentOf(dp))) return Res('', "mkdir: cannot create directory '" + d + "': No such file or directory", 1);
      X.mkdirp(X.fsOf(S, S.host), dp);
    }
    return Res();
  }

  function cmdRm(S, argv) {
    const rec = argv.some((x) => /^-[a-zA-Z]*r/i.test(x));
    for (const f of argv.slice(1).filter((x) => !x.startsWith('-'))) {
      const p = X.norm(f, S.cwd);
      if (!X.fsExists(S, S.host, p)) { if (argv.some((x) => /^-[a-zA-Z]*f/.test(x))) continue; return Res('', "rm: cannot remove '" + f + "': No such file or directory", 1); }
      if (!X.canWrite(S, p)) return Res('', "rm: cannot remove '" + f + "': Permission denied", 1);
      if (X.fsIsDir(S, S.host, p) && !rec) return Res('', "rm: cannot remove '" + f + "': Is a directory", 1);
      X.fsRemove(S, S.host, p, rec);
    }
    return Res();
  }

  function cmdTouch(S, argv) {
    for (const f of argv.slice(1).filter((x) => !x.startsWith('-'))) {
      const p = X.norm(f, S.cwd);
      if (!X.canWrite(S, p)) return Res('', "touch: cannot touch '" + f + "': Permission denied", 1);
      if (!X.fsIsDir(S, S.host, X.parentOf(p))) return Res('', "touch: cannot touch '" + f + "': No such file or directory", 1);
      if (X.fsRead(S, S.host, p) == null) X.fsWrite(S, S.host, p, '');
    }
    return Res();
  }

  function editorFor(S, argv) {
    const f = argv.slice(1).filter((x) => !x.startsWith('-') && !x.startsWith('+'))[0];
    if (!f) return Res('', argv[0] + ': en el simulador indica un archivo, p. ej. ' + argv[0] + ' pod.yaml', 1);
    const p = X.norm(f, S.cwd);
    if (X.fsIsDir(S, S.host, p)) return Res('', '"' + f + '" is a directory', 1);
    if (!X.canRead(S, p)) return Res('', '"' + f + '" [Permission Denied]', 1);
    const cur = X.fsRead(S, S.host, p);
    const user = S.user;
    return {
      out: '', err: '', code: 0,
      editor: {
        title: argv[0] + ' ' + f + (cur == null ? '  [New]' : ''),
        path: p,
        content: cur == null ? '' : cur,
        onSave(S2, text) {
          if (!X.canWrite(Object.assign({}, S2, { user }), p)) return { err: '"' + f + '" E212: Can\'t open file for writing (¿necesitas sudo? usa "sudo vim ' + f + '" o "sudo -i")', code: 1 };
          if (!X.fsIsDir(S2, S2.host, X.parentOf(p))) return { err: '"' + f + '" E212: Can\'t open file for writing (el directorio ' + X.parentOf(p) + ' no existe)', code: 1 };
          X.fsWrite(S2, S2.host, p, text.endsWith('\n') ? text : text + '\n');
          return { out: '"' + f + '" ' + (cur == null ? '[New] ' : '') + lines(text).length + 'L, ' + text.length + 'B written' };
        },
      },
    };
  }

  // ================================================================ nodos
  function nodeHere(S) { return find(S, 'Node', null, X.hostKey(S, S.host)); }
  function needRoot(S, msg) { return S.user === 'root' ? null : msg; }

  function kubeletUnit(S, nn) {
    const fs = X.fsOf(S, nn);
    const files = Object.keys(fs.files).filter((f) => /^\/(usr\/lib|etc|lib)\/systemd\/system\/kubelet\.service\.d\/.*\.conf$/.test(f)).sort((a, b) => a.split('/').pop().localeCompare(b.split('/').pop()));
    return files.map((f) => fs.files[f]).join('\n');
  }

  function svcDef(S, n, name) {
    name = name.replace(/\.service$/, '');
    if (name === 'docker') return null;
    return n._sim.svc[name] ? name : null;
  }

  function journalLines(S, n, svc, count) {
    const s = n._sim.svc[svc];
    const nn = n.metadata.name;
    const ts = (k) => 'Oct 03 13:' + String(50 + k).padStart(2, '0') + ':0' + (k % 10) + ' ' + nn + ' ';
    const L = [];
    if (svc === 'kubelet') {
      if (s.error) { for (let k = 0; k < 4; k++) { L.push(ts(k) + 'systemd[1]: Started kubelet.service - kubelet: The Kubernetes Node Agent.'); L.push(ts(k) + 'kubelet[' + (4100 + k) + ']: ' + s.error); L.push(ts(k) + 'systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE'); L.push(ts(k) + 'systemd[1]: kubelet.service: Failed with result \'exit-code\'.'); } }
      else if (!s.active) { L.push(ts(1) + 'systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...'); L.push(ts(1) + 'systemd[1]: kubelet.service: Deactivated successfully.'); L.push(ts(1) + 'systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.'); }
      else {
        L.push(ts(2) + 'systemd[1]: Started kubelet.service - kubelet: The Kubernetes Node Agent.');
        L.push(ts(2) + 'kubelet[2211]: I1003 server.go:530] "Kubelet version" kubeletVersion="v' + n._sim.runningKubelet + '"');
        if (!S.cni) L.push(ts(3) + 'kubelet[2211]: E1003 kubelet.go:3115] "Container runtime network not ready" networkReady="NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized"');
        if (n._sim.cp && S.cp.apiserver && !S.cp.apiserver.ok) L.push(ts(3) + 'kubelet[2211]: E1003 pod_workers.go:1301] "Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"kube-apiserver\\" with CrashLoopBackOff: \\"back-off 5m0s restarting failed container=kube-apiserver pod=kube-apiserver-' + nn + '_kube-system\\"" pod="kube-system/kube-apiserver-' + nn + '"');
        if (n._sim.cp && S.cp.apiserver && !S.cp.apiserver.ok) L.push(ts(4) + 'kubelet[2211]: E1003 kubelet_node_status.go:548] "Error updating node status, will retry" err="error getting node \\"' + nn + '\\": Get \\"https://' + S.cpIP + ':6443/api/v1/nodes/' + nn + '\\": dial tcp ' + S.cpIP + ':6443: connect: connection refused"');
      }
    } else {
      L.push(ts(1) + 'systemd[1]: ' + (s.active ? 'Started' : 'Stopped') + ' ' + svc + '.service.');
    }
    return L.slice(-(count || 50));
  }

  function cmdSystemctl(S, argv) {
    const args = argv.slice(1).filter((x) => !x.startsWith('-') || x === '--now');
    const now = argv.includes('--now');
    const sub = args[0];
    const names = args.slice(1).filter((x) => x !== '--now');
    const n = nodeHere(S);
    if (!n && sub !== 'daemon-reload') return Res('', 'Unit ' + (names[0] || '') + '.service could not be found.', 4);
    const priv = ['start', 'stop', 'restart', 'enable', 'disable', 'daemon-reload', 'reload'];
    if (priv.includes(sub) && S.user !== 'root') return Res('', 'Failed to ' + sub + ' ' + (names[0] || 'units') + ': Access denied\nSee system logs and \'systemctl status ' + (names[0] || '') + '\' for details.\n(pista: usa sudo o sudo -i)', 1);
    if (sub === 'daemon-reload') { if (n) n._sim.unitLoaded = kubeletUnit(S, n.metadata.name); return Res(); }
    if (!names.length) return Res('', 'Too few arguments.', 1);
    const out = []; const errs = [];
    for (const raw of names) {
      const svc = svcDef(S, n, raw);
      if (!svc) { errs.push((sub === 'status' ? 'Unit ' : 'Failed to ' + sub + ' ') + raw.replace(/\.service$/, '') + '.service' + (sub === 'status' ? ' could not be found.' : ': Unit ' + raw.replace(/\.service$/, '') + '.service not found.')); continue; }
      const s = n._sim.svc[svc];
      const start = () => {
        if (svc === 'kubelet') {
          const stale = n._sim.unitLoaded !== kubeletUnit(S, n.metadata.name);
          if (stale) out.push('Warning: The unit file, source configuration file or drop-ins of kubelet.service changed on disk. Run \'systemctl daemon-reload\' to reload units.');
          const e = X.kubeletCheck(S, n);
          if (e) { s.active = false; s.error = e; } else { s.active = true; s.error = null; n._sim.runningKubelet = n._sim.pkgs.kubelet; }
        } else { s.active = true; s.error = null; }
      };
      switch (sub) {
        case 'start': case 'restart': case 'reload': start(); break;
        case 'stop': s.active = false; s.error = null; break;
        case 'enable': s.enabled = true; out.push('Created symlink /etc/systemd/system/multi-user.target.wants/' + svc + '.service → /usr/lib/systemd/system/' + svc + '.service.'); if (now) start(); break;
        case 'disable': s.enabled = false; out.push('Removed "/etc/systemd/system/multi-user.target.wants/' + svc + '.service".'); if (now) s.active = false; break;
        case 'is-active': out.push(s.active ? 'active' : (s.error ? 'activating' : 'inactive')); break;
        case 'is-enabled': out.push(s.enabled ? 'enabled' : 'disabled'); break;
        case 'status': {
          const state = s.active ? 'active (running) since Fri 2026-10-03 13:10:02 UTC; 50min ago' : s.error ? 'activating (auto-restart) (Result: exit-code) since Fri 2026-10-03 14:00:01 UTC; 3s ago' : 'inactive (dead) since Fri 2026-10-03 13:40:00 UTC; 20min ago';
          const L = ['● ' + svc + '.service - ' + (svc === 'kubelet' ? 'kubelet: The Kubernetes Node Agent' : svc === 'containerd' ? 'containerd container runtime' : svc),
            '     Loaded: loaded (/usr/lib/systemd/system/' + svc + '.service; ' + (s.enabled ? 'enabled' : 'disabled') + '; preset: enabled)'];
          if (svc === 'kubelet') L.push('    Drop-In: /usr/lib/systemd/system/kubelet.service.d\n             └─10-kubeadm.conf');
          L.push('     Active: ' + state);
          if (svc === 'kubelet' && n._sim.unitLoaded !== kubeletUnit(S, n.metadata.name)) L.unshift('Warning: The unit file, source configuration file or drop-ins of kubelet.service changed on disk. Run \'systemctl daemon-reload\' to reload units.');
          if (s.active) L.push('   Main PID: 2211 (' + svc + ')\n      Tasks: 12 (limit: 4598)\n     Memory: 48.2M');
          if (s.error) L.push('    Process: 4103 ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS (code=exited, status=1/FAILURE)\n   Main PID: 4103 (code=exited, status=1/FAILURE)');
          L.push('');
          L.push(...journalLines(S, n, svc, 4));
          out.push(L.join('\n'));
          if (!s.active) return Res(out.join('\n'), errs.join('\n'), 3);
          break;
        }
        default: return Res('', 'Unknown command verb \'' + sub + '\'.', 1);
      }
    }
    X.reconcile(S);
    return Res(out.join('\n'), errs.join('\n'), errs.length ? 5 : 0);
  }

  function cmdJournalctl(S, argv) {
    const n = nodeHere(S);
    let unit = null; let count = 40;
    for (let k = 1; k < argv.length; k++) {
      if (argv[k] === '-u') unit = argv[++k];
      else if (argv[k].startsWith('-u')) unit = argv[k].slice(2);
      else if (argv[k].startsWith('--unit=')) unit = argv[k].slice(7);
      else if (argv[k] === '-n') count = +argv[++k];
      else if (/^-n\d+$/.test(argv[k])) count = +argv[k].slice(2);
    }
    if (!n) return Res('-- No entries --');
    if (!unit) return Res(journalLines(S, n, 'kubelet', count).join('\n'));
    const svc = unit.replace(/\.service$/, '');
    if (!n._sim.svc[svc]) return Res('-- No entries --');
    return Res(journalLines(S, n, svc, count).join('\n'));
  }

  function cmdCrictl(S, argv) {
    const n = nodeHere(S);
    if (!n) return Res('', 'crictl: command not found', 127);
    if (S.user !== 'root') return Res('', 'FATA[0000] validate service connection: validate CRI v1 runtime API for endpoint "unix:///run/containerd/containerd.sock": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied"', 1);
    if (!n._sim.svc.containerd.active) return Res('', 'FATA[0002] validate service connection: validate CRI v1 runtime API for endpoint "unix:///run/containerd/containerd.sock": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: no such file or directory"', 1);
    const sub = argv[1];
    const pods = list(S, 'Pod').filter((p) => p.spec.nodeName === n.metadata.name);
    const cid = (p, c) => C.hashStr(p.metadata.uid + c.name, 13);
    if (sub === 'ps') {
      const all = argv.includes('-a');
      const rows = [];
      for (const p of pods) for (const c of p.spec.containers || []) {
        const st = (p.status.containerStatuses || []).find((x) => x.name === c.name);
        const running = st && st.state && st.state.running && !(p._sim && p._sim.crash);
        if (!running && !all) continue;
        rows.push([cid(p, c), c.image.split('/').pop().slice(0, 13) + '…', running ? '50 minutes ago' : '10 seconds ago', running ? 'Running' : 'Exited', c.name, String(st ? st.restartCount : 0), C.hashStr(p.metadata.uid, 13), p.metadata.name, C.nsOf(p)]);
      }
      return Res(C.table(['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'ATTEMPT', 'POD ID', 'POD', 'NAMESPACE'], rows));
    }
    if (sub === 'pods') return Res(C.table(['POD ID', 'CREATED', 'STATE', 'NAME', 'NAMESPACE', 'ATTEMPT', 'RUNTIME'], pods.map((p) => [C.hashStr(p.metadata.uid, 13), '50 minutes ago', 'Ready', p.metadata.name, C.nsOf(p), '0', '(default)'])));
    if (sub === 'images') return Res(C.table(['IMAGE', 'TAG', 'IMAGE ID', 'SIZE'], Array.from(new Set(pods.flatMap((p) => p.spec.containers.map((c) => c.image)))).map((im) => [im.split(':')[0], im.split(':')[1] || 'latest', C.hashStr(im, 13), '20.1MB'])));
    if (sub === 'logs') {
      const id = argv.filter((x) => !x.startsWith('-')).slice(2)[0];
      for (const p of pods) for (const c of p.spec.containers || []) if (id && cid(p, c).startsWith(id)) {
        if (p._sim && p._sim.static && p._sim.crash) return Res('', p._sim.crashReason || 'Error');
        try { return Res(CKA.kubectl.run(S, ['logs', p.metadata.name, '-n', C.nsOf(p), '-c', c.name]).out || ''); } catch (e) { return Res(''); }
      }
      return Res('', 'E1003 remote_runtime.go: "ContainerStatus from runtime service failed" err="rpc error: code = NotFound desc = an error occurred when try to find container \\"' + id + '\\": not found"', 1);
    }
    if (sub === 'inspect' || sub === 'inspectp') return Res('{ "status": { "state": "CONTAINER_RUNNING" } }');
    if (sub === 'info') return Res('{ "status": { "conditions": [ { "type": "RuntimeReady", "status": true }, { "type": "NetworkReady", "status": ' + (!!S.cni) + ' } ] } }');
    return Res('', 'NAME:\n   crictl - client for CRI\n\nCOMMANDS:\n   ps, pods, images, logs, inspect, info', sub ? 1 : 0);
  }

  // ------------------------------------------------ paquetes
  const APT = {
    'v1.33': ['1.33.0-1.1', '1.33.1-1.1', '1.33.2-1.1', '1.33.3-1.1', '1.33.4-1.1', '1.33.5-1.1'],
    'v1.34': ['1.34.0-1.1', '1.34.1-1.1', '1.34.2-1.1', '1.34.3-1.1'],
    'v1.35': ['1.35.0-1.1', '1.35.1-1.1', '1.35.2-1.1', '1.35.3-1.1'],
    'v1.36': ['1.36.0-1.1', '1.36.1-1.1'],
  };
  function repoMinor(S, nn) {
    const t = X.fsRead(S, nn, '/etc/apt/sources.list.d/kubernetes.list') || '';
    const m = t.match(/stable:\/(v\d+\.\d+)\//);
    return m ? m[1] : null;
  }
  function cmdApt(S, argv) {
    const tool = argv[0];
    const n = nodeHere(S);
    const nn = X.hostKey(S, S.host);
    const args = argv.slice(1);
    const sub = args.find((x) => !x.startsWith('-'));
    const minor = repoMinor(S, nn);
    const avail = (APT[minor] || []);
    if (tool === 'apt-cache' || (tool === 'apt' && sub === 'list')) {
      if (sub === 'madison' || sub === 'policy' || sub === 'show') {
        const pkg = args.filter((x) => !x.startsWith('-'))[1];
        if (!['kubeadm', 'kubelet', 'kubectl'].includes(pkg)) return Res('', 'N: Unable to locate package ' + pkg, 100);
        if (sub === 'policy') return Res(pkg + ':\n  Installed: ' + (n ? n._sim.pkgs[pkg] + '-1.1' : '(none)') + '\n  Candidate: ' + avail[avail.length - 1] + '\n  Version table:\n' + avail.slice().reverse().map((v) => '     ' + v + ' 500\n        500 https://pkgs.k8s.io/core:/stable:/' + minor + '/deb  Packages').join('\n'));
        return Res(avail.slice().reverse().map((v) => '   ' + pkg + ' | ' + v + ' | https://pkgs.k8s.io/core:/stable:/' + minor + '/deb  Packages').join('\n'));
      }
      return Res('');
    }
    if (tool === 'apt-mark') {
      if (sub === 'showhold') return Res(n ? Object.keys(n._sim.held).filter((k) => n._sim.held[k]).join('\n') : '');
      const e = needRoot(S, 'E: Could not create temporary file for /var/lib/apt/extended_states - mkstemp (13: Permission denied)\nE: Failed to write temporary StateFile /var/lib/apt/extended_states');
      if (e) return Res('', e, 100);
      const pkgs = args.filter((x) => !x.startsWith('-')).slice(1);
      const out = pkgs.map((p) => { if (!n || !n._sim.held.hasOwnProperty(p)) return p + ' was already not on hold.'; const was = n._sim.held[p]; n._sim.held[p] = sub === 'hold'; return sub === 'hold' ? (was ? p + ' was already set on hold.' : p + ' set on hold.') : (was ? 'Canceled hold on ' + p + '.' : p + ' was already not on hold.'); });
      return Res(out.join('\n'));
    }
    // apt / apt-get
    const e = needRoot(S, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
    if (sub === 'update') {
      if (S.user !== 'root') return Res('', 'E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/', 100);
      S.flags['aptUpdated_' + nn] = true;
      return Res('Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nHit:2 https://prod-cdn.packages.k8s.io/repositories/isv:/kubernetes:/core:/stable:/' + minor + '/deb  InRelease\nReading package lists... Done');
    }
    if (sub === 'install' || sub === 'upgrade') {
      if (e) return Res('', e, 100);
      const allowHeld = args.includes('--allow-change-held-packages');
      const yes = args.some((x) => /^-[a-z]*y/.test(x) || x === '--yes');
      const specs = args.filter((x) => !x.startsWith('-')).slice(1);
      const changes = [];
      for (const sp of specs) {
        const [pkg, ver] = sp.split('=');
        if (!['kubeadm', 'kubelet', 'kubectl', 'kubernetes-cni', 'cri-tools'].includes(pkg)) return Res('', 'E: Unable to locate package ' + pkg, 100);
        if (!n || !n._sim.pkgs[pkg]) { changes.push({ pkg, v: ver }); continue; }
        const v = ver || avail[avail.length - 1];
        if (!avail.includes(v)) return Res('Reading package lists... Done\nBuilding dependency tree... Done', 'E: Version \'' + ver + '\' for \'' + pkg + '\' was not found' + (ver && ver.split('.').slice(0, 2).join('.') !== (minor || '').slice(1) ? '\n(pista: el repositorio configurado es ' + minor + '; para otra versión menor edita /etc/apt/sources.list.d/kubernetes.list y ejecuta apt-get update)' : ''), 100);
        if (v.split('-')[0] === n._sim.pkgs[pkg]) { changes.push({ pkg, v, same: true }); continue; }
        if (n._sim.held[pkg] && !allowHeld) return Res('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nThe following held packages will be changed:\n  ' + pkg + '\nThe following packages will be upgraded:\n  ' + pkg, 'E: Held packages were changed and -y was used without --allow-change-held-packages.', 100);
        changes.push({ pkg, v });
      }
      if (!yes && changes.some((c) => !c.same)) return Res('Do you want to continue? [Y/n] Abort.', '(el simulador no admite respuestas interactivas: añade -y)', 1);
      const out = ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'];
      for (const c of changes) {
        if (c.same) { out.push(c.pkg + ' is already the newest version (' + c.v + ').'); continue; }
        const old = n._sim.pkgs[c.pkg];
        n._sim.pkgs[c.pkg] = c.v.split('-')[0];
        X.fsWrite(S, nn, '/usr/bin/' + c.pkg, '\u007fELF ' + c.pkg + ' v' + n._sim.pkgs[c.pkg]);
        out.push('Preparing to unpack .../' + c.pkg + '_' + c.v + '_amd64.deb ...', 'Unpacking ' + c.pkg + ' (' + c.v + ') over (' + old + '-1.1) ...', 'Setting up ' + c.pkg + ' (' + c.v + ') ...');
      }
      return Res(out.join('\n'));
    }
    return Res('', 'E: Invalid operation ' + (sub || ''), 100);
  }

  function cmdDpkg(S, argv) {
    const n = nodeHere(S);
    const nn = X.hostKey(S, S.host);
    if (argv[1] === '-l' || argv[1] === '--list') {
      const rows = n ? Object.keys(n._sim.pkgs).map((k) => 'hi  ' + k.padEnd(20) + (n._sim.pkgs[k] + '-1.1').padEnd(16) + 'amd64        Kubernetes ' + k) : [];
      if (n && n._sim.svc['cri-docker']) rows.push('ii  cri-dockerd'.padEnd(24) + '0.3.20.3-0.ubuntu-jammy amd64  Containerd-backed CRI for Docker');
      return Res('Desired=Unknown/Install/Remove/Purge/Hold\n||/ Name                Version         Architecture Description\n+++-===================-===============-============-=================\n' + rows.join('\n'));
    }
    if (argv[1] === '-i' || argv[1] === '--install') {
      const e = needRoot(S, 'dpkg: error: requested operation requires superuser privilege');
      if (e) return Res('', e, 2);
      const f = argv[2];
      const p = X.norm(f || '', S.cwd);
      if (X.fsRead(S, S.host, p) == null) return Res('', 'dpkg: error: cannot access archive \'' + f + '\': No such file or directory', 2);
      const base = p.split('/').pop();
      if (/cri-dockerd/.test(base)) {
        n._sim.svc['cri-docker'] = { active: false, enabled: false };
        n._sim.svc['cri-docker.socket'] = { active: false, enabled: false };
        X.fsWrite(S, nn, '/usr/bin/cri-dockerd', '\u007fELF cri-dockerd');
        X.fsWrite(S, nn, '/usr/lib/systemd/system/cri-docker.service', '[Unit]\nDescription=CRI Interface for Docker Application Container Engine\n[Service]\nExecStart=/usr/bin/cri-dockerd --container-runtime-endpoint fd://\n[Install]\nWantedBy=multi-user.target\n');
        return Res('Selecting previously unselected package cri-dockerd.\n(Reading database ... 72811 files and directories currently installed.)\nPreparing to unpack ' + f + ' ...\nUnpacking cri-dockerd (0.3.20.3-0.ubuntu-jammy) ...\nSetting up cri-dockerd (0.3.20.3-0.ubuntu-jammy) ...\nCreated symlink /etc/systemd/system/multi-user.target.wants/cri-docker.service → /usr/lib/systemd/system/cri-docker.service.');
      }
      return Res('Selecting previously unselected package ' + base.split('_')[0] + '.\nSetting up ' + base.split('_')[0] + ' ...');
    }
    return Res('', 'dpkg: error: need an action option', 2);
  }

  function cmdSysctl(S, argv) {
    const nn = X.hostKey(S, S.host);
    S.sysctl = S.sysctl || {};
    const cur = S.sysctl[nn] = S.sysctl[nn] || { 'net.ipv4.ip_forward': '0', 'net.bridge.bridge-nf-call-iptables': '0', 'net.ipv6.conf.all.forwarding': '0', 'net.netfilter.nf_conntrack_max': '131072', 'vm.swappiness': '60' };
    const args = argv.slice(1);
    if (args[0] === '--system' || args[0] === '-p') {
      const e = needRoot(S, 'sysctl: permission denied on key "net.ipv4.ip_forward"');
      if (e) return Res('', e, 255);
      const fs = X.fsOf(S, nn);
      const files = args[0] === '-p' && args[1] ? [X.norm(args[1], S.cwd)] : Object.keys(fs.files).filter((f) => /^\/etc\/sysctl\.d\/.*\.conf$/.test(f) || f === '/etc/sysctl.conf').sort();
      const out = [];
      for (const f of files) {
        const t = fs.files[f];
        if (t == null) return Res('', 'sysctl: cannot open "' + f + '": No such file or directory', 255);
        if (args[0] === '--system') out.push('* Applying ' + f + ' ...');
        for (const l of lines(t)) { const m = l.match(/^\s*([\w.\-/]+)\s*=\s*(\S+)/); if (m) { cur[m[1]] = m[2]; out.push(m[1] + ' = ' + m[2]); } }
      }
      return Res(out.join('\n'));
    }
    if (args[0] === '-w') {
      const e = needRoot(S, 'sysctl: permission denied on key "' + (args[1] || '').split('=')[0] + '"');
      if (e) return Res('', e, 255);
      const [k, v] = (args[1] || '').split('=');
      cur[k] = v; return Res(k + ' = ' + v);
    }
    if (args[0] === '-a') return Res(Object.keys(cur).map((k) => k + ' = ' + cur[k]).join('\n'));
    return Res(args.map((k) => (cur[k] !== undefined ? k + ' = ' + cur[k] : 'sysctl: cannot stat /proc/sys/' + k.replace(/\./g, '/') + ': No such file or directory')).join('\n'));
  }

  // ------------------------------------------------ kubeadm
  function certsTable(S) {
    S.certs = S.certs || { admin: 330, apiserver: 330, 'apiserver-etcd-client': 330, 'apiserver-kubelet-client': 330, 'controller-manager.conf': 330, 'etcd-healthcheck-client': 330, 'etcd-peer': 330, 'etcd-server': 330, 'front-proxy-client': 330, 'scheduler.conf': 330, 'super-admin.conf': 330 };
    return S.certs;
  }
  function cmdKubeadm(S, argv) {
    const n = nodeHere(S);
    const args = argv.slice(1);
    const sub = args[0];
    if (!n) return Res('', 'kubeadm: command not found', 127);
    if (sub === 'version') {
      const v = 'v' + n._sim.pkgs.kubeadm;
      if (args.includes('short') || args.includes('-o=short')) return Res(v);
      return Res('kubeadm version: &version.Info{Major:"1", Minor:"' + v.split('.')[1] + '", GitVersion:"' + v + '", GoVersion:"go1.24.6", Compiler:"gc", Platform:"linux/amd64"}');
    }
    if (sub === 'upgrade') {
      const act = args[1];
      if (S.user !== 'root') return Res('', '[preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root\n[preflight] If you know what you are doing, you can make a check non-fatal with `--ignore-preflight-errors=...`', 1);
      const cur = S.serverVersion || S.version;
      if (act === 'plan') {
        if (!n._sim.cp) return Res('', 'couldn\'t create a Kubernetes client from file "/etc/kubernetes/admin.conf" (ejecuta kubeadm upgrade plan en el nodo del plano de control)', 1);
        const target = 'v' + n._sim.pkgs.kubeadm;
        const minor = repoMinor(S, n.metadata.name);
        const latest = 'v' + (APT[minor] || []).slice(-1)[0].split('-')[0];
        return Res('[preflight] Running pre-flight checks.\n[upgrade/config] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade] Running cluster health checks\n[upgrade] Fetching available versions to upgrade to\n[upgrade/versions] Cluster version: ' + cur + '\n[upgrade/versions] kubeadm version: ' + target + '\n[upgrade/versions] Target version: ' + latest + '\n[upgrade/versions] Latest version in the ' + minor + ' series: ' + latest + '\n\nComponents that must be upgraded manually after you have upgraded the control plane with \'kubeadm upgrade apply\':\nCOMPONENT   NODE           CURRENT   TARGET\nkubelet     ' + S.cpName.padEnd(14) + ' v' + n._sim.runningKubelet + '   ' + latest + '\n\nUpgrade to the latest version in the ' + minor + ' series:\n\nCOMPONENT                 NODE           CURRENT   TARGET\nkube-apiserver            ' + S.cpName.padEnd(14) + ' ' + cur + '   ' + latest + '\nkube-controller-manager   ' + S.cpName.padEnd(14) + ' ' + cur + '   ' + latest + '\nkube-scheduler            ' + S.cpName.padEnd(14) + ' ' + cur + '   ' + latest + '\nkube-proxy                               ' + cur + '   ' + latest + '\nCoreDNS                                  v1.12.1   v1.12.1\netcd                      ' + S.cpName.padEnd(14) + ' 3.6.4-0   3.6.4-0\n\nYou can now apply the upgrade by executing the following command:\n\n\tkubeadm upgrade apply ' + latest + '\n\nNote: Before you can perform this upgrade, you have to update kubeadm to ' + latest + '.');
      }
      if (act === 'apply') {
        if (!n._sim.cp) return Res('', 'error: kubeadm upgrade apply debe ejecutarse en el nodo del plano de control', 1);
        const target = args.slice(2).find((x) => /^v?\d+\.\d+\.\d+$/.test(x));
        if (!target) return Res('', 'error: missing one or more required arguments: [version]', 1);
        const tv = target.startsWith('v') ? target : 'v' + target;
        const kv = 'v' + n._sim.pkgs.kubeadm;
        const cmpv = (a, b) => { const x = a.slice(1).split('.').map(Number); const y = b.slice(1).split('.').map(Number); for (let q = 0; q < 3; q++) if (x[q] !== y[q]) return x[q] - y[q]; return 0; };
        if (cmpv(tv, kv) > 0) return Res('[upgrade/version] You have chosen to upgrade to version "' + tv + '"', '[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "' + tv + '" is higher than the kubeadm version "' + kv + '". Upgrade kubeadm first using the tool you used to install kubeadm\n\nCan be bypassed if you pass the --force flag\nTo see the stack trace of this error execute with --v=5 or higher', 1);
        const cm = +cur.split('.')[1]; const tm = +tv.split('.')[1];
        if (tm - cm > 1) return Res('', '[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "' + tv + '" is too high; kubeadm can upgrade only 1 minor version at a time', 1);
        if (cmpv(tv, cur) < 0) return Res('', '[upgrade/version] FATAL: the --version argument is invalid: Specified version to upgrade to "' + tv + '" is lower than the cluster version "' + cur + '". Downgrades are not supported', 1);
        const yes = args.includes('-y') || args.includes('--yes') || args.includes('-f') || args.includes('--force');
        S.serverVersion = tv;
        S.flags.upgradeApplied = tv;
        S.flags.upgradeWhileCordoned = !!n.spec.unschedulable;
        S.flags.etcdUpgrade = !args.includes('--etcd-upgrade=false');
        for (const comp of ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
          const p = '/etc/kubernetes/manifests/' + comp + '.yaml';
          const t = X.fsRead(S, n.metadata.name, p);
          if (t) X.fsWrite(S, n.metadata.name, p, t.replace(new RegExp('(registry\\.k8s\\.io/' + comp + ':)v[\\d.]+'), '$1' + tv));
        }
        const kp = find(S, 'DaemonSet', 'kube-system', 'kube-proxy');
        if (kp) kp.spec.template.spec.containers[0].image = 'registry.k8s.io/kube-proxy:' + tv;
        X.reconcile(S);
        return Res((yes ? '' : '[upgrade] Are you sure you want to proceed? [y/N]: y   (simulador: se asume "y"; en el examen puedes usar -y)\n') + '[upgrade] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade/preflight] Running preflight checks\n[upgrade] Running cluster health checks\n[upgrade/version] You have chosen to upgrade to version "' + tv + '"\n[upgrade/versions] Cluster version: ' + cur + '\n[upgrade/versions] kubeadm version: ' + kv + '\n[upgrade/staticpods] Writing new Static Pod manifests to "/etc/kubernetes/tmp/kubeadm-upgraded-manifests"\n[upgrade/staticpods] Component "kube-apiserver" upgraded successfully!\n[upgrade/staticpods] Component "kube-controller-manager" upgraded successfully!\n[upgrade/staticpods] Component "kube-scheduler" upgraded successfully!\n' + (S.flags.etcdUpgrade ? '[upgrade/etcd] Upgrading to TLS for etcd\n' : '[upgrade/etcd] Skipping etcd upgrade (--etcd-upgrade=false)\n') + '[addons] Applied essential addon: CoreDNS\n[addons] Applied essential addon: kube-proxy\n\n[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "' + tv + '".\n\n[upgrade] Now please proceed with upgrading the rest of the nodes by following the right order.');
      }
      if (act === 'node') {
        n._sim.upgradedNode = n._sim.pkgs.kubeadm;
        return Res('[upgrade] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n[upgrade/preflight] Running pre-flight checks\n[upgrade] Skipping phase. Not a control plane node.\n[upgrade/kubelet-config] The kubelet configuration for this node was successfully upgraded!\n[upgrade] The configuration for this node was successfully upgraded!\n[upgrade] Now you should go ahead and upgrade the kubelet package using your package manager.');
      }
      return Res('', 'error: unknown command "' + act + '" for "kubeadm upgrade"', 1);
    }
    if (sub === 'token') {
      if (args[1] === 'create') { const tok = 'abcdef.' + C.hashStr('tok' + S.now, 16).toLowerCase(); S.flags.joinToken = tok; return Res(args.includes('--print-join-command') ? 'kubeadm join ' + S.cpIP + ':6443 --token ' + tok + ' --discovery-token-ca-cert-hash sha256:4f1c2e9a7d8b3c5e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6' : tok); }
      if (args[1] === 'list') return Res('TOKEN                     TTL         EXPIRES                USAGES                   DESCRIPTION\n' + (S.flags.joinToken ? S.flags.joinToken + '   23h         2026-10-04T14:00:00Z   authentication,signing   <none>' : ''));
    }
    if (sub === 'certs') {
      const t = certsTable(S);
      if (args[1] === 'check-expiration') {
        if (S.user !== 'root') return Res('', 'error: open /etc/kubernetes/pki/ca.key: permission denied', 1);
        const exp = (d) => new Date(S.now + d * 86400000).toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT/, ' UTC').replace(/(\d\d) (\w+) (\d{4})/, '$2 $1, $3');
        const rows = Object.keys(t).map((k) => [k, exp(t[k]), t[k] + 'd', 'ca', 'no']);
        return Res('[check-expiration] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...\n\n' + C.table(['CERTIFICATE', 'EXPIRES', 'RESIDUAL TIME', 'CERTIFICATE AUTHORITY', 'EXTERNALLY MANAGED'], rows) + '\n\nCERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED\nca                      Sep 29, 2035 10:00 UTC   8y              no\netcd-ca                 Sep 29, 2035 10:00 UTC   8y              no\nfront-proxy-ca          Sep 29, 2035 10:00 UTC   8y              no');
      }
      if (args[1] === 'renew') {
        if (S.user !== 'root') return Res('', 'error: open /etc/kubernetes/pki/ca.key: permission denied', 1);
        const which = args[2];
        const keys = which === 'all' ? Object.keys(t) : [which];
        if (!keys.every((k) => t[k] !== undefined)) return Res('', 'error: unknown command "' + which + '" for "kubeadm certs renew"', 1);
        for (const k of keys) t[k] = 364;
        S.flags.certsRenewed = (S.flags.certsRenewed || []).concat(keys);
        return Res(keys.map((k) => 'certificate ' + (k.endsWith('.conf') ? 'embedded in the kubeconfig file for ' + k.replace('.conf', '') : 'for ' + k) + ' renewed').join('\n') + '\n\nDone renewing certificates. You must restart the kube-apiserver, kube-controller-manager, kube-scheduler and etcd, so that they can use the new certificates.');
      }
    }
    if (sub === 'join') {
      if (S.user !== 'root') return Res('', '[preflight] Some fatal errors occurred:\n\t[ERROR IsPrivilegedUser]: user is not running as root', 1);
      return Res('', 'error execution phase preflight: [preflight] Some fatal errors occurred:\n\t[ERROR FileAvailable--etc-kubernetes-kubelet.conf]: /etc/kubernetes/kubelet.conf already exists\n(este nodo ya pertenece al clúster)', 1);
    }
    if (sub === 'config' && args[1] === 'print') return Res('apiVersion: kubeadm.k8s.io/v1beta4\nkind: ClusterConfiguration\nkubernetesVersion: ' + (S.serverVersion || S.version) + '\nnetworking:\n  podSubnet: 192.168.0.0/16\n  serviceSubnet: 10.96.0.0/12');
    return Res('', 'Usage:\n  kubeadm [command]\n\nAvailable Commands:\n  certs, config, init, join, reset, token, upgrade, version', 1);
  }

  // ------------------------------------------------ etcd
  function etcdFlags(S, argv, env) {
    const f = { env: {} };
    const pos = [];
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
      if (m) { const needs = ['endpoints', 'cacert', 'cert', 'key', 'data-dir', 'write-out', 'name', 'initial-cluster', 'initial-advertise-peer-urls', 'initial-cluster-token', 'skip-hash-check', 'dial-timeout', 'command-timeout']; if (m[2] !== undefined) f[m[1]] = m[2]; else if (needs.includes(m[1]) && k + 1 < argv.length) f[m[1]] = argv[++k]; else f[m[1]] = true; continue; }
      if (a === '-w') { f['write-out'] = argv[++k]; continue; }
      pos.push(a);
    }
    for (const k of ['endpoints', 'cacert', 'cert', 'key']) if (f[k] === undefined && env['ETCDCTL_' + k.toUpperCase()]) f[k] = env['ETCDCTL_' + k.toUpperCase()];
    return { f, pos };
  }
  const ETCD_CLIENT_CERTS = [['/etc/kubernetes/pki/etcd/server.crt', '/etc/kubernetes/pki/etcd/server.key'], ['/etc/kubernetes/pki/etcd/healthcheck-client.crt', '/etc/kubernetes/pki/etcd/healthcheck-client.key'], ['/etc/kubernetes/pki/apiserver-etcd-client.crt', '/etc/kubernetes/pki/apiserver-etcd-client.key'], ['/etc/kubernetes/pki/etcd/peer.crt', '/etc/kubernetes/pki/etcd/peer.key']];

  function etcdConnect(S, f) {
    const nn = X.hostKey(S, S.host);
    const ep = f.endpoints || '127.0.0.1:2379';
    const onCp = nn === S.cpName;
    const epOk = /(127\.0\.0\.1|localhost|172\.30\.1\.2):2379/.test(ep);
    if (!onCp && /127\.0\.0\.1|localhost/.test(ep)) return { err: '{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"transport: Error while dialing: dial tcp 127.0.0.1:2379: connect: connection refused\\""}\nError: context deadline exceeded', why: 'etcd corre en el plano de control; conéctate con ssh al host correcto' };
    if (!epOk) return { err: 'Error: context deadline exceeded', why: 'el endpoint debe ser https://127.0.0.1:2379 (puerto de clientes de etcd)' };
    if (!S.cp.etcd || !S.cp.etcd.ok) return { err: '{"level":"warn","msg":"retrying of unary invoker failed","error":"connection refused"}\nError: context deadline exceeded', why: 'etcd no está en ejecución: ' + (S.cp.etcd && S.cp.etcd.reason) };
    if (!f.cacert || !f.cert || !f.key) return { err: '{"level":"warn","ts":"2026-10-03T14:00:05.000Z","logger":"etcd-client","caller":"v3@v3.6.4/retry_interceptor.go:63","msg":"retrying of unary invoker failed","target":"etcd-endpoints://0xc000358000/127.0.0.1:2379","attempt":0,"error":"rpc error: code = DeadlineExceeded desc = context deadline exceeded"}\nError: context deadline exceeded', why: 'faltan --cacert, --cert y --key: etcd exige TLS mutuo (client-cert-auth=true)' };
    for (const k of ['cacert', 'cert', 'key']) {
      const p = X.norm(f[k], S.cwd);
      if (X.fsRead(S, S.host, p) == null) return { err: 'Error: open ' + f[k] + ': no such file or directory' };
      if (!X.canRead(S, p)) return { err: 'Error: open ' + f[k] + ': permission denied', why: 'los certificados/llaves de etcd requieren root: usa sudo' };
    }
    const alias = S.etcdCertAlias || {};
    const ca = X.norm(f.cacert, S.cwd); const cert = X.norm(f.cert, S.cwd); const key = X.norm(f.key, S.cwd);
    const caOk = ca === '/etc/kubernetes/pki/etcd/ca.crt' || alias.ca === ca;
    if (!caOk) return { err: '{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"transport: authentication handshake failed: tls: failed to verify certificate: x509: certificate signed by unknown authority\\""}\nError: context deadline exceeded', why: '--cacert debe ser la CA de etcd (/etc/kubernetes/pki/etcd/ca.crt), no la CA del clúster' };
    const pairOk = ETCD_CLIENT_CERTS.some(([c, k]) => c === cert && k === key) || (alias.cert === cert && alias.key === key);
    if (!pairOk) return { err: '{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = Unavailable desc = connection error: desc = \\"transport: authentication handshake failed: remote error: tls: bad certificate\\""}\nError: context deadline exceeded', why: 'el par --cert/--key no es un certificado cliente válido de etcd (p. ej. /etc/kubernetes/pki/etcd/server.crt y server.key)' };
    return { ok: true };
  }

  function cmdEtcdctl(S, argv, env) {
    const { f, pos } = etcdFlags(S, argv, env);
    const sub = pos[0];
    const nn = X.hostKey(S, S.host);
    if (!find(S, 'Node', null, nn)) return Res('', argv[0] + ': command not found', 127);
    if (sub === 'version' || f.version) return Res('etcdctl version: 3.6.4\nAPI version: 3.6');
    if (sub === 'snapshot' && (pos[1] === 'restore' || pos[1] === 'status')) {
      if (argv[0] === 'etcdctl' && pos[1] === 'restore') return Res('', 'Error: unknown command "restore" for "etcdctl snapshot"\nRun \'etcdctl snapshot --help\' for usage.\n(en etcd 3.6 la restauración se hace con: etcdutl snapshot restore <archivo> --data-dir <dir>)', 1);
      return cmdEtcdutl(S, ['etcdutl'].concat(argv.slice(1)), env, argv[0] === 'etcdctl');
    }
    const c = etcdConnect(S, f);
    if (!c.ok) return Object.assign(Res('', c.err, 1), { why: c.why });
    if (sub === 'snapshot' && pos[1] === 'save') {
      const file = pos[2];
      if (!file) return Res('', 'Error: snapshot save expects one argument', 1);
      const p = X.norm(file, S.cwd);
      if (!X.fsIsDir(S, S.host, X.parentOf(p))) return Res('', 'Error: could not open ' + p + '.part (open ' + p + '.part: no such file or directory)', 1);
      if (!X.canWrite(S, p)) return Res('', 'Error: could not open ' + p + '.part (open ' + p + '.part: permission denied)', 1);
      X.fsWrite(S, S.host, p, '(snapshot binario de etcd, revisión ' + S.rv + ')');
      S.snapshots[nn + ':' + p] = clone(S.objs);
      S.flags.snapshotSaved = (S.flags.snapshotSaved || []).concat([p]);
      return Res('{"level":"info","ts":"2026-10-03T14:00:10.000Z","caller":"snapshot/v3_snapshot.go:65","msg":"created temporary db file","path":"' + p + '.part"}\n{"level":"info","ts":"2026-10-03T14:00:10.010Z","logger":"client","caller":"v3@v3.6.4/maintenance.go:237","msg":"opened snapshot stream; downloading"}\n{"level":"info","ts":"2026-10-03T14:00:10.020Z","caller":"snapshot/v3_snapshot.go:73","msg":"fetching snapshot","endpoint":"' + (f.endpoints || '127.0.0.1:2379') + '"}\n{"level":"info","ts":"2026-10-03T14:00:10.160Z","caller":"snapshot/v3_snapshot.go:88","msg":"fetched snapshot","endpoint":"' + (f.endpoints || '127.0.0.1:2379') + '","size":"5.7 MB","took":"now"}\n{"level":"info","ts":"2026-10-03T14:00:10.161Z","caller":"snapshot/v3_snapshot.go:97","msg":"saved","path":"' + p + '"}\nSnapshot saved at ' + p);
    }
    if (sub === 'member' && pos[1] === 'list') return Res(f['write-out'] === 'table' ? '+------------------+---------+--------------+-------------------------+-------------------------+------------+\n|        ID        | STATUS  |     NAME     |       PEER ADDRS        |      CLIENT ADDRS       | IS LEARNER |\n+------------------+---------+--------------+-------------------------+-------------------------+------------+\n| 8e9e05c52164694d | started | controlplane | https://172.30.1.2:2380 | https://172.30.1.2:2379 |      false |\n+------------------+---------+--------------+-------------------------+-------------------------+------------+' : '8e9e05c52164694d, started, controlplane, https://172.30.1.2:2380, https://172.30.1.2:2379, false');
    if (sub === 'endpoint') return Res((f.endpoints || '127.0.0.1:2379') + ' is healthy: successfully committed proposal: took = 9.8ms');
    if (sub === 'get') {
      const keys = S.objs.map((o) => '/registry/' + (C.defByKind(S, o.kind) || { plural: o.kind.toLowerCase() }).plural + '/' + (C.nsOf(o) ? C.nsOf(o) + '/' : '') + o.metadata.name).sort();
      const prefix = pos[1] || '';
      return Res(keys.filter((k) => k.startsWith(prefix)).slice(0, 60).join('\n'));
    }
    return Res('', 'Error: unknown command "' + (sub || '') + '" for "etcdctl"', 1);
  }

  function cmdEtcdutl(S, argv, env, fromEtcdctl) {
    const { f, pos } = etcdFlags(S, argv, env);
    const nn = X.hostKey(S, S.host);
    if (!find(S, 'Node', null, nn)) return Res('', argv[0] + ': command not found', 127);
    if (pos[0] === 'version') return Res('etcdutl version: 3.6.4\nAPI version: 3.6');
    if (pos[0] !== 'snapshot') return Res('', 'Error: unknown command "' + (pos[0] || '') + '" for "etcdutl"', 1);
    const file = pos[2];
    const p = X.norm(file || '', S.cwd);
    if (!file) return Res('', 'Error: snapshot ' + pos[1] + ' requires exactly one argument', 1);
    if (X.fsRead(S, S.host, p) == null) return Res('', 'Error: stat ' + p + ': no such file or directory', 1);
    if (!X.canRead(S, p)) return Res('', 'Error: open ' + p + ': permission denied', 1);
    const data = S.snapshots[nn + ':' + p];
    const warn = fromEtcdctl ? 'Deprecated: Use `etcdutl snapshot ' + pos[1] + '` instead.\n\n' : '';
    if (pos[1] === 'status') {
      const rows = ['+----------+----------+------------+------------+---------+', '|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |', '+----------+----------+------------+------------+---------+', '| ' + C.hashStr(p, 8) + ' |     ' + String(S.rv).padEnd(5) + '|       ' + String((data || []).length || 1034).padEnd(5) + '|     5.7 MB |   3.6.0 |', '+----------+----------+------------+------------+---------+'];
      return Res(warn + (f['write-out'] === 'table' ? rows.join('\n') : C.hashStr(p, 8) + ', ' + S.rv + ', ' + ((data || []).length || 1034) + ', 5.7 MB, 3.6.0'));
    }
    if (pos[1] === 'restore') {
      if (!data) return Res('', 'Error: snapshot file integrity check failed. 2 errors occurred:\n\t* failed to read snapshot hash', 1);
      const dir = f['data-dir'] ? X.norm(f['data-dir'], S.cwd) : X.norm((f.name || 'default') + '.etcd', S.cwd);
      if (X.fsExists(S, S.host, dir) && X.fsList(S, S.host, dir).length) return Res('', 'Error: data-dir "' + dir + '" not empty or could not be read', 1);
      if (!X.canWrite(S, dir)) return Res('', 'Error: mkdir ' + dir + ': permission denied', 1);
      X.mkdirp(X.fsOf(S, S.host), dir + '/member/snap');
      X.fsWrite(S, S.host, dir + '/member/snap/db', '(base de datos restaurada)');
      X.fsWrite(S, S.host, dir + '/member/wal/0000000000000000-0000000000000000.wal', '(wal)');
      const snapObjs = clone(data);
      snapObjs._from = p;
      S.etcdDirs[dir] = snapObjs;
      S.flags.restoredTo = dir;
      S.flags.restoredFrom = p;
      return Res(warn + '2026-10-03T14:01:00Z\tinfo\tsnapshot/v3_snapshot.go:265\trestoring snapshot\t{"path": "' + p + '", "wal-dir": "' + dir + '/member/wal", "data-dir": "' + dir + '", "snap-dir": "' + dir + '/member/snap", "initial-memory-map-size": 10737418240}\n2026-10-03T14:01:00Z\tinfo\tmembership/store.go:141\tTrimming membership information from the backend...\n2026-10-03T14:01:00Z\tinfo\tsnapshot/v3_snapshot.go:293\trestored snapshot\t{"path": "' + p + '", "wal-dir": "' + dir + '/member/wal", "data-dir": "' + dir + '", "snap-dir": "' + dir + '/member/snap", "initial-memory-map-size": 10737418240}');
    }
    return Res('', 'Error: unknown command "' + pos[1] + '"', 1);
  }

  // ------------------------------------------------ helm
  function parseSets(sets) {
    const vals = {};
    for (const s of sets) for (const pair of s.split(',')) {
      const i = pair.indexOf('=');
      const path = pair.slice(0, i).split('.');
      let v = pair.slice(i + 1);
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (/^\d+$/.test(v)) v = +v;
      let cur = vals;
      path.slice(0, -1).forEach((k) => { cur[k] = cur[k] || {}; cur = cur[k]; });
      cur[path[path.length - 1]] = v;
    }
    return vals;
  }
  function deepMerge(a, b) { const r = clone(a || {}); for (const k of Object.keys(b || {})) r[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(r[k], b[k]) : b[k]; return r; }

  function cmdHelm(S, argv) {
    if (S.host === 'base') return Res('', 'Error: Kubernetes cluster unreachable: Get "http://localhost:8080/version": dial tcp 127.0.0.1:8080: connect: connection refused', 1);
    const args = argv.slice(1);
    const pos = []; const fl = { set: [], values: [] };
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const m = a.match(/^--?([\w-]+)(?:=(.*))?$/);
      if (m) {
        const name = { n: 'namespace', f: 'values', A: 'all-namespaces', a: 'all' }[m[1]] || m[1];
        const boolf = ['create-namespace', 'all-namespaces', 'install', 'versions', 'dry-run', 'wait', 'atomic', 'devel', 'debug', 'skip-crds', 'include-crds', 'force', 'reuse-values', 'all', 'short', 'no-hooks'];
        let v;
        if (m[2] !== undefined) v = m[2]; else if (boolf.includes(name)) v = true; else v = args[++k];
        if (name === 'set' || name === 'set-string') fl.set.push(v); else if (name === 'values') fl.values.push(v); else fl[name] = v;
        continue;
      }
      pos.push(a);
    }
    const sub = pos[0];
    const ns = fl.namespace || S.defaultNs || 'default';
    const charts = CKA.charts || {};
    const repoOf = (ref) => { const [r, c] = String(ref).split('/'); return { r, c }; };
    const getChart = (ref) => {
      const { r, c } = repoOf(ref);
      if (!c) return { err: 'Error: INSTALLATION FAILED: repo ' + r + ' not found' };
      if (!S.helm.repos[r]) return { err: 'Error: INSTALLATION FAILED: repo ' + r + ' not found' };
      const url = S.helm.repos[r];
      const ch = Object.values(charts).find((x) => x.url === url && x.name === c);
      if (!ch) return { err: 'Error: INSTALLATION FAILED: chart "' + c + '" not found in ' + r + ' index. (try \'helm repo update\')' };
      const ver = fl.version || ch.versions[ch.versions.length - 1];
      if (!ch.versions.includes(ver)) return { err: 'Error: INSTALLATION FAILED: chart "' + c + '" matching ' + ver + ' not found in ' + r + ' index. (try \'helm repo update\')' };
      return { ch, ver };
    };
    const values = () => {
      let v = {};
      for (const vf of fl.values) { const t = X.fsRead(S, S.host, X.norm(vf, S.cwd)); if (t == null) return { err: 'Error: open ' + vf + ': no such file or directory' }; v = deepMerge(v, C.yaml.load(t) || {}); }
      return { v: deepMerge(v, parseSets(fl.set)) };
    };
    switch (sub) {
      case 'version': return Res('version.BuildInfo{Version:"v3.19.0", GitCommit:"3d8990f0836691f0229297773f3524598f46bda6", GitTreeState:"clean", GoVersion:"go1.24.7"}');
      case 'repo': {
        const act = pos[1];
        if (act === 'add') {
          const name = pos[2]; const url = pos[3];
          if (!name || !url) return Res('', 'Error: "helm repo add" requires 2 arguments', 1);
          if (!Object.values(charts).some((c) => c.url === url.replace(/\/$/, ''))) return Res('', 'Error: looks like "' + url + '" is not a valid chart repository or cannot be reached: failed to fetch ' + url + '/index.yaml : 404 Not Found', 1);
          if (S.helm.repos[name] && S.helm.repos[name] !== url.replace(/\/$/, '')) return Res('', 'Error: repository name (' + name + ') already exists, please specify a different name', 1);
          const had = !!S.helm.repos[name];
          S.helm.repos[name] = url.replace(/\/$/, '');
          return Res(had ? '"' + name + '" already exists with the same configuration, skipping' : '"' + name + '" has been added to your repositories');
        }
        if (act === 'list' || act === 'ls') { const k = Object.keys(S.helm.repos); if (!k.length) return Res('', 'Error: no repositories to show', 1); return Res(C.table(['NAME', 'URL'], k.map((x) => [x, S.helm.repos[x]]))); }
        if (act === 'update' || act === 'up') return Res('Hang tight while we grab the latest from your chart repositories...\n' + Object.keys(S.helm.repos).map((r) => '...Successfully got an update from the "' + r + '" chart repository').join('\n') + '\nUpdate Complete. ⎈Happy Helming!⎈');
        if (act === 'remove' || act === 'rm') { delete S.helm.repos[pos[2]]; return Res('"' + pos[2] + '" has been removed from your repositories'); }
        return Res('', 'Error: unknown command "' + act + '" for "helm repo"', 1);
      }
      case 'search': {
        const term = pos[2] || '';
        const rows = [];
        for (const r of Object.keys(S.helm.repos)) for (const ch of Object.values(charts).filter((c) => c.url === S.helm.repos[r])) {
          const full = r + '/' + ch.name;
          if (term && !full.includes(term)) continue;
          const vs = fl.versions ? ch.versions.slice().reverse() : [ch.versions[ch.versions.length - 1]];
          for (const v of vs) rows.push([full, v, ch.appVersions[v] || ch.appVersion, ch.description]);
        }
        if (!rows.length) return Res('No results found');
        return Res(C.table(['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], rows));
      }
      case 'show': case 'inspect': {
        const g = getChart(pos[2]); if (g.err) return Res('', g.err.replace('INSTALLATION FAILED: ', ''), 1);
        if (pos[1] === 'values') return Res(g.ch.valuesYaml);
        if (pos[1] === 'chart') return Res('apiVersion: v2\nname: ' + g.ch.name + '\nversion: ' + g.ver + '\nappVersion: ' + (g.ch.appVersions[g.ver] || g.ch.appVersion) + '\ndescription: ' + g.ch.description);
        return Res(g.ch.valuesYaml);
      }
      case 'template': case 'install': case 'upgrade': {
        let rel = pos[1]; let ref = pos[2];
        if (!ref) { if (sub === 'template' && rel && rel.includes('/')) { ref = rel; rel = 'release-name'; } else return Res('', 'Error: "helm ' + sub + '" requires 2 arguments\n\nUsage:  helm ' + sub + ' [NAME] [CHART] [flags]', 1); }
        const g = getChart(ref); if (g.err) return Res('', sub === 'template' ? g.err.replace('INSTALLATION FAILED', 'failed to download') : g.err, 1);
        const vv = values(); if (vv.err) return Res('', vv.err, 1);
        const vals = deepMerge(g.ch.defaults, vv.v);
        const objs = g.ch.render(rel, ns, vals, g.ver).filter((o) => !(fl['skip-crds'] && o.kind === 'CustomResourceDefinition'));
        if (sub === 'template') return Res(objs.map((o) => '---\n# Source: ' + g.ch.name + '/templates/' + o.kind.toLowerCase() + '.yaml\n' + C.toYaml(o)).join('').replace(/\n$/, ''));
        const existing = S.helm.releases.find((r) => r.name === rel && r.ns === ns);
        if (sub === 'install' && existing) return Res('', 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use', 1);
        if (sub === 'upgrade' && !existing && !fl.install) return Res('', 'Error: UPGRADE FAILED: "' + rel + '" has no deployed releases', 1);
        if (!find(S, 'Namespace', null, ns)) {
          if (!fl['create-namespace']) return Res('', 'Error: INSTALLATION FAILED: create: failed to create: namespaces "' + ns + '" not found', 1);
          CKA.kubectl.applyObject(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }, 'create', {});
        }
        for (const o of objs) {
          const def = C.defByKind(S, o.kind);
          if (o.kind === 'CustomResourceDefinition' && find(S, o.kind, null, o.metadata.name) && !existing) return Res('', 'Error: INSTALLATION FAILED: Unable to continue with install: CustomResourceDefinition "' + o.metadata.name + '" in namespace "" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"', 1);
          if (def && def.namespaced) o.metadata.namespace = o.metadata.namespace || ns;
        }
        for (const o of objs) CKA.kubectl.applyObject(S, clone(o), 'apply', {});
        const rev = existing ? existing.revision + 1 : 1;
        if (existing) Object.assign(existing, { revision: rev, chart: g.ch.name + '-' + g.ver, values: vv.v, app: g.ch.appVersions[g.ver] || g.ch.appVersion });
        else S.helm.releases.push({ name: rel, ns, revision: 1, chart: g.ch.name + '-' + g.ver, values: vv.v, app: g.ch.appVersions[g.ver] || g.ch.appVersion });
        X.reconcile(S);
        return Res((sub === 'upgrade' ? 'Release "' + rel + '" has been upgraded. Happy Helming!\n' : '') + 'NAME: ' + rel + '\nLAST DEPLOYED: Sat Oct  3 14:00:00 2026\nNAMESPACE: ' + ns + '\nSTATUS: deployed\nREVISION: ' + rev + '\nTEST SUITE: None');
      }
      case 'list': case 'ls': {
        const rs = S.helm.releases.filter((r) => fl['all-namespaces'] || r.ns === ns);
        return Res(C.table(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], rs.map((r) => [r.name, r.ns, String(r.revision), '2026-10-03 14:00:00.000000 +0000 UTC', 'deployed', r.chart, r.app])));
      }
      case 'uninstall': case 'delete': case 'del': {
        const r = S.helm.releases.find((x) => x.name === pos[1] && x.ns === ns);
        if (!r) return Res('', 'Error: uninstall: Release not loaded: ' + pos[1] + ': release: not found', 1);
        for (const o of S.objs.slice()) if ((o.metadata.labels || {})['app.kubernetes.io/instance'] === r.name && (C.nsOf(o) === r.ns || !C.nsOf(o)) && o.kind !== 'CustomResourceDefinition') C.remove(S, o);
        S.helm.releases.splice(S.helm.releases.indexOf(r), 1);
        X.reconcile(S);
        return Res('release "' + r.name + '" uninstalled');
      }
      case 'get': {
        const r = S.helm.releases.find((x) => x.name === pos[2] && x.ns === ns);
        if (!r) return Res('', 'Error: release: not found', 1);
        if (pos[1] === 'values') return Res('USER-SUPPLIED VALUES:\n' + (Object.keys(r.values).length ? C.toYaml(r.values).replace(/\n$/, '') : 'null'));
        return Res('NAME: ' + r.name + '\nNAMESPACE: ' + r.ns + '\nSTATUS: deployed');
      }
      case 'status': { const r = S.helm.releases.find((x) => x.name === pos[1] && x.ns === ns); return r ? Res('NAME: ' + r.name + '\nNAMESPACE: ' + r.ns + '\nSTATUS: deployed\nREVISION: ' + r.revision) : Res('', 'Error: release: not found', 1); }
      case 'pull': { const g = getChart(pos[1]); if (g.err) return Res('', g.err.replace('INSTALLATION FAILED: ', ''), 1); X.fsWrite(S, S.host, X.norm(g.ch.name + '-' + g.ver + '.tgz', S.cwd), '(chart empaquetado)'); return Res(''); }
      default: return Res('The Kubernetes package manager\n\nUsage:\n  helm [command]\n\nAvailable Commands:\n  get, install, list, pull, repo, search, show, status, template, uninstall, upgrade, version', '', sub ? 1 : 0);
    }
  }

  // ------------------------------------------------ red desde el host
  function cmdCurl(S, argv) {
    const isWget = argv[0] === 'wget';
    let url = null; let hostHdr = null; const resolve = {}; let outFile = null; let fmt = null; let silent = false; let headOnly = false; let remoteName = false;
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-H' || a === '--header') { const h = argv[++k] || ''; const m = h.match(/^host:\s*(.*)$/i); if (m) hostHdr = m[1]; continue; }
      if (a === '--resolve') { const [h, , ip] = (argv[++k] || '').split(':'); resolve[h] = ip; continue; }
      if (a === '-o' || a === '-O' && isWget) { outFile = argv[++k]; continue; }
      if (a === '-O' && !isWget) { remoteName = true; continue; }
      if (a === '-w') { fmt = argv[++k]; continue; }
      if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '-T' || a === '--timeout') { k++; continue; }
      if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes('s') || a.includes('q')) silent = true; if (a.includes('I')) headOnly = true; if (a.includes('O') && !isWget) remoteName = true; continue; }
      if (a.startsWith('--')) continue;
      url = a;
    }
    if (!url) return Res('', isWget ? 'wget: missing URL' : 'curl: try \'curl --help\' for more information', 2);
    if (/^https?:\/\/(raw\.githubusercontent|github\.com|get\.helm|dl\.k8s|pkgs\.k8s|storage\.googleapis)/.test(url) || (CKA.remote && CKA.remote[url])) {
      const r = CKA.remote && CKA.remote[url];
      if (!r) return Res('', isWget ? 'ERROR 404: Not Found.' : 'curl: (22) The requested URL returned error: 404', isWget ? 8 : 22);
      const text = typeof r === 'function' ? r(S) : typeof r === 'object' ? r.text : r;
      if (remoteName && !outFile) outFile = url.split('/').pop();
      if (isWget && !outFile) outFile = url.split('/').pop();
      if (outFile && outFile !== '-') {
        const p = X.norm(outFile, S.cwd);
        if (!X.canWrite(S, p)) return Res('', (isWget ? outFile + ': Permission denied' : 'curl: (23) Failure writing output to destination'), 23);
        X.fsWrite(S, S.host, p, text);
        return Res(isWget ? "Saving to: '" + outFile + "'\n\n" + outFile + '    100%[===================>]  ' + (text.length / 1024).toFixed(1) + 'K  --.-KB/s    in 0.01s\n\n\'' + outFile + '\' saved' : '');
      }
      return Res(text.replace(/\n$/, ''));
    }
    const r = X.httpRequest(S, null, url, hostHdr, resolve);
    if (r.err) return Object.assign(Res('', isWget ? 'wget: can\'t connect to remote host: ' + r.err : 'curl: (' + r.code + ') ' + r.err, isWget ? 4 : r.code), { why: r.why });
    if (fmt) return Object.assign(Res(fmt.replace(/%\{http_code\}/g, String(r.status)).replace(/\\n/g, '\n')), { why: r.why });
    if (headOnly) return Res('HTTP/1.1 ' + r.status + (r.status === 200 ? ' OK' : '') + '\nServer: nginx\nContent-Type: text/html');
    if (outFile && outFile !== '/dev/null') X.fsWrite(S, S.host, X.norm(outFile, S.cwd), r.body);
    if (outFile) return Res('');
    return Object.assign(Res(r.body), { why: r.why });
  }

  // ================================================================ ejecutor
  const HOST_ONLY = ['systemctl', 'journalctl', 'crictl', 'kubeadm', 'apt', 'apt-get', 'apt-mark', 'apt-cache', 'dpkg', 'etcdctl', 'etcdutl', 'sysctl'];

  function runArgv(S, argv, ctx) {
    const stdin = ctx.stdin;
    let env = Object.assign({}, S.env);
    // VAR=valor comando
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) && argv.length > 1) { const i = argv[0].indexOf('='); env[argv[0].slice(0, i)] = argv[0].slice(i + 1); argv = argv.slice(1); }
    if (argv.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) { const i = argv[0].indexOf('='); S.env[argv[0].slice(0, i)] = argv[0].slice(i + 1); return Res(); }
    // alias
    if (S.aliases[argv[0]] && !ctx.noAlias) { const exp = tokenize(S.aliases[argv[0]], S).filter((t) => typeof t === 'string'); argv = exp.concat(argv.slice(1)); }
    argv = argv.flatMap((a) => globExpand(S, a));
    const cmd = argv[0];
    if (!cmd) return Res();
    if (cmd === 'sudo') {
      let rest = argv.slice(1);
      while (rest[0] && rest[0].startsWith('-') && !['-i', '-s', '-u'].includes(rest[0])) rest = rest.slice(1);
      if (!rest.length || rest[0] === '-i' || rest[0] === '-s' || (rest[0] === 'su' && rest.length <= 2) || (rest[0] === 'bash' && rest.length === 1) || (rest[0] === '-u' && rest[1] === 'root' && rest.length === 2)) {
        if (S.host === 'base') return Res('', 'candidate is not in the sudoers file.  This incident will be reported.\n(en el examen, sudo se usa en los hosts de cada pregunta, no en la terminal base)', 1);
        S.hostStack.push({ host: S.host, user: S.user, cwd: S.cwd, sudo: true });
        S.user = 'root'; S.cwd = '/root';
        return Res();
      }
      if (S.host === 'base') return Res('', 'candidate is not in the sudoers file.  This incident will be reported.', 1);
      if (rest[0] === '-u') rest = rest.slice(2);
      const prevUser = S.user; const prevHost = S.host; S.user = 'root';
      const r = runArgv(S, rest, Object.assign({}, ctx, { noAlias: false }));
      if (S.host === prevHost) S.user = prevUser;
      return r;
    }
    switch (cmd) {
      case 'kubectl': {
        const r = CKA.kubectl.run(S, argv.slice(1), { stdin, env });
        return Object.assign({ out: r.out || '', err: r.err || '', code: r.code || 0 }, r.editor ? { editor: r.editor } : {}, r.hint ? { hint: r.hint } : {}, r.why ? { why: r.why } : {});
      }
      case 'helm': return cmdHelm(S, argv);
      case 'etcdctl': return cmdEtcdctl(S, argv, env);
      case 'etcdutl': return cmdEtcdutl(S, argv, env);
      case 'kubeadm': return cmdKubeadm(S, argv);
      case 'systemctl': return cmdSystemctl(S, argv);
      case 'service': return cmdSystemctl(S, ['systemctl', argv[2], argv[1]]);
      case 'journalctl': return cmdJournalctl(S, argv);
      case 'crictl': return cmdCrictl(S, argv);
      case 'apt': case 'apt-get': case 'apt-mark': case 'apt-cache': return cmdApt(S, argv);
      case 'dpkg': return cmdDpkg(S, argv);
      case 'sysctl': return cmdSysctl(S, argv);
      case 'kubelet': { const n = nodeHere(S); if (!n) return Res('', 'kubelet: command not found', 127); if (argv.includes('--version')) return Res('Kubernetes v' + n._sim.pkgs.kubelet); return Res('', 'E1003 run.go:72] "command failed" err="failed to run Kubelet: running kubelet directly is not supported here; use systemctl"', 1); }
      case 'containerd': return Res('containerd containerd.io 2.1.4');
      case 'swapoff': return S.user === 'root' ? Res() : Res('', 'swapoff: Not superuser.', 1);
      case 'modprobe': return S.user === 'root' ? Res() : Res('', 'modprobe: ERROR: could not insert \'' + argv[1] + '\': Operation not permitted', 1);
      case 'ssh': return cmdSsh(S, argv);
      case 'exit': case 'logout': return cmdExit(S);
      case 'su': if (argv[1] === '-' || argv[1] === 'root' || !argv[1]) return Res('', 'su: Authentication failure (usa sudo -i)', 1); return Res('', 'su: user ' + argv[1] + ' does not exist', 1);
      case 'whoami': return Res(S.user);
      case 'id': return Res(S.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)' : 'uid=1000(candidate) gid=1000(candidate) groups=1000(candidate),27(sudo)');
      case 'hostname': return Res(S.host);
      case 'pwd': return Res(S.cwd);
      case 'cd': {
        const target = argv[1] ? X.norm(argv[1], S.cwd) : (S.user === 'root' ? '/root' : '/home/candidate');
        if (!X.fsIsDir(S, S.host, target)) return Res('', 'bash: cd: ' + argv[1] + ': No such file or directory', 1);
        if (target.startsWith('/root') && S.user !== 'root') return Res('', 'bash: cd: ' + argv[1] + ': Permission denied', 1);
        S.cwd = target; return Res();
      }
      case 'ls': case 'll': return cmdLs(S, cmd === 'll' ? ['ls', '-la'].concat(argv.slice(1)) : argv);
      case 'cat': case 'less': case 'more': return cmdCat(S, argv, stdin);
      case 'head': return cmdHeadTail(S, argv, stdin, true);
      case 'tail': return cmdHeadTail(S, argv, stdin, false);
      case 'grep': case 'egrep': return cmdGrep(S, cmd === 'egrep' ? ['grep', '-E'].concat(argv.slice(1)) : argv, stdin);
      case 'wc': return cmdWc(S, argv, stdin);
      case 'sort': return cmdSort(S, argv, stdin);
      case 'uniq': return cmdUniq(S, argv, stdin);
      case 'cut': return cmdCut(S, argv, stdin);
      case 'tr': return cmdTr(S, argv, stdin);
      case 'awk': return cmdAwk(S, argv, stdin);
      case 'sed': return cmdSed(S, argv, stdin);
      case 'column': return Res((stdin || '').replace(/\n$/, ''));
      case 'tee': {
        const append = argv.includes('-a');
        for (const f of argv.slice(1).filter((x) => !x.startsWith('-'))) {
          const p = X.norm(f, S.cwd);
          if (!X.canWrite(S, p)) return Res(stdin, 'tee: ' + f + ': Permission denied', 1);
          if (!X.fsIsDir(S, S.host, X.parentOf(p))) return Res(stdin, 'tee: ' + f + ': No such file or directory', 1);
          X.fsWrite(S, S.host, p, (append ? (X.fsRead(S, S.host, p) || '') : '') + (stdin || ''));
        }
        return Res((stdin || '').replace(/\n$/, ''));
      }
      case 'echo': {
        let a = argv.slice(1); let nl = true; let esc = false;
        while (a[0] && /^-[ne]+$/.test(a[0])) { if (a[0].includes('n')) nl = false; if (a[0].includes('e')) esc = true; a = a.slice(1); }
        let s = a.join(' ');
        if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return { out: s, err: '', code: 0, noNewline: !nl };
      }
      case 'printf': { let s = (argv[1] || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t'); let q = 2; s = s.replace(/%s|%d/g, () => argv[q++] || ''); return { out: s, err: '', code: 0, noNewline: true }; }
      case 'cp': return cmdCpMv(S, argv, false);
      case 'mv': return cmdCpMv(S, argv, true);
      case 'rm': case 'rmdir': return cmdRm(S, cmd === 'rmdir' ? ['rm', '-r'].concat(argv.slice(1)) : argv);
      case 'mkdir': return cmdMkdir(S, argv);
      case 'touch': return cmdTouch(S, argv);
      case 'chmod': case 'chown': case 'chgrp': return S.user === 'root' || !argv.slice(1).some((x) => X.norm(x, S.cwd).startsWith('/etc')) ? Res() : Res('', cmd + ': changing permissions: Operation not permitted', 1);
      case 'vi': case 'vim': case 'nano': case 'view': return editorFor(S, argv);
      case 'clear': return { out: '', err: '', code: 0, clear: true };
      case 'history': return Res(S.history.map((h, i) => String(i + 1).padStart(5) + '  ' + h).join('\n'));
      case 'alias': {
        if (argv.length === 1) return Res(Object.keys(S.aliases).map((k) => "alias " + k + "='" + S.aliases[k] + "'").join('\n'));
        for (const a of argv.slice(1)) { const i = a.indexOf('='); if (i > 0) S.aliases[a.slice(0, i)] = a.slice(i + 1); }
        return Res();
      }
      case 'unalias': delete S.aliases[argv[1]]; return Res();
      case 'export': for (const a of argv.slice(1)) { const i = a.indexOf('='); if (i > 0) S.env[a.slice(0, i)] = a.slice(i + 1); } return Res();
      case 'unset': delete S.env[argv[1]]; return Res();
      case 'env': case 'printenv': return Res(Object.keys(S.env).map((k) => k + '=' + S.env[k]).join('\n'));
      case 'source': case '.': return Res();
      case 'complete': case 'set': case 'shopt': case 'bind': case 'true': case ':': case 'sleep': case 'watch': case 'wait': return Res();
      case 'false': return Res('', '', 1);
      case 'date': return Res(new Date(S.now).toUTCString().replace('GMT', 'UTC'));
      case 'uname': return Res(argv.includes('-a') ? 'Linux ' + S.host + ' 6.8.0-79-generic #79-Ubuntu SMP x86_64 GNU/Linux' : 'Linux');
      case 'base64': {
        if (argv.includes('-d') || argv.includes('--decode')) { const r = b64dec(stdin || ''); return r == null ? Res('', 'base64: invalid input', 1) : { out: r, err: '', code: 0, noNewline: true }; }
        return Res(b64enc(stdin || ''));
      }
      case 'which': case 'type': { const known = ['kubectl', 'helm', 'etcdctl', 'etcdutl', 'kubeadm', 'kubelet', 'crictl', 'systemctl', 'vim', 'vi', 'nano', 'curl', 'wget', 'jq']; return argv.slice(1).every((x) => known.includes(x)) ? Res(argv.slice(1).map((x) => '/usr/bin/' + x).join('\n')) : Res('', '', 1); }
      case 'find': {
        const dir = X.norm(argv[1] && !argv[1].startsWith('-') ? argv[1] : '.', S.cwd);
        const ni = argv.indexOf('-name');
        const pat = ni > 0 ? argv[ni + 1] : '*';
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const fs = X.fsOf(S, S.host);
        const all = Object.keys(fs.files).concat(Object.keys(fs.dirs)).filter((p) => (p === dir || p.startsWith(dir === '/' ? '/' : dir + '/')) && re.test(p.split('/').pop()));
        return Res(Array.from(new Set(all)).sort().join('\n'));
      }
      case 'diff': { const a = readFileFor(S, argv[1] || '', 'diff'); const b = readFileFor(S, argv[2] || '', 'diff'); if (a.err || b.err) return Res('', a.err || b.err, 2); if (a.text === b.text) return Res(); const la = lines(a.text); const lb = lines(b.text); const out = []; for (let q = 0; q < Math.max(la.length, lb.length); q++) if (la[q] !== lb[q]) { if (la[q] !== undefined) out.push('< ' + la[q]); if (lb[q] !== undefined) out.push('> ' + lb[q]); } return Res(out.join('\n'), '', 1); }
      case 'curl': case 'wget': return cmdCurl(S, argv);
      case 'nslookup': case 'dig': { if (S.host === 'base') return Res('', ';; connection timed out; no servers could be reached', 1); const t = X.resolveHost(S, argv[argv.length - 1], 'default'); if (!t || t.t === 'svc') return Res('Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\n** server can\'t find ' + argv[argv.length - 1] + ': NXDOMAIN\n(los nombres *.svc.cluster.local se resuelven desde un pod: kubectl exec/run ... -- nslookup)', '', 1); return Res('Name:\t' + argv[argv.length - 1] + '\nAddress: ' + (t.node ? t.node.status.addresses[0].address : '')); }
      case 'ping': return Res('PING ' + argv[argv.length - 1] + ' 56(84) bytes of data.\n64 bytes from ' + argv[argv.length - 1] + ': icmp_seq=1 ttl=64 time=0.412 ms');
      case 'ip': return Res('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet ' + (nodeHere(S) ? nodeHere(S).status.addresses[0].address : '172.30.0.10') + '/24 scope global eth0');
      case 'free': return Res('               total        used        free      shared  buff/cache   available\nMem:            3.9Gi       1.2Gi       1.1Gi       4.0Mi       1.9Gi       2.7Gi\nSwap:             0B          0B          0B');
      case 'df': return Res('Filesystem      Size  Used Avail Use% Mounted on\n/dev/root        19G  7.1G   12G  38% /');
      case 'ps': return Res('    PID TTY          TIME CMD\n   2211 ?        00:01:12 kubelet\n   1054 ?        00:00:31 containerd');
      case 'jq': {
        let expr = argv.slice(1).filter((x) => !x.startsWith('-'))[0] || '.';
        let data; try { data = JSON.parse(stdin || 'null'); } catch (e) { return Res('', 'jq: error (at <stdin>:0): Cannot parse input', 2); }
        const raw = argv.includes('-r');
        const res = C.jpEval(expr.replace(/\[\]/g, '[*]'), data);
        return Res(res.map((v) => (raw && typeof v === 'string' ? v : JSON.stringify(v, null, 2))).join('\n'));
      }
      case 'yq': return Res((stdin || '').replace(/\n$/, ''));
      case 'xargs': {
        const items = (stdin || '').split(/\s+/).filter(Boolean);
        if (!items.length) return Res();
        const sub = argv.slice(1).length ? argv.slice(1) : ['echo'];
        return runArgv(S, sub.concat(items), Object.assign({}, ctx, { stdin: '' }));
      }
      case 'man': return Res('(simulador) Usa --help o la documentación de kubernetes.io/docs, permitida en el examen.');
      case 'help': return Res(HELP_TEXT);
      case 'tree': { const r = CKA.shell.runLine(S, 'find ' + (argv[1] || '.'), { capture: true }); return Res(r.stdout.replace(/\n$/, '')); }
      case 'stat': { const p = X.norm(argv[1] || '', S.cwd); if (!X.fsExists(S, S.host, p)) return Res('', "stat: cannot statx '" + argv[1] + "': No such file or directory", 1); return Res('  File: ' + p + '\n  Size: ' + (X.fsRead(S, S.host, p) || '').length + '\nAccess: (0644/-rw-r--r--)  Uid: (    0/    root)   Gid: (    0/    root)'); }
      case 'openssl': return Res('Certificate:\n    Data:\n        Version: 3 (0x2)\n        Issuer: CN = kubernetes\n        Validity\n            Not Before: Oct  3 10:00:00 2025 GMT\n            Not After : Oct  3 10:00:00 2026 GMT\n        Subject: CN = kube-apiserver');
      default:
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return Res();
        return Res('', cmd + ': command not found', 127);
    }
  }

  function cmdSsh(S, argv) {
    const target = (argv.slice(1).find((x) => !x.startsWith('-')) || '').replace(/^[\w-]+@/, '');
    if (!target) return Res('', 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] destination [command]', 255);
    const nodeNames = list(S, 'Node').map((n) => n.metadata.name);
    const allowed = S.host === 'base' ? [S.taskHost] : nodeNames.concat([S.taskHost]).filter((h) => h !== S.host && X.hostKey(S, h) !== X.hostKey(S, S.host));
    if (!allowed.includes(target)) {
      if (S.host === 'base' && nodeNames.includes(target)) return Res('', 'ssh: Could not resolve hostname ' + target + ': Name or service not known\n(primero conéctate al host de la pregunta: ssh ' + S.taskHost + ')', 255);
      if (X.hostKey(S, target) === X.hostKey(S, S.host)) return Res('', '(ya estás en ' + S.host + ')', 0);
      return Res('', 'ssh: Could not resolve hostname ' + target + ': Name or service not known', 255);
    }
    S.hostStack.push({ host: S.host, user: S.user, cwd: S.cwd });
    S.host = target;
    S.user = 'candidate';
    S.cwd = '/home/candidate';
    X.mkdirp(X.fsOf(S, target), '/home/candidate');
    const n = find(S, 'Node', null, X.hostKey(S, target));
    return Res('Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0-79-generic x86_64)\n\n' + (n ? ' * Nodo del clúster: ' + n.metadata.name + (n._sim.cp ? ' (control plane)' : '') + '\n' : '') + 'Last login: Fri Oct  2 18:22:41 2026 from 172.30.0.10');
  }

  function cmdExit(S) {
    const prev = S.hostStack.pop();
    if (!prev) return Res('', '(estás en la terminal base; en el examen no cierres esta sesión)', 0);
    const wasSudo = prev.sudo;
    S.host = prev.host; S.user = prev.user; S.cwd = prev.cwd;
    return Res(wasSudo ? 'logout' : 'logout\nConnection to ' + (S.hostStack.length || prev.host !== 'base' ? '' : '') + 'host closed.');
  }

  const HELP_TEXT = [
    'Kubelab CKA — comandos disponibles en el simulador',
    '  kubectl (alias k) · helm · etcdctl · etcdutl · kubeadm · crictl',
    '  ssh <host> · exit · sudo / sudo -i · systemctl · journalctl -u kubelet',
    '  apt-get · apt-mark · apt-cache madison · dpkg -i · sysctl',
    '  vi/vim/nano <archivo> (abre el editor) · cat · ls · cp · mv · rm · mkdir · touch · cd',
    '  grep · awk · sed · sort · head · tail · wc · cut · tr · tee · base64 · jq · xargs · curl · wget',
    '  Tuberías |, redirección > >> 2>/dev/null, &&, ||, ;, heredoc (cat <<EOF), variables ($do), alias',
    'Atajos: ↑/↓ historial · Tab autocompletar · Ctrl+L limpiar · Ctrl+C cancelar línea · pega YAML multilínea',
  ].join('\n');

  // ---------------------------------------------------------------- líneas completas
  function splitHeredocs(script) {
    const L = script.replace(/\r/g, '').split('\n');
    const out = []; const docs = {};
    let id = 0;
    for (let i = 0; i < L.length; i++) {
      let line = L[i];
      while (/\\$/.test(line) && i + 1 < L.length) line = line.slice(0, -1) + ' ' + L[++i].trimStart();
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
      if (m) {
        const delim = m[2];
        const body = [];
        i++;
        while (i < L.length && L[i].trim() !== delim) { body.push(L[i]); i++; }
        const key = 'H' + (id++);
        docs[key] = body.join('\n') + '\n';
        const quoted = !!m[1];
        if (!quoted) docs[key] = docs[key];
        out.push(line.replace(m[0], '<<__HEREDOC' + key + '__'));
      } else out.push(line);
    }
    return { lines: out, docs };
  }

  function splitOps(toks) {
    // separa por && || ;
    const seq = []; let cur = [];
    for (const t of toks) {
      if (t.op === '&&' || t.op === '||' || t.op === ';') { seq.push({ toks: cur, next: t.op }); cur = []; } else cur.push(t);
    }
    seq.push({ toks: cur, next: null });
    return seq;
  }

  function runPipeline(S, toks, docs, ctx) {
    const stages = [[]];
    for (const t of toks) { if (t.op === '|') stages.push([]); else stages[stages.length - 1].push(t); }
    let stdin = ctx.stdin || '';
    let res = Res();
    const errs = [];
    const trace = [];
    for (let si = 0; si < stages.length; si++) {
      const st = stages[si];
      const argv = []; const redirs = [];
      for (let k = 0; k < st.length; k++) {
        const t = st[k];
        if (typeof t === 'string') { argv.push(t); continue; }
        if (t.op === 'heredoc') { redirs.push({ op: 'heredoc', id: t.id }); continue; }
        if (t.op === '2>&1') { redirs.push({ op: '2>&1' }); continue; }
        const target = st[k + 1];
        if (typeof target === 'string') { redirs.push({ op: t.op, file: target }); k++; } else { return { res: Res('', 'bash: syntax error near unexpected token `newline\'', 2), trace }; }
      }
      let input = si === 0 ? stdin : res.out + (res.out && !res.noNewline ? '\n' : '');
      for (const r of redirs) {
        if (r.op === 'heredoc') input = docs[r.id] || '';
        if (r.op === '<') { const rr = readFileFor(S, r.file, 'bash'); if (rr.err) return { res: Res('', 'bash: ' + r.file + ': No such file or directory', 1), trace }; input = rr.text; }
      }
      if (!argv.length) { res = Res(); continue; }
      const userBefore = S.user;
      res = runArgv(S, argv, { stdin: input, depth: ctx.depth });
      trace.push({ argv: argv.slice(), res });
      if (res.editor) return { res, trace };
      const to2 = redirs.find((r) => r.op === '2>');
      const both = redirs.find((r) => r.op === '2>&1');
      const amp = redirs.find((r) => r.op === '&>');
      if (both || amp) { res.out = [res.out, res.err].filter(Boolean).join('\n'); res.err = ''; }
      if (to2) { if (to2.file !== '/dev/null') X.fsWrite(S, S.host, X.norm(to2.file, S.cwd), res.err + '\n'); res.err = ''; }
      const outR = redirs.filter((r) => r.op === '>' || r.op === '>>' || r.op === '&>').pop();
      if (outR) {
        if (outR.file !== '/dev/null') {
          const p = X.norm(outR.file, S.cwd);
          if (!X.canWrite(S, p)) { errs.push('bash: ' + outR.file + ': Permission denied'); res = Res('', '', 1); continue; }
          if (!X.fsIsDir(S, S.host, X.parentOf(p))) { errs.push('bash: ' + outR.file + ': No such file or directory'); res = Res('', '', 1); continue; }
          if (X.fsIsDir(S, S.host, p)) { errs.push('bash: ' + outR.file + ': Is a directory'); res = Res('', '', 1); continue; }
          const content = res.out + (res.out && !res.noNewline ? '\n' : '');
          X.fsWrite(S, S.host, p, outR.op === '>>' ? (X.fsRead(S, S.host, p) || '') + content : content);
        }
        if (res.err) errs.push(res.err);
        res = Object.assign({}, res, { out: '', err: '' });
        continue;
      }
      if (res.err) { errs.push(res.err); res.err = ''; }
    }
    res.err = errs.join('\n');
    return { res, trace };
  }

  function runLine(S, script, ctx) {
    ctx = ctx || {};
    if (!ctx.depth) S.now += 6000;
    const { lines: L, docs } = splitHeredocs(script);
    const outChunks = [];
    let stdout = '';
    let last = Res();
    let traceAll = [];
    let editor = null; let clear = false; let why = null; let hint = null;
    for (const line of L) {
      if (!line.trim()) continue;
      const toks = tokenize(line, S, ctx.depth);
      const seq = splitOps(toks);
      let skip = false;
      for (const part of seq) {
        if (!skip && part.toks.length) {
          const { res, trace } = runPipeline(S, part.toks, docs, ctx);
          traceAll = traceAll.concat(trace);
          last = res;
          S.lastCode = res.code;
          if (res.out) { outChunks.push({ t: 'out', s: res.out }); stdout += res.out + (res.noNewline ? '' : '\n'); }
          if (res.err) outChunks.push({ t: 'err', s: res.err });
          if (res.why) why = res.why;
          if (res.hint) hint = res.hint;
          if (res.clear) clear = true;
          for (const tr of trace) { if (tr.res.why) why = tr.res.why; if (tr.res.hint) hint = tr.res.hint; }
          if (res.editor) { editor = res.editor; break; }
        }
        if (part.next === '&&') skip = skip || last.code !== 0;
        else if (part.next === '||') skip = !skip && last.code === 0 ? true : (skip && last.code !== 0 ? false : skip);
        else skip = false;
      }
      if (editor) break;
    }
    if (!ctx.depth) X.reconcile(S);
    return { chunks: outChunks, stdout, code: last.code, trace: traceAll, editor, clear, why, hint };
  }

  // ---------------------------------------------------------------- autocompletar
  const KVERBS = ['get', 'describe', 'create', 'apply', 'delete', 'edit', 'run', 'expose', 'scale', 'autoscale', 'set', 'rollout', 'label', 'annotate', 'taint', 'cordon', 'uncordon', 'drain', 'patch', 'replace', 'logs', 'exec', 'top', 'auth', 'config', 'api-resources', 'explain', 'version', 'certificate', 'kustomize', 'events', 'cluster-info'];
  const TOP = ['kubectl', 'k', 'helm', 'etcdctl', 'etcdutl', 'kubeadm', 'ssh', 'exit', 'sudo', 'systemctl', 'journalctl', 'crictl', 'apt-get', 'apt-mark', 'apt-cache', 'dpkg', 'sysctl', 'vim', 'vi', 'nano', 'cat', 'ls', 'cd', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'grep', 'echo', 'export', 'alias', 'clear', 'history', 'curl', 'wget', 'base64', 'help'];
  function complete(S, line) {
    const parts = line.split(/\s+/);
    const word = parts[parts.length - 1];
    let cands = [];
    if (parts.length === 1) cands = TOP.concat(Object.keys(S.aliases));
    else {
      const cmd = S.aliases[parts[0]] === 'kubectl' ? 'kubectl' : parts[0];
      const prev = parts[parts.length - 2];
      if (cmd === 'kubectl' && parts.length === 2) cands = KVERBS;
      else if (cmd === 'kubectl' && (prev === '-n' || prev === '--namespace')) cands = list(S, 'Namespace').map((n) => n.metadata.name);
      else if (cmd === 'kubectl' && parts.length === 3 && ['get', 'describe', 'delete', 'edit', 'label', 'annotate', 'scale', 'expose', 'patch', 'rollout'].includes(parts[1])) cands = C.allDefs(S).map((d) => d.plural).concat(C.allDefs(S).flatMap((d) => d.short));
      else if (cmd === 'kubectl' && parts.length >= 4 && ['get', 'describe', 'delete', 'edit', 'label', 'annotate', 'scale', 'expose', 'patch', 'logs', 'exec', 'cordon', 'uncordon', 'drain', 'taint'].includes(parts[1])) {
        const nsI = parts.indexOf('-n'); const ns = nsI > 0 ? parts[nsI + 1] : (S.defaultNs || 'default');
        const kindWord = ['logs', 'exec'].includes(parts[1]) ? 'pods' : ['cordon', 'uncordon', 'drain'].includes(parts[1]) ? 'nodes' : parts[1] === 'taint' ? 'nodes' : parts[2];
        const def = C.resolveKind(S, kindWord);
        if (def) cands = (def.kind === 'Node' || !def.namespaced ? list(S, def.kind) : list(S, def.kind, ns)).map((o) => o.metadata.name);
        if (parts[1] === 'rollout' && parts.length === 3) cands = ['status', 'history', 'undo', 'restart', 'pause', 'resume'];
      } else if (cmd === 'kubectl' && parts[1] === 'rollout' && parts.length === 3) cands = ['status', 'history', 'undo', 'restart'];
      else if (cmd === 'ssh') cands = S.host === 'base' ? [S.taskHost] : list(S, 'Node').map((n) => n.metadata.name);
      else if (cmd === 'systemctl' && parts.length === 2) cands = ['status', 'start', 'stop', 'restart', 'enable', 'disable', 'daemon-reload', 'is-active'];
      else if (cmd === 'systemctl' && parts.length === 3) cands = ['kubelet', 'containerd'];
      if (!cands.length || word.includes('/')) {
        const p = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
        const dir = X.norm(p || '.', S.cwd);
        cands = cands.concat(X.fsList(S, S.host, dir).map((e) => p + e.name + (e.dir ? '/' : '')));
      }
    }
    return cands.filter((c) => c.startsWith(word));
  }

  function prompt(S) {
    const home = S.user === 'root' ? '/root' : '/home/candidate';
    const cwd = S.cwd === home ? '~' : S.cwd.startsWith(home + '/') ? '~' + S.cwd.slice(home.length) : S.cwd;
    return { user: S.user, host: S.host, cwd, sym: S.user === 'root' ? '#' : '$' };
  }

  CKA.shell = { tokenize, runLine, complete, prompt, HELP_TEXT, APT };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
