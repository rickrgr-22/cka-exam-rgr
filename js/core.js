/* Kubelab CKA — núcleo: tipos de recursos, estado, utilidades, JSONPath y formato. */
(function (CKA) {
  'use strict';

  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  function stable(o) {
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    if (o && typeof o === 'object') {
      return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
    }
    return JSON.stringify(o);
  }

  function hashStr(s, len) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const alpha = 'bcdfghjklmnpqrstvwxz2456789';
    let out = '';
    let x = h >>> 0;
    for (let i = 0; i < (len || 10); i++) { out += alpha[x % alpha.length]; x = Math.floor(x / alpha.length) || (h >>> 0) + i * 7919; }
    return out;
  }

  function rand(n) {
    const alpha = 'bcdfghjklmnpqrstvwxz2456789';
    let s = '';
    for (let i = 0; i < n; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
    return s;
  }

  // [Kind, plural, cortos, namespaced, apiVersion]
  const KIND_DEFS = [
    ['Pod', 'pods', ['po'], true, 'v1'],
    ['Service', 'services', ['svc'], true, 'v1'],
    ['Endpoints', 'endpoints', ['ep'], true, 'v1'],
    ['ConfigMap', 'configmaps', ['cm'], true, 'v1'],
    ['Secret', 'secrets', [], true, 'v1'],
    ['ServiceAccount', 'serviceaccounts', ['sa'], true, 'v1'],
    ['Namespace', 'namespaces', ['ns'], false, 'v1'],
    ['Node', 'nodes', ['no'], false, 'v1'],
    ['PersistentVolume', 'persistentvolumes', ['pv'], false, 'v1'],
    ['PersistentVolumeClaim', 'persistentvolumeclaims', ['pvc'], true, 'v1'],
    ['Event', 'events', ['ev'], true, 'v1'],
    ['ResourceQuota', 'resourcequotas', ['quota'], true, 'v1'],
    ['LimitRange', 'limitranges', ['limits'], true, 'v1'],
    ['Deployment', 'deployments', ['deploy'], true, 'apps/v1'],
    ['ReplicaSet', 'replicasets', ['rs'], true, 'apps/v1'],
    ['DaemonSet', 'daemonsets', ['ds'], true, 'apps/v1'],
    ['StatefulSet', 'statefulsets', ['sts'], true, 'apps/v1'],
    ['Job', 'jobs', [], true, 'batch/v1'],
    ['CronJob', 'cronjobs', ['cj'], true, 'batch/v1'],
    ['HorizontalPodAutoscaler', 'horizontalpodautoscalers', ['hpa'], true, 'autoscaling/v2'],
    ['Ingress', 'ingresses', ['ing'], true, 'networking.k8s.io/v1'],
    ['IngressClass', 'ingressclasses', [], false, 'networking.k8s.io/v1'],
    ['NetworkPolicy', 'networkpolicies', ['netpol'], true, 'networking.k8s.io/v1'],
    ['Role', 'roles', [], true, 'rbac.authorization.k8s.io/v1'],
    ['RoleBinding', 'rolebindings', [], true, 'rbac.authorization.k8s.io/v1'],
    ['ClusterRole', 'clusterroles', [], false, 'rbac.authorization.k8s.io/v1'],
    ['ClusterRoleBinding', 'clusterrolebindings', [], false, 'rbac.authorization.k8s.io/v1'],
    ['StorageClass', 'storageclasses', ['sc'], false, 'storage.k8s.io/v1'],
    ['PriorityClass', 'priorityclasses', ['pc'], false, 'scheduling.k8s.io/v1'],
    ['CustomResourceDefinition', 'customresourcedefinitions', ['crd', 'crds'], false, 'apiextensions.k8s.io/v1'],
    ['PodDisruptionBudget', 'poddisruptionbudgets', ['pdb'], true, 'policy/v1'],
    ['GatewayClass', 'gatewayclasses', ['gc'], false, 'gateway.networking.k8s.io/v1'],
    ['Gateway', 'gateways', ['gtw'], true, 'gateway.networking.k8s.io/v1'],
    ['HTTPRoute', 'httproutes', [], true, 'gateway.networking.k8s.io/v1'],
    ['CertificateSigningRequest', 'certificatesigningrequests', ['csr'], false, 'certificates.k8s.io/v1'],
  ].map(([kind, plural, short, namespaced, apiVersion]) => ({
    kind, plural, short, namespaced, apiVersion,
    group: apiVersion.includes('/') ? apiVersion.split('/')[0] : '',
    singular: kind.toLowerCase(),
  }));

  function crdDefs(S) {
    return S.objs.filter((o) => o.kind === 'CustomResourceDefinition').map((c) => {
      const v = (c.spec.versions || []).find((x) => x.storage) || (c.spec.versions || [])[0] || { name: 'v1' };
      return {
        kind: c.spec.names.kind, plural: c.spec.names.plural, short: c.spec.names.shortNames || [],
        singular: c.spec.names.singular || c.spec.names.kind.toLowerCase(), namespaced: c.spec.scope !== 'Cluster',
        apiVersion: c.spec.group + '/' + v.name, group: c.spec.group, crd: c,
      };
    });
  }

  function allDefs(S) { return KIND_DEFS.concat(S ? crdDefs(S) : []); }

  function resolveKind(S, word) {
    if (!word) return null;
    let w = String(word);
    let group = null;
    const dot = w.indexOf('.');
    if (dot > 0) { group = w.slice(dot + 1).toLowerCase(); w = w.slice(0, dot); }
    const lw = w.toLowerCase();
    const defs = allDefs(S);
    const matches = defs.filter((d) => d.kind.toLowerCase() === lw || d.plural === lw || d.singular === lw || d.short.includes(lw));
    if (!matches.length) return null;
    if (group) {
      const g = matches.find((d) => d.group === group || (d.group && group.startsWith(d.group)) || d.group.startsWith(group));
      return g || matches[0];
    }
    return matches[0];
  }

  function defByKind(S, kind) { return allDefs(S).find((d) => d.kind === kind) || null; }

  // ---------------------------------------------------------------- estado
  function newState() {
    return {
      now: Date.parse('2026-10-03T14:00:00Z'),
      objs: [],
      events: [],
      rv: 1000,
      ipSeq: 20,
      svcSeq: 40,
      hosts: {},
      host: 'base',
      user: 'candidate',
      hostStack: [],
      env: { HOME: '/home/candidate', KUBE_EDITOR: 'vim' },
      aliases: { k: 'kubectl' },
      cwd: '/home/candidate',
      history: [],
      badImages: [],
      helm: { repos: {}, releases: [] },
      snapshots: {},
      etcdDirs: {},
      etcd: { dataDir: '/var/lib/etcd' },
      cp: {},
      log: [],
      flags: {},
      context: 'kubernetes-admin@kubernetes',
    };
  }

  function nsOf(o) { return (o.metadata && o.metadata.namespace) || ''; }

  function find(S, kind, ns, name) {
    const d = defByKind(S, kind);
    const namespaced = d ? d.namespaced : true;
    return S.objs.find((o) => o.kind === kind && o.metadata.name === name && (!namespaced || nsOf(o) === (ns || 'default'))) || null;
  }

  function list(S, kind, ns) {
    return S.objs.filter((o) => o.kind === kind && (ns == null || nsOf(o) === ns));
  }

  function uid() {
    const h = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
  }

  function put(S, obj, opts) {
    opts = opts || {};
    const d = defByKind(S, obj.kind);
    obj.metadata = obj.metadata || {};
    if (d && d.namespaced && !obj.metadata.namespace) obj.metadata.namespace = 'default';
    if (d && !d.namespaced) delete obj.metadata.namespace;
    if (!obj.apiVersion && d) obj.apiVersion = d.apiVersion;
    const existing = S.objs.find((o) => o.kind === obj.kind && o.metadata.name === obj.metadata.name && nsOf(o) === nsOf(obj));
    S.rv += 1;
    if (existing) {
      obj.metadata.uid = existing.metadata.uid;
      obj.metadata.creationTimestamp = existing.metadata.creationTimestamp;
      const specChanged = stable(existing.spec) !== stable(obj.spec);
      obj.metadata.generation = (existing.metadata.generation || 1) + (specChanged ? 1 : 0);
      if (!obj._sim && existing._sim) obj._sim = existing._sim;
      else if (obj._sim && existing._sim) obj._sim = Object.assign({}, existing._sim, obj._sim);
      if (!obj.status && existing.status) obj.status = existing.status;
      obj.metadata.resourceVersion = String(S.rv);
      S.objs[S.objs.indexOf(existing)] = obj;
    } else {
      if (obj.kind === 'Pod' && S.podSimByName) {
        const base = S.podSimByName[nsOf(obj) + '/' + obj.metadata.name];
        if (base) obj._sim = Object.assign({}, JSON.parse(JSON.stringify(base)), obj._sim || {});
      }
      obj.metadata.uid = obj.metadata.uid || uid();
      obj.metadata.creationTimestamp = obj.metadata.creationTimestamp || new Date(S.now - (opts.ageMs || 0)).toISOString();
      obj.metadata.generation = 1;
      obj.metadata.resourceVersion = String(S.rv);
      S.objs.push(obj);
    }
    return obj;
  }

  function remove(S, obj) {
    const i = S.objs.indexOf(obj);
    if (i >= 0) S.objs.splice(i, 1);
  }

  function event(S, obj, type, reason, msg) {
    S.events.push({
      ns: nsOf(obj) || 'default', kind: obj.kind, name: obj.metadata.name, type, reason, msg, time: S.now,
    });
    if (S.events.length > 400) S.events.shift();
  }

  // ---------------------------------------------------------------- selectores
  function parseSelector(str) {
    // a=b,c!=d,e in (x,y),!f,g
    const out = [];
    if (!str) return out;
    const parts = [];
    let depth = 0; let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) parts.push(cur);
    for (let p of parts) {
      p = p.trim();
      let m;
      if ((m = p.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/))) out.push({ key: m[1], op: m[2] === 'in' ? 'In' : 'NotIn', values: m[3].split(',').map((s) => s.trim()) });
      else if ((m = p.match(/^([\w./-]+)\s*!=\s*(.*)$/))) out.push({ key: m[1], op: 'NotIn', values: [m[2].trim()] });
      else if ((m = p.match(/^([\w./-]+)\s*==?\s*(.*)$/))) out.push({ key: m[1], op: 'In', values: [m[2].trim()] });
      else if ((m = p.match(/^!([\w./-]+)$/))) out.push({ key: m[1], op: 'DoesNotExist' });
      else if (p) out.push({ key: p, op: 'Exists' });
    }
    return out;
  }

  function matchExpr(labels, e) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const v = labels[e.key];
    switch (e.op || e.operator) {
      case 'In': return has && (e.values || []).includes(v);
      case 'NotIn': return !has || !(e.values || []).includes(v);
      case 'Exists': return has;
      case 'DoesNotExist': return !has;
      case 'Gt': return has && Number(v) > Number(e.values[0]);
      case 'Lt': return has && Number(v) < Number(e.values[0]);
      default: return false;
    }
  }

  function matchLabelSelector(labels, sel) {
    labels = labels || {};
    if (!sel) return false;
    const ml = sel.matchLabels || {};
    for (const k of Object.keys(ml)) if (labels[k] !== String(ml[k])) return false;
    for (const e of sel.matchExpressions || []) if (!matchExpr(labels, { key: e.key, op: e.operator, values: e.values })) return false;
    return true;
  }

  function matchMap(labels, map) {
    labels = labels || {};
    if (!map) return false;
    return Object.keys(map).every((k) => labels[k] === String(map[k]));
  }

  function matchParsed(labels, parsed) {
    labels = labels || {};
    return parsed.every((e) => matchExpr(labels, e));
  }

  // ---------------------------------------------------------------- cantidades
  function parseCpu(v) {
    if (v == null || v === '') return 0;
    const s = String(v);
    if (s.endsWith('m')) return parseFloat(s);
    return parseFloat(s) * 1000;
  }
  function parseMem(v) {
    if (v == null || v === '') return 0;
    const s = String(v);
    const m = s.match(/^([\d.]+)\s*([KMGT]i?|[kmgt]|)$/);
    if (!m) return parseFloat(s) / (1024 * 1024);
    const n = parseFloat(m[1]);
    const f = { '': 1 / (1024 * 1024), Ki: 1 / 1024, K: 1000 / (1024 * 1024), k: 1000 / (1024 * 1024), Mi: 1, M: 1e6 / (1024 * 1024), Gi: 1024, G: 1e9 / (1024 * 1024), Ti: 1024 * 1024, T: 1e12 / (1024 * 1024) };
    return n * (f[m[2]] || 1);
  }
  function parseStorage(v) { return parseMem(v); }

  // ---------------------------------------------------------------- tiempo
  function age(S, ts) {
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    let s = Math.max(0, Math.floor((S.now - t) / 1000));
    if (s < 120) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h' + (h < 10 && m % 60 ? (m % 60) + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd' + (d < 10 && h % 24 ? (h % 24) + 'h' : '');
  }

  // ---------------------------------------------------------------- JSONPath
  function splitSegs(p) {
    const segs = [];
    let i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === '.') {
        if (p[i + 1] === '.') { segs.push({ t: 'desc' }); i += 2; continue; }
        i++;
        let j = i;
        while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
        const name = p.slice(i, j);
        if (name === '*') segs.push({ t: 'all' });
        else if (name) segs.push({ t: 'key', k: name });
        i = j;
      } else if (c === '[') {
        let depth = 0; let j = i; let q = null;
        for (; j < p.length; j++) {
          const ch = p[j];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === '"' || ch === "'") { q = ch; continue; }
          if (ch === '[') depth++;
          if (ch === ']') { depth--; if (depth === 0) break; }
        }
        const inner = p.slice(i + 1, j).trim();
        i = j + 1;
        if (inner === '*') segs.push({ t: 'all' });
        else if (/^-?\d+$/.test(inner)) segs.push({ t: 'idx', n: parseInt(inner, 10) });
        else if (/^-?\d*:-?\d*$/.test(inner)) { const [a, b] = inner.split(':'); segs.push({ t: 'slice', a: a === '' ? null : +a, b: b === '' ? null : +b }); }
        else if (/^['"].*['"]$/.test(inner)) segs.push({ t: 'key', k: inner.slice(1, -1) });
        else if (inner.startsWith('?')) segs.push({ t: 'filter', f: inner.replace(/^\?\s*\(/, '').replace(/\)\s*$/, '') });
        else segs.push({ t: 'key', k: inner });
      } else {
        let j = i;
        while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
        segs.push({ t: 'key', k: p.slice(i, j) });
        i = j;
      }
    }
    return segs;
  }

  function descend(v, out) {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { out.push(v[k]); descend(v[k], out); }
    }
  }

  function filterOk(item, f) {
    const m = f.match(/^@((?:\.[^\s=!<>]+|\[[^\]]*\])*)\s*(==|!=|<=|>=|<|>|=~)?\s*(.*)$/);
    if (!m) return false;
    const vals = jpEval('@' + m[1], item);
    if (!m[2]) return vals.length > 0 && vals[0] !== undefined && vals[0] !== null && vals[0] !== false;
    let rhs = m[3].trim();
    if (/^['"].*['"]$/.test(rhs)) rhs = rhs.slice(1, -1);
    else if (rhs === 'true') rhs = true; else if (rhs === 'false') rhs = false;
    else if (!isNaN(Number(rhs))) rhs = Number(rhs);
    const v = vals[0];
    switch (m[2]) {
      case '==': return v == rhs; // eslint-disable-line eqeqeq
      case '!=': return v != rhs; // eslint-disable-line eqeqeq
      case '<': return v < rhs;
      case '>': return v > rhs;
      case '<=': return v <= rhs;
      case '>=': return v >= rhs;
      default: return false;
    }
  }

  function jpEval(path, root) {
    let p = String(path).trim();
    if (p[0] === '$' || p[0] === '@') p = p.slice(1);
    if (p && p[0] !== '.' && p[0] !== '[') p = '.' + p;
    let cur = [root];
    for (const seg of splitSegs(p)) {
      const next = [];
      for (const v of cur) {
        if (v == null) continue;
        if (seg.t === 'key') { if (typeof v === 'object' && v[seg.k] !== undefined) next.push(v[seg.k]); }
        else if (seg.t === 'all') { if (Array.isArray(v)) next.push(...v); else if (typeof v === 'object') next.push(...Object.values(v)); }
        else if (seg.t === 'idx') { if (Array.isArray(v)) { const x = v[seg.n < 0 ? v.length + seg.n : seg.n]; if (x !== undefined) next.push(x); } }
        else if (seg.t === 'slice') { if (Array.isArray(v)) next.push(...v.slice(seg.a == null ? 0 : seg.a, seg.b == null ? undefined : seg.b)); }
        else if (seg.t === 'filter') { if (Array.isArray(v)) next.push(...v.filter((x) => filterOk(x, seg.f))); }
        else if (seg.t === 'desc') { next.push(v); descend(v, next); }
      }
      cur = next;
    }
    return cur;
  }

  function jpFormat(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function unescapeLit(s) {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }

  function jsonpathTemplate(tpl, root) {
    // tokens
    const toks = [];
    let i = 0;
    while (i < tpl.length) {
      if (tpl[i] === '{') {
        let j = i + 1; let q = null; let depth = 1;
        for (; j < tpl.length; j++) {
          const ch = tpl[j];
          if (q) { if (ch === q && tpl[j - 1] !== '\\') q = null; continue; }
          if (ch === '"' || ch === "'") { q = ch; continue; }
          if (ch === '{') depth++;
          if (ch === '}') { depth--; if (depth === 0) break; }
        }
        if (j >= tpl.length) throw new Error('error: error parsing jsonpath ' + tpl + ', unclosed action');
        toks.push({ t: 'expr', v: tpl.slice(i + 1, j).trim() });
        i = j + 1;
      } else {
        let j = i;
        while (j < tpl.length && tpl[j] !== '{') j++;
        toks.push({ t: 'text', v: tpl.slice(i, j) });
        i = j;
      }
    }
    function run(start, ctx, out) {
      let k = start;
      while (k < toks.length) {
        const tk = toks[k];
        if (tk.t === 'text') { out.push(unescapeLit(tk.v)); k++; continue; }
        const e = tk.v;
        if (e === 'end') return k;
        if (e.startsWith('range ')) {
          const items = jpEval(e.slice(6).trim(), ctx);
          let endAt = k + 1;
          // encontrar fin correspondiente
          let depth = 1; let m = k + 1;
          for (; m < toks.length; m++) {
            if (toks[m].t === 'expr' && toks[m].v.startsWith('range ')) depth++;
            if (toks[m].t === 'expr' && toks[m].v === 'end') { depth--; if (depth === 0) break; }
          }
          endAt = m;
          const list = items.length === 1 && Array.isArray(items[0]) ? items[0] : items;
          for (const it of list) run(k + 1, it, out);
          k = endAt + 1;
          continue;
        }
        if (/^["'].*["']$/.test(e)) { out.push(unescapeLit(e.slice(1, -1))); k++; continue; }
        const vals = jpEval(e, ctx);
        out.push(vals.map(jpFormat).join(' '));
        k++;
      }
      return k;
    }
    const out = [];
    run(0, root, out);
    return out.join('');
  }

  // ---------------------------------------------------------------- tablas
  function table(headers, rows, opts) {
    opts = opts || {};
    const all = opts.noHeaders ? rows : [headers].concat(rows);
    if (!all.length) return '';
    const widths = [];
    for (const r of all) r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); });
    return all.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i] + 3))).join('')).join('\n');
  }

  // ---------------------------------------------------------------- público
  function toPublic(o) {
    if (Array.isArray(o)) return o.map(toPublic);
    if (o && typeof o === 'object') {
      const r = {};
      for (const k of Object.keys(o)) if (k[0] !== '_' && o[k] !== undefined) r[k] = toPublic(o[k]);
      return r;
    }
    return o;
  }

  function orderManifest(o) {
    const order = ['apiVersion', 'kind', 'metadata', 'spec', 'data', 'stringData', 'type', 'immutable', 'rules', 'subjects', 'roleRef', 'provisioner', 'parameters', 'reclaimPolicy', 'allowVolumeExpansion', 'volumeBindingMode', 'value', 'globalDefault', 'description', 'preemptionPolicy', 'status'];
    const r = {};
    for (const k of order) if (o[k] !== undefined) r[k] = o[k];
    for (const k of Object.keys(o)) if (r[k] === undefined) r[k] = o[k];
    return r;
  }

  function toYaml(o) {
    return CKA.yaml.dump(o, { noRefs: true, lineWidth: -1, quotingType: '"', noArrayIndent: true })
      .replace(/^(\s*- )"(--[^"\\]*)"$/gm, (m, a, b) => (/: | #/.test(b) ? m : a + b));
  }

  function parseYamlDocs(text) {
    const docs = [];
    CKA.yaml.loadAll(text, (d) => { if (d != null) docs.push(d); });
    return docs;
  }

  CKA.yaml = (typeof jsyaml !== 'undefined') ? jsyaml : (typeof window !== 'undefined' && window.jsyaml);
  CKA.core = {
    clone, stable, hashStr, rand, KIND_DEFS, allDefs, resolveKind, defByKind, newState, find, list, put, remove, event, nsOf,
    parseSelector, matchExpr, matchLabelSelector, matchMap, matchParsed, parseCpu, parseMem, parseStorage, age,
    jpEval, jsonpathTemplate, jpFormat, table, toPublic, toYaml, parseYamlDocs, orderManifest, uid, yaml: CKA.yaml,
  };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
