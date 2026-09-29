/* Kubelab CKA — banco de tareas prácticas.
   Las 17 preguntas del PDF «CKA Exam» + tareas nuevas alineadas al currículo CKA 2026 (Kubernetes v1.35). */
(function (CKA) {
  'use strict';
  const C = CKA.core;
  const X = CKA.sim;
  const { find, list, put } = C;
  const AGE = 3 * 3600000;

  // ------------------------------------------------------------ helpers de preparación
  function ns(S, name, labels) {
    return put(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: Object.assign({ 'kubernetes.io/metadata.name': name }, labels || {}) }, status: { phase: 'Active' } }, { ageMs: AGE });
  }
  function deploy(S, nsName, name, image, replicas, o) {
    o = o || {};
    const labels = o.labels || { app: name };
    const containers = o.containers || [Object.assign({ name: o.cname || name, image }, o.ports ? { ports: o.ports } : {}, o.command ? { command: o.command } : {}, o.resources ? { resources: o.resources } : {}, o.env ? { env: o.env } : {}, o.volumeMounts ? { volumeMounts: o.volumeMounts } : {})];
    const spec = Object.assign({ containers }, o.podSpec || {});
    return put(S, {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name, namespace: nsName, labels: Object.assign({}, labels), annotations: o.annotations },
      spec: { replicas: replicas == null ? 1 : replicas, selector: { matchLabels: Object.assign({}, labels) }, template: { metadata: { labels: Object.assign({}, labels) }, spec } },
      _sim: o.sim ? { podSim: o.sim } : {},
    }, { ageMs: AGE });
  }
  function pod(S, nsName, name, image, o) {
    o = o || {};
    const c = Object.assign({ name: o.cname || name, image }, o.command ? { command: o.command } : {}, o.ports ? { ports: o.ports } : {}, o.resources ? { resources: o.resources } : {}, o.volumeMounts ? { volumeMounts: o.volumeMounts } : {}, o.env ? { env: o.env } : {});
    if (o.sim) { S.podSimByName = S.podSimByName || {}; S.podSimByName[nsName + '/' + name] = o.sim; }
    return put(S, { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: nsName, labels: o.labels || { run: name } }, spec: Object.assign({ containers: o.containers || [c], restartPolicy: 'Always', serviceAccountName: 'default' }, o.spec || {}), status: {} }, { ageMs: AGE });
  }
  function service(S, nsName, name, selector, port, targetPort, type, extra) {
    return put(S, { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: nsName, labels: { app: name } }, spec: Object.assign({ type: type || 'ClusterIP', selector, ports: [{ port, targetPort: targetPort == null ? port : targetPort, protocol: 'TCP' }] }, extra || {}) }, { ageMs: AGE });
  }
  function file(S, host, path, content) { X.fsWrite(S, host === 'cp' ? S.cpName : host, path, content); }
  function exec(S, script) {
    const saved = { host: S.host, user: S.user, cwd: S.cwd, stack: S.hostStack };
    S.host = S.cpName; S.user = 'root'; S.cwd = '/root'; S.hostStack = [];
    const r = CKA.shell.runLine(S, script, { depth: 1 });
    Object.assign(S, { host: saved.host, user: saved.user, cwd: saved.cwd, hostStack: saved.stack });
    X.reconcile(S);
    return r;
  }
  function busybox(cmd) { return ['/bin/sh', '-c', cmd || 'sleep 3600']; }
  function sc(S, name, provisioner, o) {
    o = o || {};
    return put(S, Object.assign({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name, annotations: o.default ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : undefined }, provisioner, reclaimPolicy: o.reclaimPolicy || 'Delete', volumeBindingMode: o.mode || 'Immediate' }, o.expand ? { allowVolumeExpansion: true } : {}), { ageMs: AGE });
  }
  function ingressClass(S, name, isDefault) {
    return put(S, { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name, annotations: isDefault ? { 'ingressclass.kubernetes.io/is-default-class': 'true' } : undefined }, spec: { controller: 'k8s.io/ingress-nginx' } }, { ageMs: AGE });
  }

  // ------------------------------------------------------------ helpers de verificación
  const H = {
    get: (S, k, n, name) => find(S, k, n, name),
    file: (S, host, path) => X.fsRead(S, host === 'cp' ? S.cpName : host, path),
    pods: (S, n, labels) => list(S, 'Pod', n).filter((p) => !labels || C.matchMap(p.metadata.labels, labels)),
    ready: (p) => !!p && X.podIsReady(p),
    allReady: (S, n, labels, count) => { const ps = H.pods(S, n, labels); return ps.length === (count == null ? ps.length : count) && ps.length > 0 && ps.every(X.podIsReady); },
    deployReady: (S, n, name, count) => { const d = find(S, 'Deployment', n, name); if (!d) return false; const want = count == null ? d.spec.replicas : count; return d.spec.replicas === want && (d.status.readyReplicas || 0) === want && X.ownedBy(S, 'ReplicaSet', d).filter((r) => r.spec.replicas > 0).every((r) => X.ownedBy(S, 'Pod', r).every(X.podIsReady)); },
    can: (S, as, verb, res, n) => X.canI(S, X.parseAs(as), verb, res, n),
    net: (S, fromNs, fromPod, toNs, toPod, port) => { const a = find(S, 'Pod', fromNs, fromPod); const b = find(S, 'Pod', toNs, toPod); if (!a || !b) return false; return X.netAllowed(S, a, b, port).ok; },
    http: (S, fromNs, fromPod, url, host, resolve) => { const a = fromNs ? find(S, 'Pod', fromNs, fromPod) : null; if (fromNs && !a) return { err: 'no pod' }; return X.httpRequest(S, a, url, host, resolve); },
    ctr: (spec, name) => ((spec && spec.containers) || []).concat((spec && spec.initContainers) || []).find((c) => c.name === name),
    cmd: (c) => (c ? (c.command || []).concat(c.args || []).join(' ') : ''),
    node: (S, name) => find(S, 'Node', null, name),
    nodeReady: (S, name) => { const n = find(S, 'Node', null, name); return !!n && X.nodeReady(n); },
    podTpl: (d) => (d && d.spec && d.spec.template && d.spec.template.spec) || {},
    trim: (s) => (s == null ? null : String(s).trim()),
  };

  // ------------------------------------------------------------ dominios
  const DOMAINS = {
    trbl: { name: 'Troubleshooting', pct: 30, color: 'crit' },
    arch: { name: 'Arquitectura, instalación y configuración del clúster', pct: 25, color: 'a1' },
    net: { name: 'Servicios y redes', pct: 20, color: 'a2' },
    work: { name: 'Workloads y scheduling', pct: 15, color: 'a3' },
    stor: { name: 'Almacenamiento', pct: 10, color: 'a4' },
  };

  const T = [];
  const add = (t) => { t.n = T.length + 1; T.push(t); };

  // =====================================================================================
  //                                PREGUNTAS DEL PDF (Topic 1)
  // =====================================================================================

  add({
    id: 'pdf01', src: 'PDF #1', domain: 'arch', weight: 7, mins: 7, host: 'cka1024',
    title: 'RBAC: ClusterRole para un pipeline de despliegue',
    context: 'You have been asked to create a new ClusterRole for a deployment pipeline and bind it to a specific ServiceAccount scoped to a specific namespace.',
    task: [
      'Create a new ClusterRole named `deployment-clusterrole`, which only allows to **create** the following resource types:',
      '- Deployment', '- StatefulSet', '- DaemonSet',
      'Create a new ServiceAccount named `cicd-token` in the existing namespace `app-team1`.',
      'Bind the new ClusterRole `deployment-clusterrole` to the new ServiceAccount `cicd-token`, **limited to the namespace** `app-team1`.',
    ],
    es: 'ClusterRole que solo permita *create* sobre deployments, statefulsets y daemonsets; ServiceAccount cicd-token en app-team1; vincúlalos **solo** dentro de app-team1.',
    setup(S) { ns(S, 'app-team1'); },
    checks: [
      { t: 'La ClusterRole deployment-clusterrole existe y solo tiene el verbo create', fn: (S) => { const r = find(S, 'ClusterRole', null, 'deployment-clusterrole'); return !!r && (r.rules || []).length > 0 && r.rules.every((x) => (x.verbs || []).length === 1 && x.verbs[0] === 'create'); } },
      { t: 'Permite create sobre deployments, statefulsets y daemonsets (grupo apps)', fn: (S) => ['deployments', 'statefulsets', 'daemonsets'].every((res) => (find(S, 'ClusterRole', null, 'deployment-clusterrole') || { rules: [] }).rules.some((r) => (r.apiGroups || []).some((g) => g === 'apps' || g === '*') && ((r.resources || []).includes(res) || (r.resources || []).includes('*')))) },
      { t: 'Existe el ServiceAccount cicd-token en app-team1', fn: (S) => !!find(S, 'ServiceAccount', 'app-team1', 'cicd-token') },
      { t: 'cicd-token puede crear Deployments en app-team1', fn: (S) => H.can(S, 'system:serviceaccount:app-team1:cicd-token', 'create', 'deployments', 'app-team1') && H.can(S, 'system:serviceaccount:app-team1:cicd-token', 'create', 'daemonsets', 'app-team1') },
      { t: 'El permiso está limitado a app-team1 (RoleBinding, no ClusterRoleBinding)', fn: (S) => !H.can(S, 'system:serviceaccount:app-team1:cicd-token', 'create', 'deployments', 'default') && list(S, 'RoleBinding', 'app-team1').some((b) => b.roleRef.name === 'deployment-clusterrole') },
    ],
    hints: ['`kubectl create clusterrole -h` muestra el ejemplo exacto con --verb y --resource.', '“Limited to the namespace” = RoleBinding en ese namespace que referencia la ClusterRole.', 'Verifica con `kubectl auth can-i create deployments -n app-team1 --as=system:serviceaccount:app-team1:cicd-token`.'],
    solution: [
      'kubectl create clusterrole deployment-clusterrole --verb=create --resource=deployments,statefulsets,daemonsets',
      'kubectl -n app-team1 create serviceaccount cicd-token',
      'kubectl -n app-team1 create rolebinding deployment-clusterrole-binding --clusterrole=deployment-clusterrole --serviceaccount=app-team1:cicd-token',
      'kubectl auth can-i create deployments -n app-team1 --as=system:serviceaccount:app-team1:cicd-token',
      'kubectl auth can-i create deployments -n default --as=system:serviceaccount:app-team1:cicd-token',
    ],
    explain: 'Una ClusterRole no tiene namespace; lo que define el alcance es el binding. Una **RoleBinding** que apunta a una ClusterRole concede esos permisos solo en el namespace del RoleBinding. Una ClusterRoleBinding los daría en todo el clúster (error típico en este ejercicio). Los recursos Deployment/StatefulSet/DaemonSet están en el grupo `apps`; `kubectl create clusterrole` lo resuelve solo.',
    docs: ['https://kubernetes.io/docs/reference/access-authn-authz/rbac/#command-line-utilities'],
    coach(ev) { if (ev.kubectl && ev.args[0] === 'create' && ev.args[1] === 'clusterrolebinding') return 'Ojo: una ClusterRoleBinding da el permiso en TODO el clúster. La tarea pide limitarlo a app-team1 → usa `kubectl create rolebinding ... --clusterrole=deployment-clusterrole -n app-team1`.'; return null; },
  });

  add({
    id: 'pdf02', src: 'PDF #2', domain: 'arch', weight: 4, mins: 4, host: 'cka2053',
    cluster: { workers: ['ek8s-node-0', 'ek8s-node-1'] },
    title: 'Mantenimiento: drenar un nodo',
    task: ['Set the node named `ek8s-node-0` as unavailable and reschedule all the pods running on it.'],
    es: 'Marca ek8s-node-0 como no programable y reubica todos sus pods.',
    setup(S) {
      deploy(S, 'default', 'web', 'nginx:1.29', 4);
      deploy(S, 'default', 'cache', 'redis:7.4', 2, { podSpec: { volumes: [{ name: 'tmp', emptyDir: {} }] }, volumeMounts: [{ name: 'tmp', mountPath: '/data' }] });
      pod(S, 'default', 'debug-shell', 'busybox:1.36', { command: busybox(), spec: { nodeName: 'ek8s-node-0' } });
    },
    checks: [
      { t: 'ek8s-node-0 está marcado como SchedulingDisabled', fn: (S) => !!(H.node(S, 'ek8s-node-0') || { spec: {} }).spec.unschedulable },
      { t: 'No quedan pods de aplicación en ek8s-node-0 (solo DaemonSets)', fn: (S) => list(S, 'Pod').filter((p) => p.spec.nodeName === 'ek8s-node-0').every((p) => (p.metadata.ownerReferences || []).some((r) => r.kind === 'DaemonSet' || r.kind === 'Node')) },
      { t: 'Los Deployments web y cache siguen con todas sus réplicas Ready', fn: (S) => H.deployReady(S, 'default', 'web', 4) && H.deployReady(S, 'default', 'cache', 2) },
    ],
    hints: ['`kubectl drain` ya hace cordon; no hace falta cordon por separado.', 'Si falla, lee el mensaje: te dice qué flag necesitas (--ignore-daemonsets, --delete-emptydir-data, --force).'],
    solution: ['kubectl get pods -o wide', 'kubectl drain ek8s-node-0 --ignore-daemonsets --delete-emptydir-data --force', 'kubectl get nodes'],
    explain: '`drain` = cordon + evicción. Los pods de DaemonSet no se pueden desalojar (se ignoran con --ignore-daemonsets), los que usan emptyDir pierden datos (--delete-emptydir-data) y los pods sin controlador se borran para siempre (--force). No hagas `uncordon`: la tarea pide dejar el nodo no disponible.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/'],
  });

  add({
    id: 'pdf03', src: 'PDF #3', domain: 'arch', weight: 7, mins: 12, host: 'mk8s-master-0',
    cluster: { cp: 'mk8s-master-0', workers: ['mk8s-node-0'], version: 'v1.35.1' },
    title: 'Actualizar el plano de control con kubeadm',
    task: [
      'Given an existing Kubernetes cluster running version `1.35.1`, upgrade all of the Kubernetes control plane and node components on the **master node only** to version `1.35.2`.',
      'Be sure to drain the master node before upgrading it and uncordon it after the upgrade.',
      'You are also expected to upgrade **kubelet** and **kubectl** on the master node.',
      'Do not upgrade the worker nodes, etcd, the container manager, the CNI plugin, the DNS service or any other addons.',
    ],
    es: 'Actualiza el nodo maestro de 1.35.1 a 1.35.2 (kubeadm, plano de control, kubelet, kubectl). Drena antes y uncordon después. No actualices etcd ni los workers.',
    setup(S) { deploy(S, 'default', 'app', 'nginx:1.29', 2); },
    checks: [
      { t: 'El plano de control reporta la versión v1.35.2', fn: (S) => S.serverVersion === 'v1.35.2' },
      { t: 'kubeadm, kubelet y kubectl del maestro están en 1.35.2', fn: (S) => { const n = H.node(S, 'mk8s-master-0'); return !!n && ['kubeadm', 'kubelet', 'kubectl'].every((k) => n._sim.pkgs[k] === '1.35.2'); } },
      { t: 'El kubelet del maestro se reinició con la nueva versión (daemon-reload + restart)', fn: (S) => (H.node(S, 'mk8s-master-0') || { _sim: {} })._sim.runningKubelet === '1.35.2' && H.nodeReady(S, 'mk8s-master-0') },
      { t: 'El maestro estaba drenado durante el upgrade y quedó uncordoned', fn: (S) => S.flags.upgradeWhileCordoned === true && !(H.node(S, 'mk8s-master-0') || { spec: {} }).spec.unschedulable },
      { t: 'etcd no se actualizó (--etcd-upgrade=false)', fn: (S) => S.flags.etcdUpgrade === false },
      { t: 'El worker mk8s-node-0 sigue en 1.35.1', fn: (S) => (H.node(S, 'mk8s-node-0') || { _sim: { pkgs: {} } })._sim.pkgs.kubelet === '1.35.1' },
    ],
    hints: ['Sigue la guía oficial “Upgrading kubeadm clusters” (está permitida en el examen).', 'Orden: drain → kubeadm (unhold/install/hold) → kubeadm upgrade apply → kubelet+kubectl → daemon-reload + restart kubelet → uncordon.', 'Los paquetes están retenidos (apt-mark hold).'],
    solution: [
      'kubectl drain mk8s-master-0 --ignore-daemonsets',
      'sudo -i',
      'apt-mark unhold kubeadm && apt-get update && apt-get install -y kubeadm=1.35.2-1.1 && apt-mark hold kubeadm',
      'kubeadm version -o short',
      'kubeadm upgrade plan',
      'kubeadm upgrade apply v1.35.2 --etcd-upgrade=false -y',
      'apt-mark unhold kubelet kubectl && apt-get install -y kubelet=1.35.2-1.1 kubectl=1.35.2-1.1 && apt-mark hold kubelet kubectl',
      'systemctl daemon-reload && systemctl restart kubelet',
      'exit',
      'kubectl uncordon mk8s-master-0',
      'kubectl get nodes',
    ],
    explain: 'kubeadm debe actualizarse primero porque `kubeadm upgrade apply` no puede subir a una versión mayor que la suya. `--etcd-upgrade=false` respeta la restricción de no tocar etcd. El kubelet nuevo solo corre después de `systemctl daemon-reload` y `restart`. En el examen actual te conectas por ssh al host de la pregunta; muchas veces ese host ya es el nodo maestro.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/'],
  });

  add({
    id: 'pdf04', src: 'PDF #4', domain: 'arch', weight: 7, mins: 12, host: 'cka3962',
    title: 'Respaldo y restauración de etcd',
    task: [
      'First, create a snapshot of the existing etcd instance running at `https://127.0.0.1:2379`, saving the snapshot to `/var/lib/backup/etcd-snapshot.db`.',
      'Next, restore an existing, previous snapshot located at `/var/lib/backup/etcd-snapshot-previous.db`.',
      'The following TLS certificates/key are supplied for connecting to the server with etcdctl:',
      '- CA certificate: `/opt/KUIN00601/ca.crt`', '- Client certificate: `/opt/KUIN00601/etcd-client.crt`', '- Client key: `/opt/KUIN00601/etcd-client.key`',
    ],
    es: 'Crea un snapshot de etcd en /var/lib/backup/etcd-snapshot.db y luego restaura el snapshot previo /var/lib/backup/etcd-snapshot-previous.db (el clúster debe quedar usando los datos restaurados).',
    setup(S) {
      S.etcdCertAlias = { ca: '/opt/KUIN00601/ca.crt', cert: '/opt/KUIN00601/etcd-client.crt', key: '/opt/KUIN00601/etcd-client.key' };
      file(S, 'cp', '/opt/KUIN00601/ca.crt', '(CA de etcd)\n');
      file(S, 'cp', '/opt/KUIN00601/etcd-client.crt', '(certificado cliente de etcd)\n');
      file(S, 'cp', '/opt/KUIN00601/etcd-client.key', '(llave cliente de etcd)\n');
      X.mkdirp(X.fsOf(S, S.cpName), '/var/lib/backup');
      ns(S, 'restore-check');
      deploy(S, 'restore-check', 'legacy-app', 'nginx:1.27', 1);
      X.reconcile(S);
      S.snapshots[S.cpName + ':/var/lib/backup/etcd-snapshot-previous.db'] = C.clone(S.objs);
      file(S, 'cp', '/var/lib/backup/etcd-snapshot-previous.db', '(snapshot binario de etcd anterior)');
      C.remove(S, find(S, 'Namespace', null, 'restore-check'));
      for (const o of S.objs.slice()) if (C.nsOf(o) === 'restore-check') C.remove(S, o);
      ns(S, 'post-backup');
      deploy(S, 'default', 'current-app', 'nginx:1.29', 2);
    },
    checks: [
      { t: 'Existe el snapshot /var/lib/backup/etcd-snapshot.db tomado con etcdctl', fn: (S) => !!S.snapshots[S.cpName + ':/var/lib/backup/etcd-snapshot.db'] },
      { t: 'Se restauró etcd-snapshot-previous.db en un directorio de datos nuevo', fn: (S) => S.etcd.restoredFrom === '/var/lib/backup/etcd-snapshot-previous.db' || S.flags.restoredFrom === '/var/lib/backup/etcd-snapshot-previous.db' },
      { t: 'etcd y el API server usan los datos restaurados (existe el namespace restore-check)', fn: (S) => S.cp.apiserver.ok && S.etcd.restoredFrom === '/var/lib/backup/etcd-snapshot-previous.db' && !!find(S, 'Namespace', null, 'restore-check') },
    ],
    hints: ['Toma --endpoints, --cacert, --cert y --key del enunciado.', 'En etcd 3.6 la restauración se hace con `etcdutl snapshot restore ... --data-dir <nuevo-dir>`.', 'Después apunta el volumen `etcd-data` (hostPath) de /etc/kubernetes/manifests/etcd.yaml al nuevo directorio y espera a que el API server vuelva.'],
    solution: [
      'sudo -i',
      'ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/opt/KUIN00601/ca.crt --cert=/opt/KUIN00601/etcd-client.crt --key=/opt/KUIN00601/etcd-client.key snapshot save /var/lib/backup/etcd-snapshot.db',
      'etcdutl snapshot restore /var/lib/backup/etcd-snapshot-previous.db --data-dir /var/lib/etcd-restore',
      "sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd-restore#' /etc/kubernetes/manifests/etcd.yaml",
      'grep -A2 etcd-data /etc/kubernetes/manifests/etcd.yaml',
      'kubectl get ns',
    ],
    explain: 'Un restore crea un directorio de datos NUEVO; no sirve de nada si etcd sigue leyendo /var/lib/etcd. Lo más seguro es cambiar solo el `hostPath` del volumen `etcd-data` en el manifiesto estático: kubelet recrea el pod de etcd y el API server vuelve con los datos restaurados. Si restauras sin `--data-dir`, se crea `default.etcd` en tu directorio actual (trampa frecuente). Los certificados de etcd requieren root.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/#backing-up-an-etcd-cluster'],
  });

  add({
    id: 'pdf05', src: 'PDF #5', domain: 'net', weight: 7, mins: 7, host: 'cka4174',
    title: 'NetworkPolicy: permitir un puerto desde otro namespace',
    task: [
      'Create a new NetworkPolicy named `allow-port-from-namespace` in the existing namespace `fubar`.',
      'Ensure that the new NetworkPolicy allows Pods in namespace `internal` to connect to port `9000` of Pods in namespace `fubar`.',
      'Further ensure that the new NetworkPolicy:',
      '- does not allow access to Pods, which don\'t listen on port 9000',
      '- does not allow access from Pods, which are not in namespace internal',
    ],
    es: 'NetworkPolicy en fubar que solo permita tráfico entrante al puerto 9000 desde pods del namespace internal.',
    setup(S) {
      ns(S, 'fubar'); ns(S, 'internal'); ns(S, 'external');
      deploy(S, 'fubar', 'api', 'nginx:1.29', 1, { ports: [{ containerPort: 9000 }], sim: { listen: [9000], body: 'api on 9000' } });
      pod(S, 'fubar', 'web-9000', 'nginx:1.29', { labels: { app: 'web' }, ports: [{ containerPort: 9000 }], sim: { listen: [9000], body: 'fubar app on 9000' } });
      pod(S, 'fubar', 'legacy-80', 'nginx:1.29', { labels: { app: 'legacy' }, ports: [{ containerPort: 80 }] });
      pod(S, 'internal', 'client', 'busybox:1.36', { command: busybox() });
      pod(S, 'external', 'intruder', 'busybox:1.36', { command: busybox() });
    },
    checks: [
      { t: 'Existe la NetworkPolicy allow-port-from-namespace en fubar', fn: (S) => !!find(S, 'NetworkPolicy', 'fubar', 'allow-port-from-namespace') },
      { t: 'internal/client puede conectar a fubar/web-9000:9000', fn: (S) => H.net(S, 'internal', 'client', 'fubar', 'web-9000', 9000) },
      { t: 'external/intruder NO puede conectar a fubar/web-9000:9000', fn: (S) => !H.net(S, 'external', 'intruder', 'fubar', 'web-9000', 9000) },
      { t: 'internal/client NO puede conectar a otros puertos (legacy-80:80)', fn: (S) => !H.net(S, 'internal', 'client', 'fubar', 'legacy-80', 80) },
    ],
    hints: ['El namespace internal ya tiene la etiqueta automática `kubernetes.io/metadata.name=internal` (`kubectl get ns internal --show-labels`).', '`podSelector: {}` selecciona todos los pods de fubar.', 'Prueba: `kubectl -n internal exec client -- wget -qO- -T2 web-9000...` o con la IP del pod.'],
    solution: [
      "cat <<EOF | kubectl apply -f -\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-port-from-namespace\n  namespace: fubar\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: internal\n    ports:\n    - protocol: TCP\n      port: 9000\nEOF",
      'kubectl -n fubar describe networkpolicy allow-port-from-namespace',
    ],
    explain: 'Al seleccionar los pods de fubar con una política de Ingress, todo el tráfico entrante no permitido explícitamente queda bloqueado. `from` + `ports` en la MISMA regla significa “desde internal Y solo al 9000”. Si pones `ports` en otra regla separada abrirías el 9000 a todo el mundo.',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/network-policies/'],
  });

  add({
    id: 'pdf06', src: 'PDF #6', domain: 'net', weight: 7, mins: 7, host: 'cka5248',
    title: 'Puerto con nombre + Service NodePort',
    task: [
      'Reconfigure the existing deployment `front-end` and add a port specification named `http` exposing port `80/tcp` of the existing container `nginx`.',
      'Create a new service named `front-end-svc` exposing the container port `http`.',
      'Configure the new service to also expose the individual Pods via a **NodePort** on the nodes on which they are scheduled.',
    ],
    es: 'Agrega el puerto con nombre http (80/TCP) al contenedor nginx del deployment front-end y crea el Service NodePort front-end-svc apuntando a ese puerto.',
    setup(S) { deploy(S, 'default', 'front-end', 'nginx:1.29', 2, { cname: 'nginx' }); },
    checks: [
      { t: 'El contenedor nginx declara el puerto http 80/TCP', fn: (S) => { const c = H.ctr(H.podTpl(find(S, 'Deployment', 'default', 'front-end')), 'nginx'); return !!c && (c.ports || []).some((p) => p.name === 'http' && p.containerPort === 80 && (p.protocol || 'TCP') === 'TCP'); } },
      { t: 'El Service front-end-svc es de tipo NodePort', fn: (S) => (find(S, 'Service', 'default', 'front-end-svc') || { spec: {} }).spec.type === 'NodePort' },
      { t: 'front-end-svc apunta al puerto http y tiene endpoints', fn: (S) => { const s = find(S, 'Service', 'default', 'front-end-svc'); return !!s && X.svcEndpoints(S, s).length === 2 && s.spec.ports.some((p) => p.targetPort === 'http' || p.targetPort === 80); } },
      { t: 'Responde vía NodePort en la IP del nodo', fn: (S) => { const s = find(S, 'Service', 'default', 'front-end-svc'); if (!s || !s.spec.ports[0].nodePort) return false; return !H.http(S, null, null, 'http://172.30.2.2:' + s.spec.ports[0].nodePort + '/').err; } },
    ],
    hints: ['`kubectl edit deploy front-end` y añade `ports:` bajo el contenedor nginx.', '`kubectl expose deploy front-end --name=front-end-svc --port=80 --target-port=http --type=NodePort`.'],
    solution: [
      'kubectl patch deployment front-end -p \'{"spec":{"template":{"spec":{"containers":[{"name":"nginx","ports":[{"name":"http","containerPort":80,"protocol":"TCP"}]}]}}}}\'',
      'kubectl expose deployment front-end --name=front-end-svc --port=80 --target-port=http --type=NodePort',
      'kubectl get svc front-end-svc -o wide && kubectl get endpoints front-end-svc',
    ],
    explain: 'Un `targetPort` puede ser el NOMBRE del puerto del contenedor; así el Service sigue funcionando aunque cambie el número. `type: NodePort` expone el Service en un puerto 30000-32767 de cada nodo.',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/service/#type-nodeport'],
  });

  add({
    id: 'pdf07', src: 'PDF #7', domain: 'work', weight: 4, mins: 2, host: 'cka5731',
    title: 'Escalar un Deployment',
    task: ['Scale the deployment `presentation` to `3` pods.'],
    es: 'Escala el deployment presentation a 3 réplicas.',
    setup(S) { deploy(S, 'default', 'presentation', 'nginx:1.29', 1); },
    checks: [{ t: 'presentation tiene 3/3 réplicas Ready', fn: (S) => H.deployReady(S, 'default', 'presentation', 3) }],
    hints: ['`kubectl scale deployment <nombre> --replicas=N`'],
    solution: ['kubectl scale deployment presentation --replicas=3', 'kubectl get deploy presentation'],
    explain: 'Tarea de calentamiento: resuélvela en menos de un minuto. En el examen, empieza por las tareas rápidas para asegurar puntos.',
    docs: ['https://kubernetes.io/docs/reference/kubectl/generated/kubectl_scale/'],
  });

  add({
    id: 'pdf08', src: 'PDF #8', domain: 'work', weight: 4, mins: 3, host: 'cka6015',
    cluster: { workers: ['node01', 'node02'], nodeLabels: { node01: { disk: 'ssd' }, node02: { disk: 'spinning' } } },
    title: 'Programar un pod con nodeSelector',
    task: ['Schedule a pod as follows:', '- Name: `nginx-kusc00401`', '- Image: `nginx`', '- Node selector: `disk=ssd`'],
    es: 'Crea el pod nginx-kusc00401 (imagen nginx) con nodeSelector disk=ssd.',
    setup() {},
    checks: [
      { t: 'El pod nginx-kusc00401 existe con imagen nginx', fn: (S) => { const p = find(S, 'Pod', 'default', 'nginx-kusc00401'); return !!p && /^nginx(:|$)/.test(p.spec.containers[0].image); } },
      { t: 'Tiene nodeSelector disk: ssd', fn: (S) => ((find(S, 'Pod', 'default', 'nginx-kusc00401') || { spec: {} }).spec.nodeSelector || {}).disk === 'ssd' },
      { t: 'Está Running en node01 (el nodo con disk=ssd)', fn: (S) => { const p = find(S, 'Pod', 'default', 'nginx-kusc00401'); return H.ready(p) && p.spec.nodeName === 'node01'; } },
    ],
    hints: ['Genera el YAML: `kubectl run nginx-kusc00401 --image=nginx --dry-run=client -o yaml > p.yaml` y agrega `nodeSelector` bajo `spec`.', 'En YAML es `disk: ssd` (dos puntos), no `disk=ssd`.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: nginx-kusc00401\nspec:\n  containers:\n  - name: nginx\n    image: nginx\n  nodeSelector:\n    disk: ssd\nEOF", 'kubectl get pod nginx-kusc00401 -o wide'],
    explain: '`nodeSelector` es la forma más simple de restringir nodos: todas las etiquetas deben coincidir. Si ningún nodo coincide, el pod queda Pending con el evento `didn\'t match Pod\'s node affinity/selector`.',
    docs: ['https://kubernetes.io/docs/tasks/configure-pod-container/assign-pods-nodes/'],
  });

  add({
    id: 'pdf09', src: 'PDF #9', domain: 'trbl', weight: 4, mins: 4, host: 'cka6420',
    cluster: { workers: ['node01', 'node02', 'node03', 'node04'], nodeTaints: { node02: [{ key: 'maintenance', value: 'true', effect: 'NoSchedule' }], node03: [{ key: 'spot', value: 'true', effect: 'PreferNoSchedule' }] } },
    title: 'Contar nodos Ready sin taint NoSchedule',
    task: ['Check to see how many nodes are ready (not including nodes tainted `NoSchedule`) and write the number to `/opt/KUSC00402/kusc00402.txt`.'],
    es: 'Cuenta los nodos Ready que NO tengan un taint NoSchedule y escribe el número en /opt/KUSC00402/kusc00402.txt.',
    setup(S) { const n = H.node(S, 'node04'); n._sim.svc.kubelet.active = false; X.mkdirp(X.fsOf(S, S.cpName), '/opt/KUSC00402'); },
    checks: [{ t: 'El archivo contiene el número correcto (2)', fn: (S) => H.trim(H.file(S, 'cp', '/opt/KUSC00402/kusc00402.txt')) === '2' }],
    hints: ['`kubectl get nodes` para ver cuáles están Ready.', '`kubectl describe nodes | grep -i taints` — PreferNoSchedule no cuenta como NoSchedule.'],
    solution: ['kubectl get nodes', 'kubectl describe nodes | grep -iE "^Name:|Taints:"', 'echo 2 > /opt/KUSC00402/kusc00402.txt', 'cat /opt/KUSC00402/kusc00402.txt'],
    explain: 'Ready: controlplane, node01, node02, node03 (node04 está NotReady). Con NoSchedule: controlplane y node02. Quedan node01 y node03 (PreferNoSchedule es solo una preferencia) → 2. Lee con calma: el enunciado dice “not including”.',
    docs: ['https://kubernetes.io/docs/reference/kubectl/quick-reference/#interacting-with-nodes-and-cluster'],
  });

  add({
    id: 'pdf10', src: 'PDF #10', domain: 'work', weight: 4, mins: 3, host: 'cka6977',
    title: 'Pod con varios contenedores',
    task: ['Schedule a Pod as follows:', '- Name: `kucc8`', '- App Containers: 2', '- Container Name/Images:', '  - `nginx`', '  - `consul`'],
    es: 'Pod kucc8 con dos contenedores: nginx (imagen nginx) y consul (imagen consul).',
    setup() {},
    checks: [
      { t: 'kucc8 tiene exactamente 2 contenedores: nginx/nginx y consul/consul', fn: (S) => { const p = find(S, 'Pod', 'default', 'kucc8'); if (!p || p.spec.containers.length !== 2) return false; const n = H.ctr(p.spec, 'nginx'); const c = H.ctr(p.spec, 'consul'); return !!n && !!c && /^nginx/.test(n.image) && /^consul/.test(c.image); } },
      { t: 'kucc8 está Running 2/2', fn: (S) => H.ready(find(S, 'Pod', 'default', 'kucc8')) },
    ],
    hints: ['Genera un pod con `kubectl run kucc8 --image=nginx --dry-run=client -o yaml` y duplica el bloque del contenedor.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: kucc8\nspec:\n  containers:\n  - name: nginx\n    image: nginx\n  - name: consul\n    image: consul\nEOF", 'kubectl get pod kucc8'],
    explain: 'Los nombres de contenedor deben ser únicos dentro del pod. Cuida la indentación: cada contenedor empieza con `- name:` al mismo nivel.',
    docs: ['https://kubernetes.io/docs/concepts/workloads/pods/'],
  });

  add({
    id: 'pdf11', src: 'PDF #11', domain: 'stor', weight: 4, mins: 3, host: 'cka7361',
    title: 'PersistentVolume hostPath',
    task: ['Create a persistent volume with name `app-data`, of capacity `2Gi` and access mode `ReadOnlyMany`. The type of volume is `hostPath` and its location is `/srv/app-data`.'],
    es: 'PV app-data de 2Gi, modo ReadOnlyMany, hostPath /srv/app-data.',
    setup() {},
    checks: [
      { t: 'El PV app-data existe con 2Gi', fn: (S) => ((find(S, 'PersistentVolume', null, 'app-data') || { spec: { capacity: {} } }).spec.capacity.storage === '2Gi') },
      { t: 'accessModes = ReadOnlyMany', fn: (S) => { const v = find(S, 'PersistentVolume', null, 'app-data'); return !!v && v.spec.accessModes.length === 1 && v.spec.accessModes[0] === 'ReadOnlyMany'; } },
      { t: 'hostPath.path = /srv/app-data', fn: (S) => ((find(S, 'PersistentVolume', null, 'app-data') || { spec: {} }).spec.hostPath || {}).path === '/srv/app-data' },
    ],
    hints: ['No hay `kubectl create pv`: copia el ejemplo de la documentación (busca “hostPath PersistentVolume”).'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: app-data\nspec:\n  capacity:\n    storage: 2Gi\n  accessModes:\n  - ReadOnlyMany\n  hostPath:\n    path: /srv/app-data\nEOF", 'kubectl get pv app-data'],
    explain: 'Los PV son de ámbito de clúster (sin namespace). ROX = ReadOnlyMany. La ruta del enunciado del PDF trae un espacio (“/srv/app- data”) por el OCR; en el examen real copia la ruta exacta.',
    docs: ['https://kubernetes.io/docs/tasks/configure-pod-container/configure-persistent-volume-storage/'],
  });

  add({
    id: 'pdf12', src: 'PDF #12', domain: 'trbl', weight: 5, mins: 3, host: 'cka7748',
    title: 'Extraer líneas de logs',
    task: ['Monitor the logs of pod `foo` and:', '- Extract log lines corresponding to error `file-not-found`', '- Write them to `/opt/KUTR00101/foo`'],
    es: 'Extrae las líneas con “file-not-found” de los logs del pod foo y guárdalas en /opt/KUTR00101/foo.',
    setup(S) {
      const logs = ['2026-10-03T13:01:02Z INFO server started on :8080', '2026-10-03T13:01:07Z ERROR file-not-found: /data/config.json', '2026-10-03T13:02:11Z INFO GET /health 200', '2026-10-03T13:02:40Z WARN slow request /api/items 1.2s', '2026-10-03T13:03:05Z ERROR file-not-found: /data/cache/index.db', '2026-10-03T13:04:18Z ERROR permission-denied: /var/run/secret', '2026-10-03T13:05:59Z ERROR file-not-found: /data/templates/mail.tpl', '2026-10-03T13:06:00Z INFO GET /health 200'].join('\n');
      pod(S, 'default', 'foo', 'busybox:1.36', { command: busybox('while true; do sleep 5; done'), sim: { logs } });
      X.mkdirp(X.fsOf(S, S.cpName), '/opt/KUTR00101');
    },
    checks: [{ t: '/opt/KUTR00101/foo contiene exactamente las 3 líneas file-not-found', fn: (S) => { const t = H.file(S, 'cp', '/opt/KUTR00101/foo'); if (!t) return false; const L = t.trim().split('\n'); return L.length === 3 && L.every((l) => l.includes('file-not-found')); } }],
    hints: ['`kubectl logs foo | grep file-not-found > /opt/KUTR00101/foo`'],
    solution: ['kubectl logs foo | grep file-not-found > /opt/KUTR00101/foo', 'cat /opt/KUTR00101/foo'],
    explain: 'Combina kubectl con herramientas de shell. Revisa siempre el archivo final con `cat`: un error de ruta o de permisos cuesta la pregunta completa.',
    docs: ['https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/'],
  });

  add({
    id: 'pdf13', src: 'PDF #13', domain: 'trbl', weight: 7, mins: 10, host: 'cka8127',
    title: 'Sidecar de logging (streaming)',
    context: 'An existing Pod needs to be integrated into the Kubernetes built-in logging architecture (e.g. kubectl logs). Adding a streaming sidecar container is a good and common way to accomplish this requirement.',
    task: [
      'Add a sidecar container named `sidecar`, using the `busybox` image, to the existing Pod `big-corp-app`. The new sidecar container has to run the following command:',
      '`/bin/sh -c tail -n+1 -f /var/log/big-corp-app.log`',
      'Use a Volume, mounted at `/var/log`, to make the log file `big-corp-app.log` available to the sidecar container.',
      'Don\'t modify the specification of the existing container other than adding a required volume mount.',
    ],
    es: 'Agrega al pod big-corp-app un contenedor sidecar (busybox) que haga tail del log compartido mediante un volumen montado en /var/log.',
    setup(S) {
      const lines = []; for (let i = 0; i < 6; i++) lines.push(i + ': Sat Oct  3 13:5' + i + ':00 UTC 2026');
      pod(S, 'default', 'big-corp-app', 'busybox:1.36', { command: busybox('i=0; while true; do echo "$i: $(date)" >> /var/log/big-corp-app.log; i=$((i+1)); sleep 1; done'), cname: 'count', labels: { app: 'big-corp-app' }, sim: { files: { '/var/log/big-corp-app.log': lines.join('\n') } } });
    },
    checks: [
      { t: 'El pod tiene un contenedor sidecar con imagen busybox', fn: (S) => { const p = find(S, 'Pod', 'default', 'big-corp-app'); const c = p && H.ctr(p.spec, 'sidecar'); return !!c && /^busybox/.test(c.image); } },
      { t: 'El sidecar ejecuta tail -n+1 -f /var/log/big-corp-app.log', fn: (S) => { const p = find(S, 'Pod', 'default', 'big-corp-app'); const c = p && H.ctr(p.spec, 'sidecar'); return /tail -n\s?\+1 -[fF] \/var\/log\/big-corp-app\.log/.test(H.cmd(c)); } },
      { t: 'Ambos contenedores comparten un volumen montado en /var/log', fn: (S) => { const p = find(S, 'Pod', 'default', 'big-corp-app'); if (!p) return false; const a = H.ctr(p.spec, 'count'); const b = H.ctr(p.spec, 'sidecar'); if (!a || !b) return false; const va = (a.volumeMounts || []).find((m) => m.mountPath === '/var/log'); const vb = (b.volumeMounts || []).find((m) => m.mountPath === '/var/log'); return !!va && !!vb && va.name === vb.name; } },
      { t: 'El pod está Running y `kubectl logs big-corp-app -c sidecar` muestra el log', fn: (S) => { const p = find(S, 'Pod', 'default', 'big-corp-app'); if (!H.ready(p)) return false; const r = CKA.kubectl.run(S, ['logs', 'big-corp-app', '-c', 'sidecar']); return /0: /.test(r.out || ''); } },
    ],
    hints: ['Los pods no se pueden editar en caliente (salvo la imagen): `kubectl get pod big-corp-app -o yaml > p.yaml`, edita y `kubectl replace --force -f p.yaml`.', 'Agrega `volumes: [{name: logs, emptyDir: {}}]` y el mismo volumeMount en ambos contenedores.', 'Alternativa moderna (v1.29+): sidecar nativo como initContainer con `restartPolicy: Always`.'],
    solution: [
      'kubectl get pod big-corp-app -o yaml > big-corp-app.yaml',
      "cat <<'EOF' > big-corp-app.yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: big-corp-app\n  labels:\n    app: big-corp-app\nspec:\n  containers:\n  - name: count\n    image: busybox:1.36\n    command: [\"/bin/sh\", \"-c\", \"i=0; while true; do echo \\\"$i: $(date)\\\" >> /var/log/big-corp-app.log; i=$((i+1)); sleep 1; done\"]\n    volumeMounts:\n    - name: logs\n      mountPath: /var/log\n  - name: sidecar\n    image: busybox\n    command: [\"/bin/sh\", \"-c\", \"tail -n+1 -f /var/log/big-corp-app.log\"]\n    volumeMounts:\n    - name: logs\n      mountPath: /var/log\n  volumes:\n  - name: logs\n    emptyDir: {}\nEOF",
      'kubectl replace --force -f big-corp-app.yaml',
      'kubectl logs big-corp-app -c sidecar',
    ],
    explain: 'El sidecar lee el archivo que escribe el contenedor principal gracias a un volumen compartido (emptyDir). Como el spec de un pod es inmutable, `kubectl edit` fallará y guardará tus cambios en /tmp/kubectl-edit-*.yaml: aplícalos con `kubectl replace --force -f`. En Kubernetes ≥1.29 también es válido declararlo como sidecar nativo en `initContainers` con `restartPolicy: Always`.',
    docs: ['https://kubernetes.io/docs/concepts/cluster-administration/logging/#streaming-sidecar-container', 'https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/'],
  });

  add({
    id: 'pdf14', src: 'PDF #14', domain: 'trbl', weight: 5, mins: 3, host: 'cka8540',
    title: 'Pod con mayor consumo de CPU',
    task: ['From the pod label `name=overloaded-cpu`, find pods running high CPU workloads and write the name of the pod consuming most CPU to the file `/opt/KUTR00401/KUTR00401.txt` (which already exists).'],
    es: 'Entre los pods con la etiqueta name=overloaded-cpu, escribe el nombre del que más CPU consume en /opt/KUTR00401/KUTR00401.txt.',
    setup(S) {
      pod(S, 'default', 'cpu-burner-a1', 'polinux/stress', { command: busybox('stress --cpu 1'), labels: { name: 'overloaded-cpu' }, sim: { cpu: 312, mem: 40 } });
      pod(S, 'default', 'cpu-burner-b2', 'polinux/stress', { command: busybox('stress --cpu 2'), labels: { name: 'overloaded-cpu' }, sim: { cpu: 674, mem: 38 } });
      pod(S, 'default', 'cpu-burner-c3', 'polinux/stress', { command: busybox('stress --cpu 1'), labels: { name: 'overloaded-cpu' }, sim: { cpu: 97, mem: 35 } });
      pod(S, 'default', 'video-encoder', 'polinux/stress', { command: busybox('stress --cpu 4'), labels: { name: 'encoder' }, sim: { cpu: 910, mem: 120 } });
      file(S, 'cp', '/opt/KUTR00401/KUTR00401.txt', '');
    },
    checks: [{ t: 'El archivo contiene cpu-burner-b2', fn: (S) => H.trim(H.file(S, 'cp', '/opt/KUTR00401/KUTR00401.txt')) === 'cpu-burner-b2' }],
    hints: ['`kubectl top pod -l name=overloaded-cpu --sort-by=cpu`', 'Cuidado: hay otro pod con más CPU pero SIN esa etiqueta.'],
    solution: ['kubectl top pod -l name=overloaded-cpu --sort-by=cpu', 'kubectl top pod -l name=overloaded-cpu --sort-by=cpu --no-headers | head -1 | awk \'{print $1}\' > /opt/KUTR00401/KUTR00401.txt', 'cat /opt/KUTR00401/KUTR00401.txt'],
    explain: '`kubectl top` necesita metrics-server. `--sort-by=cpu` ordena de mayor a menor. Filtra siempre por la etiqueta pedida.',
    docs: ['https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_pod/'],
  });

  add({
    id: 'pdf15', src: 'PDF #15', domain: 'trbl', weight: 13, mins: 8, host: 'cka8911',
    cluster: { workers: ['wk8s-node-0', 'wk8s-node-1'] },
    title: 'Nodo NotReady (kubelet)',
    task: ['A Kubernetes worker node, named `wk8s-node-0` is in state **NotReady**. Investigate why this is the case, and perform any appropriate steps to bring the node to a Ready state, ensuring that any changes are made **permanent**.'],
    es: 'El worker wk8s-node-0 está NotReady. Diagnostica y corrígelo de forma permanente.',
    setup(S) { const n = H.node(S, 'wk8s-node-0'); n._sim.svc.kubelet.active = false; n._sim.svc.kubelet.enabled = false; },
    checks: [
      { t: 'wk8s-node-0 está Ready', fn: (S) => H.nodeReady(S, 'wk8s-node-0') },
      { t: 'kubelet quedó habilitado al arranque (permanente)', fn: (S) => (H.node(S, 'wk8s-node-0') || { _sim: { svc: { kubelet: {} } } })._sim.svc.kubelet.enabled === true },
    ],
    hints: ['`ssh wk8s-node-0` y luego `sudo systemctl status kubelet`.', '“Permanent” = `systemctl enable`, no solo `start`.', 'Lee los logs: `sudo journalctl -u kubelet | tail`.'],
    solution: ['kubectl get nodes', 'ssh wk8s-node-0', 'sudo systemctl status kubelet', 'sudo systemctl enable --now kubelet', 'exit', 'kubectl get nodes'],
    explain: 'Metodología: `kubectl describe node` (condición Ready=Unknown → el kubelet dejó de reportar) → ssh al nodo → `systemctl status kubelet` → `journalctl -u kubelet`. Aquí el kubelet estaba detenido y deshabilitado: `enable --now` lo arranca y lo deja persistente tras reinicios.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-cluster/'],
  });

  add({
    id: 'pdf16', src: 'PDF #16', domain: 'stor', weight: 7, mins: 8, host: 'cka9204',
    title: 'PVC + Pod + expansión de volumen',
    task: [
      'Create a new PersistentVolumeClaim:', '- Name: `pv-volume`', '- Class: `csi-hostpath-sc`', '- Capacity: `10Mi`',
      'Create a new Pod which mounts the PersistentVolumeClaim as a volume:', '- Name: `web-server`', '- Image: `nginx`', '- Mount path: `/usr/share/nginx/html`',
      'Configure the new Pod to have `ReadWriteOnce` access on the volume.',
      'Finally, using `kubectl edit` or `kubectl patch` expand the PersistentVolumeClaim to a capacity of `70Mi` and record that change.',
    ],
    es: 'PVC pv-volume (csi-hostpath-sc, 10Mi, RWO), pod web-server que lo monte en /usr/share/nginx/html y luego expandir el PVC a 70Mi.',
    setup(S) { sc(S, 'csi-hostpath-sc', 'hostpath.csi.k8s.io', { expand: true, mode: 'WaitForFirstConsumer' }); },
    checks: [
      { t: 'PVC pv-volume con clase csi-hostpath-sc y acceso RWO', fn: (S) => { const c = find(S, 'PersistentVolumeClaim', 'default', 'pv-volume'); return !!c && c.spec.storageClassName === 'csi-hostpath-sc' && (c.spec.accessModes || []).join() === 'ReadWriteOnce'; } },
      { t: 'El pod web-server (nginx) monta el PVC en /usr/share/nginx/html y está Running', fn: (S) => { const p = find(S, 'Pod', 'default', 'web-server'); if (!H.ready(p)) return false; const v = (p.spec.volumes || []).find((x) => x.persistentVolumeClaim && x.persistentVolumeClaim.claimName === 'pv-volume'); return !!v && p.spec.containers.some((c) => (c.volumeMounts || []).some((m) => m.name === v.name && m.mountPath === '/usr/share/nginx/html')); } },
      { t: 'El PVC está Bound y expandido a 70Mi', fn: (S) => { const c = find(S, 'PersistentVolumeClaim', 'default', 'pv-volume'); return !!c && c.status.phase === 'Bound' && c.spec.resources.requests.storage === '70Mi'; } },
    ],
    hints: ['La clase usa WaitForFirstConsumer: el PVC queda Pending hasta que el pod lo use (es normal).', '`kubectl patch pvc pv-volume -p \'{"spec":{"resources":{"requests":{"storage":"70Mi"}}}}\' --record`', '`--record` está obsoleto; alternativamente anota `kubernetes.io/change-cause`.'],
    solution: [
      "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: pv-volume\nspec:\n  storageClassName: csi-hostpath-sc\n  accessModes:\n  - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Mi\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: web-server\nspec:\n  containers:\n  - name: nginx\n    image: nginx\n    volumeMounts:\n    - name: data\n      mountPath: /usr/share/nginx/html\n  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: pv-volume\nEOF",
      'kubectl get pvc pv-volume',
      'kubectl patch pvc pv-volume -p \'{"spec":{"resources":{"requests":{"storage":"70Mi"}}}}\' --record',
      'kubectl get pvc pv-volume',
    ],
    explain: 'Solo los PVC aprovisionados dinámicamente por una StorageClass con `allowVolumeExpansion: true` pueden crecer (nunca encoger). El modo de acceso se define en el PVC. `--record` guarda la anotación `kubernetes.io/change-cause` (está obsoleto pero todavía funciona).',
    docs: ['https://kubernetes.io/docs/concepts/storage/persistent-volumes/#expanding-persistent-volumes-claims'],
  });

  add({
    id: 'pdf17', src: 'PDF #17', domain: 'net', weight: 7, mins: 6, host: 'cka9577',
    title: 'Ingress hacia un Service',
    task: ['Create a new nginx Ingress resource as follows:', '- Name: `pong`', '- Namespace: `ing-internal`', '- Exposing service `hello` on path `/hello` using service port `5678`'],
    es: 'Ingress pong en ing-internal que exponga el Service hello:5678 en la ruta /hello.',
    setup(S) {
      ingressClass(S, 'nginx', true);
      ns(S, 'ing-internal');
      deploy(S, 'ing-internal', 'hello', 'hashicorp/http-echo:1.0', 2, { ports: [{ containerPort: 5678 }], sim: { listen: [5678], body: 'hello' } });
      service(S, 'ing-internal', 'hello', { app: 'hello' }, 5678, 5678);
    },
    checks: [
      { t: 'Existe el Ingress pong en ing-internal', fn: (S) => !!find(S, 'Ingress', 'ing-internal', 'pong') },
      { t: 'La regla /hello apunta a hello:5678', fn: (S) => { const i = find(S, 'Ingress', 'ing-internal', 'pong'); return !!i && (i.spec.rules || []).some((r) => ((r.http || {}).paths || []).some((p) => p.path === '/hello' && p.backend.service.name === 'hello' && p.backend.service.port.number === 5678)); } },
      { t: 'curl http://<ingress>/hello responde 200 con "hello"', fn: (S) => { const r = H.http(S, null, null, 'http://172.30.1.100/hello'); return r.status === 200 && /hello/.test(r.body); } },
    ],
    hints: ['`kubectl create ingress pong -n ing-internal --rule="/hello=hello:5678"`', 'Para pathType Prefix usa `--rule="/hello*=hello:5678"`.', 'Prueba: `curl http://172.30.1.100/hello` (IP del controlador de ingress).'],
    solution: ['kubectl -n ing-internal create ingress pong --rule="/hello=hello:5678"', 'kubectl -n ing-internal get ingress pong', 'curl -s http://172.30.1.100/hello'],
    explain: 'Con `networking.k8s.io/v1`, cada path requiere `pathType` (Exact, Prefix o ImplementationSpecific) y el backend es `service.name` + `service.port.number`. Si hay una IngressClass por defecto no necesitas `ingressClassName`; si no, debes indicarla.',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/ingress/'],
  });

  // =====================================================================================
  //                     TAREAS NUEVAS — CURRÍCULO CKA 2026 (Kubernetes v1.35)
  // =====================================================================================

  // ---------------------------------------------------------------- Arquitectura
  add({
    id: 'n-helm-argo', src: 'Estilo 2025-26', domain: 'arch', weight: 7, mins: 8, host: 'cka1150',
    title: 'Helm: Argo CD sin instalar CRDs',
    task: [
      'Install Argo CD in the cluster:',
      '- Add the official Argo CD Helm repository with the name `argocd` (URL: `https://argoproj.github.io/argo-helm`).',
      '- Generate a Helm template of the Argo CD chart version `7.7.3` for the `argocd` namespace and save it to `/home/candidate/argo-helm.yaml`. Configure the chart to **not install CRDs**.',
      '- Install Argo CD using Helm with release name `argocd`, the same chart version and configuration, in the namespace `argocd` (the CRDs are already installed in the cluster).',
    ],
    es: 'Agrega el repo argocd, genera el template del chart argo-cd 7.7.3 sin CRDs en /home/candidate/argo-helm.yaml e instala la release argocd en el namespace argocd con la misma versión y sin CRDs.',
    setup(S) { for (const c of CKA.argoCrds()) put(S, c, { ageMs: AGE }); },
    checks: [
      { t: 'El repo argocd apunta a https://argoproj.github.io/argo-helm', fn: (S) => S.helm.repos.argocd === 'https://argoproj.github.io/argo-helm' },
      { t: '/home/candidate/argo-helm.yaml contiene el template (argocd-server) sin CRDs', fn: (S) => { const t = H.file(S, 'cp', '/home/candidate/argo-helm.yaml'); return !!t && /argocd-server/.test(t) && !/kind: CustomResourceDefinition/.test(t) && /helm\.sh\/chart: argo-cd-7\.7\.3/.test(t); } },
      { t: 'La release argocd (argo-cd-7.7.3) está desplegada en argocd con crds.install=false', fn: (S) => { const r = S.helm.releases.find((x) => x.name === 'argocd' && x.ns === 'argocd'); return !!r && r.chart === 'argo-cd-7.7.3' && r.values && r.values.crds && r.values.crds.install === false; } },
      { t: 'El deployment argocd-server está Ready', fn: (S) => H.deployReady(S, 'argocd', 'argocd-server') },
    ],
    hints: ['`helm repo add argocd https://argoproj.github.io/argo-helm && helm repo update`', '`helm search repo argocd --versions` para ver el nombre del chart (argo-cd).', '`helm show values argocd/argo-cd --version 7.7.3 | grep -A3 crds`'],
    solution: [
      'helm repo add argocd https://argoproj.github.io/argo-helm',
      'helm repo update',
      'helm search repo argocd',
      'helm template argocd argocd/argo-cd --version 7.7.3 --namespace argocd --set crds.install=false > /home/candidate/argo-helm.yaml',
      'grep -c CustomResourceDefinition /home/candidate/argo-helm.yaml',
      'helm install argocd argocd/argo-cd --version 7.7.3 --namespace argocd --create-namespace --set crds.install=false',
      'helm list -n argocd && kubectl -n argocd get deploy',
    ],
    explain: 'Si las CRDs ya existen y no pertenecen a la release, instalar con CRDs falla por “invalid ownership metadata”. `helm template` renderiza localmente (ideal para revisar); `helm install` crea la release. Usa `--version` y `--namespace` exactamente como pide el enunciado. La documentación de Helm está permitida en el examen.',
    docs: ['https://helm.sh/docs/helm/helm_template/', 'https://helm.sh/docs/helm/helm_install/'],
  });

  add({
    id: 'n-helm-upgrade', src: 'Nueva', domain: 'arch', weight: 5, mins: 5, host: 'cka1188',
    title: 'Helm: actualizar una release existente',
    task: [
      'The Helm release `web` in namespace `web` uses the chart `bitnami/nginx`.',
      'Upgrade the release to chart version `21.1.3`, setting `replicaCount=3` and `service.type=ClusterIP`.',
    ],
    es: 'Actualiza la release web (ns web) al chart nginx 21.1.3 con replicaCount=3 y service.type=ClusterIP.',
    setup(S) {
      S.helm.repos.bitnami = CKA.urls.BITNAMI_URL;
      exec(S, 'helm install web bitnami/nginx --version 20.0.3 -n web --create-namespace');
    },
    checks: [
      { t: 'La release web usa nginx-21.1.3', fn: (S) => (S.helm.releases.find((r) => r.name === 'web' && r.ns === 'web') || {}).chart === 'nginx-21.1.3' },
      { t: 'El deployment web-nginx tiene 3 réplicas Ready', fn: (S) => H.deployReady(S, 'web', 'web-nginx', 3) },
      { t: 'El Service web-nginx es ClusterIP', fn: (S) => (find(S, 'Service', 'web', 'web-nginx') || { spec: {} }).spec.type === 'ClusterIP' },
    ],
    hints: ['`helm list -A` para ubicar la release.', '`helm upgrade web bitnami/nginx -n web --version 21.1.3 --set replicaCount=3 --set service.type=ClusterIP`'],
    solution: ['helm list -A', 'helm search repo bitnami/nginx --versions', 'helm upgrade web bitnami/nginx -n web --version 21.1.3 --set replicaCount=3 --set service.type=ClusterIP', 'kubectl -n web get deploy,svc'],
    explain: '`helm upgrade` crea una nueva revisión de la release. Sin `--reuse-values`, los valores que no pases vuelven a los del chart; en esta release no había valores personalizados, así que no se pierde nada.',
    docs: ['https://helm.sh/docs/helm/helm_upgrade/'],
  });

  add({
    id: 'n-kustomize', src: 'Nueva', domain: 'arch', weight: 5, mins: 7, host: 'cka1236',
    title: 'Kustomize: overlay de producción',
    task: [
      'A Kustomize base exists in `/home/candidate/kustomize/base`.',
      'Create an overlay in `/home/candidate/kustomize/overlays/prod` that:',
      '- uses the base, deploys everything into namespace `prod`',
      '- sets the image `nginx` to tag `1.27`',
      '- sets the `web` Deployment to `3` replicas',
      '- adds the label `env=prod` to all resources',
      'Apply the overlay using `kubectl`.',
    ],
    es: 'Crea el overlay prod (namespace prod, imagen nginx:1.27, 3 réplicas, etiqueta env=prod) y aplícalo con kubectl -k.',
    setup(S) {
      ns(S, 'prod');
      const h = S.cpName;
      file(S, h, '/home/candidate/kustomize/base/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  labels:\n    app: web\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: nginx\n        image: nginx:1.25\n        ports:\n        - containerPort: 80\n');
      file(S, h, '/home/candidate/kustomize/base/service.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n  - port: 80\n    targetPort: 80\n');
      file(S, h, '/home/candidate/kustomize/base/kustomization.yaml', 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- deployment.yaml\n- service.yaml\n');
      X.mkdirp(X.fsOf(S, h), '/home/candidate/kustomize/overlays/prod');
    },
    checks: [
      { t: 'Existe overlays/prod/kustomization.yaml', fn: (S) => !!H.file(S, 'cp', '/home/candidate/kustomize/overlays/prod/kustomization.yaml') },
      { t: 'Deployment web en prod con nginx:1.27 y 3 réplicas Ready', fn: (S) => { const d = find(S, 'Deployment', 'prod', 'web'); return !!d && d.spec.template.spec.containers[0].image === 'nginx:1.27' && H.deployReady(S, 'prod', 'web', 3); } },
      { t: 'Deployment y Service en prod tienen la etiqueta env=prod', fn: (S) => ['Deployment', 'Service'].every((k) => ((find(S, k, 'prod', 'web') || { metadata: {} }).metadata.labels || {}).env === 'prod') },
    ],
    hints: ['`kubectl kustomize <dir>` muestra el resultado sin aplicarlo.', 'Campos: resources, namespace, images (name/newTag), replicas (name/count), labels o commonLabels.'],
    solution: [
      "cat <<EOF > /home/candidate/kustomize/overlays/prod/kustomization.yaml\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- ../../base\nnamespace: prod\nimages:\n- name: nginx\n  newTag: \"1.27\"\nreplicas:\n- name: web\n  count: 3\nlabels:\n- pairs:\n    env: prod\n  includeSelectors: false\nEOF",
      'kubectl kustomize /home/candidate/kustomize/overlays/prod',
      'kubectl apply -k /home/candidate/kustomize/overlays/prod',
      'kubectl -n prod get deploy,svc --show-labels',
    ],
    explain: 'Kustomize está integrado en kubectl (`-k`). Un overlay referencia la base y aplica transformaciones sin copiar YAML. `commonLabels` también cambia los selectores (inmutables en Deployments existentes); `labels` con `includeSelectors: false` es más seguro.',
    docs: ['https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/'],
  });

  add({
    id: 'n-crd-certmgr', src: 'Estilo 2025-26', domain: 'arch', weight: 5, mins: 4, host: 'cka1277',
    title: 'CRDs de cert-manager y kubectl explain',
    task: [
      'Verify the cert-manager application which has been deployed in the cluster.',
      '- Create a list of all cert-manager Custom Resource Definitions (CRDs) and save it to `~/resources.yaml`. You must use kubectl\'s default output format; do not set an output format.',
      '- Using kubectl, extract the documentation for the `subject` specification field of the Certificate Custom Resource and save it to `~/subject.yaml`.',
    ],
    es: 'Lista las CRDs de cert-manager en ~/resources.yaml (formato por defecto) y guarda la documentación de spec.subject de Certificate en ~/subject.yaml.',
    setup(S) {
      ns(S, 'cert-manager');
      for (const c of CKA.certManagerCrds()) put(S, c, { ageMs: AGE });
      deploy(S, 'cert-manager', 'cert-manager', 'quay.io/jetstack/cert-manager-controller:v1.18.2', 1);
      put(S, CKA.crd('traefik.io', 'IngressRoute', 'ingressroutes', 'Namespaced'), { ageMs: AGE });
    },
    checks: [
      { t: '~/resources.yaml lista las 6 CRDs de cert-manager', fn: (S) => { const t = H.file(S, 'cp', '/home/candidate/resources.yaml') || ''; return ['certificates.cert-manager.io', 'certificaterequests.cert-manager.io', 'issuers.cert-manager.io', 'clusterissuers.cert-manager.io', 'challenges.acme.cert-manager.io', 'orders.acme.cert-manager.io'].every((n) => t.includes(n)); } },
      { t: '~/resources.yaml usa el formato por defecto (tabla, no YAML/JSON) y sin otras CRDs', fn: (S) => { const t = H.file(S, 'cp', '/home/candidate/resources.yaml') || ''; return !!t && !/apiVersion:|"kind"/.test(t) && !/traefik/.test(t); } },
      { t: '~/subject.yaml contiene la documentación de spec.subject', fn: (S) => { const t = H.file(S, 'cp', '/home/candidate/subject.yaml') || ''; return /subject/.test(t) && /organizations/.test(t); } },
    ],
    hints: ['`kubectl get crd | grep cert-manager`', '`kubectl explain certificate.spec.subject`'],
    solution: ['kubectl get crd | grep cert-manager > ~/resources.yaml', 'cat ~/resources.yaml', 'kubectl explain certificate.spec.subject > ~/subject.yaml', 'cat ~/subject.yaml'],
    explain: 'Los operadores extienden la API con CRDs. `kubectl explain` también funciona con recursos personalizados si la CRD publica su esquema OpenAPI. Lee “default output format”: no uses -o yaml.',
    docs: ['https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/'],
  });

  add({
    id: 'n-cr-database', src: 'Nueva', domain: 'arch', weight: 4, mins: 4, host: 'cka1302',
    title: 'Crear un recurso personalizado (CR)',
    task: [
      'The CRD `databases.stable.example.com` is installed in the cluster.',
      'Create a `Database` resource named `mysql-prod` in namespace `data` with `spec.engine: mysql` and `spec.replicas: 3`.',
      'Write the list of all Database resources in all namespaces (default output) to `/opt/course/databases.txt`.',
    ],
    es: 'Crea el CR Database mysql-prod (engine mysql, replicas 3) en data y guarda el listado de todas las Databases en /opt/course/databases.txt.',
    setup(S) {
      ns(S, 'data');
      put(S, CKA.crd('stable.example.com', 'Database', 'databases', 'Namespaced', { type: 'object', properties: { spec: { type: 'object', properties: { engine: { type: 'string', description: 'Database engine (mysql|postgres)' }, replicas: { type: 'integer', description: 'Number of instances' } } } } }, ['db']), { ageMs: AGE });
      put(S, { apiVersion: 'stable.example.com/v1', kind: 'Database', metadata: { name: 'pg-staging', namespace: 'default' }, spec: { engine: 'postgres', replicas: 1 } }, { ageMs: AGE });
      X.mkdirp(X.fsOf(S, S.cpName), '/opt/course');
    },
    checks: [
      { t: 'Existe Database data/mysql-prod con engine mysql y replicas 3', fn: (S) => { const d = find(S, 'Database', 'data', 'mysql-prod'); return !!d && d.spec.engine === 'mysql' && d.spec.replicas === 3; } },
      { t: '/opt/course/databases.txt lista mysql-prod y pg-staging', fn: (S) => { const t = H.file(S, 'cp', '/opt/course/databases.txt') || ''; return /mysql-prod/.test(t) && /pg-staging/.test(t); } },
    ],
    hints: ['`kubectl get crd databases.stable.example.com -o yaml` para ver group/version/kind.', '`kubectl explain database.spec`'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: stable.example.com/v1\nkind: Database\nmetadata:\n  name: mysql-prod\n  namespace: data\nspec:\n  engine: mysql\n  replicas: 3\nEOF", 'kubectl get databases -A > /opt/course/databases.txt', 'cat /opt/course/databases.txt'],
    explain: 'Un CR se crea como cualquier objeto; `apiVersion` = `<group>/<version>` de la CRD. Los nombres corto/plural salen de `spec.names`.',
    docs: ['https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/'],
  });

  add({
    id: 'n-cni', src: 'Estilo 2025-26', domain: 'arch', weight: 7, mins: 6, host: 'cka1350',
    cluster: { workers: ['node01'], cni: null },
    title: 'Instalar un CNI que soporte NetworkPolicy',
    task: [
      'The cluster has no CNI installed and nodes are NotReady.',
      'Install and configure a Container Network Interface (CNI) of your choice that meets the following requirements:',
      '- Pods can communicate with each other',
      '- Supports **Network Policy enforcement**',
      '- Install from manifest files (do not use Helm)',
      'Choose one of the following:',
      '- Flannel v0.27.3: `https://github.com/flannel-io/flannel/releases/download/v0.27.3/kube-flannel.yml`',
      '- Calico v3.30.3 (operator): `https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/tigera-operator.yaml` and `https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/custom-resources.yaml`',
    ],
    es: 'Instala un CNI que aplique NetworkPolicies (Calico; Flannel no las soporta) desde los manifiestos dados.',
    setup() {},
    checks: [
      { t: 'Calico está instalado (Flannel no aplica NetworkPolicies)', fn: (S) => S.cni === 'calico' },
      { t: 'Todos los nodos están Ready', fn: (S) => list(S, 'Node').every(X.nodeReady) },
      { t: 'CoreDNS está Running', fn: (S) => H.deployReady(S, 'kube-system', 'coredns') },
    ],
    hints: ['Flannel no implementa NetworkPolicy → Calico.', 'El manifiesto del operador es muy grande: usa `kubectl create -f`, no `apply`.', 'Después aplica custom-resources.yaml (crea la Installation).'],
    solution: ['kubectl get nodes', 'kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/tigera-operator.yaml', 'kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/custom-resources.yaml', 'kubectl get pods -n calico-system', 'kubectl get nodes'],
    explain: 'Sin CNI el kubelet reporta `NetworkPluginNotReady` y los nodos quedan NotReady. Flannel solo da conectividad; para NetworkPolicy necesitas Calico, Cilium, etc. `kubectl apply` falla con el manifiesto del operador porque la anotación last-applied supera 256 KiB: usa `create` (o `apply --server-side`). Revisa que el CIDR de custom-resources coincida con el podSubnet del clúster.',
    docs: ['https://kubernetes.io/docs/concepts/cluster-administration/addons/'],
  });

  add({
    id: 'n-cri-dockerd', src: 'Estilo 2025-26', domain: 'arch', weight: 6, mins: 6, host: 'cka1399',
    title: 'Preparar un nodo: cri-dockerd y sysctl',
    task: [
      'Set up cri-dockerd on this node:',
      '- Install the Debian package `/home/candidate/cri-dockerd_0.3.20.3.ubuntu-jammy_amd64.deb` using `dpkg`.',
      '- Enable and start the `cri-docker` service.',
      'Configure these system parameters and make them **persistent** across reboots:',
      '- `net.bridge.bridge-nf-call-iptables` set to `1`', '- `net.ipv6.conf.all.forwarding` set to `1`', '- `net.ipv4.ip_forward` set to `1`', '- `net.netfilter.nf_conntrack_max` set to `131072`',
    ],
    es: 'Instala cri-dockerd con dpkg, habilita e inicia cri-docker y deja 4 parámetros sysctl configurados y persistentes.',
    setup(S) { file(S, 'cp', '/home/candidate/cri-dockerd_0.3.20.3.ubuntu-jammy_amd64.deb', '!<arch>\ndebian-binary (paquete simulado)'); },
    checks: [
      { t: 'cri-dockerd instalado y el servicio cri-docker activo y habilitado', fn: (S) => { const s = (H.node(S, S.cpName)._sim.svc || {})['cri-docker']; return !!s && s.active && s.enabled; } },
      { t: 'Los 4 parámetros sysctl están aplicados en el kernel', fn: (S) => { const v = (S.sysctl || {})[S.cpName] || {}; return v['net.bridge.bridge-nf-call-iptables'] === '1' && v['net.ipv6.conf.all.forwarding'] === '1' && v['net.ipv4.ip_forward'] === '1' && v['net.netfilter.nf_conntrack_max'] === '131072'; } },
      { t: 'Son persistentes (archivo en /etc/sysctl.d/)', fn: (S) => { const fs = X.fsOf(S, S.cpName); const t = Object.keys(fs.files).filter((f) => /^\/etc\/sysctl\.d\/.+\.conf$/.test(f)).map((f) => fs.files[f]).join('\n'); return ['net.bridge.bridge-nf-call-iptables', 'net.ipv6.conf.all.forwarding', 'net.ipv4.ip_forward', 'net.netfilter.nf_conntrack_max'].every((k) => new RegExp(k.replace(/\./g, '\\.') + '\\s*=\\s*\\d').test(t)); } },
    ],
    hints: ['Todo requiere root: `sudo -i`.', 'Persistente = archivo en /etc/sysctl.d/*.conf + `sysctl --system`.'],
    solution: [
      'sudo -i',
      'dpkg -i /home/candidate/cri-dockerd_0.3.20.3.ubuntu-jammy_amd64.deb',
      'systemctl enable --now cri-docker.service',
      'systemctl status cri-docker',
      "cat <<EOF > /etc/sysctl.d/k8s.conf\nnet.bridge.bridge-nf-call-iptables = 1\nnet.ipv6.conf.all.forwarding = 1\nnet.ipv4.ip_forward = 1\nnet.netfilter.nf_conntrack_max = 131072\nEOF",
      'sysctl --system',
    ],
    explain: '`sysctl -w` solo cambia el valor en memoria; para que sobreviva a un reinicio escribe un archivo en /etc/sysctl.d/ y cárgalo con `sysctl --system`. `systemctl enable --now` habilita y arranca en un solo paso.',
    docs: ['https://kubernetes.io/docs/setup/production-environment/container-runtimes/#prerequisite-ipv4-forwarding-optional'],
  });

  add({
    id: 'n-upgrade-worker', src: 'Nueva', domain: 'arch', weight: 6, mins: 10, host: 'cka1421',
    title: 'Actualizar un nodo worker',
    task: [
      'The control plane has already been upgraded to `v1.35.2`. Upgrade the worker node `node01` to the same version (`kubeadm`, `kubelet` and `kubectl`).',
      'Drain the node before the upgrade and make it schedulable again afterwards.',
    ],
    es: 'Actualiza node01 a 1.35.2 (kubeadm → kubeadm upgrade node → kubelet/kubectl) drenándolo antes y haciendo uncordon después.',
    setup(S) {
      const cp = H.node(S, S.cpName);
      cp._sim.pkgs = { kubeadm: '1.35.2', kubelet: '1.35.2', kubectl: '1.35.2' }; cp._sim.runningKubelet = '1.35.2';
      S.serverVersion = 'v1.35.2';
      deploy(S, 'default', 'shop', 'nginx:1.29', 2);
    },
    checks: [
      { t: 'node01 tiene kubeadm, kubelet y kubectl 1.35.2', fn: (S) => { const n = H.node(S, 'node01'); return ['kubeadm', 'kubelet', 'kubectl'].every((k) => n._sim.pkgs[k] === '1.35.2'); } },
      { t: 'Se ejecutó `kubeadm upgrade node` con kubeadm 1.35.2', fn: (S) => H.node(S, 'node01')._sim.upgradedNode === '1.35.2' },
      { t: 'node01 reporta kubelet v1.35.2 y está Ready', fn: (S) => H.node(S, 'node01').status.nodeInfo.kubeletVersion === 'v1.35.2' && H.nodeReady(S, 'node01') },
      { t: 'node01 se drenó y quedó schedulable', fn: (S) => !!H.node(S, 'node01')._sim.drained && !H.node(S, 'node01').spec.unschedulable },
    ],
    hints: ['Drain/uncordon desde el host con kubectl; el upgrade de paquetes con `ssh node01`.', 'En un worker se usa `kubeadm upgrade node` (no `apply`).'],
    solution: [
      'kubectl drain node01 --ignore-daemonsets',
      'ssh node01',
      'sudo -i',
      'apt-mark unhold kubeadm kubelet kubectl',
      'apt-get update && apt-get install -y kubeadm=1.35.2-1.1',
      'kubeadm upgrade node',
      'apt-get install -y kubelet=1.35.2-1.1 kubectl=1.35.2-1.1',
      'apt-mark hold kubeadm kubelet kubectl',
      'systemctl daemon-reload && systemctl restart kubelet',
      'exit',
      'exit',
      'kubectl uncordon node01',
      'kubectl get nodes',
    ],
    explain: 'Orden de un worker: drain (desde el plano de control) → kubeadm → `kubeadm upgrade node` → kubelet/kubectl → daemon-reload + restart → uncordon. Recuerda salir de `sudo -i` y del ssh con `exit` antes de usar kubectl en el host.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/'],
  });

  add({
    id: 'n-certs', src: 'Nueva', domain: 'arch', weight: 4, mins: 4, host: 'cka1465',
    title: 'Certificados con kubeadm',
    task: [
      'Using kubeadm, check the expiration of the cluster certificates and write the complete output to `/opt/course/certs-before.txt`.',
      'Then renew **only** the `apiserver` certificate.',
    ],
    es: 'Guarda la salida de kubeadm certs check-expiration en /opt/course/certs-before.txt y renueva solo el certificado apiserver.',
    setup(S) { X.mkdirp(X.fsOf(S, S.cpName), '/opt/course'); },
    checks: [
      { t: '/opt/course/certs-before.txt contiene la tabla de expiración', fn: (S) => /CERTIFICATE\s+EXPIRES/.test(H.file(S, 'cp', '/opt/course/certs-before.txt') || '') && /apiserver/.test(H.file(S, 'cp', '/opt/course/certs-before.txt') || '') },
      { t: 'Se renovó el certificado apiserver', fn: (S) => (S.flags.certsRenewed || []).includes('apiserver') },
      { t: 'No se renovaron otros certificados', fn: (S) => (S.flags.certsRenewed || []).every((c) => c === 'apiserver') },
    ],
    hints: ['`sudo kubeadm certs check-expiration`', 'La redirección `>` la hace tu shell (candidate); /opt/course es escribible.'],
    solution: ['sudo kubeadm certs check-expiration > /opt/course/certs-before.txt', 'cat /opt/course/certs-before.txt', 'sudo kubeadm certs renew apiserver'],
    explain: 'kubeadm emite certificados por 1 año; `kubeadm upgrade` también los renueva. Tras renovar hay que reiniciar los pods estáticos afectados (moviendo el manifiesto fuera y de vuelta).',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/'],
  });

  add({
    id: 'n-csr-rbac', src: 'Nueva', domain: 'arch', weight: 5, mins: 6, host: 'cka1502',
    title: 'Usuario con certificado: CSR + RBAC',
    task: [
      'A CertificateSigningRequest named `jane` has been submitted for the user `jane`. Approve it.',
      'Create a Role `pod-reader` in namespace `dev` that allows `get`, `list` and `watch` on pods.',
      'Bind the Role to the user `jane` with a RoleBinding named `jane-pod-reader`.',
    ],
    es: 'Aprueba el CSR jane, crea el Role pod-reader (get/list/watch pods) en dev y vincúlalo al usuario jane.',
    setup(S) {
      ns(S, 'dev');
      put(S, { apiVersion: 'certificates.k8s.io/v1', kind: 'CertificateSigningRequest', metadata: { name: 'jane' }, spec: { request: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0K', signerName: 'kubernetes.io/kube-apiserver-client', expirationSeconds: 86400, usages: ['client auth'], username: 'kubernetes-admin' }, status: {} }, { ageMs: 600000 });
    },
    checks: [
      { t: 'El CSR jane está Approved', fn: (S) => ((find(S, 'CertificateSigningRequest', null, 'jane') || { status: {} }).status.conditions || []).some((c) => c.type === 'Approved') },
      { t: 'jane puede listar pods en dev', fn: (S) => H.can(S, 'jane', 'list', 'pods', 'dev') && H.can(S, 'jane', 'watch', 'pods', 'dev') },
      { t: 'jane NO puede borrar pods ni listar en default', fn: (S) => !H.can(S, 'jane', 'delete', 'pods', 'dev') && !H.can(S, 'jane', 'list', 'pods', 'default') },
      { t: 'El RoleBinding se llama jane-pod-reader', fn: (S) => !!find(S, 'RoleBinding', 'dev', 'jane-pod-reader') },
    ],
    hints: ['`kubectl certificate approve jane`', '`kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev`', '`kubectl create rolebinding jane-pod-reader --role=pod-reader --user=jane -n dev`'],
    solution: ['kubectl get csr', 'kubectl certificate approve jane', 'kubectl -n dev create role pod-reader --verb=get,list,watch --resource=pods', 'kubectl -n dev create rolebinding jane-pod-reader --role=pod-reader --user=jane', 'kubectl auth can-i list pods -n dev --as jane'],
    explain: 'Kubernetes no tiene objetos “User”: el nombre sale del CN del certificado firmado por la CA del clúster. Tras aprobar el CSR, el certificado queda en `.status.certificate`.',
    docs: ['https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/#normal-user'],
  });

  add({
    id: 'n-static-pod', src: 'Nueva', domain: 'arch', weight: 4, mins: 5, host: 'cka1544',
    title: 'Pod estático en un worker',
    task: ['Create a static Pod named `my-static-pod` in namespace `default` on node `node01`, using image `nginx:1.29`.'],
    es: 'Crea un pod estático my-static-pod (nginx:1.29) en node01.',
    setup() {},
    checks: [{ t: 'El pod espejo my-static-pod-node01 está Running en node01 con nginx:1.29', fn: (S) => { const p = find(S, 'Pod', 'default', 'my-static-pod-node01'); return H.ready(p) && p.spec.nodeName === 'node01' && p.spec.containers[0].image === 'nginx:1.29'; } }],
    hints: ['Genera el YAML con `kubectl run ... --dry-run=client -o yaml` y cópialo.', 'En node01: `/etc/kubernetes/manifests/` (staticPodPath en /var/lib/kubelet/config.yaml).'],
    solution: ['ssh node01', 'sudo -i', 'grep staticPodPath /var/lib/kubelet/config.yaml', "cat <<EOF > /etc/kubernetes/manifests/my-static-pod.yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: my-static-pod\n  namespace: default\nspec:\n  containers:\n  - name: nginx\n    image: nginx:1.29\nEOF", 'exit', 'exit', 'kubectl get pod my-static-pod-node01 -o wide'],
    explain: 'El kubelet crea los pods estáticos desde su `staticPodPath`; el API server solo ve un pod “espejo” con el sufijo del nodo. Para borrarlo hay que eliminar el archivo, no el pod.',
    docs: ['https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/'],
  });

  // ---------------------------------------------------------------- Workloads & scheduling
  add({
    id: 'n-rollout', src: 'Nueva', domain: 'work', weight: 5, mins: 5, host: 'cka2010',
    title: 'Rolling update y rollback',
    task: [
      'Update the deployment `webapp` to image `nginx:1.29` and record the change cause `upgrade to 1.29` (annotation `kubernetes.io/change-cause`).',
      'The new version has a bug: roll back the deployment to the previous revision.',
      'Finally write the rollout history of `webapp` to `/opt/course/rollout-history.txt`.',
    ],
    es: 'Actualiza webapp a nginx:1.29 con change-cause, haz rollback y guarda el historial en /opt/course/rollout-history.txt.',
    setup(S) { deploy(S, 'default', 'webapp', 'nginx:1.27', 3, { cname: 'nginx' }); X.mkdirp(X.fsOf(S, S.cpName), '/opt/course'); },
    checks: [
      { t: 'webapp vuelve a usar nginx:1.27 con 3 réplicas Ready', fn: (S) => { const d = find(S, 'Deployment', 'default', 'webapp'); return !!d && d.spec.template.spec.containers[0].image === 'nginx:1.27' && H.deployReady(S, 'default', 'webapp', 3); } },
      { t: 'Existe una revisión con change-cause "upgrade to 1.29"', fn: (S) => { const d = find(S, 'Deployment', 'default', 'webapp'); return !!d && X.ownedBy(S, 'ReplicaSet', d).some((r) => (r.metadata.annotations || {})['kubernetes.io/change-cause'] === 'upgrade to 1.29' && /1\.29/.test(r.spec.template.spec.containers[0].image)); } },
      { t: '/opt/course/rollout-history.txt contiene el historial', fn: (S) => /REVISION/.test(H.file(S, 'cp', '/opt/course/rollout-history.txt') || '') && /upgrade to 1\.29/.test(H.file(S, 'cp', '/opt/course/rollout-history.txt') || '') },
    ],
    hints: ['`kubectl set image deploy/webapp nginx=nginx:1.29`', '`kubectl annotate deploy webapp kubernetes.io/change-cause="upgrade to 1.29"`', '`kubectl rollout undo deploy/webapp`'],
    solution: ['kubectl set image deployment/webapp nginx=nginx:1.29', 'kubectl annotate deployment webapp kubernetes.io/change-cause="upgrade to 1.29"', 'kubectl rollout status deployment/webapp', 'kubectl rollout undo deployment/webapp', 'kubectl rollout history deployment/webapp > /opt/course/rollout-history.txt', 'cat /opt/course/rollout-history.txt'],
    explain: 'Cada cambio del pod template crea un nuevo ReplicaSet (revisión). `rollout undo` reutiliza el ReplicaSet anterior, que pasa a ser la revisión más alta. La anotación `kubernetes.io/change-cause` es lo que aparece en CHANGE-CAUSE.',
    docs: ['https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-back-a-deployment'],
  });

  add({
    id: 'n-hpa', src: 'Estilo 2025-26', domain: 'work', weight: 5, mins: 5, host: 'cka2044',
    title: 'HorizontalPodAutoscaler con ventana de estabilización',
    task: [
      'Create a new HorizontalPodAutoscaler (HPA) named `apache-server` in the `autoscale` namespace. This HPA must target the existing Deployment called `apache-server` in the `autoscale` namespace.',
      'Set the HPA to aim for **50%** CPU usage per Pod. Configure it to have at least `1` Pod and no more than `4` Pods. Also, set the downscale stabilization window to `30` seconds.',
    ],
    es: 'HPA apache-server (autoscale) al 50% de CPU, mín 1, máx 4, con ventana de estabilización de bajada de 30 s.',
    setup(S) { ns(S, 'autoscale'); deploy(S, 'autoscale', 'apache-server', 'httpd:2.4', 1, { resources: { requests: { cpu: '100m' } } }); },
    checks: [
      { t: 'El HPA apunta al Deployment apache-server con min 1 y max 4', fn: (S) => { const h = find(S, 'HorizontalPodAutoscaler', 'autoscale', 'apache-server'); return !!h && h.spec.scaleTargetRef.name === 'apache-server' && (h.spec.scaleTargetRef.kind || 'Deployment') === 'Deployment' && (h.spec.minReplicas || 1) === 1 && h.spec.maxReplicas === 4; } },
      { t: 'Objetivo de CPU 50% (Utilization)', fn: (S) => { const h = find(S, 'HorizontalPodAutoscaler', 'autoscale', 'apache-server'); return !!h && (h.spec.metrics || []).some((m) => m.resource && m.resource.name === 'cpu' && m.resource.target.averageUtilization === 50); } },
      { t: 'behavior.scaleDown.stabilizationWindowSeconds = 30', fn: (S) => { const h = find(S, 'HorizontalPodAutoscaler', 'autoscale', 'apache-server'); return !!h && ((h.spec.behavior || {}).scaleDown || {}).stabilizationWindowSeconds === 30; } },
    ],
    hints: ['`kubectl autoscale deploy apache-server -n autoscale --cpu-percent=50 --min=1 --max=4 --dry-run=client -o yaml > hpa.yaml`', 'Añade `behavior.scaleDown.stabilizationWindowSeconds: 30` (solo existe en autoscaling/v2).'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: apache-server\n  namespace: autoscale\nspec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: Deployment\n    name: apache-server\n  minReplicas: 1\n  maxReplicas: 4\n  metrics:\n  - type: Resource\n    resource:\n      name: cpu\n      target:\n        type: Utilization\n        averageUtilization: 50\n  behavior:\n    scaleDown:\n      stabilizationWindowSeconds: 30\nEOF", 'kubectl -n autoscale get hpa apache-server'],
    explain: 'El HPA calcula la utilización sobre los `requests` de CPU del pod: sin requests no puede escalar por porcentaje. `behavior` solo existe en autoscaling/v2.',
    docs: ['https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#configurable-scaling-behavior'],
  });

  add({
    id: 'n-priority', src: 'Estilo 2025-26', domain: 'work', weight: 5, mins: 5, host: 'cka2089',
    title: 'PriorityClass relativa a las existentes',
    task: [
      'Create a new PriorityClass named `high-priority` for user workloads with a value that is **one less than the highest existing user-defined priority class** value.',
      'Patch the existing Deployment `busybox-logger` running in the `priority` namespace to use the `high-priority` priority class.',
      'Ensure that the `busybox-logger` Deployment rolls out successfully with the new priority class set.',
    ],
    es: 'Crea high-priority con valor = (máxima PriorityClass de usuario − 1) y úsala en el deployment busybox-logger (ns priority).',
    setup(S) {
      put(S, { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'low-batch' }, value: 1000, description: 'batch' }, { ageMs: AGE });
      put(S, { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'business-critical' }, value: 100000, description: 'critical apps' }, { ageMs: AGE });
      put(S, { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'medium' }, value: 50000 }, { ageMs: AGE });
      ns(S, 'priority');
      deploy(S, 'priority', 'busybox-logger', 'busybox:1.36', 2, { command: busybox('while true; do echo logging; sleep 10; done') });
    },
    checks: [
      { t: 'PriorityClass high-priority con valor 99999', fn: (S) => (find(S, 'PriorityClass', null, 'high-priority') || {}).value === 99999 },
      { t: 'busybox-logger usa priorityClassName high-priority', fn: (S) => H.podTpl(find(S, 'Deployment', 'priority', 'busybox-logger')).priorityClassName === 'high-priority' },
      { t: 'Los pods de busybox-logger corren con prioridad 99999', fn: (S) => H.deployReady(S, 'priority', 'busybox-logger') && H.pods(S, 'priority', { app: 'busybox-logger' }).every((p) => p.spec.priority === 99999) },
    ],
    hints: ['`kubectl get priorityclass` — ignora las system-* (no son de usuario).', '`kubectl create priorityclass high-priority --value=99999`', 'Patch: `{"spec":{"template":{"spec":{"priorityClassName":"high-priority"}}}}`'],
    solution: ['kubectl get priorityclass', 'kubectl create priorityclass high-priority --value=99999 --description="high priority user workloads"', 'kubectl -n priority patch deployment busybox-logger -p \'{"spec":{"template":{"spec":{"priorityClassName":"high-priority"}}}}\'', 'kubectl -n priority rollout status deployment busybox-logger'],
    explain: 'Las clases `system-cluster-critical` y `system-node-critical` son del sistema (≥ 2 000 000 000). La mayor de usuario es business-critical (100000) → 99999. El valor de prioridad se copia al pod al crearlo, por eso el rollout crea pods nuevos.',
    docs: ['https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/'],
  });

  add({
    id: 'n-resources', src: 'Estilo 2025-26', domain: 'work', weight: 6, mins: 8, host: 'cka2130',
    cluster: { workers: ['node01'], cpuPerNode: 1, memMi: 2100 },
    title: 'Repartir recursos del nodo entre réplicas',
    task: [
      'You are managing a WordPress application in namespace `wp`. The Deployment `wordpress` has 3 replicas, but only one Pod can be scheduled.',
      'Adjust all Pod resource requests as follows:',
      '- Divide node resources evenly across all 3 pods; give each Pod a fair share of CPU and memory.',
      '- Add enough overhead to keep the node stable.',
      '- Use the **exact same requests** for both containers and init containers.',
      'Scale down the wordpress deployment to 0 replicas while updating the resource requests. After updates, confirm WordPress keeps 3 replicas and all Pods are running and ready.',
    ],
    es: 'Ajusta los requests (contenedor e init container iguales) para que las 3 réplicas quepan en node01 (1 CPU, ~2000Mi), dejando margen.',
    setup(S) {
      ns(S, 'wp');
      put(S, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'wordpress', namespace: 'wp', labels: { app: 'wordpress' } }, spec: { replicas: 3, selector: { matchLabels: { app: 'wordpress' } }, template: { metadata: { labels: { app: 'wordpress' } }, spec: { initContainers: [{ name: 'init-db', image: 'busybox:1.36', command: busybox('echo waiting for db; sleep 2'), resources: { requests: { cpu: '500m', memory: '1Gi' } } }], containers: [{ name: 'wordpress', image: 'wordpress:6.8', ports: [{ containerPort: 80 }], resources: { requests: { cpu: '500m', memory: '1Gi' } } }] } } } }, { ageMs: AGE });
    },
    checks: [
      { t: 'wordpress tiene 3/3 pods Running y Ready', fn: (S) => H.deployReady(S, 'wp', 'wordpress', 3) },
      { t: 'Contenedor e init container tienen exactamente los mismos requests', fn: (S) => { const s = H.podTpl(find(S, 'Deployment', 'wp', 'wordpress')); const a = (H.ctr(s, 'wordpress') || {}).resources; const b = (H.ctr(s, 'init-db') || {}).resources; return !!a && !!b && !!a.requests && C.stable(a.requests) === C.stable(b.requests); } },
      { t: 'Cada pod pide un reparto justo (≥250m CPU y ≥400Mi) sin agotar el nodo', fn: (S) => { const r = ((H.ctr(H.podTpl(find(S, 'Deployment', 'wp', 'wordpress')), 'wordpress') || {}).resources || {}).requests || {}; const cpu = C.parseCpu(r.cpu); const mem = C.parseMem(r.memory); return cpu >= 250 && cpu <= 330 && mem >= 400 && mem <= 660; } },
    ],
    hints: ['`kubectl describe node node01` → Allocatable (1 CPU, ~2000Mi).', '1000m/3 ≈ 333m → deja margen: ~300m CPU; 2000Mi/3 ≈ 666Mi → ~600Mi.', 'El pod usa max(init) y la suma de contenedores; ambos deben ser iguales.'],
    solution: ['kubectl -n wp scale deployment wordpress --replicas=0', 'kubectl describe node node01 | grep -A5 Allocatable', 'kubectl -n wp patch deployment wordpress -p \'{"spec":{"template":{"spec":{"containers":[{"name":"wordpress","resources":{"requests":{"cpu":"300m","memory":"600Mi"}}}],"initContainers":[{"name":"init-db","resources":{"requests":{"cpu":"300m","memory":"600Mi"}}}]}}}}\'', 'kubectl -n wp scale deployment wordpress --replicas=3', 'kubectl -n wp get pods -o wide'],
    explain: 'El scheduler reserva requests, no uso real. Requests efectivos de un pod = max(init containers, suma de contenedores). Escalar a 0 antes evita pods Pending durante el cambio.',
    docs: ['https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/'],
  });

  add({
    id: 'n-cm-immutable', src: 'Estilo 2025-26', domain: 'work', weight: 5, mins: 6, host: 'cka2177',
    title: 'ConfigMap inmutable: habilitar solo TLSv1.3',
    task: [
      'An NGINX Deployment `nginx-static` is running in the `nginx-static` namespace. It is configured using a ConfigMap named `nginx-config`.',
      'Update the `nginx-config` ConfigMap to allow **only TLSv1.3** connections (TLSv1.2 must no longer be allowed).',
      'Re-create, restart, or scale resources as necessary so the Deployment uses the new configuration.',
    ],
    es: 'Cambia el ConfigMap nginx-config (inmutable) para permitir solo TLSv1.3 y reinicia el deployment para que lo use.',
    setup(S) {
      ns(S, 'nginx-static');
      put(S, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nginx-config', namespace: 'nginx-static' }, immutable: true, data: { 'nginx.conf': 'events {}\nhttp {\n  server {\n    listen 443 ssl;\n    server_name web.k8snginx.local;\n    ssl_certificate /etc/nginx/tls/tls.crt;\n    ssl_certificate_key /etc/nginx/tls/tls.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    location / { root /usr/share/nginx/html; }\n  }\n}\n' } }, { ageMs: AGE });
      deploy(S, 'nginx-static', 'nginx-static', 'nginx:1.29', 1, { cname: 'nginx', volumeMounts: [{ name: 'cfg', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf' }], podSpec: { volumes: [{ name: 'cfg', configMap: { name: 'nginx-config' } }] } });
    },
    checks: [
      { t: 'nginx-config permite solo TLSv1.3', fn: (S) => { const c = find(S, 'ConfigMap', 'nginx-static', 'nginx-config'); const t = c && c.data && c.data['nginx.conf']; return !!t && /ssl_protocols\s+TLSv1\.3\s*;/.test(t) && !/TLSv1\.2/.test(t); } },
      { t: 'Los pods de nginx-static se recrearon después del cambio y están Ready', fn: (S) => { const c = find(S, 'ConfigMap', 'nginx-static', 'nginx-config'); const ps = H.pods(S, 'nginx-static', { app: 'nginx-static' }); return !!c && ps.length > 0 && H.deployReady(S, 'nginx-static', 'nginx-static') && ps.every((p) => Date.parse(p.metadata.creationTimestamp) >= Date.parse(c.metadata.creationTimestamp)); } },
    ],
    hints: ['Un ConfigMap con `immutable: true` no se puede editar: hay que borrarlo y recrearlo.', '`kubectl get cm ... -o yaml > cm.yaml`, edita, `kubectl replace --force -f cm.yaml`.', 'Después `kubectl rollout restart deployment nginx-static -n nginx-static`.'],
    solution: ['kubectl -n nginx-static get cm nginx-config -o yaml > cm.yaml', "sed -i 's/ssl_protocols TLSv1.2 TLSv1.3;/ssl_protocols TLSv1.3;/' cm.yaml", 'kubectl replace --force -f cm.yaml', 'kubectl -n nginx-static rollout restart deployment nginx-static', 'kubectl -n nginx-static get pods'],
    explain: 'Los ConfigMaps montados con `subPath` nunca se actualizan en caliente, y los inmutables no se pueden cambiar: se recrean y se reinicia el Deployment (`rollout restart` añade una anotación al template y genera pods nuevos).',
    docs: ['https://kubernetes.io/docs/concepts/configuration/configmap/#configmap-immutable'],
  });

  add({
    id: 'n-taints', src: 'Nueva', domain: 'work', weight: 4, mins: 5, host: 'cka2213',
    cluster: { workers: ['node01', 'node02'] },
    title: 'Taints, tolerations y nodo dedicado',
    task: [
      'Taint the node `node01` with key `dedicated`, value `gpu` and effect `NoSchedule`, and label it `gpu=true`.',
      'Create a Pod named `gpu-pod` with image `nginx` in namespace `default` that tolerates this taint and can **only** be scheduled on nodes labeled `gpu=true`.',
    ],
    es: 'Taint dedicated=gpu:NoSchedule y etiqueta gpu=true en node01; pod gpu-pod que lo tolere y solo pueda ir a nodos gpu=true.',
    setup(S) { deploy(S, 'default', 'regular', 'nginx:1.29', 2); },
    checks: [
      { t: 'node01 tiene el taint dedicated=gpu:NoSchedule y la etiqueta gpu=true', fn: (S) => { const n = H.node(S, 'node01'); return (n.spec.taints || []).some((t) => t.key === 'dedicated' && t.value === 'gpu' && t.effect === 'NoSchedule') && n.metadata.labels.gpu === 'true'; } },
      { t: 'gpu-pod tolera el taint', fn: (S) => { const p = find(S, 'Pod', 'default', 'gpu-pod'); return !!p && X.tolerates(p.spec.tolerations, { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }); } },
      { t: 'gpu-pod solo puede ir a nodos gpu=true (nodeSelector o nodeAffinity) y corre en node01', fn: (S) => { const p = find(S, 'Pod', 'default', 'gpu-pod'); if (!H.ready(p) || p.spec.nodeName !== 'node01') return false; const ns1 = (p.spec.nodeSelector || {}).gpu === 'true'; const aff = JSON.stringify(((p.spec.affinity || {}).nodeAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || {}); return ns1 || (/"gpu"/.test(aff) && /"true"/.test(aff)); } },
    ],
    hints: ['`kubectl taint node node01 dedicated=gpu:NoSchedule`', 'La toleration permite ir al nodo, pero NO obliga: por eso también nodeSelector/affinity.'],
    solution: ['kubectl taint node node01 dedicated=gpu:NoSchedule', 'kubectl label node node01 gpu=true', "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: gpu-pod\nspec:\n  containers:\n  - name: nginx\n    image: nginx\n  tolerations:\n  - key: dedicated\n    operator: Equal\n    value: gpu\n    effect: NoSchedule\n  nodeSelector:\n    gpu: \"true\"\nEOF", 'kubectl get pod gpu-pod -o wide'],
    explain: 'Taint + toleration repelen a los demás pods; nodeSelector/affinity atrae a los que sí quieres. Para un nodo dedicado se usan ambos. En YAML, `"true"` va entre comillas porque las etiquetas son strings.',
    docs: ['https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/'],
  });

  add({
    id: 'n-affinity', src: 'Nueva', domain: 'work', weight: 5, mins: 7, host: 'cka2256',
    cluster: { workers: ['node01', 'node02', 'node03'], nodeLabels: { node01: { disktype: 'ssd' }, node02: { disktype: 'ssd' }, node03: { disktype: 'hdd' } } },
    title: 'Node affinity + pod anti-affinity',
    task: [
      'Create a Deployment named `cache` in namespace `default` with `2` replicas of image `redis:7.4` (pod label `app=cache`).',
      '- Pods must only run on nodes with label `disktype=ssd` (use **required node affinity**).',
      '- No two `cache` Pods may run on the same node (use **required pod anti-affinity** with topology key `kubernetes.io/hostname`).',
    ],
    es: 'Deployment cache (2 réplicas redis:7.4) con nodeAffinity obligatoria a disktype=ssd y podAntiAffinity para no compartir nodo.',
    setup() {},
    checks: [
      { t: 'cache usa nodeAffinity required con disktype In [ssd]', fn: (S) => { const s = H.podTpl(find(S, 'Deployment', 'default', 'cache')); const r = (((s.affinity || {}).nodeAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || {}).nodeSelectorTerms || []; return r.some((t) => (t.matchExpressions || []).some((e) => e.key === 'disktype' && e.operator === 'In' && (e.values || []).includes('ssd'))); } },
      { t: 'cache usa podAntiAffinity required por hostname', fn: (S) => { const s = H.podTpl(find(S, 'Deployment', 'default', 'cache')); const a = ((s.affinity || {}).podAntiAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || []; return a.some((t) => t.topologyKey === 'kubernetes.io/hostname'); } },
      { t: 'Las 2 réplicas corren en node01 y node02 (una por nodo)', fn: (S) => { const ps = H.pods(S, 'default', { app: 'cache' }); return ps.length === 2 && ps.every(X.podIsReady) && new Set(ps.map((p) => p.spec.nodeName)).size === 2 && ps.every((p) => ['node01', 'node02'].includes(p.spec.nodeName)); } },
    ],
    hints: ['Parte de `kubectl create deploy cache --image=redis:7.4 --replicas=2 --dry-run=client -o yaml`.', 'Copia los bloques de affinity de la documentación “Assign Pods to Nodes using Node Affinity”.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: cache\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: cache\n  template:\n    metadata:\n      labels:\n        app: cache\n    spec:\n      affinity:\n        nodeAffinity:\n          requiredDuringSchedulingIgnoredDuringExecution:\n            nodeSelectorTerms:\n            - matchExpressions:\n              - key: disktype\n                operator: In\n                values:\n                - ssd\n        podAntiAffinity:\n          requiredDuringSchedulingIgnoredDuringExecution:\n          - labelSelector:\n              matchLabels:\n                app: cache\n            topologyKey: kubernetes.io/hostname\n      containers:\n      - name: redis\n        image: redis:7.4\nEOF", 'kubectl get pods -l app=cache -o wide'],
    explain: '`required...` es obligatorio (si no se cumple, Pending); `preferred...` solo suma puntos. La anti-afinidad con topologyKey hostname reparte réplicas en nodos distintos: con 3 réplicas y 2 nodos ssd, una quedaría Pending.',
    docs: ['https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#affinity-and-anti-affinity'],
  });

  add({
    id: 'n-sidecar-native', src: 'Estilo 2025-26', domain: 'work', weight: 6, mins: 7, host: 'cka2301',
    title: 'Sidecar en un Deployment (volumen compartido)',
    task: [
      'Update the existing Deployment `synergy-deployment`, adding a co-located container named `sidecar` using the `busybox:stable` image to the existing Pod.',
      'The new co-located container has to run the following command: `/bin/sh -c "tail -n+1 -f /var/log/synergy-deployment.log"`.',
      'Use a Volume mounted at `/var/log` to make the log file `synergy-deployment.log` available to the co-located container.',
      'Do not modify the specification of the existing container other than adding the required volume mount.',
    ],
    es: 'Agrega al deployment synergy-deployment un contenedor sidecar (busybox:stable) que haga tail del log, compartiendo un volumen en /var/log.',
    setup(S) {
      const L = []; for (let i = 0; i < 5; i++) L.push('2026-10-03T13:0' + i + ':00Z synergy request id=' + (1000 + i) + ' status=200');
      deploy(S, 'default', 'synergy-deployment', 'busybox:1.36', 1, { cname: 'synergy', command: busybox('while true; do echo "$(date) synergy request" >> /var/log/synergy-deployment.log; sleep 2; done'), sim: { files: { '/var/log/synergy-deployment.log': L.join('\n') } } });
    },
    checks: [
      { t: 'Existe el contenedor sidecar con busybox:stable', fn: (S) => (H.ctr(H.podTpl(find(S, 'Deployment', 'default', 'synergy-deployment')), 'sidecar') || {}).image === 'busybox:stable' },
      { t: 'sidecar ejecuta tail -n+1 -f /var/log/synergy-deployment.log', fn: (S) => /tail -n\s?\+1 -[fF] \/var\/log\/synergy-deployment\.log/.test(H.cmd(H.ctr(H.podTpl(find(S, 'Deployment', 'default', 'synergy-deployment')), 'sidecar'))) },
      { t: 'synergy y sidecar comparten un volumen en /var/log', fn: (S) => { const s = H.podTpl(find(S, 'Deployment', 'default', 'synergy-deployment')); const a = ((H.ctr(s, 'synergy') || {}).volumeMounts || []).find((m) => m.mountPath === '/var/log'); const b = ((H.ctr(s, 'sidecar') || {}).volumeMounts || []).find((m) => m.mountPath === '/var/log'); return !!a && !!b && a.name === b.name; } },
      { t: 'El pod está Ready y el sidecar muestra el log', fn: (S) => { if (!H.deployReady(S, 'default', 'synergy-deployment')) return false; const p = H.pods(S, 'default', { app: 'synergy-deployment' })[0]; return !!p && /synergy request/.test(CKA.kubectl.run(S, ['logs', p.metadata.name, '-c', 'sidecar']).out || ''); } },
    ],
    hints: ['Un Deployment sí se puede editar: `kubectl edit deploy synergy-deployment`.', 'Añade `volumes`, un volumeMount en el contenedor existente y el nuevo contenedor.', 'O como sidecar nativo: `initContainers` con `restartPolicy: Always`.'],
    solution: ['kubectl patch deployment synergy-deployment -p \'{"spec":{"template":{"spec":{"volumes":[{"name":"logs","emptyDir":{}}],"containers":[{"name":"synergy","volumeMounts":[{"name":"logs","mountPath":"/var/log"}]},{"name":"sidecar","image":"busybox:stable","command":["/bin/sh","-c","tail -n+1 -f /var/log/synergy-deployment.log"],"volumeMounts":[{"name":"logs","mountPath":"/var/log"}]}]}}}}\'', 'kubectl rollout status deployment synergy-deployment', 'kubectl logs deploy/synergy-deployment -c sidecar'],
    explain: 'El patch estratégico fusiona listas de contenedores por `name`, así que solo añades lo necesario sin reescribir el contenedor original. Cambiar el template dispara un rolling update.',
    docs: ['https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/'],
  });

  add({
    id: 'n-cronjob', src: 'Nueva', domain: 'work', weight: 4, mins: 5, host: 'cka2345',
    title: 'CronJob con historial y ejecución manual',
    task: [
      'Create a CronJob named `backup` in namespace `ops` that runs every 30 minutes, uses image `busybox:1.36` and runs the command `echo backup done`.',
      'Keep `3` successful and `1` failed finished jobs. Jobs must be terminated after `40` seconds (`activeDeadlineSeconds`).',
      'Trigger the CronJob manually once by creating a Job named `backup-manual` from it.',
    ],
    es: 'CronJob backup (cada 30 min, busybox:1.36, echo backup done, historial 3/1, activeDeadlineSeconds 40) y Job manual backup-manual a partir de él.',
    setup(S) { ns(S, 'ops'); },
    checks: [
      { t: 'CronJob backup con schedule */30 * * * * e imagen busybox:1.36', fn: (S) => { const c = find(S, 'CronJob', 'ops', 'backup'); return !!c && c.spec.schedule.trim() === '*/30 * * * *' && c.spec.jobTemplate.spec.template.spec.containers[0].image === 'busybox:1.36'; } },
      { t: 'Historial: 3 exitosos y 1 fallido', fn: (S) => { const c = find(S, 'CronJob', 'ops', 'backup'); return !!c && c.spec.successfulJobsHistoryLimit === 3 && c.spec.failedJobsHistoryLimit === 1; } },
      { t: 'activeDeadlineSeconds = 40 en el job template', fn: (S) => ((find(S, 'CronJob', 'ops', 'backup') || { spec: { jobTemplate: { spec: {} } } }).spec.jobTemplate.spec.activeDeadlineSeconds) === 40 },
      { t: 'El Job backup-manual existe y completó', fn: (S) => ((find(S, 'Job', 'ops', 'backup-manual') || { status: {} }).status.succeeded || 0) >= 1 },
    ],
    hints: ['`kubectl create cronjob backup -n ops --image=busybox:1.36 --schedule="*/30 * * * *" --dry-run=client -o yaml -- /bin/sh -c "echo backup done"`', '`kubectl create job backup-manual --from=cronjob/backup -n ops`'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: backup\n  namespace: ops\nspec:\n  schedule: \"*/30 * * * *\"\n  successfulJobsHistoryLimit: 3\n  failedJobsHistoryLimit: 1\n  jobTemplate:\n    spec:\n      activeDeadlineSeconds: 40\n      template:\n        spec:\n          restartPolicy: OnFailure\n          containers:\n          - name: backup\n            image: busybox:1.36\n            command: [\"/bin/sh\", \"-c\", \"echo backup done\"]\nEOF", 'kubectl -n ops create job backup-manual --from=cronjob/backup', 'kubectl -n ops get cronjob,job,pods'],
    explain: 'Ubicación de los campos: los límites de historial van en `CronJob.spec`; `activeDeadlineSeconds` va en `jobTemplate.spec`, que es el spec del Job. Los pods de un Job requieren `restartPolicy` Never u OnFailure.',
    docs: ['https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/'],
  });

  add({
    id: 'n-secret', src: 'Nueva', domain: 'work', weight: 4, mins: 5, host: 'cka2388',
    title: 'Secret como variables y como volumen',
    task: [
      'Create a Secret named `db-credentials` in namespace `app` with the keys `username=admin` and `password=S3cr3t!`.',
      'Create a Pod `db-client` (image `busybox:1.36`, command `sleep 3600`) in namespace `app` that:',
      '- exposes the key `username` as environment variable `DB_USER` and `password` as `DB_PASS`',
      '- mounts the whole Secret read-only at `/etc/db`',
    ],
    es: 'Secret db-credentials y pod db-client con DB_USER/DB_PASS desde el Secret y el Secret montado de solo lectura en /etc/db.',
    setup(S) { ns(S, 'app'); },
    checks: [
      { t: 'Secret db-credentials con username=admin y password=S3cr3t!', fn: (S) => { const s = find(S, 'Secret', 'app', 'db-credentials'); return !!s && CKA.kubectl.unb64(s.data.username) === 'admin' && CKA.kubectl.unb64(s.data.password) === 'S3cr3t!'; } },
      { t: 'db-client tiene DB_USER y DB_PASS desde el Secret', fn: (S) => { const p = find(S, 'Pod', 'app', 'db-client'); const env = (p && p.spec.containers[0].env) || []; const ref = (n, k) => env.some((e) => e.name === n && e.valueFrom && e.valueFrom.secretKeyRef && e.valueFrom.secretKeyRef.name === 'db-credentials' && e.valueFrom.secretKeyRef.key === k); return ref('DB_USER', 'username') && ref('DB_PASS', 'password'); } },
      { t: 'El Secret está montado readOnly en /etc/db y el pod corre', fn: (S) => { const p = find(S, 'Pod', 'app', 'db-client'); if (!H.ready(p)) return false; const v = (p.spec.volumes || []).find((x) => x.secret && x.secret.secretName === 'db-credentials'); return !!v && (p.spec.containers[0].volumeMounts || []).some((m) => m.name === v.name && m.mountPath === '/etc/db' && m.readOnly === true); } },
    ],
    hints: ["`kubectl -n app create secret generic db-credentials --from-literal=username=admin --from-literal='password=S3cr3t!'`", 'Verifica: `kubectl -n app exec db-client -- env | grep DB_`'],
    solution: ["kubectl -n app create secret generic db-credentials --from-literal=username=admin --from-literal='password=S3cr3t!'", "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: db-client\n  namespace: app\nspec:\n  containers:\n  - name: db-client\n    image: busybox:1.36\n    command: [\"sleep\", \"3600\"]\n    env:\n    - name: DB_USER\n      valueFrom:\n        secretKeyRef:\n          name: db-credentials\n          key: username\n    - name: DB_PASS\n      valueFrom:\n        secretKeyRef:\n          name: db-credentials\n          key: password\n    volumeMounts:\n    - name: creds\n      mountPath: /etc/db\n      readOnly: true\n  volumes:\n  - name: creds\n    secret:\n      secretName: db-credentials\nEOF", 'kubectl -n app exec db-client -- env', 'kubectl -n app exec db-client -- cat /etc/db/username'],
    explain: 'Usa comillas simples para valores con caracteres especiales (`!`). Los Secrets se guardan en base64 (no cifrados). Montados como volumen, cada clave es un archivo.',
    docs: ['https://kubernetes.io/docs/concepts/configuration/secret/'],
  });

  add({
    id: 'n-daemonset', src: 'Nueva', domain: 'work', weight: 4, mins: 5, host: 'cka2431',
    title: 'DaemonSet también en el plano de control',
    task: ['Create a DaemonSet named `node-exporter` in namespace `monitoring` using image `prom/node-exporter:v1.9.1`. It must run one Pod on **every** node of the cluster, including the control plane node.'],
    es: 'DaemonSet node-exporter en monitoring que corra en todos los nodos, incluido el plano de control.',
    setup(S) { ns(S, 'monitoring'); },
    checks: [
      { t: 'Existe el DaemonSet node-exporter con la imagen correcta', fn: (S) => !!find(S, 'DaemonSet', 'monitoring', 'node-exporter') && (H.podTpl(find(S, 'DaemonSet', 'monitoring', 'node-exporter')).containers || []).some((c) => c.image === 'prom/node-exporter:v1.9.1') },
      { t: 'Hay un pod Running en cada nodo (incluido el control plane)', fn: (S) => { const ps = list(S, 'Pod', 'monitoring').filter((p) => (p.metadata.ownerReferences || []).some((r) => r.kind === 'DaemonSet' && r.name === 'node-exporter')); const nodes = list(S, 'Node').map((n) => n.metadata.name); return nodes.every((n) => ps.some((p) => p.spec.nodeName === n && X.podIsReady(p))); } },
    ],
    hints: ['No hay `kubectl create daemonset`: genera un Deployment con --dry-run y cambia kind a DaemonSet (quita replicas y strategy).', 'Toleration para `node-role.kubernetes.io/control-plane:NoSchedule`.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: node-exporter\n  namespace: monitoring\nspec:\n  selector:\n    matchLabels:\n      app: node-exporter\n  template:\n    metadata:\n      labels:\n        app: node-exporter\n    spec:\n      tolerations:\n      - key: node-role.kubernetes.io/control-plane\n        operator: Exists\n        effect: NoSchedule\n      containers:\n      - name: node-exporter\n        image: prom/node-exporter:v1.9.1\nEOF", 'kubectl -n monitoring get ds,pods -o wide'],
    explain: 'El nodo del plano de control tiene el taint `node-role.kubernetes.io/control-plane:NoSchedule`; sin la toleration el DaemonSet lo omite.',
    docs: ['https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/'],
  });

  add({
    id: 'n-limits', src: 'Nueva', domain: 'work', weight: 4, mins: 6, host: 'cka2470',
    title: 'LimitRange y ResourceQuota',
    task: [
      'In namespace `limited`:',
      '- Create a LimitRange `container-defaults` so containers get default requests `cpu: 100m, memory: 128Mi` and default limits `cpu: 200m, memory: 256Mi`.',
      '- Create a ResourceQuota `pod-quota` limiting the namespace to `5` pods.',
      '- Create a Pod `test` with image `nginx` (without resources) and verify it received the defaults.',
    ],
    es: 'LimitRange con defaults, ResourceQuota de 5 pods y un pod test que herede los valores por defecto.',
    setup(S) { ns(S, 'limited'); },
    checks: [
      { t: 'LimitRange container-defaults con defaults correctos', fn: (S) => { const l = find(S, 'LimitRange', 'limited', 'container-defaults'); const c = l && (l.spec.limits || []).find((x) => x.type === 'Container'); return !!c && C.parseCpu((c.defaultRequest || {}).cpu) === 100 && C.parseMem((c.defaultRequest || {}).memory) === 128 && C.parseCpu((c.default || {}).cpu) === 200 && C.parseMem((c.default || {}).memory) === 256; } },
      { t: 'ResourceQuota pod-quota con pods: 5', fn: (S) => String((((find(S, 'ResourceQuota', 'limited', 'pod-quota') || { spec: {} }).spec.hard) || {}).pods) === '5' },
      { t: 'El pod test recibió requests 100m/128Mi', fn: (S) => { const p = find(S, 'Pod', 'limited', 'test'); const r = p && ((p.spec.containers[0].resources || {}).requests || {}); return !!p && C.parseCpu(r.cpu) === 100 && C.parseMem(r.memory) === 128; } },
    ],
    hints: ['La LimitRange debe existir ANTES de crear el pod (se aplica en la admisión).', '`kubectl create quota pod-quota --hard=pods=5 -n limited`'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: LimitRange\nmetadata:\n  name: container-defaults\n  namespace: limited\nspec:\n  limits:\n  - type: Container\n    defaultRequest:\n      cpu: 100m\n      memory: 128Mi\n    default:\n      cpu: 200m\n      memory: 256Mi\nEOF", 'kubectl -n limited create quota pod-quota --hard=pods=5', 'kubectl -n limited run test --image=nginx', 'kubectl -n limited get pod test -o jsonpath="{.spec.containers[0].resources}"'],
    explain: 'LimitRange y ResourceQuota actúan en la admisión: no cambian pods existentes. Con cuotas de CPU/memoria, cada pod nuevo debe declarar requests/limits (o recibirlos de una LimitRange).',
    docs: ['https://kubernetes.io/docs/concepts/policy/limit-range/', 'https://kubernetes.io/docs/concepts/policy/resource-quotas/'],
  });

  // ---------------------------------------------------------------- Servicios y redes
  add({
    id: 'n-gateway', src: 'Estilo 2025-26', domain: 'net', weight: 7, mins: 10, host: 'cka3012',
    title: 'Migrar un Ingress a Gateway API (HTTPS)',
    task: [
      'Migrate an existing web application from Ingress to Gateway API. You must maintain HTTPS access.',
      '- A GatewayClass named `nginx` is installed in the cluster.',
      '- Create a Gateway named `web-gateway` in namespace `web-app` with hostname `gateway.web.k8s.local` that maintains the existing TLS and listener configuration from the existing Ingress resource named `web`.',
      '- Create an HTTPRoute named `web-route` with hostname `gateway.web.k8s.local` that maintains the existing routing rules from the current Ingress resource named `web`.',
      '- Finally, delete the existing Ingress resource named `web`.',
    ],
    es: 'Crea el Gateway web-gateway (HTTPS, host gateway.web.k8s.local, TLS web-tls) y el HTTPRoute web-route con las mismas reglas del Ingress web; después borra el Ingress.',
    setup(S) {
      ns(S, 'web-app');
      put(S, { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass', metadata: { name: 'nginx' }, spec: { controllerName: 'gateway.nginx.org/nginx-gateway-controller' } }, { ageMs: AGE });
      ingressClass(S, 'nginx', true);
      deploy(S, 'web-app', 'web', 'nginx:1.29', 2, { sim: { body: 'web-app v2' } });
      service(S, 'web-app', 'web', { app: 'web' }, 80, 80);
      put(S, { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-tls', namespace: 'web-app' }, type: 'kubernetes.io/tls', data: { 'tls.crt': 'LS0tLS1CRUdJTi...', 'tls.key': 'LS0tLS1CRUdJTi...' } }, { ageMs: AGE });
      put(S, { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'web', namespace: 'web-app' }, spec: { ingressClassName: 'nginx', tls: [{ hosts: ['gateway.web.k8s.local'], secretName: 'web-tls' }], rules: [{ host: 'gateway.web.k8s.local', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } }, { ageMs: AGE });
      file(S, 'cp', '/etc/hosts', X.fsRead(S, S.cpName, '/etc/hosts') + '172.30.1.101 gateway.web.k8s.local\n');
    },
    checks: [
      { t: 'Gateway web-gateway (clase nginx) con listener HTTPS 443, hostname y TLS web-tls', fn: (S) => { const g = find(S, 'Gateway', 'web-app', 'web-gateway'); return !!g && g.spec.gatewayClassName === 'nginx' && (g.spec.listeners || []).some((l) => l.protocol === 'HTTPS' && l.port === 443 && l.hostname === 'gateway.web.k8s.local' && ((l.tls || {}).certificateRefs || []).some((c) => c.name === 'web-tls')); } },
      { t: 'HTTPRoute web-route con el hostname, ligado al Gateway y con backend web:80', fn: (S) => { const r = find(S, 'HTTPRoute', 'web-app', 'web-route'); return !!r && (r.spec.hostnames || []).includes('gateway.web.k8s.local') && (r.spec.parentRefs || []).some((p) => p.name === 'web-gateway') && (r.spec.rules || []).some((x) => (x.backendRefs || []).some((b) => b.name === 'web' && b.port === 80)); } },
      { t: 'curl https://gateway.web.k8s.local responde vía Gateway', fn: (S) => { const r = H.http(S, null, null, 'https://gateway.web.k8s.local/', null, { 'gateway.web.k8s.local': '172.30.1.101' }); return r.status === 200; } },
      { t: 'El Ingress web fue eliminado', fn: (S) => !find(S, 'Ingress', 'web-app', 'web') },
    ],
    hints: ['`kubectl -n web-app get ingress web -o yaml` para copiar host, TLS y reglas.', 'Gateway: `listeners: [{name: https, protocol: HTTPS, port: 443, hostname: ..., tls: {mode: Terminate, certificateRefs: [{kind: Secret, name: web-tls}]}}]`', 'HTTPRoute: `parentRefs`, `hostnames`, `rules[].matches[].path` y `backendRefs` (con port).'],
    solution: [
      'kubectl -n web-app get ingress web -o yaml',
      "cat <<EOF | kubectl apply -f -\napiVersion: gateway.networking.k8s.io/v1\nkind: Gateway\nmetadata:\n  name: web-gateway\n  namespace: web-app\nspec:\n  gatewayClassName: nginx\n  listeners:\n  - name: https\n    protocol: HTTPS\n    port: 443\n    hostname: gateway.web.k8s.local\n    tls:\n      mode: Terminate\n      certificateRefs:\n      - kind: Secret\n        name: web-tls\n---\napiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\nmetadata:\n  name: web-route\n  namespace: web-app\nspec:\n  parentRefs:\n  - name: web-gateway\n  hostnames:\n  - gateway.web.k8s.local\n  rules:\n  - matches:\n    - path:\n        type: PathPrefix\n        value: /\n    backendRefs:\n    - name: web\n      port: 80\nEOF",
      'curl -k https://gateway.web.k8s.local',
      'kubectl -n web-app delete ingress web',
    ],
    explain: 'Gateway API separa responsabilidades: GatewayClass (infraestructura), Gateway (listeners, puertos, TLS) y HTTPRoute (reglas). En el HTTPRoute, `backendRefs` a un Service siempre requiere `port`. La documentación de Gateway API (gateway-api.sigs.k8s.io) está permitida en el examen.',
    docs: ['https://gateway-api.sigs.k8s.io/guides/tls/', 'https://kubernetes.io/docs/concepts/services-networking/gateway/'],
  });

  add({
    id: 'n-netpol-files', src: 'Estilo 2025-26', domain: 'net', weight: 6, mins: 6, host: 'cka3055',
    title: 'Elegir la NetworkPolicy menos permisiva',
    task: [
      'There are two Deployments, `frontend` (namespace `frontend`) and `backend` (namespace `backend`). A default-deny policy exists in `backend`.',
      'Review the NetworkPolicy manifests in `/home/candidate/netpol/`. Deploy the **one** policy that allows interaction between the frontend and backend Deployments while being the **least permissive**.',
      'Do not delete or change the existing default-deny NetworkPolicy. Failure to comply may result in a reduced score.',
    ],
    es: 'Aplica, de las tres políticas en ~/netpol, la que permita frontend → backend de la forma menos permisiva, sin tocar el default-deny.',
    setup(S) {
      ns(S, 'frontend'); ns(S, 'backend'); ns(S, 'other');
      deploy(S, 'frontend', 'frontend', 'nginx:1.29', 1);
      deploy(S, 'backend', 'backend', 'nginx:1.29', 1, { ports: [{ containerPort: 8080 }], sim: { listen: [8080], body: 'backend ok' } });
      pod(S, 'other', 'scanner', 'busybox:1.36', { command: busybox(), labels: { app: 'frontend' } });
      pod(S, 'frontend', 'debug', 'busybox:1.36', { command: busybox(), labels: { app: 'debug' } });
      put(S, { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'default-deny-ingress', namespace: 'backend' }, spec: { podSelector: {}, policyTypes: ['Ingress'] } }, { ageMs: AGE });
      const h = S.cpName;
      file(S, h, '/home/candidate/netpol/policy-1.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-all-namespaces\n  namespace: backend\nspec:\n  podSelector:\n    matchLabels:\n      app: backend\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector: {}\n');
      file(S, h, '/home/candidate/netpol/policy-2.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-frontend-ns-or-pods\n  namespace: backend\nspec:\n  podSelector:\n    matchLabels:\n      app: backend\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: frontend\n    - podSelector:\n        matchLabels:\n          app: frontend\n');
      file(S, h, '/home/candidate/netpol/policy-3.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-frontend-app\n  namespace: backend\nspec:\n  podSelector:\n    matchLabels:\n      app: backend\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: frontend\n      podSelector:\n        matchLabels:\n          app: frontend\n    ports:\n    - protocol: TCP\n      port: 8080\n');
    },
    checks: [
      { t: 'Se aplicó allow-frontend-app (policy-3) y ninguna otra', fn: (S) => !!find(S, 'NetworkPolicy', 'backend', 'allow-frontend-app') && !find(S, 'NetworkPolicy', 'backend', 'allow-all-namespaces') && !find(S, 'NetworkPolicy', 'backend', 'allow-frontend-ns-or-pods') },
      { t: 'El default-deny sigue existiendo', fn: (S) => !!find(S, 'NetworkPolicy', 'backend', 'default-deny-ingress') },
      { t: 'frontend → backend:8080 funciona; debug (frontend ns) y scanner (otro ns) no', fn: (S) => { const f = H.pods(S, 'frontend', { app: 'frontend' })[0]; const b = H.pods(S, 'backend', { app: 'backend' })[0]; if (!f || !b) return false; return X.netAllowed(S, f, b, 8080).ok && !H.net(S, 'frontend', 'debug', 'backend', b.metadata.name, 8080) && !H.net(S, 'other', 'scanner', 'backend', b.metadata.name, 8080); } },
    ],
    hints: ['Compara: namespaceSelector y podSelector en el MISMO elemento = AND; en elementos separados (dos guiones) = OR.', 'La que restringe puerto, namespace y etiqueta es la menos permisiva.'],
    solution: ['cat /home/candidate/netpol/policy-*.yaml', 'kubectl apply -f /home/candidate/netpol/policy-3.yaml', 'kubectl -n backend get netpol'],
    explain: 'policy-1 abre a todos los namespaces; policy-2 usa dos elementos en `from` (OR): cualquier pod del ns frontend O cualquier pod app=frontend de backend. policy-3 exige ns frontend Y app=frontend, y solo el puerto 8080: es la menos permisiva.',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/network-policies/#behavior-of-to-and-from-selectors'],
  });

  add({
    id: 'n-netpol-egress', src: 'Nueva', domain: 'net', weight: 6, mins: 9, host: 'cka3099',
    title: 'Default deny + egress a DNS y base de datos',
    task: [
      'In namespace `secure`:',
      '- Create a NetworkPolicy `deny-all` that denies all ingress and egress traffic for all Pods.',
      '- Create a NetworkPolicy `api-egress` that allows Pods with label `app=api` egress to DNS (port 53 UDP and TCP) and to Pods with label `app=db` on TCP port `5432`.',
      '- Create a NetworkPolicy `db-ingress` that allows Pods with label `app=db` to receive traffic only from `app=api` Pods on TCP port `5432`.',
    ],
    es: 'Default-deny total en secure, egress de api a DNS (53) y a db:5432, e ingress a db solo desde api:5432.',
    setup(S) {
      ns(S, 'secure');
      pod(S, 'secure', 'api', 'busybox:1.36', { command: busybox(), labels: { app: 'api' } });
      pod(S, 'secure', 'db', 'postgres:17', { labels: { app: 'db' }, ports: [{ containerPort: 5432 }], sim: { listen: [5432] } });
      pod(S, 'secure', 'web', 'busybox:1.36', { command: busybox(), labels: { app: 'web' } });
    },
    checks: [
      { t: 'deny-all selecciona todos los pods con Ingress y Egress', fn: (S) => { const n = find(S, 'NetworkPolicy', 'secure', 'deny-all'); return !!n && !((n.spec.podSelector || {}).matchLabels) && ['Ingress', 'Egress'].every((t) => (n.spec.policyTypes || []).includes(t)) && !(n.spec.ingress || []).length && !(n.spec.egress || []).length; } },
      { t: 'api-egress permite DNS (53 UDP y TCP)', fn: (S) => { const n = find(S, 'NetworkPolicy', 'secure', 'api-egress'); const ps = n ? (n.spec.egress || []).flatMap((e) => e.ports || []) : []; return ps.some((p) => +p.port === 53 && (p.protocol || 'TCP') === 'UDP') && ps.some((p) => +p.port === 53 && (p.protocol || 'TCP') === 'TCP'); } },
      { t: 'api → db:5432 permitido', fn: (S) => H.net(S, 'secure', 'api', 'secure', 'db', 5432) },
      { t: 'web → db:5432 y api → web bloqueados', fn: (S) => !H.net(S, 'secure', 'web', 'secure', 'db', 5432) && !H.net(S, 'secure', 'api', 'secure', 'web', 80) },
    ],
    hints: ['Con Egress denegado, sin regla de DNS ni siquiera se resuelven nombres.', 'Una conexión necesita egress en el origen E ingress en el destino.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny-all\n  namespace: secure\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n  - Egress\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-egress\n  namespace: secure\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n  policyTypes:\n  - Egress\n  egress:\n  - ports:\n    - protocol: UDP\n      port: 53\n    - protocol: TCP\n      port: 53\n  - to:\n    - podSelector:\n        matchLabels:\n          app: db\n    ports:\n    - protocol: TCP\n      port: 5432\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-ingress\n  namespace: secure\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: api\n    ports:\n    - protocol: TCP\n      port: 5432\nEOF", 'kubectl -n secure get netpol'],
    explain: 'Las políticas son aditivas: una política vacía `deny-all` bloquea todo y las demás abren excepciones. Recuerda siempre el DNS cuando restringes egress.',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/network-policies/#default-deny-all-ingress-and-all-egress-traffic'],
  });

  add({
    id: 'n-svc-fix', src: 'Nueva', domain: 'trbl', weight: 6, mins: 6, host: 'cka3144',
    title: 'Service sin endpoints',
    task: [
      'The Service `checkout` in namespace `shop` should route traffic on port `80` to the Pods of the Deployment `checkout`, but `curl http://checkout.shop` from Pod `client` fails.',
      'Fix the **Service** so that it works. Do not modify the Deployment.',
    ],
    es: 'El Service checkout (shop) no enruta al Deployment checkout. Corrige solo el Service.',
    setup(S) {
      ns(S, 'shop');
      deploy(S, 'shop', 'checkout', 'nginx:1.29', 2, { ports: [{ containerPort: 8080, name: 'http' }], sim: { listen: [8080], body: 'checkout ok' } });
      service(S, 'shop', 'checkout', { app: 'check-out' }, 80, 80);
      pod(S, 'shop', 'client', 'busybox:1.36', { command: busybox() });
    },
    checks: [
      { t: 'El Deployment checkout no fue modificado', fn: (S) => { const d = find(S, 'Deployment', 'shop', 'checkout'); return !!d && d.metadata.generation === 1 && d.spec.template.metadata.labels.app === 'checkout'; } },
      { t: 'El Service tiene endpoints', fn: (S) => { const s = find(S, 'Service', 'shop', 'checkout'); return !!s && X.svcEndpoints(S, s).length === 2; } },
      { t: 'curl http://checkout.shop desde client responde', fn: (S) => { const r = H.http(S, 'shop', 'client', 'http://checkout.shop'); return r.status === 200 && /checkout ok/.test(r.body); } },
    ],
    hints: ['`kubectl -n shop get endpoints checkout` vacío ⇒ selector incorrecto.', 'Compara el selector con `kubectl -n shop get pods --show-labels`.', 'Revisa también el puerto del contenedor (targetPort).'],
    solution: ['kubectl -n shop describe svc checkout', 'kubectl -n shop get pods --show-labels -o wide', 'kubectl -n shop patch svc checkout -p \'{"spec":{"selector":{"app":"checkout"},"ports":[{"port":80,"targetPort":8080,"protocol":"TCP"}]}}\'', 'kubectl -n shop get endpoints checkout', 'kubectl -n shop exec client -- wget -qO- http://checkout.shop'],
    explain: 'Dos fallos: el selector (`check-out` ≠ `checkout`) y el targetPort (80, pero el contenedor escucha en 8080). Un Service sin endpoints casi siempre es selector o readiness; si hay endpoints y aun así falla, revisa targetPort.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/'],
  });

  add({
    id: 'n-dns', src: 'Nueva', domain: 'trbl', weight: 6, mins: 6, host: 'cka3190',
    title: 'CoreDNS roto',
    task: [
      'Pods in the cluster can no longer resolve Service names. Investigate and fix the cluster DNS.',
      'Then, from the Pod `dns-test` (namespace `default`), resolve the Service `db` in namespace `data` and write the output of `nslookup` to `/opt/course/dns.txt`.',
    ],
    es: 'Repara CoreDNS y guarda la salida de nslookup del Service db.data (desde el pod dns-test) en /opt/course/dns.txt.',
    setup(S) {
      const d = find(S, 'Deployment', 'kube-system', 'coredns');
      d.spec.template.spec.containers[0].image = 'registry.k8s.io/coredns/coredns:v1.21.1';
      S.badImages = ['registry.k8s.io/coredns/coredns:v1.21.1'];
      ns(S, 'data');
      deploy(S, 'data', 'db', 'postgres:17', 1, { ports: [{ containerPort: 5432 }], sim: { listen: [5432] } });
      service(S, 'data', 'db', { app: 'db' }, 5432, 5432);
      pod(S, 'default', 'dns-test', 'busybox:1.36', { command: busybox() });
      X.mkdirp(X.fsOf(S, S.cpName), '/opt/course');
    },
    checks: [
      { t: 'CoreDNS tiene pods Ready', fn: (S) => X.dnsWorks(S) && H.deployReady(S, 'kube-system', 'coredns') },
      { t: '/opt/course/dns.txt contiene db.data.svc.cluster.local y su IP', fn: (S) => { const t = H.file(S, 'cp', '/opt/course/dns.txt') || ''; const s = find(S, 'Service', 'data', 'db'); return /db\.data\.svc\.cluster\.local/.test(t) && !!s && t.includes(s.spec.clusterIP); } },
    ],
    hints: ['`kubectl -n kube-system get pods -l k8s-app=kube-dns` y `describe`.', 'Compara la imagen con la de otro clúster (la versión correcta es v1.12.1).'],
    solution: ['kubectl -n kube-system get pods -l k8s-app=kube-dns', 'kubectl -n kube-system describe deploy coredns | grep Image', 'kubectl -n kube-system set image deployment/coredns coredns=registry.k8s.io/coredns/coredns:v1.12.1', 'kubectl -n kube-system rollout status deployment coredns', 'kubectl exec dns-test -- nslookup db.data > /opt/course/dns.txt', 'cat /opt/course/dns.txt'],
    explain: 'Sin CoreDNS los pods no resuelven `*.svc.cluster.local`. El FQDN de un Service es `<svc>.<ns>.svc.cluster.local`; desde otro namespace basta `<svc>.<ns>`.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/'],
  });

  add({
    id: 'n-ingress-hosts', src: 'Nueva', domain: 'net', weight: 5, mins: 6, host: 'cka3233',
    title: 'Ingress con host y dos rutas',
    task: [
      'Create an Ingress named `shop` in namespace `store` using the IngressClass `nginx` for host `shop.example.com`:',
      '- path `/` (Prefix) → Service `frontend` port `80`',
      '- path `/api` (Prefix) → Service `api` port `8080`',
    ],
    es: 'Ingress shop (clase nginx, host shop.example.com): / → frontend:80 y /api → api:8080, ambos Prefix.',
    setup(S) {
      ingressClass(S, 'nginx', false);
      ns(S, 'store');
      deploy(S, 'store', 'frontend', 'nginx:1.29', 1, { sim: { body: 'storefront' } });
      service(S, 'store', 'frontend', { app: 'frontend' }, 80, 80);
      deploy(S, 'store', 'api', 'hashicorp/http-echo:1.0', 1, { ports: [{ containerPort: 8080 }], sim: { listen: [8080], body: 'api v1' } });
      service(S, 'store', 'api', { app: 'api' }, 8080, 8080);
    },
    checks: [
      { t: 'El Ingress usa ingressClassName nginx y host shop.example.com', fn: (S) => { const i = find(S, 'Ingress', 'store', 'shop'); return !!i && i.spec.ingressClassName === 'nginx' && (i.spec.rules || []).some((r) => r.host === 'shop.example.com'); } },
      { t: 'Host shop.example.com / → storefront', fn: (S) => { const r = H.http(S, null, null, 'http://172.30.1.100/', 'shop.example.com'); return r.status === 200 && /storefront/.test(r.body); } },
      { t: 'Host shop.example.com /api/orders → api', fn: (S) => { const r = H.http(S, null, null, 'http://172.30.1.100/api/orders', 'shop.example.com'); return r.status === 200 && /api v1/.test(r.body); } },
    ],
    hints: ['La IngressClass nginx NO es la predeterminada: debes indicar `--class nginx`.', '`kubectl create ingress shop -n store --class=nginx --rule="shop.example.com/*=frontend:80" --rule="shop.example.com/api*=api:8080"`'],
    solution: ['kubectl -n store create ingress shop --class=nginx --rule="shop.example.com/*=frontend:80" --rule="shop.example.com/api*=api:8080"', 'kubectl -n store describe ingress shop', 'curl -s -H "Host: shop.example.com" http://172.30.1.100/api/orders'],
    explain: 'Con Prefix gana la ruta más larga que coincide (/api antes que /). Sin `ingressClassName` y sin clase por defecto, ningún controlador atiende el Ingress (sin ADDRESS).',
    docs: ['https://kubernetes.io/docs/concepts/services-networking/ingress/#path-types'],
  });

  // ---------------------------------------------------------------- Almacenamiento
  add({
    id: 'n-sc-default', src: 'Estilo 2025-26', domain: 'stor', weight: 5, mins: 5, host: 'cka4020',
    title: 'StorageClass predeterminada',
    task: [
      'Create a new StorageClass named `local-fast` with provisioner `rancher.io/local-path`, `volumeBindingMode: WaitForFirstConsumer`, reclaim policy `Delete` and volume expansion allowed.',
      'Configure it as the **default** StorageClass. It must be the only default StorageClass in the cluster.',
      'Do not modify any existing Deployments or PersistentVolumeClaims.',
    ],
    es: 'StorageClass local-fast (local-path, WaitForFirstConsumer, Delete, expansible) como única predeterminada.',
    setup(S) { sc(S, 'standard', 'kubernetes.io/no-provisioner', { default: true, mode: 'WaitForFirstConsumer', reclaimPolicy: 'Retain' }); },
    checks: [
      { t: 'local-fast con provisioner, binding mode, reclaim y expansión correctos', fn: (S) => { const s = find(S, 'StorageClass', null, 'local-fast'); return !!s && s.provisioner === 'rancher.io/local-path' && s.volumeBindingMode === 'WaitForFirstConsumer' && s.reclaimPolicy === 'Delete' && s.allowVolumeExpansion === true; } },
      { t: 'local-fast es la única StorageClass por defecto', fn: (S) => { const d = list(S, 'StorageClass').filter((s) => (s.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true'); return d.length === 1 && d[0].metadata.name === 'local-fast'; } },
    ],
    hints: ['La marca de predeterminada es la anotación `storageclass.kubernetes.io/is-default-class: "true"`.', 'Quita (o pon en "false") la anotación de `standard` con `kubectl patch` o `kubectl annotate --overwrite`.'],
    solution: ["cat <<EOF | kubectl apply -f -\napiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: local-fast\n  annotations:\n    storageclass.kubernetes.io/is-default-class: \"true\"\nprovisioner: rancher.io/local-path\nreclaimPolicy: Delete\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true\nEOF", 'kubectl annotate storageclass standard storageclass.kubernetes.io/is-default-class=false --overwrite', 'kubectl get sc'],
    explain: 'Si hay dos StorageClasses por defecto, Kubernetes usa la más reciente, pero es una mala configuración. WaitForFirstConsumer retrasa el aprovisionamiento hasta que un pod usa el PVC, para respetar la topología del nodo.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/change-default-storage-class/'],
  });

  add({
    id: 'n-mariadb', src: 'Estilo 2025-26', domain: 'stor', weight: 7, mins: 8, host: 'cka4066',
    title: 'Recuperar datos: PVC hacia un PV retenido',
    task: [
      'A user accidentally deleted the MariaDB Deployment in the `mariadb` namespace. It was configured with persistent storage. Your responsibility is to re-establish the Deployment while ensuring data is preserved by reusing the available PersistentVolume.',
      '- A PersistentVolume already exists and is retained for reuse. There is only one PV.',
      '- Create a PersistentVolumeClaim named `mariadb` in the `mariadb` namespace with access mode `ReadWriteOnce` and storage `250Mi`.',
      '- Edit the MariaDB Deployment file located at `/home/candidate/mariadb-deploy.yaml` to use the PVC you created, and apply it.',
      '- Ensure the MariaDB Deployment is running and stable.',
    ],
    es: 'Crea el PVC mariadb (RWO, 250Mi) que se ligue al PV existente, edita ~/mariadb-deploy.yaml para usarlo y aplícalo.',
    setup(S) {
      ns(S, 'mariadb');
      sc(S, 'local-path', 'rancher.io/local-path', { default: true, mode: 'Immediate' });
      put(S, { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'mariadb-pv', labels: { app: 'mariadb' } }, spec: { capacity: { storage: '250Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: '/mnt/data/mariadb' }, volumeMode: 'Filesystem' }, status: { phase: 'Available' } }, { ageMs: 5 * 86400000 });
      file(S, 'cp', '/home/candidate/mariadb-deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: mariadb\n  namespace: mariadb\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: mariadb\n  template:\n    metadata:\n      labels:\n        app: mariadb\n    spec:\n      containers:\n      - name: mariadb\n        image: mariadb:11.4\n        env:\n        - name: MARIADB_ROOT_PASSWORD\n          value: rootpass\n        ports:\n        - containerPort: 3306\n        volumeMounts:\n        - name: mariadb-data\n          mountPath: /var/lib/mysql\n      volumes:\n      - name: mariadb-data\n        persistentVolumeClaim:\n          claimName: ""\n');
    },
    checks: [
      { t: 'PVC mariadb (RWO, 250Mi) Bound al PV mariadb-pv', fn: (S) => { const c = find(S, 'PersistentVolumeClaim', 'mariadb', 'mariadb'); return !!c && c.status.phase === 'Bound' && c.spec.volumeName === 'mariadb-pv' && (c.spec.accessModes || []).join() === 'ReadWriteOnce' && c.spec.resources.requests.storage === '250Mi'; } },
      { t: 'El archivo del Deployment referencia claimName: mariadb', fn: (S) => /claimName:\s*"?mariadb"?\s*$/m.test(H.file(S, 'cp', '/home/candidate/mariadb-deploy.yaml') || '') },
      { t: 'El Deployment mariadb está Ready usando el PVC', fn: (S) => H.deployReady(S, 'mariadb', 'mariadb', 1) && (H.podTpl(find(S, 'Deployment', 'mariadb', 'mariadb')).volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === 'mariadb') },
    ],
    hints: ['`kubectl get pv mariadb-pv -o yaml`: fíjate en storageClassName (vacío).', 'Hay una StorageClass por defecto: si omites `storageClassName`, el PVC NO se ligará al PV. Usa `storageClassName: ""`.', 'Puedes forzar el vínculo con `volumeName: mariadb-pv`.'],
    solution: ['kubectl get pv', 'kubectl get sc', "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: mariadb\n  namespace: mariadb\nspec:\n  storageClassName: \"\"\n  accessModes:\n  - ReadWriteOnce\n  resources:\n    requests:\n      storage: 250Mi\nEOF", 'kubectl -n mariadb get pvc mariadb', "sed -i 's/claimName: \"\"/claimName: mariadb/' /home/candidate/mariadb-deploy.yaml", 'kubectl apply -f /home/candidate/mariadb-deploy.yaml', 'kubectl -n mariadb get deploy,pods'],
    explain: 'Un PVC sin `storageClassName` recibe la StorageClass por defecto y dispara aprovisionamiento dinámico: tendrías un volumen nuevo y vacío (datos perdidos). `storageClassName: ""` pide explícitamente un PV estático sin clase.',
    docs: ['https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reserving-a-persistentvolume'],
  });

  add({
    id: 'n-pvc-pending', src: 'Nueva', domain: 'stor', weight: 5, mins: 6, host: 'cka4101',
    title: 'PVC Pending por modo de acceso',
    task: [
      'The Pod `logger` in namespace `logging` is Pending because its PersistentVolumeClaim `logs-pvc` does not bind.',
      'Fix the PVC (do not modify the PersistentVolume `logs-pv`) so that it binds to `logs-pv` and the Pod runs.',
    ],
    es: 'El PVC logs-pvc no se liga al PV logs-pv. Corrige el PVC (no el PV) para que el pod logger arranque.',
    setup(S) {
      ns(S, 'logging');
      put(S, { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'logs-pv' }, spec: { capacity: { storage: '1Gi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual', hostPath: { path: '/mnt/logs' } }, status: { phase: 'Available' } }, { ageMs: AGE });
      put(S, { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'logs-pvc', namespace: 'logging' }, spec: { storageClassName: 'manual', accessModes: ['ReadWriteMany'], resources: { requests: { storage: '1Gi' } } }, status: { phase: 'Pending' } }, { ageMs: AGE });
      pod(S, 'logging', 'logger', 'busybox:1.36', { command: busybox(), volumeMounts: [{ name: 'logs', mountPath: '/logs' }], spec: { volumes: [{ name: 'logs', persistentVolumeClaim: { claimName: 'logs-pvc' } }] } });
    },
    checks: [
      { t: 'logs-pvc está Bound a logs-pv', fn: (S) => { const c = find(S, 'PersistentVolumeClaim', 'logging', 'logs-pvc'); return !!c && c.status.phase === 'Bound' && c.spec.volumeName === 'logs-pv'; } },
      { t: 'El PV logs-pv no se modificó (sigue RWO, 1Gi)', fn: (S) => { const v = find(S, 'PersistentVolume', null, 'logs-pv'); return !!v && v.spec.accessModes.join() === 'ReadWriteOnce' && v.spec.capacity.storage === '1Gi'; } },
      { t: 'El pod logger está Running', fn: (S) => H.ready(find(S, 'Pod', 'logging', 'logger')) },
    ],
    hints: ['`kubectl describe pvc logs-pvc -n logging` y compara accessModes con el PV.', 'El spec de un PVC es inmutable: bórralo y recréalo (o `replace --force`).'],
    solution: ['kubectl -n logging describe pvc logs-pvc', 'kubectl get pv logs-pv', 'kubectl -n logging get pvc logs-pvc -o yaml > pvc.yaml', "sed -i 's/ReadWriteMany/ReadWriteOnce/' pvc.yaml", 'kubectl replace --force -f pvc.yaml', 'kubectl -n logging get pvc,pods'],
    explain: 'Para ligarse, el PV debe ofrecer TODOS los modos de acceso pedidos, capacidad ≥ solicitada y la misma storageClassName. En un clúster real, si el pod ya usa el PVC, la protección `kubernetes.io/pvc-protection` deja el PVC en Terminating hasta borrar el pod.',
    docs: ['https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes'],
  });

  // ---------------------------------------------------------------- Troubleshooting
  add({
    id: 'n-apiserver', src: 'Estilo 2025-26', domain: 'trbl', weight: 8, mins: 8, host: 'cka5002',
    title: 'kube-apiserver caído tras migración',
    task: [
      'After a cluster migration, the controlplane `kube-apiserver` is not coming up. Before the migration, etcd was external and in HA; after migration, the kube-apiserver was pointing to the etcd **peer** port `2380`.',
      'Investigate and fix the issue so that `kubectl` works again against the cluster.',
    ],
    es: 'El kube-apiserver no arranca porque apunta al puerto de peers de etcd (2380). Arréglalo.',
    setup(S) {
      const p = '/etc/kubernetes/manifests/kube-apiserver.yaml';
      X.fsWrite(S, S.cpName, p, X.fsRead(S, S.cpName, p).replace('--etcd-servers=https://127.0.0.1:2379', '--etcd-servers=https://127.0.0.1:2380'));
    },
    checks: [
      { t: 'kube-apiserver responde (kubectl funciona)', fn: (S) => S.cp.apiserver.ok },
      { t: '--etcd-servers apunta al puerto de clientes 2379', fn: (S) => /--etcd-servers=https:\/\/(127\.0\.0\.1|localhost|172\.30\.1\.2):2379/.test(H.file(S, 'cp', '/etc/kubernetes/manifests/kube-apiserver.yaml') || '') },
    ],
    hints: ['Sin API server, kubectl no sirve: usa `sudo crictl ps -a` y `sudo crictl logs <id>`.', 'También `sudo journalctl -u kubelet | tail` y los logs en /var/log/pods/.', 'El manifiesto está en /etc/kubernetes/manifests/kube-apiserver.yaml.'],
    solution: ['kubectl get nodes', 'sudo crictl ps -a | grep apiserver', "sudo grep etcd-servers /etc/kubernetes/manifests/kube-apiserver.yaml", "sudo sed -i 's#--etcd-servers=https://127.0.0.1:2380#--etcd-servers=https://127.0.0.1:2379#' /etc/kubernetes/manifests/kube-apiserver.yaml", 'kubectl get nodes'],
    explain: 'etcd: 2379 = clientes (lo que usa el API server), 2380 = comunicación entre miembros. Los componentes del plano de control son pods estáticos: al guardar el manifiesto, el kubelet los recrea (puede tardar ~1 min). Nunca edites con `kubectl edit` un pod estático.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-cluster/#control-plane-nodes'],
  });

  add({
    id: 'n-scheduler', src: 'Nueva', domain: 'trbl', weight: 7, mins: 6, host: 'cka5048',
    title: 'Pods Pending: scheduler roto',
    task: ['New Pods in the cluster stay in `Pending` state and are never assigned to a node. Find the cause and fix it. The Pod `test-sched` must be running afterwards.'],
    es: 'Los pods nuevos quedan Pending sin nodo. Encuentra y corrige la causa; test-sched debe quedar Running.',
    setup(S) {
      const p = '/etc/kubernetes/manifests/kube-scheduler.yaml';
      X.fsWrite(S, S.cpName, p, X.fsRead(S, S.cpName, p).replace('- --kubeconfig=/etc/kubernetes/scheduler.conf', '- --kubeconfig=/etc/kubernetes/scheduler.config'));
      X.reconcile(S);
      pod(S, 'default', 'test-sched', 'nginx:1.29');
    },
    checks: [
      { t: 'kube-scheduler está sano', fn: (S) => S.cp.scheduler.ok },
      { t: 'test-sched está Running en un nodo', fn: (S) => H.ready(find(S, 'Pod', 'default', 'test-sched')) },
    ],
    hints: ['`kubectl get pods -n kube-system` → kube-scheduler en CrashLoopBackOff.', '`kubectl -n kube-system logs kube-scheduler-controlplane` o `crictl logs`.', 'Compara las rutas del manifiesto con los archivos reales de /etc/kubernetes/.'],
    solution: ['kubectl get pods -A | grep -v Running', 'kubectl -n kube-system describe pod kube-scheduler-controlplane | grep -i kubeconfig', 'ls /etc/kubernetes/', "sudo sed -i 's#scheduler.config#scheduler.conf#' /etc/kubernetes/manifests/kube-scheduler.yaml", 'kubectl get pod test-sched -o wide'],
    explain: 'Pods Pending sin eventos de scheduling = el scheduler no está trabajando. Los pods con `nodeName` fijo sí arrancan porque saltan al scheduler.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-cluster/'],
  });

  add({
    id: 'n-kubelet-ca', src: 'Nueva', domain: 'trbl', weight: 7, mins: 7, host: 'cka5091',
    title: 'Nodo NotReady: configuración del kubelet',
    task: ['The node `node01` is `NotReady`. Investigate and fix the problem. The fix must survive a reboot of the node.'],
    es: 'node01 está NotReady. Diagnostica y corrige de forma permanente.',
    setup(S) {
      const n = H.node(S, 'node01');
      X.fsWrite(S, 'node01', '/var/lib/kubelet/config.yaml', X.KUBELET_CONFIG.replace('clientCAFile: /etc/kubernetes/pki/ca.crt', 'clientCAFile: /etc/kubernetes/pki/ca-cert.crt'));
      n._sim.svc.kubelet.active = false;
      n._sim.svc.kubelet.error = X.kubeletCheck(S, n);
    },
    checks: [
      { t: 'node01 está Ready', fn: (S) => H.nodeReady(S, 'node01') },
      { t: 'clientCAFile apunta a /etc/kubernetes/pki/ca.crt', fn: (S) => /clientCAFile:\s*\/etc\/kubernetes\/pki\/ca\.crt/.test(H.file(S, 'node01', '/var/lib/kubelet/config.yaml') || '') },
    ],
    hints: ['`ssh node01`, `sudo systemctl status kubelet`, `sudo journalctl -u kubelet | tail -20`.', 'El error menciona un archivo que no existe.'],
    solution: ['ssh node01', 'sudo journalctl -u kubelet -n 5', 'ls /etc/kubernetes/pki/', "sudo sed -i 's#ca-cert.crt#ca.crt#' /var/lib/kubelet/config.yaml", 'sudo systemctl restart kubelet', 'sudo systemctl status kubelet', 'exit', 'kubectl get nodes'],
    explain: 'El kubelet lee /var/lib/kubelet/config.yaml; un error ahí lo hace fallar en bucle (activating/auto-restart). Editar ese archivo y reiniciar es permanente.',
    docs: ['https://kubernetes.io/docs/tasks/administer-cluster/kubelet-config-file/'],
  });

  add({
    id: 'n-kubelet-dropin', src: 'Nueva', domain: 'trbl', weight: 7, mins: 7, host: 'cka5133',
    title: 'Nodo NotReady: unidad systemd del kubelet',
    task: ['The node `node01` is `NotReady` after someone changed the kubelet service configuration. Fix it permanently.'],
    es: 'node01 NotReady tras un cambio en la unidad systemd del kubelet. Corrígelo permanentemente.',
    setup(S) {
      const n = H.node(S, 'node01');
      const p = '/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf';
      const bad = X.KUBEADM_DROPIN.replace('ExecStart=/usr/bin/kubelet', 'ExecStart=/usr/local/bin/kubelet');
      X.fsWrite(S, 'node01', p, bad);
      n._sim.unitLoaded = bad;
      n._sim.svc.kubelet.active = false;
      n._sim.svc.kubelet.error = X.kubeletCheck(S, n);
    },
    checks: [
      { t: 'El drop-in usa /usr/bin/kubelet', fn: (S) => /ExecStart=\/usr\/bin\/kubelet /.test(H.file(S, 'node01', '/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf') || '') },
      { t: 'systemd recargó la unidad (daemon-reload)', fn: (S) => /ExecStart=\/usr\/bin\/kubelet /.test(H.node(S, 'node01')._sim.unitLoaded || '') },
      { t: 'node01 está Ready', fn: (S) => H.nodeReady(S, 'node01') },
    ],
    hints: ['`systemctl status kubelet` muestra el drop-in y el error de ExecStart.', '`which kubelet` / `ls /usr/bin/kubelet`.', 'Después de editar una unidad: `systemctl daemon-reload`.'],
    solution: ['ssh node01', 'sudo systemctl status kubelet', 'sudo journalctl -u kubelet -n 5', 'ls -l /usr/bin/kubelet', "sudo sed -i 's#/usr/local/bin/kubelet#/usr/bin/kubelet#' /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf", 'sudo systemctl daemon-reload', 'sudo systemctl restart kubelet', 'exit', 'kubectl get nodes'],
    explain: 'systemd guarda en memoria la definición de la unidad; si editas el archivo y no haces `daemon-reload`, el restart sigue usando la ruta vieja (verás un aviso). Revisa siempre la línea `ExecStart` del drop-in.',
    docs: ['https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/'],
  });

  add({
    id: 'n-containerd', src: 'Nueva', domain: 'trbl', weight: 6, mins: 5, host: 'cka5170',
    cluster: { workers: ['node01', 'node02'] },
    title: 'Nodo NotReady: runtime de contenedores',
    task: ['The node `node02` is `NotReady`. Investigate the root cause and bring it back to `Ready` permanently.'],
    es: 'node02 está NotReady. Encuentra la causa raíz y corrígela de forma permanente.',
    setup(S) { const n = H.node(S, 'node02'); n._sim.svc.containerd.active = false; n._sim.svc.containerd.enabled = false; },
    checks: [
      { t: 'containerd está activo y habilitado en node02', fn: (S) => { const s = H.node(S, 'node02')._sim.svc.containerd; return s.active && s.enabled; } },
      { t: 'node02 está Ready', fn: (S) => H.nodeReady(S, 'node02') },
    ],
    hints: ['`kubectl describe node node02` → mensaje “container runtime is down”.', 'ssh node02 → `systemctl status containerd`.'],
    solution: ['kubectl describe node node02 | grep -A6 Conditions', 'ssh node02', 'sudo systemctl status containerd', 'sudo systemctl enable --now containerd', 'sudo systemctl restart kubelet', 'exit', 'kubectl get nodes'],
    explain: 'El kubelet depende del runtime (CRI). Revisa en orden: containerd → kubelet → CNI. `enable --now` lo deja persistente.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/'],
  });

  add({
    id: 'n-controller-mgr', src: 'Nueva', domain: 'trbl', weight: 7, mins: 6, host: 'cka5212',
    title: 'Deployments que no crean pods',
    task: ['The Deployment `scale-me` in namespace `default` shows `0/3` ready replicas and no ReplicaSet or Pods are being created. Fix the cluster so that the Deployment reaches `3/3`.'],
    es: 'El deployment scale-me no crea ReplicaSets ni pods. Arregla el clúster para que llegue a 3/3.',
    setup(S) {
      const p = '/etc/kubernetes/manifests/kube-controller-manager.yaml';
      X.fsWrite(S, S.cpName, p, X.fsRead(S, S.cpName, p).replace('- kube-controller-manager\n', '- kube-controller-manger\n'));
      X.reconcile(S);
      put(S, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'scale-me', namespace: 'default', labels: { app: 'scale-me' } }, spec: { replicas: 3, selector: { matchLabels: { app: 'scale-me' } }, template: { metadata: { labels: { app: 'scale-me' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.29' }] } } }, status: {} }, { ageMs: 600000 });
    },
    checks: [
      { t: 'kube-controller-manager está sano', fn: (S) => S.cp.controllerManager.ok },
      { t: 'scale-me tiene 3/3 réplicas Ready', fn: (S) => H.deployReady(S, 'default', 'scale-me', 3) },
    ],
    hints: ['Los ReplicaSets los crea el kube-controller-manager.', '`kubectl -n kube-system get pods` y `describe` del controller-manager.', 'Revisa el primer elemento de `command` en el manifiesto.'],
    solution: ['kubectl get deploy,rs scale-me', 'kubectl -n kube-system get pods', 'kubectl -n kube-system describe pod kube-controller-manager-controlplane | tail -5', "sudo sed -i 's/kube-controller-manger/kube-controller-manager/' /etc/kubernetes/manifests/kube-controller-manager.yaml", 'kubectl get deploy scale-me'],
    explain: 'Sin controller-manager no hay reconciliación: Deployments, ReplicaSets, Jobs, endpoints y PVs dinámicos dejan de funcionar, aunque el API server acepte objetos.',
    docs: ['https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/'],
  });

  add({
    id: 'n-app-fix', src: 'Nueva', domain: 'trbl', weight: 6, mins: 6, host: 'cka5255',
    title: 'Aplicación que no arranca (imagen y ConfigMap)',
    task: [
      'Two Deployments in namespace `prod` are not ready:',
      '- `api` should run image `nginx:1.27`.',
      '- `worker` expects a ConfigMap named `worker-config` with the key `log_level` set to `info`.',
      'Fix both so all their Pods are Running and Ready.',
    ],
    es: 'Corrige api (imagen nginx:1.27) y worker (crea el ConfigMap worker-config con log_level=info) en prod.',
    setup(S) {
      ns(S, 'prod');
      deploy(S, 'prod', 'api', 'ngnix:1.27', 2, { cname: 'api' });
      deploy(S, 'prod', 'worker', 'busybox:1.36', 1, { command: busybox('while true; do echo "level=$LOG_LEVEL"; sleep 5; done'), env: [{ name: 'LOG_LEVEL', valueFrom: { configMapKeyRef: { name: 'worker-config', key: 'log_level' } } }] });
    },
    checks: [
      { t: 'api usa nginx:1.27 y está 2/2', fn: (S) => H.podTpl(find(S, 'Deployment', 'prod', 'api')).containers[0].image === 'nginx:1.27' && H.deployReady(S, 'prod', 'api', 2) },
      { t: 'ConfigMap worker-config con log_level=info', fn: (S) => ((find(S, 'ConfigMap', 'prod', 'worker-config') || {}).data || {}).log_level === 'info' },
      { t: 'worker está 1/1', fn: (S) => H.deployReady(S, 'prod', 'worker', 1) },
    ],
    hints: ['`kubectl -n prod get pods` → ImagePullBackOff y CreateContainerConfigError.', '`kubectl -n prod describe pod <pod>` → sección Events.'],
    solution: ['kubectl -n prod get pods', 'kubectl -n prod describe pods | grep -A3 -i "warning"', 'kubectl -n prod set image deployment/api api=nginx:1.27', 'kubectl -n prod create configmap worker-config --from-literal=log_level=info', 'kubectl -n prod rollout restart deployment worker', 'kubectl -n prod get pods'],
    explain: 'ImagePullBackOff = nombre/tag de imagen o registro; CreateContainerConfigError = falta un ConfigMap/Secret o una clave referenciada. La sección Events de `describe` te da la causa exacta.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/'],
  });

  add({
    id: 'n-heavy-pod', src: 'Nueva', domain: 'trbl', weight: 5, mins: 5, host: 'cka5299',
    title: 'Pod Pending por recursos',
    task: ['The Pod `heavy` in namespace `troubled` is Pending. Find the reason and fix it by changing its memory request to `512Mi`. Do not change anything else in the Pod.'],
    es: 'El pod heavy está Pending por recursos; cambia su request de memoria a 512Mi sin tocar nada más.',
    setup(S) {
      ns(S, 'troubled');
      pod(S, 'troubled', 'heavy', 'nginx:1.29', { labels: { app: 'heavy', tier: 'batch' }, resources: { requests: { cpu: '100m', memory: '8Gi' } } });
    },
    checks: [
      { t: 'heavy pide memory: 512Mi y conserva imagen/etiquetas/cpu', fn: (S) => { const p = find(S, 'Pod', 'troubled', 'heavy'); if (!p) return false; const r = p.spec.containers[0].resources.requests; return r.memory === '512Mi' && r.cpu === '100m' && p.spec.containers[0].image === 'nginx:1.29' && p.metadata.labels.tier === 'batch'; } },
      { t: 'heavy está Running', fn: (S) => H.ready(find(S, 'Pod', 'troubled', 'heavy')) },
    ],
    hints: ['`kubectl -n troubled describe pod heavy` → FailedScheduling: Insufficient memory.', 'Los recursos de un pod no se pueden editar en caliente: exporta, cambia y `replace --force`.'],
    solution: ['kubectl -n troubled describe pod heavy | tail -3', 'kubectl -n troubled get pod heavy -o yaml > heavy.yaml', "sed -i 's/memory: 8Gi/memory: 512Mi/' heavy.yaml", 'kubectl replace --force -f heavy.yaml', 'kubectl -n troubled get pod heavy'],
    explain: 'FailedScheduling explica por qué ningún nodo sirve (Insufficient memory/cpu, taints, afinidad...). Desde v1.33 existe el resize en caliente de recursos (subrecurso `resize`), pero el camino seguro en el examen es recrear el pod.',
    docs: ['https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/'],
  });

  add({
    id: 'n-crash-prev', src: 'Nueva', domain: 'trbl', weight: 4, mins: 3, host: 'cka5341',
    title: 'Logs del contenedor anterior (CrashLoopBackOff)',
    task: ['The Pod `crashy` in namespace `default` keeps restarting. Write the **last log line of the previous (crashed) container instance** to `/opt/course/crash.txt`.'],
    es: 'Guarda la última línea del log de la instancia anterior (caída) del pod crashy en /opt/course/crash.txt.',
    setup(S) {
      pod(S, 'default', 'crashy', 'busybox:1.36', { command: busybox('/app/start.sh'), sim: { crash: true, restarts: 5, exitCode: 1, prevLogs: 'starting orders-service v2.3.1\nconnecting to postgres://db:5432/orders\nFATAL: database "orders" does not exist', logs: '' } });
      X.mkdirp(X.fsOf(S, S.cpName), '/opt/course');
    },
    checks: [{ t: '/opt/course/crash.txt contiene la línea FATAL', fn: (S) => H.trim(H.file(S, 'cp', '/opt/course/crash.txt')) === 'FATAL: database "orders" does not exist' }],
    hints: ['`kubectl logs crashy --previous` (o `-p`).'],
    solution: ['kubectl get pod crashy', 'kubectl logs crashy --previous', 'kubectl logs crashy --previous | tail -1 > /opt/course/crash.txt', 'cat /opt/course/crash.txt'],
    explain: 'En CrashLoopBackOff el contenedor actual suele no tener logs aún; `--previous` muestra los de la instancia que falló. `describe` también da el Exit Code y el motivo (Error, OOMKilled…).',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/'],
  });

  add({
    id: 'n-top-node', src: 'Nueva', domain: 'trbl', weight: 4, mins: 3, host: 'cka5384',
    cluster: { workers: ['node01', 'node02'] },
    title: 'Nodo con más memoria usada',
    task: ['Find the node with the highest **memory** usage in the cluster and write only its name to `/opt/course/top-node.txt`.'],
    es: 'Escribe en /opt/course/top-node.txt el nombre del nodo con mayor uso de memoria.',
    setup(S) {
      pod(S, 'default', 'analytics-1', 'busybox:1.36', { command: busybox(), spec: { nodeName: 'node02' }, sim: { mem: 1800, cpu: 150 } });
      pod(S, 'default', 'analytics-2', 'busybox:1.36', { command: busybox(), spec: { nodeName: 'node01' }, sim: { mem: 200, cpu: 400 } });
      X.mkdirp(X.fsOf(S, S.cpName), '/opt/course');
    },
    checks: [{ t: '/opt/course/top-node.txt contiene node02', fn: (S) => H.trim(H.file(S, 'cp', '/opt/course/top-node.txt')) === 'node02' }],
    hints: ['`kubectl top nodes --sort-by=memory`'],
    solution: ['kubectl top nodes --sort-by=memory', "kubectl top nodes --sort-by=memory --no-headers | head -1 | awk '{print $1}' > /opt/course/top-node.txt", 'cat /opt/course/top-node.txt'],
    explain: '`kubectl top` muestra consumo real (metrics-server), a diferencia de `describe node`, que muestra requests reservados.',
    docs: ['https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/'],
  });

  // ------------------------------------------------------------ utilidades del banco
  function build(task) {
    const S = X.buildCluster(Object.assign({ host: task.host }, task.cluster || {}));
    S.podSimByName = S.podSimByName || {};
    task.setup(S);
    X.reconcile(S);
    for (const o of S.objs) if (o.metadata && o.metadata.creationTimestamp && Date.parse(o.metadata.creationTimestamp) >= S.now - 1000) o.metadata.creationTimestamp = new Date(S.now - 2 * 3600000).toISOString();
    S.events = S.events.map((e) => Object.assign(e, { time: Math.min(e.time, S.now - 90000) }));
    S.taskId = task.id;
    return S;
  }

  function evaluate(task, S) {
    return task.checks.map((c) => { let ok = false; try { ok = !!c.fn(S); } catch (e) { ok = false; } return { t: c.t, ok }; });
  }

  CKA.tasks = { list: T, DOMAINS, build, evaluate, H };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
