/* Kubelab CKA — implementación de kubectl sobre el simulador. */
(function (CKA) {
  'use strict';
  const C = CKA.core;
  const X = CKA.sim;
  const { clone, find, list, put, remove } = C;

  class KErr extends Error { constructor(msg, code) { super(msg); this.code = code || 1; } }

  // ------------------------------------------------------------ argumentos
  const BOOL_FLAGS = new Set(['A', 'all-namespaces', 'show-labels', 'no-headers', 'wide', 'force', 'ignore-daemonsets', 'delete-emptydir-data', 'delete-local-data', 'overwrite', 'all', 'record', 'watch', 'w', 'i', 't', 'it', 'rm', 'previous', 'p', 'f-follow', 'follow', 'save-config', 'recursive', 'R', 'list', 'quiet', 'q', 'local', 'server-side', 'allow-missing-template-keys', 'stdin', 'tty', 'short', 'client', 'raw', 'containers', 'sort', 'use-protocol-buffers', 'now', 'disable-eviction', 'current', 'minify', 'flatten', 'restart-always', 'expose', 'dry-run-flag', 'include-uninitialized', 'recurse', 'timestamps']);

  function parseArgs(argv) {
    const pos = []; const flags = {}; let rest = null;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { rest = argv.slice(i + 1); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq > 0) { add(flags, a.slice(2, eq), a.slice(eq + 1)); continue; }
        const name = a.slice(2);
        if (BOOL_FLAGS.has(name) || name === 'dry-run' && !(argv[i + 1] && /^(client|server|none)$/.test(argv[i + 1]))) { add(flags, name, name === 'dry-run' ? 'client' : true); continue; }
        if (i + 1 < argv.length) { add(flags, name, argv[++i]); } else add(flags, name, true);
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        const name = a.slice(1);
        // -oyaml, -nfoo
        const short = { o: 'output', n: 'namespace', l: 'selector', f: 'filename', c: 'container', k: 'kustomize', A: 'all-namespaces', w: 'watch', i: 'stdin', t: 'tty', p: 'previous', R: 'recursive', q: 'quiet', r: 'replicas', L: 'label-columns', h: 'help', v: 'v' };
        if (name === 'it' || name === 'ti') { flags.stdin = true; flags.tty = true; continue; }
        const k = name[0];
        const long = short[k] || k;
        if (BOOL_FLAGS.has(long) || ['A', 'w', 'i', 't', 'p', 'R', 'q', 'h'].includes(k)) {
          if (name.length > 1 && ['i', 't'].includes(k)) { for (const ch of name) flags[short[ch] || ch] = true; continue; }
          add(flags, long, true); continue;
        }
        if (name.length > 1) { let v = name.slice(1); if (v.startsWith('=')) v = v.slice(1); add(flags, long, v); continue; }
        if (i + 1 < argv.length) add(flags, long, argv[++i]); else add(flags, long, true);
        continue;
      }
      pos.push(a);
    }
    return { pos, flags, rest };
  }
  function add(flags, k, v) {
    if (flags[k] === undefined) flags[k] = v;
    else if (Array.isArray(flags[k])) flags[k].push(v);
    else flags[k] = [flags[k], v];
  }
  function one(v) { return Array.isArray(v) ? v[v.length - 1] : v; }
  function many(v) { return v === undefined ? [] : (Array.isArray(v) ? v : [v]); }

  // ------------------------------------------------------------ utilidades
  function nsFlag(S, f) { return one(f.namespace) || S.defaultNs || 'default'; }
  function dryRun(f) { const d = one(f['dry-run']); return d && d !== 'none' ? d : null; }

  function ensureNs(S, ns) {
    if (!find(S, 'Namespace', null, ns)) throw new KErr('Error from server (NotFound): namespaces "' + ns + '" not found');
  }

  function kindErr(word) {
    return new KErr('error: the server doesn\'t have a resource type "' + word + '"');
  }

  function splitTypeName(S, pos) {
    // soporta: "pods foo bar", "pod/foo", "pods,svc"
    const out = [];
    if (!pos.length) return out;
    if (pos[0].includes('/')) {
      for (const p of pos) {
        const [t, n] = p.split('/');
        const d = C.resolveKind(S, t);
        if (!d) throw kindErr(t);
        out.push({ def: d, name: n });
      }
      return out;
    }
    const types = pos[0].split(',');
    for (const t of types) {
      const d = C.resolveKind(S, t);
      if (!d) throw kindErr(t);
      if (pos.length > 1) for (const n of pos.slice(1)) out.push({ def: d, name: n });
      else out.push({ def: d, name: null });
    }
    return out;
  }

  function notFound(def, name) {
    const g = def.group ? def.plural + '.' + def.group : def.plural;
    return new KErr('Error from server (NotFound): ' + g + ' "' + name + '" not found');
  }

  function getObj(S, def, ns, name) {
    const o = find(S, def.kind, def.namespaced ? ns : null, name);
    if (!o) throw notFound(def, name);
    return o;
  }

  function resName(o) {
    const d = C.defByKind(null, o.kind) || { plural: o.kind.toLowerCase() + 's', group: '' };
    return (d.group ? d.singular + '.' + d.group : d.singular || o.kind.toLowerCase()) + '/' + o.metadata.name;
  }
  function resNameS(S, o) {
    const d = C.defByKind(S, o.kind);
    return (d && d.group ? d.singular + '.' + d.group : (d ? d.singular : o.kind.toLowerCase())) + '/' + o.metadata.name;
  }

  function publicObj(S, o) {
    const pub = C.toPublic(clone(o));
    return C.orderManifest(pub);
  }

  function endpointsObj(S, svc) {
    const eps = X.svcEndpoints(S, svc);
    return {
      apiVersion: 'v1', kind: 'Endpoints', metadata: { name: svc.metadata.name, namespace: C.nsOf(svc), creationTimestamp: svc.metadata.creationTimestamp },
      subsets: eps.length ? [{ addresses: eps.map((p) => ({ ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: C.nsOf(p) } })), ports: (svc.spec.ports || []).map((pt) => ({ name: pt.name, port: typeof pt.targetPort === 'number' ? pt.targetPort : (X.podPorts(eps[0]).find((x) => x.name === pt.targetPort) || {}).port || pt.port, protocol: pt.protocol || 'TCP' })) }] : undefined,
    };
  }

  function listKind(S, def, ns, all) {
    if (def.kind === 'Endpoints') return list(S, 'Service', all ? null : ns).map((s) => endpointsObj(S, s));
    if (def.kind === 'Event') return S.events.filter((e) => all || e.ns === ns).map((e) => ({ kind: 'Event', apiVersion: 'v1', metadata: { name: e.name + '.' + C.hashStr(e.reason + e.time, 8), namespace: e.ns, creationTimestamp: new Date(e.time).toISOString() }, type: e.type, reason: e.reason, message: e.msg, involvedObject: { kind: e.kind, name: e.name, namespace: e.ns }, lastTimestamp: new Date(e.time).toISOString(), firstTimestamp: new Date(e.time).toISOString(), count: 1, _t: e.time }));
    return list(S, def.kind, def.namespaced ? (all ? null : ns) : null);
  }

  // ------------------------------------------------------------ tablas por tipo
  function sel(o) { return o; }
  function labelsStr(l) { const k = Object.keys(l || {}); return k.length ? k.map((x) => x + '=' + l[x]).join(',') : '<none>'; }
  function ports(svc) { return (svc.spec.ports || []).map((p) => p.port + (p.nodePort ? ':' + p.nodePort : '') + '/' + (p.protocol || 'TCP')).join(',') || '<none>'; }
  function selStr(m) { return m ? Object.keys(m).map((k) => k + '=' + m[k]).join(',') : '<none>'; }
  function accessShort(m) { return (m || []).map((x) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[x] || x)).join(','); }

  function row(S, o, wide) {
    const age = C.age(S, o.metadata.creationTimestamp);
    const nm = o.metadata.name;
    switch (o.kind) {
      case 'Pod': {
        const cs = o.status.containerStatuses || [];
        const ready = cs.filter((c) => c.ready).length + '/' + (o.spec.containers || []).length;
        const restarts = cs.reduce((a, c) => a + (c.restartCount || 0), 0);
        const r = [nm, ready, X.podDisplayStatus(o), String(restarts), age];
        if (wide) r.push(o.status.podIP || '<none>', o.spec.nodeName || '<none>', '<none>', '<none>');
        return r;
      }
      case 'Deployment': { const r = [nm, (o.status.readyReplicas || 0) + '/' + o.spec.replicas, String(o.status.updatedReplicas || 0), String(o.status.availableReplicas || 0), age]; if (wide) r.push((o.spec.template.spec.containers || []).map((c) => c.name).join(','), (o.spec.template.spec.containers || []).map((c) => c.image).join(','), selStr((o.spec.selector || {}).matchLabels)); return r; }
      case 'ReplicaSet': return [nm, String(o.spec.replicas), String(o.status.replicas || 0), String(o.status.readyReplicas || 0), age];
      case 'DaemonSet': return [nm, String(o.status.desiredNumberScheduled || 0), String(o.status.currentNumberScheduled || 0), String(o.status.numberReady || 0), String(o.status.updatedNumberScheduled || 0), String(o.status.numberAvailable || 0), selStr(o.spec.template.spec.nodeSelector), age];
      case 'StatefulSet': return [nm, (o.status.readyReplicas || 0) + '/' + o.spec.replicas, age];
      case 'Service': { const r = [nm, o.spec.type || 'ClusterIP', o.spec.clusterIP || '<none>', o.spec.type === 'LoadBalancer' ? '<pending>' : '<none>', ports(o), age]; if (wide) r.push(selStr(o.spec.selector)); return r; }
      case 'Endpoints': { const s = (o.subsets || [])[0]; return [nm, s ? s.addresses.map((a) => a.ip + ':' + s.ports[0].port).join(',') : '<none>', age]; }
      case 'Node': {
        const ready = X.nodeReady(o) ? 'Ready' : 'NotReady';
        const status = ready + (o.spec.unschedulable ? ',SchedulingDisabled' : '');
        const roles = Object.keys(o.metadata.labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).join(',') || '<none>';
        const r = [nm, status, roles, age, o.status.nodeInfo.kubeletVersion];
        if (wide) r.push(o.status.addresses[0].address, '<none>', o.status.nodeInfo.osImage, o.status.nodeInfo.kernelVersion, o.status.nodeInfo.containerRuntimeVersion);
        return r;
      }
      case 'Namespace': return [nm, 'Active', age];
      case 'ConfigMap': return [nm, String(Object.keys(o.data || {}).length + Object.keys(o.binaryData || {}).length), age];
      case 'Secret': return [nm, o.type || 'Opaque', String(Object.keys(o.data || {}).length), age];
      case 'ServiceAccount': return [nm, '0', age];
      case 'PersistentVolume': return [nm, (o.spec.capacity || {}).storage, accessShort(o.spec.accessModes), o.spec.persistentVolumeReclaimPolicy || 'Retain', (o.status || {}).phase || 'Available', o.spec.claimRef ? o.spec.claimRef.namespace + '/' + o.spec.claimRef.name : '', o.spec.storageClassName || '', '<unset>', '', age];
      case 'PersistentVolumeClaim': return [nm, (o.status || {}).phase || 'Pending', o.spec.volumeName || '', ((o.status || {}).capacity || {}).storage || '', accessShort((o.status || {}).accessModes || (o.status && o.status.phase === 'Bound' ? o.spec.accessModes : [])), o.spec.storageClassName || '', '<unset>', age];
      case 'StorageClass': { const def = (o.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true'; return [nm + (def ? ' (default)' : ''), o.provisioner, o.reclaimPolicy || 'Delete', o.volumeBindingMode || 'Immediate', String(!!o.allowVolumeExpansion), age]; }
      case 'Ingress': return [nm, o.spec.ingressClassName || '<none>', (o.spec.rules || []).map((r) => r.host || '*').join(',') || '*', ((o.status && o.status.loadBalancer && o.status.loadBalancer.ingress) || []).map((x) => x.ip).join(','), (o.spec.tls ? '80, 443' : '80'), age];
      case 'IngressClass': return [nm, o.spec.controller, '<none>', age];
      case 'NetworkPolicy': return [nm, selStr((o.spec.podSelector || {}).matchLabels) === '<none>' ? '<none>' : selStr(o.spec.podSelector.matchLabels), age];
      case 'Role': case 'ClusterRole': return [nm, o.metadata.creationTimestamp];
      case 'RoleBinding': case 'ClusterRoleBinding': { const r = [nm, o.roleRef.kind + '/' + o.roleRef.name, age]; if (wide) r.push((o.subjects || []).filter((s) => s.kind === 'User').map((s) => s.name).join(','), (o.subjects || []).filter((s) => s.kind === 'Group').map((s) => s.name).join(','), (o.subjects || []).filter((s) => s.kind === 'ServiceAccount').map((s) => (s.namespace || '') + '/' + s.name).join(',')); return r; }
      case 'Job': return [nm, (o.status.conditions || []).some((c) => c.type === 'Complete') ? 'Complete' : 'Running', (o.status.succeeded || 0) + '/' + (o.spec.completions || 1), '5s', age];
      case 'CronJob': return [nm, o.spec.schedule, o.spec.timeZone || '<none>', String(!!o.spec.suspend), '0', '<none>', age];
      case 'HorizontalPodAutoscaler': { const m = (o.spec.metrics || [])[0]; const tgt = m && m.resource ? 'cpu: ' + ((o.status.currentMetrics || [])[0] ? '12%' : '<unknown>') + '/' + (m.resource.target.averageUtilization != null ? m.resource.target.averageUtilization + '%' : m.resource.target.averageValue) : '<none>'; return [nm, (o.spec.scaleTargetRef.kind || 'Deployment') + '/' + o.spec.scaleTargetRef.name, tgt, String(o.spec.minReplicas || 1), String(o.spec.maxReplicas), String(o.status.currentReplicas || 0), age]; }
      case 'PriorityClass': return [nm, String(o.value), String(!!o.globalDefault), o.preemptionPolicy || 'PreemptLowerPriority', age];
      case 'CustomResourceDefinition': return [nm, o.metadata.creationTimestamp];
      case 'Gateway': return [nm, o.spec.gatewayClassName, ((o.status || {}).addresses || []).map((a) => a.value).join(','), String(((o.status || {}).conditions || []).some((c) => c.type === 'Programmed' && c.status === 'True')), age];
      case 'GatewayClass': return [nm, o.spec.controllerName, 'True', age];
      case 'HTTPRoute': return [nm, JSON.stringify(o.spec.hostnames || []), age];
      case 'Event': return [C.age(S, o._t), o.type, o.reason, o.involvedObject.kind.toLowerCase() + '/' + o.involvedObject.name, o.message];
      case 'ResourceQuota': return [nm, age, Object.keys((o.spec || {}).hard || {}).map((k) => k + ': 0/' + o.spec.hard[k]).join(', '), ''];
      case 'LimitRange': return [nm, o.metadata.creationTimestamp];
      case 'PodDisruptionBudget': return [nm, String(o.spec.minAvailable != null ? o.spec.minAvailable : 'N/A'), String(o.spec.maxUnavailable != null ? o.spec.maxUnavailable : 'N/A'), '0', age];
      case 'CertificateSigningRequest': return [nm, age, o.spec.signerName, o.spec.username || 'kubernetes-admin', (o.status && o.status.conditions || []).map((c) => c.type).join(',') || 'Pending'];
      default: return [nm, age];
    }
  }

  function headers(kind, wide) {
    const H = {
      Pod: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], Deployment: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], ReplicaSet: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
      DaemonSet: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'], StatefulSet: ['NAME', 'READY', 'AGE'],
      Service: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'], Endpoints: ['NAME', 'ENDPOINTS', 'AGE'], Node: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'],
      Namespace: ['NAME', 'STATUS', 'AGE'], ConfigMap: ['NAME', 'DATA', 'AGE'], Secret: ['NAME', 'TYPE', 'DATA', 'AGE'], ServiceAccount: ['NAME', 'SECRETS', 'AGE'],
      PersistentVolume: ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'],
      PersistentVolumeClaim: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'],
      StorageClass: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'], Ingress: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'],
      IngressClass: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], NetworkPolicy: ['NAME', 'POD-SELECTOR', 'AGE'], Role: ['NAME', 'CREATED AT'], ClusterRole: ['NAME', 'CREATED AT'],
      RoleBinding: ['NAME', 'ROLE', 'AGE'], ClusterRoleBinding: ['NAME', 'ROLE', 'AGE'], Job: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'],
      CronJob: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'], HorizontalPodAutoscaler: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
      PriorityClass: ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'PREEMPTIONPOLICY', 'AGE'], CustomResourceDefinition: ['NAME', 'CREATED AT'], Gateway: ['NAME', 'CLASS', 'ADDRESS', 'PROGRAMMED', 'AGE'],
      GatewayClass: ['NAME', 'CONTROLLER', 'ACCEPTED', 'AGE'], HTTPRoute: ['NAME', 'HOSTNAMES', 'AGE'], Event: ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
      ResourceQuota: ['NAME', 'AGE', 'REQUEST', 'LIMIT'], LimitRange: ['NAME', 'CREATED AT'], PodDisruptionBudget: ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'],
      CertificateSigningRequest: ['NAME', 'AGE', 'SIGNERNAME', 'REQUESTOR', 'CONDITION'],
    };
    const h = (H[kind] || ['NAME', 'AGE']).slice();
    if (wide) {
      if (kind === 'Pod') h.push('IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES');
      if (kind === 'Node') h.push('INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME');
      if (kind === 'Deployment') h.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      if (kind === 'Service') h.push('SELECTOR');
      if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') h.push('USERS', 'GROUPS', 'SERVICEACCOUNTS');
    }
    return h;
  }

  // ------------------------------------------------------------ salida
  function formatObjects(S, objs, f, def, opts) {
    const out = one(f.output);
    if (out === 'yaml' || out === 'json') {
      const pubs = objs.map((o) => publicObj(S, o));
      const doc = opts.single ? pubs[0] : { apiVersion: 'v1', items: pubs, kind: 'List', metadata: { resourceVersion: '' } };
      return out === 'yaml' ? C.toYaml(doc).replace(/\n$/, '') : JSON.stringify(doc, null, 4);
    }
    if (out === 'name') return objs.map((o) => resNameS(S, o)).join('\n');
    if (out && (out.startsWith('jsonpath') || out.startsWith('go-template'))) {
      let tpl = out.replace(/^jsonpath(-as-json)?=?/, '');
      if (out.startsWith('jsonpath-file')) throw new KErr('error: jsonpath-file no soportado en el simulador');
      tpl = tpl.replace(/^'(.*)'$/, '$1');
      const pubs = objs.map((o) => publicObj(S, o));
      const root = opts.single ? pubs[0] : { apiVersion: 'v1', kind: 'List', items: pubs };
      try { return C.jsonpathTemplate(tpl, root); } catch (e) { throw new KErr(e.message.startsWith('error') ? e.message : 'error: error executing jsonpath "' + tpl + '": ' + e.message); }
    }
    if (out && out.startsWith('custom-columns')) {
      const spec = out.replace(/^custom-columns=/, '');
      const cols = spec.split(',').map((c) => { const i = c.indexOf(':'); return { h: c.slice(0, i), p: c.slice(i + 1) }; });
      const rows = objs.map((o) => { const pub = publicObj(S, o); return cols.map((c) => { const v = C.jpEval(c.p.startsWith('.') || c.p.startsWith('{') ? c.p.replace(/^\{|\}$/g, '') : '.' + c.p, pub); return v.length ? v.map(C.jpFormat).join(',') : '<none>'; }); });
      return C.table(cols.map((c) => c.h), rows, { noHeaders: f['no-headers'] });
    }
    const wide = out === 'wide';
    const byKind = {};
    for (const o of objs) (byKind[o.kind] = byKind[o.kind] || []).push(o);
    const kinds = Object.keys(byKind);
    const blocks = [];
    for (const k of kinds) {
      let h = headers(k, wide);
      let rows = byKind[k].map((o) => row(S, o, wide));
      if (opts.allNs && C.defByKind(S, k) && C.defByKind(S, k).namespaced) { h = ['NAMESPACE'].concat(h); rows = rows.map((r, i) => [C.nsOf(byKind[k][i])].concat(r)); }
      if (f['show-labels']) { h = h.concat(['LABELS']); rows = rows.map((r, i) => r.concat([labelsStr(byKind[k][i].metadata.labels)])); }
      if (f['label-columns']) { const lc = String(one(f['label-columns'])).split(','); h = h.concat(lc.map((x) => x.toUpperCase())); rows = rows.map((r, i) => r.concat(lc.map((x) => (byKind[k][i].metadata.labels || {})[x] || ''))); }
      if (kinds.length > 1) rows = rows.map((r, i) => { r[opts.allNs ? 1 : 0] = resNameS(S, byKind[k][i]); return r; });
      blocks.push(C.table(h, rows, { noHeaders: f['no-headers'] }));
    }
    return blocks.join('\n\n');
  }

  function sortBy(S, objs, expr) {
    const e = String(expr).replace(/^\{|\}$/g, '');
    const key = (o) => { const v = C.jpEval(e.startsWith('.') ? e : '.' + e, publicObj(S, o))[0]; return v; };
    return objs.slice().sort((a, b) => {
      const x = key(a); const y = key(b);
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      const qa = String(x == null ? '' : x); const qb = String(y == null ? '' : y);
      if (/^\d+(m|Mi|Gi|Ki)?$/.test(qa) && /^\d+(m|Mi|Gi|Ki)?$/.test(qb)) return (qa.endsWith('m') ? C.parseCpu(qa) : C.parseMem(qa)) - (qb.endsWith('m') ? C.parseCpu(qb) : C.parseMem(qb));
      return qa.localeCompare(qb);
    });
  }

  // ------------------------------------------------------------ get
  function cmdGet(S, a) {
    const f = a.flags;
    if (!a.pos.length) throw new KErr('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.');
    const allNs = !!(f['all-namespaces'] || f.A);
    const ns = nsFlag(S, f);
    let targets;
    if (a.pos[0] === 'all') {
      targets = ['Pod', 'Service', 'DaemonSet', 'Deployment', 'ReplicaSet', 'StatefulSet', 'Job', 'CronJob'].map((k) => ({ def: C.defByKind(S, k), name: null }));
    } else targets = splitTypeName(S, a.pos);
    let objs = [];
    const selector = f.selector ? C.parseSelector(String(one(f.selector))) : null;
    const fsel = f['field-selector'] ? String(one(f['field-selector'])).split(',').map((x) => { const m = x.match(/^([^!=]+)(!=|==|=)(.*)$/); return m && { path: m[1], neg: m[2] === '!=', val: m[3] }; }).filter(Boolean) : null;
    const single = targets.length === 1 && targets[0].name && !f.output?.toString().startsWith('custom');
    for (const t of targets) {
      if (t.name) {
        const o = t.def.kind === 'Endpoints' ? endpointsObj(S, getObj(S, C.defByKind(S, 'Service'), ns, t.name)) : getObj(S, t.def, ns, t.name);
        objs.push(o);
      } else {
        if (t.def.namespaced && !allNs) ensureNs(S, ns);
        let l = listKind(S, t.def, ns, allNs);
        if (selector) l = l.filter((o) => C.matchParsed(o.metadata.labels, selector));
        if (fsel) l = l.filter((o) => fsel.every((c) => { const v = String(C.jpEval('.' + c.path, publicObj(S, o))[0]); return c.neg ? v !== c.val : v === c.val; }));
        objs = objs.concat(l);
      }
    }
    if (f['sort-by']) objs = sortBy(S, objs, one(f['sort-by']));
    else if (!targets.some((t) => t.name)) objs = objs.slice().sort((x, y) => (allNs ? C.nsOf(x).localeCompare(C.nsOf(y)) : 0) || x.metadata.name.localeCompare(y.metadata.name));
    if (!objs.length) {
      if (targets[0].def.namespaced && !allNs) return { out: '', err: 'No resources found in ' + ns + ' namespace.' };
      return { out: '', err: 'No resources found' };
    }
    const outFmt = one(f.output);
    const isSingle = targets.length === 1 && !!targets[0].name && a.pos.length <= 2 && !a.pos[0].includes(',');
    return { out: formatObjects(S, objs, f, targets[0].def, { allNs, single: isSingle && (outFmt === 'yaml' || outFmt === 'json' || (outFmt || '').startsWith('jsonpath')) }) };
  }

  // ------------------------------------------------------------ describe
  function kv(lines, k, v, pad) { lines.push((k + ':').padEnd(pad || 16) + (v === undefined || v === '' ? '<none>' : v)); }
  function describeEvents(S, o) {
    const ev = S.events.filter((e) => e.kind === o.kind && e.name === o.metadata.name && (e.ns === (C.nsOf(o) || 'default') || !C.nsOf(o))).slice(-8);
    if (!ev.length) return 'Events:              <none>';
    return 'Events:\n' + C.table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------']].concat(ev.map((e) => ['  ' + e.type, e.reason, C.age(S, e.time), e.reason === 'Scheduled' || e.reason === 'FailedScheduling' ? 'default-scheduler' : 'kubelet', e.msg])));
  }
  function mapLines(m, indent) { const k = Object.keys(m || {}); return k.length ? k.map((x, i) => (i ? ' '.repeat(indent) : '') + x + '=' + m[x]).join('\n') : '<none>'; }

  function describeContainers(c, st, indent) {
    const pad = ' '.repeat(indent);
    const L = [];
    L.push(pad + c.name + ':');
    L.push(pad + '  Image:          ' + c.image);
    if (c.ports && c.ports.length) L.push(pad + '  Port:           ' + c.ports.map((p) => p.containerPort + '/' + (p.protocol || 'TCP') + (p.name ? ' (' + p.name + ')' : '')).join(', '));
    if (c.command) L.push(pad + '  Command:\n' + c.command.map((x) => pad + '    ' + x).join('\n'));
    if (c.args) L.push(pad + '  Args:\n' + c.args.map((x) => pad + '    ' + x).join('\n'));
    if (st) {
      const s = st.state || {};
      if (s.running) L.push(pad + '  State:          Running\n' + pad + '    Started:      ' + s.running.startedAt);
      else if (s.waiting) L.push(pad + '  State:          Waiting\n' + pad + '    Reason:       ' + s.waiting.reason);
      else if (s.terminated) L.push(pad + '  State:          Terminated\n' + pad + '    Reason:       ' + s.terminated.reason + '\n' + pad + '    Exit Code:    ' + s.terminated.exitCode);
      if (st.lastState && st.lastState.terminated) L.push(pad + '  Last State:     Terminated\n' + pad + '    Reason:       ' + st.lastState.terminated.reason + '\n' + pad + '    Exit Code:    ' + st.lastState.terminated.exitCode);
      L.push(pad + '  Ready:          ' + (st.ready ? 'True' : 'False'));
      L.push(pad + '  Restart Count:  ' + (st.restartCount || 0));
    }
    const r = c.resources || {};
    if (r.limits) L.push(pad + '  Limits:\n' + Object.keys(r.limits).map((k) => pad + '    ' + k + ':  ' + r.limits[k]).join('\n'));
    if (r.requests) L.push(pad + '  Requests:\n' + Object.keys(r.requests).map((k) => pad + '    ' + k + ':  ' + r.requests[k]).join('\n'));
    const env = c.env || [];
    L.push(pad + '  Environment:' + (env.length ? '\n' + env.map((e) => pad + '    ' + e.name + ':  ' + (e.value !== undefined ? e.value : e.valueFrom ? JSON.stringify(e.valueFrom) : '')).join('\n') : '    <none>'));
    const vm = c.volumeMounts || [];
    L.push(pad + '  Mounts:' + (vm.length ? '\n' + vm.map((m) => pad + '    ' + m.mountPath + ' from ' + m.name + (m.readOnly ? ' (ro)' : ' (rw)')).join('\n') : '          <none>'));
    return L.join('\n');
  }

  function describe(S, o) {
    const L = [];
    const md = o.metadata;
    const common = () => {
      kv(L, 'Name', md.name);
      if (C.nsOf(o)) kv(L, 'Namespace', C.nsOf(o));
      kv(L, 'Labels', mapLines(md.labels, 16));
      kv(L, 'Annotations', mapLines(md.annotations, 16));
    };
    switch (o.kind) {
      case 'Pod': {
        kv(L, 'Name', md.name); kv(L, 'Namespace', C.nsOf(o));
        kv(L, 'Priority', o.spec.priority || 0);
        if (o.spec.priorityClassName) kv(L, 'Priority Class Name', o.spec.priorityClassName, 22);
        kv(L, 'Service Account', o.spec.serviceAccountName || 'default');
        kv(L, 'Node', o.spec.nodeName ? o.spec.nodeName + '/' + (o.status.hostIP || '') : '<none>');
        kv(L, 'Start Time', o.status.startTime || '<none>');
        kv(L, 'Labels', mapLines(md.labels, 16)); kv(L, 'Annotations', mapLines(md.annotations, 16));
        kv(L, 'Status', X.podDisplayStatus(o) === 'Completed' ? 'Succeeded' : o.status.phase);
        kv(L, 'IP', o.status.podIP || '');
        if (md.ownerReferences && md.ownerReferences.length) kv(L, 'Controlled By', md.ownerReferences[0].kind + '/' + md.ownerReferences[0].name);
        if (o.spec.initContainers && o.spec.initContainers.length) { L.push('Init Containers:'); for (const c of o.spec.initContainers) L.push(describeContainers(c, (o.status.initContainerStatuses || []).find((s) => s.name === c.name), 2)); }
        L.push('Containers:');
        for (const c of o.spec.containers || []) L.push(describeContainers(c, (o.status.containerStatuses || []).find((s) => s.name === c.name), 2));
        L.push('Conditions:\n  Type              Status\n' + (o.status.conditions || []).map((c) => '  ' + c.type.padEnd(18) + c.status).join('\n'));
        L.push('Volumes:' + ((o.spec.volumes || []).length ? '\n' + o.spec.volumes.map((v) => '  ' + v.name + ':\n    Type:       ' + Object.keys(v).filter((k) => k !== 'name').join(',') + '\n    ' + JSON.stringify(v[Object.keys(v).find((k) => k !== 'name')])).join('\n') : ' <none>'));
        kv(L, 'QoS Class', o.status.qosClass || 'BestEffort', 26);
        kv(L, 'Node-Selectors', selStr(o.spec.nodeSelector), 26);
        kv(L, 'Tolerations', (o.spec.tolerations || []).map((t) => (t.key || '') + (t.operator === 'Exists' ? '' : '=' + (t.value || '')) + ':' + (t.effect || '') + (t.operator === 'Exists' ? ' op=Exists' : '')).join('\n                            ') || '<none>', 26);
        L.push(describeEvents(S, o));
        break;
      }
      case 'Node': {
        kv(L, 'Name', md.name);
        kv(L, 'Roles', Object.keys(md.labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).join(',') || '<none>');
        kv(L, 'Labels', mapLines(md.labels, 20), 20);
        kv(L, 'Annotations', mapLines(md.annotations, 20), 20);
        kv(L, 'CreationTimestamp', md.creationTimestamp, 20);
        kv(L, 'Taints', (o.spec.taints || []).map((t) => t.key + (t.value ? '=' + t.value : '') + ':' + t.effect).join('\n                    ') || '<none>', 20);
        kv(L, 'Unschedulable', String(!!o.spec.unschedulable), 20);
        L.push('Conditions:\n' + C.table(['  Type', 'Status', 'Reason', 'Message'], [['  ----', '------', '------', '-------']].concat((o.status.conditions || []).map((c) => ['  ' + c.type, c.status, c.reason, c.message]))));
        L.push('Addresses:\n  InternalIP:  ' + o.status.addresses[0].address + '\n  Hostname:    ' + md.name);
        L.push('Capacity:\n  cpu:     ' + o.status.capacity.cpu + '\n  memory:  ' + o.status.capacity.memory + '\n  pods:    110');
        L.push('Allocatable:\n  cpu:     ' + o.status.allocatable.cpu + '\n  memory:  ' + o.status.allocatable.memory + '\n  pods:    110');
        L.push('System Info:\n  Kubelet Version:            ' + o.status.nodeInfo.kubeletVersion + '\n  Container Runtime Version:  ' + o.status.nodeInfo.containerRuntimeVersion + '\n  OS Image:                   ' + o.status.nodeInfo.osImage);
        const pods = list(S, 'Pod').filter((p) => p.spec.nodeName === md.name && p.status.phase !== 'Succeeded');
        L.push('Non-terminated Pods:          (' + pods.length + ' in total)\n' + C.table(['  Namespace', 'Name', 'CPU Requests', 'Memory Requests', 'Age'], pods.map((p) => { const r = X.podRequests(p.spec); return ['  ' + C.nsOf(p), p.metadata.name, r.cpu ? r.cpu + 'm' : '0 (0%)', r.mem ? Math.round(r.mem) + 'Mi' : '0 (0%)', C.age(S, p.metadata.creationTimestamp)]; })));
        const u = X.nodeUsage(S, md.name);
        L.push('Allocated resources:\n  Resource           Requests\n  --------           --------\n  cpu                ' + u.cpu + 'm (' + Math.round(u.cpu / C.parseCpu(o.status.allocatable.cpu) * 100) + '%)\n  memory             ' + Math.round(u.mem) + 'Mi (' + Math.round(u.mem / C.parseMem(o.status.allocatable.memory) * 100) + '%)');
        L.push(describeEvents(S, o));
        break;
      }
      case 'Deployment': {
        common();
        kv(L, 'Selector', selStr((o.spec.selector || {}).matchLabels));
        kv(L, 'Replicas', o.spec.replicas + ' desired | ' + (o.status.updatedReplicas || 0) + ' updated | ' + (o.status.replicas || 0) + ' total | ' + (o.status.availableReplicas || 0) + ' available | ' + (o.status.unavailableReplicas || 0) + ' unavailable');
        kv(L, 'StrategyType', (o.spec.strategy || {}).type || 'RollingUpdate');
        L.push('Pod Template:\n  Labels:  ' + selStr(o.spec.template.metadata && o.spec.template.metadata.labels));
        if (o.spec.template.spec.priorityClassName) L.push('  Priority Class Name:  ' + o.spec.template.spec.priorityClassName);
        if (o.spec.template.spec.initContainers) { L.push('  Init Containers:'); for (const c of o.spec.template.spec.initContainers) L.push(describeContainers(c, null, 3)); }
        L.push('  Containers:');
        for (const c of o.spec.template.spec.containers || []) L.push(describeContainers(c, null, 3));
        L.push('NewReplicaSet:   ' + (o._sim && o._sim.activeRS ? o._sim.activeRS + ' (' + (o.status.replicas || 0) + '/' + o.spec.replicas + ' replicas created)' : '<none>'));
        L.push(describeEvents(S, o));
        break;
      }
      case 'Service': {
        common();
        kv(L, 'Selector', selStr(o.spec.selector));
        kv(L, 'Type', o.spec.type || 'ClusterIP');
        kv(L, 'IP', o.spec.clusterIP);
        for (const p of o.spec.ports || []) {
          kv(L, 'Port', (p.name || '<unset>') + '  ' + p.port + '/' + (p.protocol || 'TCP'));
          kv(L, 'TargetPort', (p.targetPort !== undefined ? p.targetPort : p.port) + '/' + (p.protocol || 'TCP'));
          if (p.nodePort) kv(L, 'NodePort', (p.name || '<unset>') + '  ' + p.nodePort + '/' + (p.protocol || 'TCP'));
          const eps = X.svcEndpoints(S, o);
          kv(L, 'Endpoints', eps.map((e) => e.status.podIP + ':' + (typeof p.targetPort === 'number' ? p.targetPort : (X.podPorts(e).find((x) => x.name === p.targetPort) || {}).port || p.port)).join(',') || '<none>');
        }
        L.push(describeEvents(S, o));
        break;
      }
      case 'PersistentVolumeClaim': {
        common();
        kv(L, 'StorageClass', o.spec.storageClassName || '');
        kv(L, 'Status', (o.status || {}).phase || 'Pending');
        kv(L, 'Volume', o.spec.volumeName || '');
        kv(L, 'Capacity', ((o.status || {}).capacity || {}).storage || '');
        kv(L, 'Access Modes', accessShort(o.spec.accessModes));
        kv(L, 'Used By', list(S, 'Pod', C.nsOf(o)).filter((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === md.name)).map((p) => p.metadata.name).join(', ') || '<none>');
        if (o._sim && o._sim.why) L.push('Events:\n  Type     Reason              Age   From                         Message\n  ----     ------              ----  ----                         -------\n  Normal   ' + (/first consumer/.test(o._sim.why) ? 'WaitForFirstConsumer' : 'ProvisioningFailed') + '   5s    persistentvolume-controller  ' + o._sim.why);
        else L.push(describeEvents(S, o));
        break;
      }
      case 'Ingress': {
        common();
        kv(L, 'Ingress Class', o.spec.ingressClassName || '<none>');
        kv(L, 'Address', ((o.status.loadBalancer || {}).ingress || []).map((x) => x.ip).join(','));
        L.push('Rules:\n  Host        Path  Backends\n  ----        ----  --------');
        for (const r of o.spec.rules || []) for (const p of (r.http || {}).paths || []) {
          const svc = find(S, 'Service', C.nsOf(o), p.backend.service.name);
          const eps = svc ? X.svcEndpoints(S, svc).map((e) => e.status.podIP + ':' + (p.backend.service.port.number || p.backend.service.port.name)).join(',') : '<error: services "' + p.backend.service.name + '" not found>';
          L.push('  ' + (r.host || '*').padEnd(12) + (p.path || '/') + '   ' + p.backend.service.name + ':' + (p.backend.service.port.number || p.backend.service.port.name) + ' (' + (eps || '<none>') + ')');
        }
        L.push(describeEvents(S, o));
        break;
      }
      default: {
        common();
        const pub = publicObj(S, o);
        delete pub.metadata; delete pub.apiVersion; delete pub.kind;
        L.push(C.toYaml(pub).split('\n').map((l) => l.replace(/^(\s*)([\w.\-/]+):/, (m, s, k) => s + k.charAt(0).toUpperCase() + k.slice(1) + ':')).join('\n'));
        L.push(describeEvents(S, o));
      }
    }
    return L.join('\n');
  }

  function cmdDescribe(S, a) {
    const f = a.flags;
    const ns = nsFlag(S, f);
    const allNs = !!f['all-namespaces'];
    const targets = splitTypeName(S, a.pos);
    if (!targets.length) throw new KErr('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
    const out = [];
    for (const t of targets) {
      if (t.name) {
        let o = find(S, t.def.kind, t.def.namespaced ? ns : null, t.name);
        if (!o) {
          const pref = listKind(S, t.def, ns, false).filter((x) => x.metadata.name.startsWith(t.name));
          if (!pref.length) throw notFound(t.def, t.name);
          out.push(...pref.map((x) => describe(S, x)));
          continue;
        }
        out.push(describe(S, o));
      } else {
        let l = listKind(S, t.def, ns, allNs);
        if (f.selector) { const s = C.parseSelector(String(one(f.selector))); l = l.filter((o) => C.matchParsed(o.metadata.labels, s)); }
        out.push(...l.map((o) => describe(S, o)));
      }
    }
    return { out: out.join('\n\n\n') };
  }

  // ------------------------------------------------------------ validación y aplicación de manifiestos
  const API_OK = {
    Pod: ['v1'], Service: ['v1'], ConfigMap: ['v1'], Secret: ['v1'], ServiceAccount: ['v1'], Namespace: ['v1'], PersistentVolume: ['v1'], PersistentVolumeClaim: ['v1'], ResourceQuota: ['v1'], LimitRange: ['v1'],
    Deployment: ['apps/v1'], DaemonSet: ['apps/v1'], StatefulSet: ['apps/v1'], ReplicaSet: ['apps/v1'], Job: ['batch/v1'], CronJob: ['batch/v1'],
    HorizontalPodAutoscaler: ['autoscaling/v2', 'autoscaling/v1'], Ingress: ['networking.k8s.io/v1'], IngressClass: ['networking.k8s.io/v1'], NetworkPolicy: ['networking.k8s.io/v1'],
    Role: ['rbac.authorization.k8s.io/v1'], RoleBinding: ['rbac.authorization.k8s.io/v1'], ClusterRole: ['rbac.authorization.k8s.io/v1'], ClusterRoleBinding: ['rbac.authorization.k8s.io/v1'],
    StorageClass: ['storage.k8s.io/v1'], PriorityClass: ['scheduling.k8s.io/v1'], CustomResourceDefinition: ['apiextensions.k8s.io/v1'], PodDisruptionBudget: ['policy/v1'],
    Gateway: ['gateway.networking.k8s.io/v1', 'gateway.networking.k8s.io/v1beta1'], GatewayClass: ['gateway.networking.k8s.io/v1'], HTTPRoute: ['gateway.networking.k8s.io/v1', 'gateway.networking.k8s.io/v1beta1'], CertificateSigningRequest: ['certificates.k8s.io/v1'],
  };

  function validate(S, o, src) {
    if (!o || typeof o !== 'object') throw new KErr('error: error validating "' + src + '": error validating data: invalid object');
    if (!o.kind) throw new KErr('error: error validating "' + src + '": error validating data: kind not set');
    if (!o.apiVersion) throw new KErr('error: error validating "' + src + '": error validating data: apiVersion not set');
    const def = C.defByKind(S, o.kind);
    if (!def) {
      const ci = C.KIND_DEFS.find((d) => d.kind.toLowerCase() === String(o.kind).toLowerCase());
      throw new KErr('error: resource mapping not found for name: "' + ((o.metadata || {}).name || '') + '" namespace: "" from "' + src + '": no matches for kind "' + o.kind + '" in version "' + o.apiVersion + '"\nensure CRDs are installed first' + (ci ? '\n(pista: ¿quisiste decir kind: ' + ci.kind + '?)' : ''));
    }
    const okv = API_OK[o.kind];
    if (okv && !okv.includes(o.apiVersion)) throw new KErr('error: resource mapping not found for name: "' + ((o.metadata || {}).name || '') + '" namespace: "" from "' + src + '": no matches for kind "' + o.kind + '" in version "' + o.apiVersion + '"\nensure CRDs are installed first');
    if (!okv && def.crd && o.apiVersion.split('/')[0] !== def.group) throw new KErr('error: resource mapping not found: no matches for kind "' + o.kind + '" in version "' + o.apiVersion + '"');
    if (!o.metadata || !o.metadata.name) {
      if (o.metadata && o.metadata.generateName) o.metadata.name = o.metadata.generateName + C.rand(5);
      else throw new KErr('error: error when creating "' + src + '": ' + o.kind + ' in version "' + o.apiVersion.split('/').pop() + '" cannot be handled as a ' + o.kind + ': resource name may not be empty');
    }
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(o.metadata.name)) throw new KErr('The ' + o.kind + ' "' + o.metadata.name + '" is invalid: metadata.name: Invalid value: "' + o.metadata.name + '": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, \'-\' or \'.\'');
    const spec = o.spec || {};
    const inv = (field, msg) => new KErr('The ' + o.kind + ' "' + o.metadata.name + '" is invalid: ' + field + ': ' + msg);
    const checkPodSpec = (ps, path) => {
      if (!ps || !Array.isArray(ps.containers) || !ps.containers.length) throw inv(path + '.containers', 'Required value');
      const names = new Set();
      for (const [i, c] of ps.containers.concat(ps.initContainers || []).entries()) {
        if (!c.name) throw inv(path + '.containers[' + i + '].name', 'Required value');
        if (!c.image) throw inv(path + '.containers[' + i + '].image', 'Required value');
        if (names.has(c.name)) throw inv(path + '.containers[' + i + '].name', 'Duplicate value: "' + c.name + '"');
        names.add(c.name);
        for (const m of c.volumeMounts || []) if (!(ps.volumes || []).some((v) => v.name === m.name)) throw inv(path + '.containers[' + i + '].volumeMounts[0].name', 'Not found: "' + m.name + '"');
        for (const p of c.ports || []) if (typeof p.containerPort !== 'number') throw inv(path + '.containers[' + i + '].ports[0].containerPort', 'Required value');
        if (c.command && !Array.isArray(c.command)) throw new KErr('Error from server (BadRequest): error when creating "' + src + '": ' + o.kind + ' in version "v1" cannot be handled as a ' + o.kind + ': json: cannot unmarshal string into Go struct field Container.spec.containers.command of type []string');
      }
      if (ps.nodeSelector) for (const k of Object.keys(ps.nodeSelector)) if (typeof ps.nodeSelector[k] !== 'string') ps.nodeSelector[k] = String(ps.nodeSelector[k]);
      if (ps.priorityClassName && !find(S, 'PriorityClass', null, ps.priorityClassName)) throw new KErr('Error from server (Forbidden): error when creating "' + src + '": pods "' + o.metadata.name + '" is forbidden: no PriorityClass with name ' + ps.priorityClassName + ' was found');
    };
    switch (o.kind) {
      case 'Pod': checkPodSpec(spec, 'spec'); break;
      case 'Deployment': case 'DaemonSet': case 'StatefulSet': case 'ReplicaSet': {
        if (!spec.selector) throw inv('spec.selector', 'Required value');
        const tl = (spec.template && spec.template.metadata && spec.template.metadata.labels) || {};
        if (!C.matchLabelSelector(tl, spec.selector)) throw inv('spec.template.metadata.labels', 'Invalid value: ' + JSON.stringify(tl) + ': `selector` does not match template `labels`');
        checkPodSpec(spec.template && spec.template.spec, 'spec.template.spec');
        const ps = spec.template.spec;
        if (ps.priorityClassName && !find(S, 'PriorityClass', null, ps.priorityClassName)) { /* se valida al crear pods */ }
        break;
      }
      case 'Job': checkPodSpec(spec.template && spec.template.spec, 'spec.template.spec'); if (!['Never', 'OnFailure'].includes(spec.template.spec.restartPolicy)) throw inv('spec.template.spec.restartPolicy', 'Required value: valid values: "OnFailure", "Never"'); break;
      case 'CronJob': if (!spec.schedule) throw inv('spec.schedule', 'Required value'); checkPodSpec(spec.jobTemplate && spec.jobTemplate.spec && spec.jobTemplate.spec.template && spec.jobTemplate.spec.template.spec, 'spec.jobTemplate.spec.template.spec'); break;
      case 'Service': {
        if (!spec.ports || !spec.ports.length) { if (spec.clusterIP !== 'None') throw inv('spec.ports', 'Required value'); }
        for (const p of spec.ports || []) { if (typeof p.port !== 'number') throw inv('spec.ports[0].port', 'Required value'); if (p.nodePort && (p.nodePort < 30000 || p.nodePort > 32767)) throw inv('spec.ports[0].nodePort', 'Invalid value: ' + p.nodePort + ': provided port is not in the valid range. The range of valid ports is 30000-32767'); if (spec.ports.length > 1 && !p.name) throw inv('spec.ports[1].name', 'Required value'); }
        if (spec.type && !['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(spec.type)) throw inv('spec.type', 'Unsupported value: "' + spec.type + '": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"');
        break;
      }
      case 'PersistentVolume': {
        if (!spec.capacity || !spec.capacity.storage) throw inv('spec.capacity', 'Required value');
        if (!spec.accessModes || !spec.accessModes.length) throw inv('spec.accessModes', 'Required value');
        for (const m of spec.accessModes) if (!['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].includes(m)) throw inv('spec.accessModes', 'Unsupported value: "' + m + '"');
        if (!['hostPath', 'nfs', 'local', 'csi', 'iscsi', 'fc', 'awsElasticBlockStore', 'gcePersistentDisk'].some((k) => spec[k])) throw inv('spec', 'Required value: must specify a volume type');
        if (spec.local && !spec.nodeAffinity) throw inv('spec.nodeAffinity', 'Required value: Local volume requires node affinity');
        break;
      }
      case 'PersistentVolumeClaim': {
        if (!spec.accessModes || !spec.accessModes.length) throw inv('spec.accessModes', 'Required value: at least 1 access mode is required');
        if (!spec.resources || !spec.resources.requests || !spec.resources.requests.storage) throw inv('spec.resources[storage]', 'Required value');
        break;
      }
      case 'NetworkPolicy': if (!o.spec || o.spec.podSelector === undefined) throw inv('spec.podSelector', 'Required value'); break;
      case 'Ingress': {
        for (const r of spec.rules || []) for (const p of (r.http || {}).paths || []) {
          if (!p.pathType) throw inv('spec.rules[0].http.paths[0].pathType', 'Required value: pathType must be specified');
          if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(p.pathType)) throw inv('spec.rules[0].http.paths[0].pathType', 'Unsupported value: "' + p.pathType + '"');
          if (!p.backend || !p.backend.service || !p.backend.service.name) throw inv('spec.rules[0].http.paths[0].backend', 'Invalid value: must specify service (networking.k8s.io/v1 usa backend.service.name / backend.service.port.number)');
          if (!p.backend.service.port || (p.backend.service.port.number === undefined && !p.backend.service.port.name)) throw inv('spec.rules[0].http.paths[0].backend.service.port', 'Invalid value: port name or number is required');
        }
        break;
      }
      case 'RoleBinding': case 'ClusterRoleBinding': if (!o.roleRef || !o.roleRef.name || !o.roleRef.kind) throw inv('roleRef', 'Required value'); if (o.kind === 'ClusterRoleBinding' && o.roleRef.kind === 'Role') throw inv('roleRef.kind', 'Unsupported value: "Role": supported values: "ClusterRole"'); break;
      case 'StorageClass': if (!o.provisioner) throw inv('provisioner', 'Required value'); break;
      case 'PriorityClass': if (typeof o.value !== 'number') throw inv('value', 'Required value'); if (o.value > 1000000000) throw inv('value', 'Forbidden: maximum allowed value of a user defined priority is 1000000000'); if (o.globalDefault && list(S, 'PriorityClass').some((p) => p.globalDefault && p.metadata.name !== o.metadata.name)) throw inv('globalDefault', 'Invalid value: true: globalDefault ya está definido en otra PriorityClass'); break;
      case 'HorizontalPodAutoscaler': if (!spec.scaleTargetRef || !spec.scaleTargetRef.name) throw inv('spec.scaleTargetRef', 'Required value'); if (!spec.maxReplicas) throw inv('spec.maxReplicas', 'Required value'); break;
      case 'HTTPRoute': for (const r of spec.rules || []) for (const b of r.backendRefs || []) if (!b.port) throw inv('spec.rules[0].backendRefs[0]', 'Invalid value: "object": Must have port for Service reference'); break;
      default: break;
    }
  }

  const POD_MUTABLE = (oldSpec, newSpec) => {
    const a = clone(oldSpec); const b = clone(newSpec);
    delete a.nodeName; delete b.nodeName;
    for (const x of [a, b]) {
      for (const c of (x.containers || []).concat(x.initContainers || [])) { delete c.image; delete c.terminationMessagePath; delete c.terminationMessagePolicy; delete c.imagePullPolicy; }
      delete x.activeDeadlineSeconds; delete x.tolerations; delete x.terminationGracePeriodSeconds; delete x.dnsPolicy; delete x.restartPolicy; delete x.schedulerName; delete x.securityContext; delete x.serviceAccount; delete x.enableServiceLinks; delete x.preemptionPolicy; delete x.priority;
      if (x.serviceAccountName === 'default') delete x.serviceAccountName;
    }
    return C.stable(a) === C.stable(b);
  };

  function admission(S, o, old) {
    if (o.kind === 'Pod' || (o.spec && o.spec.template && o.spec.template.spec)) {
      const ps = o.kind === 'Pod' ? o.spec : o.spec.template.spec;
      if (ps.priorityClassName) {
        const pc = find(S, 'PriorityClass', null, ps.priorityClassName);
        if (pc && o.kind === 'Pod') ps.priority = pc.value;
      }
      // LimitRange
      const lr = list(S, 'LimitRange', C.nsOf(o))[0];
      if (lr && o.kind === 'Pod') {
        const lim = (lr.spec.limits || []).find((l) => l.type === 'Container') || {};
        for (const c of ps.containers || []) {
          c.resources = c.resources || {};
          if (lim.defaultRequest && !c.resources.requests) c.resources.requests = clone(lim.defaultRequest);
          if (lim.default && !c.resources.limits) c.resources.limits = clone(lim.default);
          if (lim.max && c.resources.limits && lim.max.cpu && C.parseCpu(c.resources.limits.cpu) > C.parseCpu(lim.max.cpu)) throw new KErr('Error from server (Forbidden): pods "' + o.metadata.name + '" is forbidden: maximum cpu usage per Container is ' + lim.max.cpu + ', but limit is ' + c.resources.limits.cpu);
        }
      }
      // ResourceQuota
      const rq = list(S, 'ResourceQuota', C.nsOf(o))[0];
      if (rq && o.kind === 'Pod' && !old) {
        const hard = rq.spec.hard || {};
        const pods = list(S, 'Pod', C.nsOf(o)).filter((p) => p.status.phase !== 'Succeeded');
        if (hard.pods && pods.length + 1 > +hard.pods) throw new KErr('Error from server (Forbidden): pods "' + o.metadata.name + '" is forbidden: exceeded quota: ' + rq.metadata.name + ', requested: pods=1, used: pods=' + pods.length + ', limited: pods=' + hard.pods);
        if ((hard['requests.cpu'] || hard['limits.cpu']) && (ps.containers || []).some((c) => !c.resources || !(c.resources.requests || c.resources.limits))) throw new KErr('Error from server (Forbidden): pods "' + o.metadata.name + '" is forbidden: failed quota: ' + rq.metadata.name + ': must specify limits.cpu for: ' + ps.containers[0].name + '; limits.memory for: ' + ps.containers[0].name);
      }
    }
    if (old && o.kind === 'Pod' && !POD_MUTABLE(old.spec, o.spec)) {
      throw new KErr('The Pod "' + o.metadata.name + '" is invalid: spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`,`spec.initContainers[*].image`,`spec.activeDeadlineSeconds`,`spec.tolerations` (only additions to existing tolerations),`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)', 'PODIMMUTABLE');
    }
    if (old && o.kind === 'ConfigMap' && old.immutable && (C.stable(old.data) !== C.stable(o.data) || o.immutable === false)) {
      throw new KErr('The ConfigMap "' + o.metadata.name + '" is invalid: data: Forbidden: field is immutable when `immutable` is set');
    }
    if (old && o.kind === 'Secret' && old.immutable && C.stable(old.data) !== C.stable(o.data)) throw new KErr('The Secret "' + o.metadata.name + '" is invalid: data: Forbidden: field is immutable when `immutable` is set');
    if (old && o.kind === 'PersistentVolumeClaim') {
      const a = C.parseStorage(old.spec.resources.requests.storage); const b = C.parseStorage(o.spec.resources.requests.storage);
      if (b < a) throw new KErr('The PersistentVolumeClaim "' + o.metadata.name + '" is invalid: spec.resources.requests.storage: Forbidden: field can not be less than status.capacity');
      if (b > a) {
        const sc = find(S, 'StorageClass', null, o.spec.storageClassName || '');
        if (!sc || !sc.allowVolumeExpansion) throw new KErr('Error from server (Forbidden): persistentvolumeclaims "' + o.metadata.name + '" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize');
        if (o.status && o.status.phase === 'Bound') { o.status.capacity = { storage: o.spec.resources.requests.storage }; const pv = find(S, 'PersistentVolume', null, o.spec.volumeName); if (pv) pv.spec.capacity.storage = o.spec.resources.requests.storage; }
      }
      const imm = clone(old.spec); const now = clone(o.spec);
      delete imm.resources; delete now.resources; delete imm.volumeName; delete now.volumeName; delete imm.storageClassName; delete now.storageClassName;
      if (C.stable(imm) !== C.stable(now)) throw new KErr('The PersistentVolumeClaim "' + o.metadata.name + '" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims');
    }
    if (old && (o.kind === 'Deployment' || o.kind === 'StatefulSet' || o.kind === 'DaemonSet') && C.stable(old.spec.selector) !== C.stable(o.spec.selector)) {
      throw new KErr('The ' + o.kind + ' "' + o.metadata.name + '" is invalid: spec.selector: Invalid value: ' + JSON.stringify(o.spec.selector) + ': field is immutable');
    }
    if (old && o.kind === 'Service' && old.spec.clusterIP && o.spec.clusterIP === undefined) o.spec.clusterIP = old.spec.clusterIP;
    if (old && (o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding') && C.stable(old.roleRef) !== C.stable(o.roleRef)) throw new KErr('The ' + o.kind + ' "' + o.metadata.name + '" is invalid: roleRef: Invalid value: cannot change roleRef');
    if (old && o.kind === 'StorageClass' && (old.provisioner !== o.provisioner || (old.volumeBindingMode || 'Immediate') !== (o.volumeBindingMode || 'Immediate'))) throw new KErr('The StorageClass "' + o.metadata.name + '" is invalid: parameters: Forbidden: updates to parameters/provisioner/volumeBindingMode are forbidden.');
  }

  function normalize(S, o) {
    if (o.kind === 'Secret') {
      if (o.stringData) { o.data = o.data || {}; for (const k of Object.keys(o.stringData)) o.data[k] = b64(String(o.stringData[k])); delete o.stringData; }
      if (!o.type) o.type = 'Opaque';
    }
    if (o.kind === 'Service') { o.spec.type = o.spec.type || 'ClusterIP'; for (const p of o.spec.ports || []) { p.protocol = p.protocol || 'TCP'; if (p.targetPort === undefined) p.targetPort = p.port; } }
    if (o.kind === 'PersistentVolume') { o.spec.persistentVolumeReclaimPolicy = o.spec.persistentVolumeReclaimPolicy || 'Retain'; o.spec.volumeMode = o.spec.volumeMode || 'Filesystem'; o.status = o.status || { phase: 'Available' }; }
    if (o.kind === 'PersistentVolumeClaim') { o.spec.volumeMode = o.spec.volumeMode || 'Filesystem'; o.status = o.status || { phase: 'Pending' }; }
    if (o.kind === 'StorageClass') { o.reclaimPolicy = o.reclaimPolicy || 'Delete'; o.volumeBindingMode = o.volumeBindingMode || 'Immediate'; }
    if (o.kind === 'Namespace') { o.metadata.labels = Object.assign({}, o.metadata.labels, { 'kubernetes.io/metadata.name': o.metadata.name }); o.status = { phase: 'Active' }; }
    if (o.kind === 'Pod') { o.spec.restartPolicy = o.spec.restartPolicy || 'Always'; o.status = o.status || {}; if (o.spec.serviceAccountName === undefined) o.spec.serviceAccountName = 'default'; }
    if (o.kind === 'Deployment') { if (o.spec.replicas == null) o.spec.replicas = 1; o.spec.strategy = o.spec.strategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } }; o.status = o.status || {}; }
    if (['DaemonSet', 'StatefulSet', 'Job', 'CronJob', 'ReplicaSet', 'HorizontalPodAutoscaler'].includes(o.kind)) o.status = o.status || {};
    if (o.kind === 'PriorityClass') o.preemptionPolicy = o.preemptionPolicy || 'PreemptLowerPriority';
    if (o.kind === 'CustomResourceDefinition' && o.spec && o.spec.names && !o.metadata.name) o.metadata.name = o.spec.names.plural + '.' + o.spec.group;
    return o;
  }

  function b64(s) { return typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'); }
  function unb64(s) { try { return typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8'); } catch (e) { return null; } }

  function applyObject(S, o, mode, f, src) {
    validate(S, o, src || 'STDIN');
    const def = C.defByKind(S, o.kind);
    if (def.namespaced) {
      const flagNs = one(f.namespace);
      if (o.metadata.namespace && flagNs && o.metadata.namespace !== flagNs) throw new KErr('error: the namespace from the provided object "' + o.metadata.namespace + '" does not match the namespace "' + flagNs + '". You must pass \'--namespace=' + o.metadata.namespace + '\' to perform this operation.');
      o.metadata.namespace = o.metadata.namespace || flagNs || S.defaultNs || 'default';
      ensureNs(S, o.metadata.namespace);
    }
    normalize(S, o);
    const old = find(S, o.kind, def.namespaced ? o.metadata.namespace : null, o.metadata.name);
    const dr = dryRun(f);
    const label = resNameS(S, o);
    if (mode === 'create' && old) throw new KErr('Error from server (AlreadyExists): error when creating "' + (src || 'STDIN') + '": ' + (def.group ? def.plural + '.' + def.group : def.plural) + ' "' + o.metadata.name + '" already exists', 'ALREADY');
    if (mode === 'replace' && !old) throw new KErr('Error from server (NotFound): error when replacing "' + (src || 'STDIN') + '": ' + def.plural + ' "' + o.metadata.name + '" not found');
    if (old && mode !== 'create') {
      if (dr) return label + ' configured (dry run)';
      admission(S, o, old);
      if (o.kind === 'Pod') { o.spec.nodeName = o.spec.nodeName || old.spec.nodeName; o.status = old.status; }
      if (o.kind === 'Service' && old.spec.ports) for (const p of o.spec.ports || []) { const op = old.spec.ports.find((x) => x.port === p.port); if (op && op.nodePort && !p.nodePort && o.spec.type !== 'ClusterIP') p.nodePort = op.nodePort; }
      if (o.kind === 'PersistentVolumeClaim') { o.spec.volumeName = o.spec.volumeName || old.spec.volumeName; o.status = o.status && o.status.capacity ? o.status : old.status; }
      if (o.kind === 'PersistentVolume') { o.spec.claimRef = o.spec.claimRef || old.spec.claimRef; o.status = old.status; }
      const same = C.stable(C.toPublic(Object.assign({}, old, { metadata: undefined, status: undefined }))) === C.stable(C.toPublic(Object.assign({}, o, { metadata: undefined, status: undefined }))) && C.stable(old.metadata.labels) === C.stable(o.metadata.labels) && C.stable(old.metadata.annotations) === C.stable(o.metadata.annotations);
      put(S, o);
      return label + (mode === 'replace' ? ' replaced' : same ? ' unchanged' : ' configured');
    }
    if (dr) return label + ' created (' + dr + ' dry run)';
    delete o.metadata.uid; delete o.metadata.resourceVersion; delete o.metadata.creationTimestamp; delete o.metadata.generation; delete o.metadata.managedFields;
    if (o.kind === 'Pod' && o.status) { delete o.status.podIP; delete o.status.startTime; }
    if (o.kind === 'PersistentVolumeClaim') { o.status = { phase: 'Pending' }; if (!o.spec.volumeName || !find(S, 'PersistentVolume', null, o.spec.volumeName)) delete o.spec.volumeName; }
    admission(S, o, null);
    put(S, o);
    return label + ' created';
  }

  function readManifestSource(S, ctx, fname) {
    if (fname === '-') return { text: ctx.stdin || '', src: 'STDIN' };
    if (/^https?:\/\//.test(fname)) {
      const r = CKA.remote && CKA.remote[fname];
      if (!r) throw new KErr('error: unable to read URL "' + fname + '", server reported 404 Not Found, status code=404\n(en el simulador solo existen las URL que aparecen en el enunciado)');
      const text = typeof r === 'function' ? r(S) : typeof r === 'object' ? r.text : r;
      return { text, src: fname, createOnly: typeof r === 'object' && r.createOnly };
    }
    const p = X.norm(fname, S.cwd);
    if (X.fsIsDir(S, S.host, p)) {
      const files = X.fsList(S, S.host, p).filter((e) => !e.dir && /\.(ya?ml|json)$/.test(e.name));
      return { text: files.map((e) => X.fsRead(S, S.host, p + '/' + e.name)).join('\n---\n'), src: p };
    }
    const t = X.fsRead(S, S.host, p);
    if (t == null) throw new KErr('error: the path "' + fname + '" does not exist');
    if (!X.canRead(S, p)) throw new KErr('error: open ' + p + ': permission denied');
    return { text: t, src: fname };
  }

  function parseDocs(text, src) {
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) { const j = JSON.parse(trimmed); return j.kind === 'List' ? j.items : [j]; }
      const docs = C.parseYamlDocs(text);
      const out = [];
      for (const d of docs) { if (d && d.kind === 'List' && Array.isArray(d.items)) out.push(...d.items); else out.push(d); }
      return out;
    } catch (e) {
      const m = String(e.message || e);
      throw new KErr('error: error parsing ' + src + ': error converting YAML to JSON: yaml: ' + m.split('\n')[0] + '\n(pista: revisa la indentación — YAML usa espacios, nunca tabuladores, y los elementos de una lista van con "- ")', 'YAMLERR');
    }
  }

  function cmdApplyLike(S, a, ctx, mode) {
    const f = a.flags;
    if (f.kustomize) return applyKustomize(S, one(f.kustomize), f, mode, ctx);
    const files = many(f.filename);
    if (!files.length) throw new KErr('error: must specify one of -f and -k');
    const out = [];
    for (const fn of files) {
      const { text, src, createOnly } = readManifestSource(S, ctx, fn);
      const docs = parseDocs(text, src).filter(Boolean);
      if (!docs.length) throw new KErr('error: no objects passed to ' + mode);
      if (createOnly && mode === 'apply' && !f['server-side']) {
        const crd = docs.find((d) => d.kind === 'CustomResourceDefinition');
        throw new KErr('The CustomResourceDefinition "' + (crd ? crd.metadata.name : 'installations.operator.tigera.io') + '" is invalid: metadata.annotations: Too long: may not be more than 262144 bytes', 'TOOLONG');
      }
      for (const d of docs) {
        const o = clone(d);
        if (mode === 'replace' && f.force) {
          const def = C.defByKind(S, o.kind);
          const ns = def && def.namespaced ? (o.metadata.namespace || one(f.namespace) || S.defaultNs || 'default') : null;
          const old = def && find(S, o.kind, ns, o.metadata && o.metadata.name);
          if (old) { remove(S, old); out.push(resNameS(S, old) + ' deleted'); }
          out.push(applyObject(S, o, 'create', f, src).replace(' created', ' replaced'));
          continue;
        }
        out.push(applyObject(S, o, mode, f, src));
      }
    }
    return { out: out.join('\n') };
  }

  function kustomizeBuild(S, dir, depth) {
    depth = depth || 0;
    if (depth > 5) throw new KErr('error: demasiados niveles de bases en kustomize');
    const base = X.norm(dir, S.cwd);
    const kf = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'].map((n) => base + '/' + n).find((p) => X.fsRead(S, S.host, p) != null);
    if (!kf) throw new KErr('error: unable to find one of \'kustomization.yaml\', \'kustomization.yml\' or \'Kustomization\' in directory \'' + base + '\'');
    let k;
    try { k = C.yaml.load(X.fsRead(S, S.host, kf)); } catch (e) { throw new KErr('error: ' + e.message); }
    let objs = [];
    for (const r of (k.resources || []).concat(k.bases || [])) {
      const p = X.norm(r, base);
      if (X.fsIsDir(S, S.host, p)) objs = objs.concat(kustomizeBuild(S, p, depth + 1));
      else {
        const t = X.fsRead(S, S.host, p);
        if (t == null) throw new KErr('error: accumulating resources: accumulation err=\'accumulating resources from \'' + r + '\': open ' + p + ': no such file or directory\'');
        objs = objs.concat(parseDocs(t, p).filter(Boolean));
      }
    }
    for (const g of k.configMapGenerator || []) {
      const data = {};
      for (const l of g.literals || []) { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
      objs.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: g.name + (k.generatorOptions && k.generatorOptions.disableNameSuffixHash ? '' : '-' + C.hashStr(C.stable(data), 10)) }, data });
    }
    for (const o of objs) {
      if (k.namespace && C.defByKind(S, o.kind) && C.defByKind(S, o.kind).namespaced) { o.metadata = o.metadata || {}; o.metadata.namespace = k.namespace; }
      if (k.namePrefix) o.metadata.name = k.namePrefix + o.metadata.name;
      if (k.nameSuffix) o.metadata.name = o.metadata.name + k.nameSuffix;
      const cl = k.labels ? Object.assign({}, ...k.labels.map((l) => l.pairs || {})) : k.commonLabels;
      if (cl) {
        o.metadata.labels = Object.assign({}, o.metadata.labels, cl);
        const includeSel = k.commonLabels || (k.labels || []).some((l) => l.includeSelectors);
        if (o.spec && o.spec.template) { o.spec.template.metadata = o.spec.template.metadata || {}; o.spec.template.metadata.labels = Object.assign({}, o.spec.template.metadata.labels, cl); if (includeSel && o.spec.selector) o.spec.selector.matchLabels = Object.assign({}, o.spec.selector.matchLabels, cl); }
        if (o.kind === 'Service' && includeSel) o.spec.selector = Object.assign({}, o.spec.selector, cl);
      }
      if (k.commonAnnotations) o.metadata.annotations = Object.assign({}, o.metadata.annotations, k.commonAnnotations);
      for (const im of k.images || []) {
        const cs = o.spec && o.spec.template && o.spec.template.spec ? o.spec.template.spec.containers : o.kind === 'Pod' ? o.spec.containers : [];
        for (const c of cs || []) {
          const repo = c.image.split(':')[0];
          if (repo === im.name) c.image = (im.newName || repo) + (im.digest ? '@' + im.digest : ':' + (im.newTag || c.image.split(':')[1] || 'latest'));
        }
      }
      for (const rp of k.replicas || []) if (o.metadata.name === rp.name && o.spec) o.spec.replicas = rp.count;
    }
    for (const pt of k.patches || k.patchesStrategicMerge || []) {
      let patch = null; let target = null;
      if (typeof pt === 'string') patch = C.yaml.load(X.fsRead(S, S.host, X.norm(pt, base)) || '');
      else if (pt.path) patch = C.yaml.load(X.fsRead(S, S.host, X.norm(pt.path, base)) || '');
      else if (pt.patch) patch = C.yaml.load(pt.patch);
      if (pt && pt.target) target = pt.target;
      if (!patch) continue;
      if (Array.isArray(patch)) {
        for (const o of objs) if (target && o.kind === target.kind && (!target.name || o.metadata.name === target.name)) jsonPatch(o, patch);
      } else {
        for (const o of objs) if (o.kind === patch.kind && o.metadata.name === (patch.metadata || {}).name) strategicMerge(o, patch);
      }
    }
    return objs;
  }

  function applyKustomize(S, dir, f, mode, ctx) {
    const objs = kustomizeBuild(S, dir);
    const out = objs.map((o) => applyObject(S, clone(o), mode === 'create' ? 'create' : 'apply', f, dir));
    return { out: out.join('\n') };
  }

  // ------------------------------------------------------------ merge / patch
  function mergePatch(t, p) {
    if (p === null) return undefined;
    if (typeof p !== 'object' || Array.isArray(p)) return clone(p);
    const r = t && typeof t === 'object' && !Array.isArray(t) ? clone(t) : {};
    for (const k of Object.keys(p)) { if (p[k] === null) delete r[k]; else r[k] = mergePatch(r[k], p[k]); }
    return r;
  }
  function strategicMerge(t, p) {
    const mergeKeys = ['name', 'containerPort', 'mountPath', 'port', 'key', 'type'];
    const walk = (a, b) => {
      for (const k of Object.keys(b)) {
        const bv = b[k];
        if (bv === null) { delete a[k]; continue; }
        if (Array.isArray(bv) && Array.isArray(a[k]) && bv.length && typeof bv[0] === 'object') {
          const mk = mergeKeys.find((m) => bv[0][m] !== undefined);
          if (mk && ['containers', 'initContainers', 'volumes', 'volumeMounts', 'ports', 'env', 'tolerations', 'imagePullSecrets'].includes(k)) {
            for (const item of bv) {
              const ex = a[k].find((x) => x[mk] === item[mk]);
              if (ex) walk(ex, item); else a[k].push(clone(item));
            }
            continue;
          }
        }
        if (bv && typeof bv === 'object' && !Array.isArray(bv) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) walk(a[k], bv);
        else a[k] = clone(bv);
      }
    };
    walk(t, p);
    return t;
  }
  function jsonPatch(t, ops) {
    const ptr = (path) => path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    for (const op of ops) {
      const parts = ptr(op.path);
      const last = parts.pop();
      let cur = t;
      for (const p of parts) { if (cur[p] === undefined) cur[p] = /^\d+$/.test(last) ? [] : {}; cur = cur[p]; }
      if (op.op === 'add') { if (Array.isArray(cur)) { if (last === '-') cur.push(clone(op.value)); else cur.splice(+last, 0, clone(op.value)); } else cur[last] = clone(op.value); }
      else if (op.op === 'replace') { cur[last] = clone(op.value); }
      else if (op.op === 'remove') { if (Array.isArray(cur)) cur.splice(+last, 1); else delete cur[last]; }
      else throw new KErr('error: operación JSON patch no soportada: ' + op.op);
    }
    return t;
  }

  function cmdPatch(S, a) {
    const f = a.flags;
    const t = splitTypeName(S, a.pos)[0];
    if (!t || !t.name) throw new KErr('error: resource(s) were provided, but no name was specified');
    const ns = nsFlag(S, f);
    const o = getObj(S, t.def, ns, t.name);
    let p = one(f.patch) || one(f.p);
    if (f['patch-file']) p = X.fsRead(S, S.host, X.norm(one(f['patch-file']), S.cwd));
    if (!p) throw new KErr('error: must specify --patch or --patch-file containing the contents of the patch');
    let body;
    try { body = /^\s*[[{]/.test(p) ? JSON.parse(p) : C.yaml.load(p); } catch (e) { throw new KErr('error: unable to parse "' + p + '": ' + e.message); }
    const type = one(f.type) || 'strategic';
    const n = clone(o);
    let res;
    if (type === 'json') res = jsonPatch(n, body);
    else if (type === 'merge') res = mergePatch(n, body);
    else res = strategicMerge(n, body);
    res._sim = o._sim;
    const before = C.stable(C.toPublic(o));
    validate(S, res, 'patch');
    admission(S, res, o);
    put(S, res);
    const changed = before !== C.stable(C.toPublic(res));
    return { out: resNameS(S, res) + (changed ? ' patched' : ' patched (no change)') };
  }

  // ------------------------------------------------------------ create
  function metaFlags(f) {
    const labels = {};
    if (f.labels) for (const kvs of String(one(f.labels)).split(',')) { const [k, v] = kvs.split('='); labels[k] = v || ''; }
    return labels;
  }

  function outputOrCreate(S, o, f, extraMsg) {
    const outFmt = one(f.output);
    const dr = dryRun(f);
    if (dr && outFmt) {
      const pub = C.orderManifest(C.toPublic(normalizeForDisplay(clone(o))));
      return { out: outFmt === 'json' ? JSON.stringify(pub, null, 2) : outFmt === 'name' ? resNameS(S, o) : C.toYaml(pub).replace(/\n$/, '') };
    }
    const r = applyObject(S, o, 'create', f, 'STDIN');
    if (outFmt && !dr) { const created = find(S, o.kind, C.nsOf(o) || null, o.metadata.name); return { out: formatObjects(S, [created], f, null, { single: true }) }; }
    return { out: r + (extraMsg || '') };
  }
  function normalizeForDisplay(o) {
    o.metadata = Object.assign({ creationTimestamp: null }, o.metadata);
    if (o.kind === 'Pod') { o.spec.containers.forEach((c) => { c.resources = c.resources || {}; }); o.spec.dnsPolicy = o.spec.dnsPolicy || 'ClusterFirst'; o.spec.restartPolicy = o.spec.restartPolicy || 'Always'; o.status = {}; }
    if (o.kind === 'Deployment') { o.spec.strategy = o.spec.strategy || {}; o.spec.template.metadata.creationTimestamp = null; o.spec.template.spec.containers.forEach((c) => { c.resources = c.resources || {}; }); o.status = {}; }
    if (o.kind === 'Service') o.status = { loadBalancer: {} };
    return o;
  }

  function podSpecFromRun(name, f, rest) {
    const image = one(f.image);
    if (!image) throw new KErr('error: required flag(s) "image" not set');
    const c = { name, image };
    if (f.port) c.ports = [{ containerPort: +one(f.port) }];
    if (f.env) c.env = many(f.env).map((e) => { const i = e.indexOf('='); return { name: e.slice(0, i), value: e.slice(i + 1) }; });
    if (rest && rest.length) { if (f.command) c.command = rest; else c.args = rest; }
    const req = {}; const lim = {};
    if (f.requests) for (const x of String(one(f.requests)).split(',')) { const [k, v] = x.split('='); req[k] = v; }
    if (f.limits) for (const x of String(one(f.limits)).split(',')) { const [k, v] = x.split('='); lim[k] = v; }
    c.resources = {};
    if (Object.keys(req).length) c.resources.requests = req;
    if (Object.keys(lim).length) c.resources.limits = lim;
    return c;
  }

  function cmdRun(S, a) {
    const f = a.flags;
    const name = a.pos[0];
    if (!name) throw new KErr('error: NAME is required for run');
    const ns = nsFlag(S, f);
    const labels = Object.keys(metaFlags(f)).length ? metaFlags(f) : { run: name };
    const c = podSpecFromRun(name, f, a.rest);
    const o = { apiVersion: 'v1', kind: 'Pod', metadata: { labels, name, namespace: one(f.namespace) ? ns : undefined }, spec: { containers: [c], restartPolicy: one(f.restart) || 'Always' } };
    if (f.overrides) { try { strategicMerge(o, JSON.parse(one(f.overrides))); } catch (e) { throw new KErr('error: invalid overrides: ' + e.message); } }
    if (f['serviceaccount']) o.spec.serviceAccountName = one(f.serviceaccount);
    if (f.stdin && f.rm) {
      // kubectl run tmp --rm -it --image=busybox -- sh -c "..."
      o.metadata.namespace = ns;
      const cmd = (a.rest || []).join(' ');
      const r = CKA.kubectl._execSim(S, o, cmd, true);
      return { out: r.out + '\npod "' + name + '" deleted from ' + ns + ' namespace', err: r.err, code: r.code };
    }
    const res = outputOrCreate(S, o, f);
    if (f.expose && !dryRun(f)) {
      const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns }, spec: { selector: labels, ports: [{ port: +one(f.port), targetPort: +one(f.port) }] } };
      res.out = 'service/' + name + ' created\n' + applyObject(S, svc, 'create', f).replace(/^.*\//, 'pod/');
    }
    return res;
  }

  function cmdCreate(S, a, ctx) {
    const f = a.flags;
    if (f.filename || f.kustomize) return cmdApplyLike(S, a, ctx, 'create');
    const what = (a.pos[0] || '').toLowerCase();
    const name = a.pos[1];
    const ns = one(f.namespace) || undefined;
    const nsv = nsFlag(S, f);
    const req = (n) => { if (!n) throw new KErr('error: exactly one NAME is required, got 0\nSee \'kubectl create ' + what + ' -h\' for help and examples'); };
    const sub = a.pos;
    switch (what) {
      case 'namespace': case 'ns': req(name); return outputOrCreate(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name } }, f);
      case 'serviceaccount': case 'sa': req(name); return outputOrCreate(S, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: ns } }, f);
      case 'deployment': case 'deploy': {
        req(name);
        const images = many(f.image);
        if (!images.length) throw new KErr('error: required flag(s) "image" not set');
        const containers = images.map((im) => ({ name: images.length > 1 ? im.split('/').pop().split(':')[0] : im.split('/').pop().split(':')[0].replace(/[^a-z0-9-]/g, '-'), image: im }));
        if (f.port) containers[0].ports = [{ containerPort: +one(f.port) }];
        if (a.rest && a.rest.length) containers[0].command = a.rest;
        return outputOrCreate(S, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { labels: { app: name }, name, namespace: ns }, spec: { replicas: f.replicas ? +one(f.replicas) : 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers } } } }, f);
      }
      case 'job': {
        req(name);
        if (f.from) {
          const cj = getObj(S, C.defByKind(S, 'CronJob'), nsv, String(one(f.from)).split('/')[1]);
          return outputOrCreate(S, { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: ns, annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' } }, spec: clone(cj.spec.jobTemplate.spec) }, f);
        }
        const c = { name, image: one(f.image) };
        if (!c.image) throw new KErr('error: required flag(s) "image" not set');
        if (a.rest && a.rest.length) c.command = a.rest;
        return outputOrCreate(S, { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: ns }, spec: { template: { spec: { containers: [c], restartPolicy: 'Never' } } } }, f);
      }
      case 'cronjob': case 'cj': {
        req(name);
        const c = { name, image: one(f.image) };
        if (!c.image) throw new KErr('error: required flag(s) "image" not set');
        if (!f.schedule) throw new KErr('error: required flag(s) "schedule" not set');
        if (a.rest && a.rest.length) c.command = a.rest;
        return outputOrCreate(S, { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace: ns }, spec: { schedule: one(f.schedule), jobTemplate: { metadata: { name }, spec: { template: { spec: { containers: [c], restartPolicy: one(f.restart) || 'OnFailure' } } } } } }, f);
      }
      case 'configmap': case 'cm': {
        req(name);
        const data = {};
        for (const l of many(f['from-literal'])) { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
        for (const ff of many(f['from-file'])) {
          const [k, pth] = ff.includes('=') ? ff.split('=') : [ff.split('/').pop(), ff];
          const p = X.norm(pth, S.cwd);
          if (X.fsIsDir(S, S.host, p)) { for (const e of X.fsList(S, S.host, p)) if (!e.dir) data[e.name] = X.fsRead(S, S.host, p + '/' + e.name); continue; }
          const t = X.fsRead(S, S.host, p);
          if (t == null) throw new KErr('error: error reading ' + pth + ': no such file or directory');
          data[k] = t;
        }
        for (const ef of many(f['from-env-file'])) { const t = X.fsRead(S, S.host, X.norm(ef, S.cwd)) || ''; for (const l of t.split('\n')) { const m = l.match(/^\s*([^#=\s]+)=(.*)$/); if (m) data[m[1]] = m[2]; } }
        return outputOrCreate(S, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns }, data }, f);
      }
      case 'secret': {
        const typ = sub[1];
        const sname = sub[2];
        if (!['generic', 'tls', 'docker-registry'].includes(typ)) throw new KErr('error: Unknown subcommand: ' + typ + '\nAvailable Commands:\n  docker-registry\n  generic\n  tls');
        if (!sname) throw new KErr('error: exactly one NAME is required, got 0');
        const data = {};
        let type = 'Opaque';
        if (typ === 'generic') {
          for (const l of many(f['from-literal'])) { const i = l.indexOf('='); data[l.slice(0, i)] = b64(l.slice(i + 1)); }
          for (const ff of many(f['from-file'])) { const [k, pth] = ff.includes('=') ? ff.split('=') : [ff.split('/').pop(), ff]; const t = X.fsRead(S, S.host, X.norm(pth, S.cwd)); if (t == null) throw new KErr('error: error reading ' + pth + ': no such file or directory'); data[k] = b64(t); }
          if (f.type) type = one(f.type);
        } else if (typ === 'tls') {
          type = 'kubernetes.io/tls';
          const cert = X.fsRead(S, S.host, X.norm(one(f.cert) || '', S.cwd)); const key = X.fsRead(S, S.host, X.norm(one(f.key) || '', S.cwd));
          if (cert == null || key == null) throw new KErr('error: open ' + (cert == null ? one(f.cert) : one(f.key)) + ': no such file or directory');
          data['tls.crt'] = b64(cert); data['tls.key'] = b64(key);
        } else { type = 'kubernetes.io/dockerconfigjson'; data['.dockerconfigjson'] = b64(JSON.stringify({ auths: { [one(f['docker-server']) || 'https://index.docker.io/v1/']: { username: one(f['docker-username']), password: one(f['docker-password']) } } })); }
        return outputOrCreate(S, { apiVersion: 'v1', kind: 'Secret', metadata: { name: sname, namespace: ns }, data, type }, f);
      }
      case 'service': case 'svc': {
        const typ = sub[1]; const sname = sub[2];
        const map = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
        if (!map[typ]) throw new KErr('error: Unknown subcommand: ' + typ);
        if (!sname) throw new KErr('error: exactly one NAME is required, got 0');
        const ports = many(f.tcp).map((t) => { const [p, tp] = t.split(':'); return { name: p + '-' + (tp || p), port: +p, protocol: 'TCP', targetPort: +(tp || p) }; });
        if (ports.length === 1 && f['node-port']) ports[0].nodePort = +one(f['node-port']);
        const o = { apiVersion: 'v1', kind: 'Service', metadata: { labels: { app: sname }, name: sname, namespace: ns }, spec: { ports, selector: { app: sname }, type: map[typ] } };
        if (f.clusterip === 'None' || one(f.clusterip) === 'None') o.spec.clusterIP = 'None';
        return outputOrCreate(S, o, f);
      }
      case 'role': case 'clusterrole': {
        req(name);
        const verbs = many(f.verb).flatMap((v) => v.split(','));
        const resources = many(f.resource).flatMap((v) => v.split(','));
        if (!verbs.length) throw new KErr('error: at least one verb must be specified');
        if (!resources.length && !f['non-resource-url'] && !f['aggregation-rule']) throw new KErr('error: at least one resource must be specified');
        const byGroup = {};
        for (const r of resources) {
          const [rn, subr] = r.split('/');
          const def = C.resolveKind(S, rn);
          if (!def) throw new KErr('error: the server doesn\'t have a resource type "' + rn + '"');
          const g = def.group;
          (byGroup[g] = byGroup[g] || []).push(def.plural + (subr ? '/' + subr : ''));
        }
        const rn = many(f['resource-name']);
        const rules = Object.keys(byGroup).map((g) => { const r = { apiGroups: [g], resources: byGroup[g], verbs }; if (rn.length) r.resourceNames = rn; return r; });
        const o = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'role' ? 'Role' : 'ClusterRole', metadata: { name, namespace: what === 'role' ? ns : undefined }, rules };
        return outputOrCreate(S, o, f);
      }
      case 'rolebinding': case 'clusterrolebinding': {
        req(name);
        const isCrb = what === 'clusterrolebinding';
        const roleRef = f.clusterrole ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: one(f.clusterrole) } : f.role ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: one(f.role) } : null;
        if (!roleRef) throw new KErr('error: exactly one of clusterrole or role must be specified');
        if (isCrb && f.role) throw new KErr('error: unknown flag: --role');
        const subjects = [];
        for (const u of many(f.user)) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
        for (const g of many(f.group)) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
        for (const s of many(f.serviceaccount)) {
          const parts = s.split(':');
          if (parts.length !== 2) throw new KErr('error: serviceaccount must be <namespace>:<name>');
          subjects.push({ kind: 'ServiceAccount', name: parts[1], namespace: parts[0] });
        }
        const o = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: isCrb ? 'ClusterRoleBinding' : 'RoleBinding', metadata: { name, namespace: isCrb ? undefined : ns }, roleRef, subjects };
        return outputOrCreate(S, o, f);
      }
      case 'ingress': case 'ing': {
        req(name);
        const rules = [];
        for (const r of many(f.rule)) {
          const m = r.match(/^([^/]*)(\/[^=]*)=([^:]+):([^,]+)(?:,tls(?:=(.*))?)?$/);
          if (!m) throw new KErr('error: rule ' + r + ' is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]');
          let path = m[2]; let pathType = 'Exact';
          if (path.endsWith('*')) { path = path.slice(0, -1).replace(/\/$/, '') || '/'; pathType = 'Prefix'; }
          const host = m[1] || undefined;
          const port = /^\d+$/.test(m[4]) ? { number: +m[4] } : { name: m[4] };
          let rule = rules.find((x) => x.host === host);
          if (!rule) { rule = { host, http: { paths: [] } }; rules.push(rule); }
          rule.http.paths.push({ backend: { service: { name: m[3], port } }, path, pathType });
        }
        const o = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: ns }, spec: { rules } };
        if (f.class) o.spec.ingressClassName = one(f.class);
        if (f.annotation) { o.metadata.annotations = {}; for (const an of many(f.annotation)) { const i = an.indexOf('='); o.metadata.annotations[an.slice(0, i)] = an.slice(i + 1); } }
        if (f['default-backend']) { const [sn, sp] = String(one(f['default-backend'])).split(':'); o.spec.defaultBackend = { service: { name: sn, port: /^\d+$/.test(sp) ? { number: +sp } : { name: sp } } }; }
        return outputOrCreate(S, o, f);
      }
      case 'priorityclass': case 'pc': {
        req(name);
        if (f.value === undefined) throw new KErr('error: required flag(s) "value" not set');
        const o = { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name }, value: +one(f.value), globalDefault: f['global-default'] === 'true' || f['global-default'] === true, description: one(f.description) };
        if (f['preemption-policy']) o.preemptionPolicy = one(f['preemption-policy']);
        return outputOrCreate(S, o, f);
      }
      case 'quota': case 'resourcequota': {
        req(name);
        const hard = {};
        for (const h of String(one(f.hard) || '').split(',').filter(Boolean)) { const [k, v] = h.split('='); hard[k] = v; }
        return outputOrCreate(S, { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name, namespace: ns }, spec: { hard } }, f);
      }
      case 'poddisruptionbudget': case 'pdb': {
        req(name);
        const o = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name, namespace: ns }, spec: { selector: { matchLabels: metaFromSel(one(f.selector)) } } };
        if (f['min-available']) o.spec.minAvailable = /%/.test(one(f['min-available'])) ? one(f['min-available']) : +one(f['min-available']);
        if (f['max-unavailable']) o.spec.maxUnavailable = /%/.test(one(f['max-unavailable'])) ? one(f['max-unavailable']) : +one(f['max-unavailable']);
        return outputOrCreate(S, o, f);
      }
      case 'token': {
        req(name);
        getObj(S, C.defByKind(S, 'ServiceAccount'), nsv, name);
        return { out: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ik' + C.hashStr(name + S.now, 40) + '.eyJhdWQiOlsiaHR0cHM6Ly9rdWJlcm5ldGVzLmRlZmF1bHQuc3ZjIl19.' + C.hashStr(name, 30) };
      }
      default:
        throw new KErr('error: Unexpected args: [' + a.pos.join(' ') + ']\nSee \'kubectl create -h\' for help and examples' + (what ? '' : '\n(uso: kubectl create <tipo> <nombre> [flags] o kubectl create -f archivo.yaml)'));
    }
  }
  function metaFromSel(s) { const r = {}; for (const kvs of String(s || '').split(',').filter(Boolean)) { const [k, v] = kvs.split('='); r[k] = v; } return r; }

  // ------------------------------------------------------------ expose
  function cmdExpose(S, a) {
    const f = a.flags;
    const t = splitTypeName(S, a.pos)[0];
    if (!t || !t.name) throw new KErr('error: You must provide one or more resources by argument or filename.');
    const ns = nsFlag(S, f);
    const o = getObj(S, t.def, ns, t.name);
    let selector; let tplPorts = [];
    if (o.kind === 'Pod') { selector = o.metadata.labels; tplPorts = (o.spec.containers || []).flatMap((c) => c.ports || []); }
    else if (o.kind === 'Service') { selector = o.spec.selector; tplPorts = (o.spec.ports || []).map((p) => ({ containerPort: p.port })); }
    else { selector = (o.spec.selector && o.spec.selector.matchLabels) || o.spec.template.metadata.labels; tplPorts = (o.spec.template.spec.containers || []).flatMap((c) => c.ports || []); }
    if (f.selector) selector = metaFromSel(one(f.selector));
    const port = f.port ? +one(f.port) : (tplPorts[0] && tplPorts[0].containerPort);
    if (!port) throw new KErr('error: couldn\'t find port via --port flag or introspection\nSee \'kubectl expose -h\' for help and examples');
    let target = f['target-port'] !== undefined ? one(f['target-port']) : port;
    if (/^\d+$/.test(String(target))) target = +target;
    const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: one(f.name) || t.name, namespace: ns, labels: clone(o.metadata.labels) }, spec: { ports: [{ port, protocol: one(f.protocol) || 'TCP', targetPort: target }], selector: clone(selector), type: one(f.type) || 'ClusterIP' } };
    if (f['port-name'] || (tplPorts[0] && tplPorts[0].name && tplPorts.length > 0 && !f.port)) svc.spec.ports[0].name = one(f['port-name']) || undefined;
    if (!svc.spec.ports[0].name) delete svc.spec.ports[0].name;
    if (f['node-port']) svc.spec.ports[0].nodePort = +one(f['node-port']);
    if (!svc.metadata.labels || !Object.keys(svc.metadata.labels).length) delete svc.metadata.labels;
    const r = outputOrCreate(S, svc, f);
    if (!dryRun(f)) r.out = 'service/' + svc.metadata.name + ' exposed';
    return r;
  }

  // ------------------------------------------------------------ scale / autoscale / set / rollout
  function cmdScale(S, a) {
    const f = a.flags;
    const targets = splitTypeName(S, a.pos);
    if (!targets.length) throw new KErr('error: required resource not specified');
    if (f.replicas === undefined) throw new KErr('error: required flag(s) "replicas" not set');
    const ns = nsFlag(S, f);
    const out = [];
    for (const t of targets) {
      if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(t.def.kind)) throw new KErr('error: no objects passed to scale ' + t.def.plural + ' "' + t.name + '"');
      const o = getObj(S, t.def, ns, t.name);
      if (f['current-replicas'] !== undefined && +one(f['current-replicas']) !== o.spec.replicas) throw new KErr('error: Expected replicas to be ' + one(f['current-replicas']) + ', was ' + o.spec.replicas);
      o.spec.replicas = +one(f.replicas);
      o.metadata.generation = (o.metadata.generation || 1) + 1;
      C.event(S, o, 'Normal', 'ScalingReplicaSet', 'Scaled to ' + o.spec.replicas);
      out.push(resNameS(S, o) + ' scaled');
    }
    return { out: out.join('\n') };
  }

  function cmdAutoscale(S, a) {
    const f = a.flags;
    const t = splitTypeName(S, a.pos)[0];
    if (!t || !t.name) throw new KErr('error: You must provide one or more resources by argument or filename.');
    const ns = nsFlag(S, f);
    const o = getObj(S, t.def, ns, t.name);
    if (!f.max) throw new KErr('error: --max=MAXPODS is required and must be at least 1, max: -1');
    const hpa = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: one(f.name) || t.name, namespace: ns }, spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: o.kind, name: t.name }, minReplicas: f.min ? +one(f.min) : 1, maxReplicas: +one(f.max) } };
    if (f['cpu-percent']) hpa.spec.metrics = [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: +one(f['cpu-percent']) } } }];
    const r = outputOrCreate(S, hpa, f);
    if (!dryRun(f)) r.out = 'horizontalpodautoscaler.autoscaling/' + hpa.metadata.name + ' autoscaled';
    return r;
  }

  function podSpecOf(o) { return o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec.jobTemplate.spec.template.spec : o.spec.template.spec; }

  function cmdSet(S, a) {
    const f = a.flags;
    const sub = a.pos[0];
    const rest = a.pos.slice(1);
    const ns = nsFlag(S, f);
    if (sub === 'image') {
      const target = rest.filter((x) => !x.includes('='));
      const pairs = rest.filter((x) => x.includes('='));
      const t = splitTypeName(S, target)[0];
      if (!t || !t.name) throw new KErr('error: resource(s) were provided, but no name was specified');
      const o = getObj(S, t.def, ns, t.name);
      const ps = podSpecOf(o);
      for (const p of pairs) {
        const [cn, img] = p.split('=');
        const cs = (ps.containers || []).concat(ps.initContainers || []).filter((c) => cn === '*' || c.name === cn);
        if (!cs.length) throw new KErr('error: unable to find container named "' + cn + '"');
        cs.forEach((c) => { c.image = img; });
      }
      if (o.kind === 'Pod') { put(S, o); } else o.metadata.generation++;
      return { out: resNameS(S, o) + ' image updated' };
    }
    if (sub === 'resources') {
      const t = splitTypeName(S, rest)[0];
      const o = getObj(S, t.def, ns, t.name);
      const ps = podSpecOf(o);
      const cn = one(f.containers) || one(f.container) || '*';
      const all = (ps.containers || []).concat(ps.initContainers || []);
      if (cn !== '*' && !all.some((x) => x.name === cn)) throw new KErr('error: unable to find container named ' + cn);
      for (const c of all.filter((x) => cn === '*' || x.name === cn)) {
        c.resources = c.resources || {};
        if (f.requests) { c.resources.requests = c.resources.requests || {}; for (const x of String(one(f.requests)).split(',')) { const [k, v] = x.split('='); c.resources.requests[k] = v; } }
        if (f.limits) { c.resources.limits = c.resources.limits || {}; for (const x of String(one(f.limits)).split(',')) { const [k, v] = x.split('='); c.resources.limits[k] = v; } }
      }
      if (o.kind === 'Pod') throw new KErr('The Pod "' + o.metadata.name + '" is invalid: spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`...');
      return { out: resNameS(S, o) + ' resource requirements updated' };
    }
    if (sub === 'env') {
      const target = rest.filter((x) => !x.includes('='));
      const pairs = rest.filter((x) => x.includes('='));
      const t = splitTypeName(S, target)[0];
      const o = getObj(S, t.def, ns, t.name);
      const ps = podSpecOf(o);
      for (const c of ps.containers || []) {
        c.env = c.env || [];
        for (const p of pairs) { const i = p.indexOf('='); const n = p.slice(0, i); const v = p.slice(i + 1); const ex = c.env.find((e) => e.name === n); if (ex) ex.value = v; else c.env.push({ name: n, value: v }); }
        if (f['from']) { const [k, nm] = String(one(f.from)).split('/'); c.envFrom = c.envFrom || []; c.envFrom.push(k.startsWith('secret') ? { secretRef: { name: nm } } : { configMapRef: { name: nm } }); }
      }
      return { out: resNameS(S, o) + ' env updated' };
    }
    if (sub === 'serviceaccount' || sub === 'sa') {
      const t = splitTypeName(S, rest.slice(0, 1))[0];
      const o = getObj(S, t.def, ns, t.name);
      podSpecOf(o).serviceAccountName = rest[1];
      return { out: resNameS(S, o) + ' serviceaccount updated' };
    }
    throw new KErr('error: Unknown command "' + sub + '" for "kubectl set"\nAvailable Commands: env, image, resources, selector, serviceaccount, subject');
  }

  function cmdRollout(S, a) {
    const f = a.flags;
    const sub = a.pos[0];
    const t = splitTypeName(S, a.pos.slice(1))[0];
    if (!t || !t.name) throw new KErr('error: required resource not specified');
    const ns = nsFlag(S, f);
    const o = getObj(S, t.def, ns, t.name);
    if (o.kind !== 'Deployment' && sub !== 'status' && sub !== 'restart') throw new KErr('error: rollout ' + sub + ' solo está simulado para Deployments');
    const rsList = () => X.ownedBy(S, 'ReplicaSet', o).sort((x, y) => +x.metadata.annotations['deployment.kubernetes.io/revision'] - +y.metadata.annotations['deployment.kubernetes.io/revision']);
    switch (sub) {
      case 'status': {
        if (o.kind === 'Deployment') {
          const ready = o.status.readyReplicas || 0;
          if (ready >= o.spec.replicas) return { out: 'deployment "' + o.metadata.name + '" successfully rolled out' };
          return { out: 'Waiting for deployment "' + o.metadata.name + '" rollout to finish: ' + ready + ' of ' + o.spec.replicas + ' updated replicas are available...', err: 'error: timed out waiting for the condition', code: 1 };
        }
        return { out: resNameS(S, o).split('/')[0] + ' "' + o.metadata.name + '" successfully rolled out' };
      }
      case 'history': {
        if (f.revision) {
          const rs = rsList().find((r) => r.metadata.annotations['deployment.kubernetes.io/revision'] === String(one(f.revision)));
          if (!rs) throw new KErr('error: unable to find the specified revision');
          return { out: 'deployment.apps/' + o.metadata.name + ' with revision #' + one(f.revision) + '\nPod Template:\n  Labels:\t' + selStr(rs.spec.template.metadata.labels) + '\n  Containers:\n' + rs.spec.template.spec.containers.map((c) => '   ' + c.name + ':\n    Image:\t' + c.image).join('\n') };
        }
        return { out: 'deployment.apps/' + o.metadata.name + '\n' + C.table(['REVISION', 'CHANGE-CAUSE'], rsList().map((r) => [r.metadata.annotations['deployment.kubernetes.io/revision'], r.metadata.annotations['kubernetes.io/change-cause'] || '<none>'])) };
      }
      case 'undo': {
        const l = rsList();
        const cur = l.find((r) => r.metadata.name === o._sim.activeRS);
        let target;
        if (f['to-revision']) target = l.find((r) => r.metadata.annotations['deployment.kubernetes.io/revision'] === String(one(f['to-revision'])));
        else target = l.filter((r) => r !== cur).pop();
        if (!target) throw new KErr('error: no rollout history found for deployment "' + o.metadata.name + '"');
        const tpl = clone(target.spec.template);
        delete tpl.metadata.labels['pod-template-hash'];
        o.spec.template = tpl;
        if (target.metadata.annotations['kubernetes.io/change-cause']) o.metadata.annotations['kubernetes.io/change-cause'] = target.metadata.annotations['kubernetes.io/change-cause'];
        else if (o.metadata.annotations) delete o.metadata.annotations['kubernetes.io/change-cause'];
        o.metadata.generation++;
        return { out: 'deployment.apps/' + o.metadata.name + ' rolled back' };
      }
      case 'restart': {
        const ps = o.spec.template;
        ps.metadata = ps.metadata || {};
        ps.metadata.annotations = Object.assign({}, ps.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': new Date(S.now).toISOString() });
        return { out: resNameS(S, o) + ' restarted' };
      }
      case 'pause': o.spec.paused = true; return { out: resNameS(S, o) + ' paused' };
      case 'resume': delete o.spec.paused; return { out: resNameS(S, o) + ' resumed' };
      default: throw new KErr('error: unknown command "' + sub + '" for "kubectl rollout"');
    }
  }

  // ------------------------------------------------------------ label / annotate / taint
  function cmdLabelAnnotate(S, a, field) {
    const f = a.flags;
    const ns = nsFlag(S, f);
    const pos = a.pos.slice();
    const changes = pos.filter((x) => /=/.test(x) || /-$/.test(x));
    const targetsRaw = pos.filter((x) => !changes.includes(x));
    let objs = [];
    if (f.all || f.selector) {
      const def = C.resolveKind(S, targetsRaw[0]);
      if (!def) throw kindErr(targetsRaw[0]);
      objs = listKind(S, def, ns, !!f['all-namespaces']);
      if (f.selector) { const s = C.parseSelector(String(one(f.selector))); objs = objs.filter((o) => C.matchParsed(o.metadata.labels, s)); }
    } else {
      const targets = splitTypeName(S, targetsRaw);
      if (!targets.length || !targets[0].name) throw new KErr('error: one or more resources must be specified as <resource> <name> or <resource>/<name>');
      objs = targets.map((t) => getObj(S, t.def, ns, t.name));
    }
    if (!changes.length) throw new KErr('error: at least one ' + (field === 'labels' ? 'label' : 'annotation') + ' update is required');
    const out = [];
    for (const o of objs) {
      o.metadata[field] = o.metadata[field] || {};
      for (const c of changes) {
        if (c.endsWith('-') && !c.includes('=')) { delete o.metadata[field][c.slice(0, -1)]; continue; }
        const i = c.indexOf('=');
        const k = c.slice(0, i); const v = c.slice(i + 1);
        if (o.metadata[field][k] !== undefined && o.metadata[field][k] !== v && !f.overwrite) throw new KErr('error: \'' + k + '\' already has a value (' + o.metadata[field][k] + '), and --overwrite is false');
        o.metadata[field][k] = v;
      }
      if (field === 'labels' && o.kind === 'Namespace') o.metadata.labels['kubernetes.io/metadata.name'] = o.metadata.name;
      out.push(resNameS(S, o) + (field === 'labels' ? ' labeled' : ' annotated'));
    }
    return { out: out.join('\n') };
  }

  function cmdTaint(S, a) {
    const f = a.flags;
    const pos = a.pos.slice();
    if (pos[0] !== 'node' && pos[0] !== 'nodes' && pos[0] !== 'no' && !pos[0].startsWith('node/')) throw new KErr('error: invalid resource type ' + pos[0] + ', only node types are supported');
    let names = [];
    let specs = [];
    if (pos[0].startsWith('node/')) { names = [pos[0].split('/')[1]]; specs = pos.slice(1); } else { names = [pos[1]]; specs = pos.slice(2); }
    let nodes;
    if (f.selector) { const s = C.parseSelector(String(one(f.selector))); nodes = list(S, 'Node').filter((n) => C.matchParsed(n.metadata.labels, s)); specs = pos.slice(1); }
    else if (f.all) { nodes = list(S, 'Node'); specs = pos.slice(1); }
    else nodes = names.map((n) => getObj(S, C.defByKind(S, 'Node'), null, n));
    if (!specs.length) throw new KErr('error: at least one taint update is required');
    for (const n of nodes) {
      n.spec.taints = n.spec.taints || [];
      for (const sp of specs) {
        if (sp.endsWith('-')) {
          const s = sp.slice(0, -1);
          const m = s.match(/^([^=:]+)(?:=([^:]*))?(?::(\w+))?$/);
          const before = n.spec.taints.length;
          n.spec.taints = n.spec.taints.filter((t) => !(t.key === m[1] && (!m[3] || t.effect === m[3])));
          if (before === n.spec.taints.length) throw new KErr('error: taint "' + s + '" not found');
          continue;
        }
        const m = sp.match(/^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/);
        if (!m) throw new KErr('error: invalid taint spec: ' + sp + ', unknown taint effect or format (formato: key=value:Effect, Effect ∈ NoSchedule|PreferNoSchedule|NoExecute)');
        const ex = n.spec.taints.find((t) => t.key === m[1] && t.effect === m[3]);
        if (ex && !f.overwrite) throw new KErr('error: node ' + n.metadata.name + ' already has ' + m[1] + ' taint(s) with same effect(s) and --overwrite is false');
        if (ex) ex.value = m[2]; else n.spec.taints.push(m[2] !== undefined ? { key: m[1], value: m[2], effect: m[3] } : { key: m[1], effect: m[3] });
        if (m[3] === 'NoExecute') {
          for (const p of list(S, 'Pod').filter((p) => p.spec.nodeName === n.metadata.name && !X.tolerates(p.spec.tolerations, { key: m[1], value: m[2], effect: 'NoExecute' }))) {
            if ((p.metadata.ownerReferences || []).some((r) => r.kind === 'DaemonSet' || r.kind === 'Node')) continue;
            remove(S, p);
          }
        }
      }
    }
    return { out: nodes.map((n) => 'node/' + n.metadata.name + ' ' + (specs.every((s) => s.endsWith('-')) ? 'untainted' : 'tainted')).join('\n') };
  }

  // ------------------------------------------------------------ cordon / drain
  function cmdCordon(S, a, on) {
    const t = splitTypeName(S, ['node'].concat(a.pos.filter((x) => !x.startsWith('node/'))).concat([]))[0];
    const name = a.pos[0] && a.pos[0].startsWith('node/') ? a.pos[0].split('/')[1] : a.pos[0];
    if (!name) throw new KErr('error: USAGE: ' + (on ? 'cordon' : 'uncordon') + ' NODE [flags]');
    const n = getObj(S, C.defByKind(S, 'Node'), null, name);
    void t;
    const was = !!n.spec.unschedulable;
    if (on) n.spec.unschedulable = true; else delete n.spec.unschedulable;
    return { out: 'node/' + name + ' ' + (was === on ? 'already ' : '') + (on ? 'cordoned' : 'uncordoned') };
  }

  function cmdDrain(S, a) {
    const f = a.flags;
    const name = a.pos[0] && a.pos[0].startsWith('node/') ? a.pos[0].split('/')[1] : a.pos[0];
    if (!name) throw new KErr('error: USAGE: drain NODE [flags]');
    const n = getObj(S, C.defByKind(S, 'Node'), null, name);
    const pods = list(S, 'Pod').filter((p) => p.spec.nodeName === name);
    const ds = pods.filter((p) => (p.metadata.ownerReferences || []).some((r) => r.kind === 'DaemonSet'));
    const mirror = pods.filter((p) => (p.metadata.ownerReferences || []).some((r) => r.kind === 'Node'));
    const bare = pods.filter((p) => !(p.metadata.ownerReferences || []).length);
    const local = pods.filter((p) => (p.spec.volumes || []).some((v) => v.emptyDir) && !ds.includes(p) && !mirror.includes(p));
    n.spec.unschedulable = true;
    const errs = [];
    if (ds.length && !f['ignore-daemonsets']) errs.push('cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ' + ds.map((p) => C.nsOf(p) + '/' + p.metadata.name).join(', '));
    if (bare.length && !f.force) errs.push('cannot delete cannot delete Pods that declare no controller (use --force to override): ' + bare.map((p) => C.nsOf(p) + '/' + p.metadata.name).join(', '));
    if (local.length && !f['delete-emptydir-data'] && !f['delete-local-data']) errs.push('cannot delete Pods with local storage (use --delete-emptydir-data to override): ' + local.map((p) => C.nsOf(p) + '/' + p.metadata.name).join(', '));
    if (errs.length) return { out: 'node/' + name + ' cordoned', err: 'error: unable to drain node "' + name + '" due to error: [' + errs.join(', ') + '], continuing command...\nThere are pending nodes to be drained:\n ' + name + '\n' + errs.map((e) => 'error: ' + e).join('\n'), code: 1 };
    const out = ['node/' + name + ' cordoned'];
    if (ds.length) out.push('Warning: ignoring DaemonSet-managed Pods: ' + ds.map((p) => C.nsOf(p) + '/' + p.metadata.name).join(', '));
    if (bare.length) out.push('Warning: deleting Pods that declare no controller: ' + bare.map((p) => C.nsOf(p) + '/' + p.metadata.name).join(', '));
    const evict = pods.filter((p) => !ds.includes(p) && !mirror.includes(p));
    for (const p of evict) out.push('evicting pod ' + C.nsOf(p) + '/' + p.metadata.name);
    for (const p of evict) { remove(S, p); out.push('pod/' + p.metadata.name + ' evicted'); }
    out.push('node/' + name + ' drained');
    n._sim.drained = true;
    return { out: out.join('\n') };
  }

  // ------------------------------------------------------------ delete
  function cmdDelete(S, a, ctx) {
    const f = a.flags;
    const ns = nsFlag(S, f);
    const out = [];
    if (f.filename) {
      for (const fn of many(f.filename)) {
        const { text, src } = readManifestSource(S, ctx, fn);
        for (const d of parseDocs(text, src).filter(Boolean)) {
          const def = C.defByKind(S, d.kind);
          const o = def && find(S, d.kind, def.namespaced ? (d.metadata.namespace || ns) : null, d.metadata.name);
          if (!o) { out.push('Error from server (NotFound): error when deleting "' + src + '": ' + (def ? def.plural : d.kind) + ' "' + d.metadata.name + '" not found'); continue; }
          deleteObj(S, o); out.push(resNameS(S, o).replace(/^([^/]+)\//, '$1 "') + '" deleted');
        }
      }
      return { out: out.join('\n') };
    }
    if (!a.pos.length) throw new KErr('error: You must provide one or more resources by argument or filename.');
    const targets = splitTypeName(S, a.pos);
    for (const t of targets) {
      let objs;
      if (t.name) objs = [getObj(S, t.def, ns, t.name)];
      else if (f.all || f.selector) {
        objs = listKind(S, t.def, ns, !!f['all-namespaces']);
        if (f.selector) { const s = C.parseSelector(String(one(f.selector))); objs = objs.filter((o) => C.matchParsed(o.metadata.labels, s)); }
      } else throw new KErr('error: resource(s) were provided, but no name was specified');
      for (const o of objs) {
        deleteObj(S, o);
        const d = C.defByKind(S, o.kind);
        out.push((d.group ? d.singular + '.' + d.group : d.singular) + ' "' + o.metadata.name + '" deleted' + (d.namespaced && S.version ? ' from ' + C.nsOf(o) + ' namespace' : ''));
      }
    }
    if (f.force && (f['grace-period'] === '0' || f['grace-period'] === 0)) out.unshift('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.');
    return { out: out.join('\n') };
  }

  function deleteObj(S, o) {
    if (o.kind === 'Namespace') {
      if (['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(o.metadata.name)) throw new KErr('Error from server (Forbidden): namespaces "' + o.metadata.name + '" is forbidden: this namespace may not be deleted');
      for (const x of S.objs.slice()) if (C.nsOf(x) === o.metadata.name) remove(S, x);
    }
    if (o.kind === 'Pod' && o._sim && o._sim.static) {
      // pod espejo: se recrea
      remove(S, o);
      return;
    }
    if (o.kind === 'PersistentVolumeClaim') {
      const using = list(S, 'Pod', C.nsOf(o)).some((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === o.metadata.name));
      if (using) { o._sim = o._sim || {}; }
    }
    remove(S, o);
  }

  // ------------------------------------------------------------ edit (usa el editor de la UI)
  function cmdEdit(S, a, ctx) {
    const f = a.flags;
    const t = splitTypeName(S, a.pos)[0];
    if (!t || !t.name) throw new KErr('error: edit requiere un recurso con nombre (p. ej. kubectl edit deploy web)');
    const ns = nsFlag(S, f);
    const o = getObj(S, t.def, ns, t.name);
    const text = C.toYaml(publicObj(S, o));
    const header = '# Please edit the object below. Lines beginning with a \'#\' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n';
    return {
      editor: {
        title: 'kubectl edit ' + resNameS(S, o) + (C.nsOf(o) ? ' -n ' + C.nsOf(o) : ''),
        content: header + text,
        onSave(S2, newText) {
          const body = newText.split('\n').filter((l) => !l.startsWith('#')).join('\n');
          if (!body.trim()) return { out: 'Edit cancelled, no changes made.' };
          if (body.trim() === text.trim()) return { out: 'Edit cancelled, no changes made.' };
          let doc;
          try { doc = C.yaml.load(body); } catch (e) { return { err: 'error: error parsing edited-file: ' + String(e.message).split('\n')[0], code: 1 }; }
          const cur = find(S2, o.kind, C.nsOf(o) || null, o.metadata.name);
          if (!cur) return { err: 'Error from server (NotFound): ' + t.def.plural + ' "' + o.metadata.name + '" not found', code: 1 };
          try {
            validate(S2, doc, 'edited-file');
            doc._sim = cur._sim;
            normalize(S2, doc);
            admission(S2, doc, cur);
            if (doc.kind === 'Pod') { doc.spec.nodeName = doc.spec.nodeName || cur.spec.nodeName; doc.status = cur.status; }
            put(S2, doc);
            return { out: resNameS(S2, doc) + ' edited' };
          } catch (e) {
            if (e.code === 'PODIMMUTABLE' || /immutable|Forbidden/.test(e.message)) {
              const tmp = '/tmp/kubectl-edit-' + Math.floor(1000000000 + Math.random() * 8999999999) + '.yaml';
              X.fsWrite(S2, S2.host, tmp, body);
              return { err: 'error: ' + resNameS(S2, cur).split('/')[0] + ' "' + cur.metadata.name + '" is invalid\nA copy of your changes has been stored to "' + tmp + '"\nerror: Edit cancelled, no valid changes were saved.\n' + e.message, code: 1, tmp };
            }
            return { err: e.message, code: 1 };
          }
        },
      },
    };
  }

  // ------------------------------------------------------------ logs / exec / top
  function podLogs(S, p, cname, prev) {
    const sim = p._sim || {};
    const cs = p.spec.containers || [];
    const c = cname ? cs.concat(p.spec.initContainers || []).find((x) => x.name === cname) : cs[0];
    if (!c) throw new KErr('error: container ' + cname + ' is not valid for pod ' + p.metadata.name);
    if (!cname && cs.length > 1) throw new KErr('error: a container name must be specified for pod ' + p.metadata.name + ', choose one of: [' + cs.map((x) => x.name).join(' ') + ']');
    if (prev) return (sim.prevLogs && (sim.prevLogs[c.name] || sim.prevLogs)) || '';
    if (sim.logs && typeof sim.logs === 'object' && sim.logs[c.name] !== undefined) return sim.logs[c.name];
    if (typeof sim.logs === 'string' && c === cs[0]) return sim.logs;
    const cmd = (c.command || []).concat(c.args || []).join(' ');
    const m = cmd.match(/tail\s+(?:-[\w+-]+\s+)*(?:-n\s*\+?\d+\s+)?(?:-[fF]\s+)?(\/\S+)/);
    if (m) {
      const file = m[1].replace(/['";]/g, '');
      const mnt = (c.volumeMounts || []).find((vm) => file.startsWith(vm.mountPath.replace(/\/$/, '') + '/'));
      if (!mnt) return 'tail: can\'t open \'' + file + '\': No such file or directory\ntail: no files';
      const writer = cs.find((o) => o !== c && (o.volumeMounts || []).some((vm) => vm.name === mnt.name && file.startsWith(vm.mountPath.replace(/\/$/, '') + '/')));
      const files = sim.files || {};
      if (writer && files[file]) return files[file];
      return 'tail: can\'t open \'' + file + '\': No such file or directory';
    }
    if (/nginx/.test(c.image)) return '/docker-entrypoint.sh: Configuration complete; ready for start up\n2026/10/03 14:00:00 [notice] 1#1: nginx/1.29.1\n2026/10/03 14:00:00 [notice] 1#1: start worker processes';
    if (/echo/.test(cmd)) { const em = cmd.match(/echo\s+["']?([^"';&|]+)/); return em ? em[1].trim() : ''; }
    return '';
  }

  function cmdLogs(S, a) {
    const f = a.flags;
    const ns = nsFlag(S, f);
    let name = a.pos[0];
    if (!name && f.selector) {
      const s = C.parseSelector(String(one(f.selector)));
      const pods = list(S, 'Pod', ns).filter((p) => C.matchParsed(p.metadata.labels, s));
      return { out: pods.map((p) => podLogs(S, p, one(f.container), f.previous)).filter(Boolean).join('\n') };
    }
    if (!name) throw new KErr('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command');
    let p;
    if (name.includes('/')) {
      const [tt, nn] = name.split('/');
      const def = C.resolveKind(S, tt);
      if (!def) throw kindErr(tt);
      if (def.kind === 'Pod') p = getObj(S, def, ns, nn);
      else { const o = getObj(S, def, ns, nn); const all = list(S, 'Pod', ns).filter((x) => C.matchLabelSelector(x.metadata.labels, o.spec.selector)); p = all[0]; if (!p) throw new KErr('error: no pods found for ' + name); }
    } else p = getObj(S, C.defByKind(S, 'Pod'), ns, name);
    const cname = one(f.container) || a.pos[1];
    if (f['all-containers']) return { out: (p.spec.containers || []).map((c) => podLogs(S, p, c.name, f.previous)).join('\n') };
    const st = (p.status.containerStatuses || []).find((c) => !cname || c.name === cname);
    if (st && st.state && st.state.waiting && ['ContainerCreating', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(st.state.waiting.reason)) throw new KErr('Error from server (BadRequest): container "' + st.name + '" in pod "' + p.metadata.name + '" is waiting to start: ' + (st.state.waiting.reason === 'ImagePullBackOff' ? 'trying and failing to pull image' : st.state.waiting.reason));
    let txt = podLogs(S, p, cname, f.previous);
    if (f.tail !== undefined && +one(f.tail) >= 0) txt = txt.split('\n').slice(-+one(f.tail)).join('\n');
    return { out: txt };
  }

  function execSim(S, pod, cmdline, fromRun) {
    // comandos típicos dentro de un contenedor
    const argv = CKA.shell ? CKA.shell.tokenize(cmdline).filter((x) => typeof x === 'string') : cmdline.split(/\s+/);
    let args = argv.slice();
    if ((args[0] === 'sh' || args[0] === '/bin/sh' || args[0] === 'bash' || args[0] === '/bin/bash') && args[1] === '-c') return execSim(S, pod, args.slice(2).join(' '), fromRun);
    if (!args.length || args[0] === 'sh' || args[0] === 'bash' || args[0] === '/bin/sh' || args[0] === '/bin/bash') return { out: '(shell interactiva simulada: usa "kubectl exec <pod> -- <comando>" con un comando concreto, p. ej. curl, wget, nslookup, cat, env, ls)' };
    if (fromRun && !find(S, 'Namespace', null, C.nsOf(pod))) throw new KErr('Error from server (NotFound): namespaces "' + C.nsOf(pod) + '" not found');
    const cmd = args[0];
    const fromPod = fromRun ? Object.assign({}, pod, { status: { podIP: '192.168.1.250' } }) : pod;
    if (cmd === 'curl' || cmd === 'wget') {
      const url = args.slice(1).filter((x) => !x.startsWith('-') && !/^\d+$/.test(x)).pop();
      let hdr = null;
      const hi = args.indexOf('-H');
      if (hi > 0) { const hv = args[hi + 1] || ''; const mm = hv.match(/^host:\s*(.*)$/i); if (mm) hdr = mm[1]; }
      if (!url) return { err: cmd + ': no URL specified!', code: 2 };
      const r = X.httpRequest(S, fromPod, url, hdr);
      if (r.err) return { err: (cmd === 'wget' ? 'wget: download timed out' : 'curl: (' + r.code + ') ' + r.err), code: r.code === 28 ? 28 : (r.code || 1), why: r.why };
      if (r.status >= 400 && cmd === 'wget') return { err: 'wget: server returned error: HTTP/1.1 ' + r.status, code: 1, why: r.why };
      return { out: r.body, why: r.why };
    }
    if (cmd === 'nc') {
      const host = args.filter((x) => !x.startsWith('-'))[1]; const port = args.filter((x) => !x.startsWith('-'))[2];
      const r = X.httpRequest(S, fromPod, 'http://' + host + ':' + port + '/');
      return r.err ? { err: 'nc: ' + host + ' (' + host + ':' + port + '): Connection timed out', code: 1, why: r.why } : { out: host + ' (' + host + ':' + port + ') open' };
    }
    if (cmd === 'nslookup' || cmd === 'dig' || cmd === 'host') {
      const name = args[args.length - 1];
      if (!X.dnsWorks(S)) return { err: ';; connection timed out; no servers could be reached', code: 1, why: 'CoreDNS no tiene pods Ready en kube-system' };
      const t = X.resolveHost(S, name, C.nsOf(pod));
      if (!t) return { out: 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n** server can\'t find ' + name + '.' + C.nsOf(pod) + '.svc.cluster.local: NXDOMAIN', code: 1 };
      const ip = t.t === 'svc' ? t.svc.spec.clusterIP : t.t === 'pod' ? t.pod.status.podIP : t.node.status.addresses[0].address;
      const fq = t.t === 'svc' ? t.svc.metadata.name + '.' + C.nsOf(t.svc) + '.svc.cluster.local' : name;
      return { out: 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\nName:\t' + fq + '\nAddress: ' + ip };
    }
    if (cmd === 'env' || cmd === 'printenv') {
      const c = pod.spec.containers[0];
      const env = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOSTNAME=' + pod.metadata.name, 'KUBERNETES_SERVICE_HOST=10.96.0.1', 'KUBERNETES_SERVICE_PORT=443'];
      for (const e of c.env || []) {
        let v = e.value;
        if (e.valueFrom && e.valueFrom.configMapKeyRef) { const cm = find(S, 'ConfigMap', C.nsOf(pod), e.valueFrom.configMapKeyRef.name); v = cm && cm.data ? cm.data[e.valueFrom.configMapKeyRef.key] : ''; }
        if (e.valueFrom && e.valueFrom.secretKeyRef) { const s = find(S, 'Secret', C.nsOf(pod), e.valueFrom.secretKeyRef.name); v = s && s.data ? unb64(s.data[e.valueFrom.secretKeyRef.key]) : ''; }
        env.push(e.name + '=' + v);
      }
      for (const ef of c.envFrom || []) {
        if (ef.configMapRef) { const cm = find(S, 'ConfigMap', C.nsOf(pod), ef.configMapRef.name); for (const k of Object.keys((cm && cm.data) || {})) env.push((ef.prefix || '') + k + '=' + cm.data[k]); }
        if (ef.secretRef) { const s = find(S, 'Secret', C.nsOf(pod), ef.secretRef.name); for (const k of Object.keys((s && s.data) || {})) env.push((ef.prefix || '') + k + '=' + unb64(s.data[k])); }
      }
      const filt = args[1];
      return { out: (filt ? env.filter((l) => l.startsWith(filt + '=')).map((l) => l.split('=').slice(1).join('=')) : env).join('\n') };
    }
    if (cmd === 'cat' || cmd === 'ls') {
      const path = args[args.length - 1];
      const c = pod.spec.containers[0];
      const vm = (c.volumeMounts || []).find((m) => path === m.mountPath || path.startsWith(m.mountPath.replace(/\/$/, '') + '/'));
      if (vm) {
        const vol = (pod.spec.volumes || []).find((v) => v.name === vm.name) || {};
        const rel = path.slice(vm.mountPath.length).replace(/^\//, '');
        let files = {};
        if (vol.configMap) { const cm = find(S, 'ConfigMap', C.nsOf(pod), vol.configMap.name); files = Object.assign({}, (cm && cm.data) || {}); if (vol.configMap.items) { const f2 = {}; for (const it of vol.configMap.items) f2[it.path] = files[it.key]; files = f2; } }
        if (vol.secret) { const s = find(S, 'Secret', C.nsOf(pod), vol.secret.secretName); for (const k of Object.keys((s && s.data) || {})) files[k] = unb64(s.data[k]); }
        if (vol.persistentVolumeClaim || vol.emptyDir || vol.hostPath) files = Object.assign({}, (pod._sim && pod._sim.volFiles && pod._sim.volFiles[vm.name]) || {});
        if (cmd === 'ls') return { out: rel ? (files[rel] !== undefined ? rel : '') : Object.keys(files).join('\n') };
        if (files[rel] === undefined) return { err: 'cat: can\'t open \'' + path + '\': No such file or directory', code: 1 };
        return { out: String(files[rel]).replace(/\n$/, '') };
      }
      if (path === '/etc/resolv.conf') return { out: 'search ' + C.nsOf(pod) + '.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5' };
      if (path === '/etc/hostname') return { out: pod.metadata.name };
      if (pod._sim && pod._sim.files && pod._sim.files[path] !== undefined) return { out: pod._sim.files[path] };
      return { err: cmd + ': ' + path + ': No such file or directory', code: 1 };
    }
    if (cmd === 'hostname') return { out: pod.metadata.name };
    if (cmd === 'echo') return { out: args.slice(1).join(' ') };
    if (cmd === 'id') return { out: 'uid=' + ((pod.spec.securityContext || {}).runAsUser || 0) + ' gid=0(root) groups=0(root)' };
    if (cmd === 'ps') return { out: 'PID   USER     TIME  COMMAND\n    1 root      0:00 ' + ((pod.spec.containers[0].command || [pod.spec.containers[0].image]).join(' ')) };
    if (cmd === 'date') return { out: new Date(S.now).toUTCString() };
    if (cmd === 'sleep' || cmd === 'true') return { out: '' };
    return { err: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "' + cmd + '": executable file not found in $PATH: unknown\ncommand terminated with exit code 126', code: 126 };
  }

  function cmdExec(S, a) {
    const f = a.flags;
    const ns = nsFlag(S, f);
    let name = a.pos[0];
    if (!name) throw new KErr('error: pod, type/name or --filename must be specified');
    let p;
    if (name.includes('/')) { const [tt, nn] = name.split('/'); const def = C.resolveKind(S, tt); if (def.kind === 'Pod') p = getObj(S, def, ns, nn); else { const o = getObj(S, def, ns, nn); p = list(S, 'Pod', ns).find((x) => C.matchLabelSelector(x.metadata.labels, o.spec.selector) && X.podIsReady(x)); } }
    else p = getObj(S, C.defByKind(S, 'Pod'), ns, name);
    if (!p) throw new KErr('error: no se encontró un pod en ejecución');
    if (!X.podIsReady(p) && !(p.status.containerStatuses || []).some((c) => c.state && c.state.running)) throw new KErr('error: unable to upgrade connection: container not found ("' + (p.spec.containers[0] || {}).name + '")');
    if (!a.rest && a.pos.length > 1) return { err: 'error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee \'kubectl exec -h\' for help and examples', code: 1 };
    const cmd = (a.rest || []).map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).join(' ');
    return execSim(S, p, cmd, false);
  }

  function metrics(S) {
    const pm = {};
    for (const p of list(S, 'Pod')) {
      if (!X.podIsReady(p)) continue;
      const sim = p._sim || {};
      const h = parseInt(C.hashStr(p.metadata.name, 4).split('').map((c) => c.charCodeAt(0) % 10).join(''), 10);
      pm[C.nsOf(p) + '/' + p.metadata.name] = { cpu: sim.cpu != null ? sim.cpu : 1 + (h % 9), mem: sim.mem != null ? sim.mem : 5 + (h % 40), containers: sim.containerCpu };
    }
    return pm;
  }

  function cmdTop(S, a) {
    const f = a.flags;
    const what = a.pos[0];
    const pm = metrics(S);
    if (what === 'node' || what === 'nodes' || what === 'no') {
      let nodes = list(S, 'Node');
      if (a.pos[1]) nodes = nodes.filter((n) => n.metadata.name === a.pos[1]);
      let rows = nodes.map((n) => {
        let cpu = n._sim.baseCpu; let mem = n._sim.baseMem;
        for (const p of list(S, 'Pod')) if (p.spec.nodeName === n.metadata.name && pm[C.nsOf(p) + '/' + p.metadata.name]) { cpu += pm[C.nsOf(p) + '/' + p.metadata.name].cpu; mem += pm[C.nsOf(p) + '/' + p.metadata.name].mem; }
        if (!X.nodeReady(n)) return [n.metadata.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>', 0, 0];
        const cap = C.parseCpu(n.status.allocatable.cpu); const mc = C.parseMem(n.status.allocatable.memory);
        return [n.metadata.name, cpu + 'm', Math.round(cpu / cap * 100) + '%', Math.round(mem) + 'Mi', Math.round(mem / mc * 100) + '%', cpu, mem];
      });
      const sb = one(f['sort-by']);
      if (sb === 'cpu') rows.sort((x, y) => y[5] - x[5]);
      if (sb === 'memory') rows.sort((x, y) => y[6] - x[6]);
      rows = rows.map((r) => r.slice(0, 5));
      return { out: C.table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], rows, { noHeaders: f['no-headers'] }) };
    }
    if (what === 'pod' || what === 'pods' || what === 'po') {
      const allNs = !!f['all-namespaces'];
      const ns = nsFlag(S, f);
      let pods = list(S, 'Pod', allNs ? null : ns).filter((p) => pm[C.nsOf(p) + '/' + p.metadata.name]);
      if (a.pos[1]) { pods = pods.filter((p) => p.metadata.name === a.pos[1]); if (!pods.length) throw new KErr('Error from server (NotFound): pods "' + a.pos[1] + '" not found'); }
      if (f.selector) { const s = C.parseSelector(String(one(f.selector))); pods = pods.filter((p) => C.matchParsed(p.metadata.labels, s)); }
      const sb = one(f['sort-by']);
      if (sb === 'cpu') pods.sort((x, y) => pm[C.nsOf(y) + '/' + y.metadata.name].cpu - pm[C.nsOf(x) + '/' + x.metadata.name].cpu);
      if (sb === 'memory') pods.sort((x, y) => pm[C.nsOf(y) + '/' + y.metadata.name].mem - pm[C.nsOf(x) + '/' + x.metadata.name].mem);
      if (!pods.length) return { out: '', err: 'No resources found in ' + ns + ' namespace.' };
      if (f.containers) {
        const rows = [];
        for (const p of pods) for (const c of p.spec.containers) { const m = pm[C.nsOf(p) + '/' + p.metadata.name]; rows.push((allNs ? [C.nsOf(p)] : []).concat([p.metadata.name, c.name, Math.round(m.cpu / p.spec.containers.length) + 'm', Math.round(m.mem / p.spec.containers.length) + 'Mi'])); }
        return { out: C.table((allNs ? ['NAMESPACE'] : []).concat(['POD', 'NAME', 'CPU(cores)', 'MEMORY(bytes)']), rows, { noHeaders: f['no-headers'] }) };
      }
      const rows = pods.map((p) => { const m = pm[C.nsOf(p) + '/' + p.metadata.name]; return (allNs ? [C.nsOf(p)] : []).concat([p.metadata.name, m.cpu + 'm', Math.round(m.mem) + 'Mi']); });
      return { out: C.table((allNs ? ['NAMESPACE'] : []).concat(['NAME', 'CPU(cores)', 'MEMORY(bytes)']), rows, { noHeaders: f['no-headers'] }) };
    }
    throw new KErr('error: unknown command "' + (what || '') + '" for "kubectl top"\nAvailable Commands:\n  node        Display resource (CPU/memory) usage of nodes\n  pod         Display resource (CPU/memory) usage of pods');
  }

  // ------------------------------------------------------------ auth / config / misc
  function cmdAuth(S, a) {
    const f = a.flags;
    if (a.pos[0] === 'whoami') return { out: C.table(['ATTRIBUTE', 'VALUE'], [['Username', 'kubernetes-admin'], ['Groups', '[kubeadm:cluster-admins system:authenticated]']]) };
    if (a.pos[0] !== 'can-i') throw new KErr('error: unknown command "' + a.pos[0] + '" for "kubectl auth"');
    const verb = a.pos[1];
    let res = a.pos[2];
    let name = a.pos[3];
    if (!verb || !res) throw new KErr('error: you must specify two arguments: verb resource or verb resource/resourceName.');
    if (res.includes('/') && !/^pods\/(log|exec|portforward|attach|status)$/.test(res)) { const parts = res.split('/'); res = parts[0]; name = parts[1]; }
    const ns = nsFlag(S, f);
    const as = one(f.as);
    const who = as ? X.parseAs(as, many(f['as-group'])) : { user: 'kubernetes-admin', groups: ['kubeadm:cluster-admins'] };
    const def = C.resolveKind(S, res.split('/')[0]);
    if (!def) return { out: 'Warning: the server doesn\'t have a resource type \'' + res + '\'\nno', code: 1 };
    const ok = X.canI(S, who, verb, res, f['all-namespaces'] ? null : ns, name);
    return { out: ok ? 'yes' : 'no', code: ok ? 0 : 1 };
  }

  function cmdConfig(S, a) {
    const sub = a.pos[0];
    const ctxs = S.contexts || [S.context];
    switch (sub) {
      case 'current-context': return { out: S.context };
      case 'get-contexts': return { out: C.table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ctxs.map((c) => [c === S.context ? '*' : '', c, c.split('@').pop(), c.split('@')[0], c === S.context && S.defaultNs && S.defaultNs !== 'default' ? S.defaultNs : ''])) };
      case 'use-context': {
        const c = a.pos[1];
        if (!ctxs.includes(c)) throw new KErr('error: no context exists with the name: "' + c + '"');
        S.context = c; return { out: 'Switched to context "' + c + '".' };
      }
      case 'set-context': {
        if (a.flags.namespace) S.defaultNs = one(a.flags.namespace);
        return { out: 'Context "' + S.context + '" modified.' };
      }
      case 'view': return { out: X.fsRead(S, S.cpName, '/etc/kubernetes/admin.conf').replace(/certificate-authority-data: .*/, 'certificate-authority-data: DATA+OMITTED') + (S.defaultNs ? '    namespace: ' + S.defaultNs + '\n' : '') };
      case 'get-clusters': return { out: 'NAME\nkubernetes' };
      default: throw new KErr('error: unknown command "' + sub + '" for "kubectl config"');
    }
  }

  function cmdApiResources(S, a) {
    const defs = C.allDefs(S);
    const f = a.flags;
    let rows = defs.map((d) => [d.plural, d.short.join(','), d.apiVersion, String(d.namespaced), d.kind]);
    if (f.namespaced !== undefined) rows = rows.filter((r) => r[3] === String(one(f.namespaced)));
    if (f['api-group'] !== undefined) rows = rows.filter((r) => (r[2].includes('/') ? r[2].split('/')[0] : '') === one(f['api-group']));
    if (one(f.output) === 'name') return { out: rows.map((r) => r[0] + (r[2].includes('/') ? '.' + r[2].split('/')[0] : '')).join('\n') };
    return { out: C.table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], rows) };
  }

  const EXPLAIN = {
    'pod.spec.containers.resources': 'FIELDS:\n  claims\t<[]ResourceClaim>\n  limits\t<map[string]Quantity>\n    Limits describes the maximum amount of compute resources allowed.\n  requests\t<map[string]Quantity>\n    Requests describes the minimum amount of compute resources required.',
    'pod.spec.tolerations': 'FIELDS:\n  effect\t<string>\n  key\t<string>\n  operator\t<string> (Exists | Equal)\n  tolerationSeconds\t<integer>\n  value\t<string>',
  };

  function cmdExplain(S, a) {
    const path = a.pos[0];
    if (!path) throw new KErr('error: You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
    const parts = path.split('.');
    const def = C.resolveKind(S, parts[0]);
    if (!def) throw new KErr('error: couldn\'t find resource for "' + parts[0] + '"');
    const rest = parts.slice(1);
    if (def.crd) {
      const v = (def.crd.spec.versions || [])[0] || {};
      let schema = v.schema && v.schema.openAPIV3Schema;
      for (const p of rest) { schema = schema && schema.properties && schema.properties[p]; }
      if (!schema) throw new KErr('error: field "' + rest.join('.') + '" does not exist');
      const lines = ['GROUP:      ' + def.group, 'KIND:       ' + def.kind, 'VERSION:    ' + v.name, '', 'FIELD: ' + (rest[rest.length - 1] || def.kind) + ' <' + (schema.type || 'Object') + '>', '', 'DESCRIPTION:', '    ' + (schema.description || '<empty>')];
      if (schema.properties) { lines.push('', 'FIELDS:'); for (const k of Object.keys(schema.properties)) { const s = schema.properties[k]; lines.push('  ' + k + '\t<' + (s.type || 'Object') + '>' + ((schema.required || []).includes(k) ? ' -required-' : '')); lines.push('    ' + (s.description || '<no description>')); lines.push(''); } }
      return { out: lines.join('\n') };
    }
    const key = [def.singular].concat(rest).join('.');
    if (EXPLAIN[key]) return { out: 'KIND:       ' + def.kind + '\nVERSION:    ' + def.apiVersion.split('/').pop() + '\n\nFIELD: ' + rest[rest.length - 1] + '\n\n' + EXPLAIN[key] };
    return { out: 'GROUP:      ' + def.group + '\nKIND:       ' + def.kind + '\nVERSION:    ' + def.apiVersion.split('/').pop() + '\n\n' + (rest.length ? 'FIELD: ' + rest[rest.length - 1] + '\n\n' : '') + 'DESCRIPTION:\n    (Simulador) Consulta la estructura con "kubectl explain ' + path + ' --recursive" en un clúster real o en la documentación oficial.' };
  }

  function cmdCertificate(S, a) {
    const sub = a.pos[0]; const name = a.pos[1];
    const csr = getObj(S, C.defByKind(S, 'CertificateSigningRequest'), null, name);
    csr.status = csr.status || {};
    if (sub === 'approve') { csr.status.conditions = [{ type: 'Approved', status: 'True', reason: 'KubectlApprove' }]; csr.status.certificate = b64('-----BEGIN CERTIFICATE-----\nMII(simulado)\n-----END CERTIFICATE-----\n'); return { out: 'certificatesigningrequest.certificates.k8s.io/' + name + ' approved' }; }
    if (sub === 'deny') { csr.status.conditions = [{ type: 'Denied', status: 'True', reason: 'KubectlDeny' }]; return { out: 'certificatesigningrequest.certificates.k8s.io/' + name + ' denied' }; }
    throw new KErr('error: unknown command "' + sub + '"');
  }

  // ------------------------------------------------------------ despachador
  const HELP = 'kubectl controls the Kubernetes cluster manager.\n\n Find more information at: https://kubernetes.io/docs/reference/kubectl/\n\nBasic Commands (Beginner):\n  create, expose, run, set\n\nBasic Commands (Intermediate):\n  explain, get, edit, delete\n\nDeploy Commands:\n  rollout, scale, autoscale\n\nCluster Management Commands:\n  certificate, cluster-info, top, cordon, uncordon, drain, taint\n\nTroubleshooting and Debugging Commands:\n  describe, logs, attach, exec, port-forward, proxy, cp, auth, debug, events\n\nAdvanced Commands:\n  diff, apply, patch, replace, wait, kustomize\n\nSettings Commands:\n  label, annotate, completion\n\nOther Commands:\n  api-resources, api-versions, config, plugin, version';

  function kubectl(S, argv, ctx) {
    ctx = ctx || {};
    if (S.host === 'base') {
      return { err: 'E1003 14:00:00.000000   memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?', code: 1, hint: 'NOHOST' };
    }
    const isNode = S.host !== S.taskHost && S.host !== S.cpName;
    const kcfg = (S.user === 'root' ? '/root/.kube/config' : '/home/candidate/.kube/config');
    if (isNode && !(S.env.KUBECONFIG && X.fsRead(S, S.host, S.env.KUBECONFIG)) && X.fsRead(S, S.host, kcfg) == null) {
      return { err: 'E1003 14:00:00.000000 memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?', code: 1, hint: 'WORKERKUBECTL' };
    }
    if (argv.includes('patch')) argv = argv.map((x) => (x === '-p' ? '--patch' : x));
    const a = parseArgs(argv);
    const verb = a.pos.shift();
    if (!verb || verb === 'help' || a.flags.help) return { out: HELP };
    if (verb === 'version') {
      const cp = find(S, 'Node', null, S.cpName);
      const kv = cp ? cp._sim.pkgs.kubectl : S.version.slice(1);
      if (a.flags.client) return { out: 'Client Version: v' + kv + '\nKustomize Version: v5.7.1' };
      if (!S.cp.apiserver || !S.cp.apiserver.ok) return { out: 'Client Version: v' + kv + '\nKustomize Version: v5.7.1', err: 'The connection to the server ' + S.cpIP + ':6443 was refused - did you specify the right host or port?', code: 1 };
      return { out: 'Client Version: v' + kv + '\nKustomize Version: v5.7.1\nServer Version: ' + (S.serverVersion || S.version) };
    }
    if (verb === 'config') return cmdConfig(S, a);
    if (verb === 'kustomize') { const objs = kustomizeBuild(S, a.pos[0] || '.'); return { out: objs.map((o) => C.toYaml(o)).join('---\n').replace(/\n$/, '') }; }
    if (verb === 'completion') return { out: '# bash completion for kubectl (ya está habilitado en el simulador; usa Tab)' };
    if (!S.cp.apiserver || !S.cp.apiserver.ok) {
      return { err: 'E1003 14:00:00.000000   memcache.go:265] couldn\'t get current server API group list: Get "https://' + S.cpIP + ':6443/api?timeout=32s": dial tcp ' + S.cpIP + ':6443: connect: connection refused\nThe connection to the server ' + S.cpIP + ':6443 was refused - did you specify the right host or port?', code: 1, hint: 'APIDOWN' };
    }
    const mut = ['create', 'apply', 'delete', 'run', 'expose', 'scale', 'set', 'label', 'annotate', 'taint', 'cordon', 'uncordon', 'drain', 'patch', 'replace', 'rollout', 'autoscale', 'edit', 'certificate'];
    let res;
    switch (verb) {
      case 'get': res = cmdGet(S, a); break;
      case 'describe': res = cmdDescribe(S, a); break;
      case 'create': res = cmdCreate(S, a, ctx); break;
      case 'apply': res = cmdApplyLike(S, a, ctx, 'apply'); break;
      case 'replace': res = cmdApplyLike(S, a, ctx, 'replace'); break;
      case 'delete': res = cmdDelete(S, a, ctx); break;
      case 'run': res = cmdRun(S, a); break;
      case 'expose': res = cmdExpose(S, a); break;
      case 'scale': res = cmdScale(S, a); break;
      case 'autoscale': res = cmdAutoscale(S, a); break;
      case 'set': res = cmdSet(S, a); break;
      case 'rollout': res = cmdRollout(S, a); break;
      case 'label': res = cmdLabelAnnotate(S, a, 'labels'); break;
      case 'annotate': res = cmdLabelAnnotate(S, a, 'annotations'); break;
      case 'taint': res = cmdTaint(S, a); break;
      case 'cordon': res = cmdCordon(S, a, true); break;
      case 'uncordon': res = cmdCordon(S, a, false); break;
      case 'drain': res = cmdDrain(S, a); break;
      case 'patch': res = cmdPatch(S, a); break;
      case 'edit': res = cmdEdit(S, a, ctx); break;
      case 'logs': res = cmdLogs(S, a); break;
      case 'exec': res = cmdExec(S, a); break;
      case 'top': res = cmdTop(S, a); break;
      case 'auth': res = cmdAuth(S, a); break;
      case 'api-resources': res = cmdApiResources(S, a); break;
      case 'api-versions': res = { out: Array.from(new Set(C.allDefs(S).map((d) => d.apiVersion))).sort().join('\n') }; break;
      case 'explain': res = cmdExplain(S, a); break;
      case 'certificate': res = cmdCertificate(S, a); break;
      case 'events': { a.pos.unshift('events'); res = cmdGet(S, a); break; }
      case 'cluster-info': res = { out: 'Kubernetes control plane is running at https://' + S.cpIP + ':6443\nCoreDNS is running at https://' + S.cpIP + ':6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.' }; break;
      case 'wait': res = { out: (a.pos[0] || 'resource') + ' condition met' }; break;
      case 'diff': res = { out: '' }; break;
      case 'debug': res = { out: 'Creating debugging pod node-debugger-' + (a.pos[0] || '').replace('node/', '') + '-' + C.rand(5) + ' with container debugger on node ' + (a.pos[0] || '').replace('node/', '') + '.\n(simulado) Usa "ssh <nodo>" para depurar el nodo en este laboratorio.' }; break;
      case 'port-forward': res = { out: 'Forwarding from 127.0.0.1:' + String(a.pos[1] || '8080').split(':')[0] + ' -> ' + String(a.pos[1] || '80').split(':').pop() + '\n(simulado: el túnel no permanece abierto)' }; break;
      case 'cp': res = { out: '' }; break;
      default:
        throw new KErr('error: unknown command "' + verb + '" for "kubectl"\n\nDid you mean this?\n\t' + (['get', 'describe', 'create', 'apply', 'delete'].find((x) => x[0] === verb[0]) || 'get'));
    }
    if (a.flags.record && ['patch', 'set', 'scale', 'apply', 'annotate', 'label', 'rollout'].includes(verb)) {
      try {
        const tp = verb === 'set' || verb === 'rollout' ? a.pos.slice(1) : a.pos;
        const t = splitTypeName(S, tp.filter((x) => !x.includes('=')))[0];
        const o = t && t.name && find(S, t.def.kind, t.def.namespaced ? nsFlag(S, a.flags) : null, t.name);
        if (o) { o.metadata.annotations = Object.assign({}, o.metadata.annotations, { 'kubernetes.io/change-cause': 'kubectl ' + argv.join(' ') }); }
      } catch (e) { /* ignorar */ }
      res.err = (res.err ? res.err + '\n' : '') + 'Flag --record has been deprecated, --record will be removed in the future';
    }
    if (mut.includes(verb) && !res.editor) X.reconcile(S);
    return res;
  }

  CKA.kubectl = {
    run(S, argv, ctx) {
      try { return kubectl(S, argv, ctx); } catch (e) {
        if (e instanceof KErr) return { err: e.message, code: typeof e.code === 'string' ? 1 : e.code, kind: typeof e.code === 'string' ? e.code : undefined };
        return { err: 'error: ' + (e && e.message ? e.message : String(e)) + '\n(error interno del simulador — repórtalo si parece un fallo)', code: 1 };
      }
    },
    parseArgs, kustomizeBuild, applyObject, describe, publicObj, b64, unb64, _execSim: execSim, KErr, strategicMerge,
  };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
