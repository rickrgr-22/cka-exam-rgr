/* Kubelab CKA — simulador del clúster: sistema de archivos, nodos, plano de control,
   controladores, planificador, red, RBAC y enrutamiento HTTP. */
(function (CKA) {
  'use strict';
  const C = CKA.core;
  const { clone, find, list, put, remove, event } = C;

  // ================================================================ sistema de archivos
  function hostKey(S, h) { return (S.alias && S.alias[h]) || h; }
  function fsOf(S, h) {
    const k = hostKey(S, h || S.host);
    if (!S.hosts[k]) S.hosts[k] = { files: {}, dirs: { '/': true } };
    return S.hosts[k];
  }
  function norm(path, cwd) {
    if (!path) return cwd || '/';
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = (cwd && cwd.startsWith('/root') ? '/root' : '/home/candidate') + p.slice(1);
    if (!p.startsWith('/')) p = (cwd || '/') + '/' + p;
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop(); else out.push(seg);
    }
    return '/' + out.join('/');
  }
  function parentOf(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  function mkdirp(fs, p) {
    let cur = '';
    for (const seg of p.split('/').filter(Boolean)) { cur += '/' + seg; fs.dirs[cur] = true; }
    fs.dirs['/'] = true;
  }
  function fsRead(S, h, p) { const fs = fsOf(S, h); return Object.prototype.hasOwnProperty.call(fs.files, p) ? fs.files[p] : null; }
  function fsWrite(S, h, p, content) { const fs = fsOf(S, h); mkdirp(fs, parentOf(p)); fs.files[p] = content; }
  function fsIsDir(S, h, p) { return !!fsOf(S, h).dirs[p]; }
  function fsExists(S, h, p) { const fs = fsOf(S, h); return fs.dirs[p] || Object.prototype.hasOwnProperty.call(fs.files, p); }
  function fsList(S, h, dir) {
    const fs = fsOf(S, h);
    const pre = dir === '/' ? '/' : dir + '/';
    const names = new Set();
    for (const f of Object.keys(fs.files)) if (f.startsWith(pre)) names.add(f.slice(pre.length).split('/')[0] + (f.slice(pre.length).includes('/') ? '/' : ''));
    for (const d of Object.keys(fs.dirs)) if (d.startsWith(pre) && d !== dir) names.add(d.slice(pre.length).split('/')[0] + '/');
    const res = [];
    for (const n of names) { const base = n.replace(/\/$/, ''); if (!res.some((r) => r.name === base)) res.push({ name: base, dir: n.endsWith('/') || !!fs.dirs[pre + base] }); }
    return res.sort((a, b) => a.name.localeCompare(b.name));
  }
  function fsRemove(S, h, p, recursive) {
    const fs = fsOf(S, h);
    if (Object.prototype.hasOwnProperty.call(fs.files, p)) { delete fs.files[p]; return true; }
    if (fs.dirs[p]) {
      if (!recursive) return false;
      for (const f of Object.keys(fs.files)) if (f.startsWith(p + '/')) delete fs.files[f];
      for (const d of Object.keys(fs.dirs)) if (d === p || d.startsWith(p + '/')) delete fs.dirs[d];
      return true;
    }
    return false;
  }
  const ROOT_WRITE = ['/etc', '/var/lib', '/usr', '/root', '/opt/cni', '/var/log'];
  const ROOT_READ = [/\.key$/, /^\/root(\/|$)/, /^\/var\/lib\/etcd/];
  function canWrite(S, p) {
    if (S.user === 'root') return true;
    if ((S.writable || []).some((w) => p.startsWith(w))) return true;
    return !ROOT_WRITE.some((r) => p === r || p.startsWith(r + '/'));
  }
  function canRead(S, p) {
    if (S.user === 'root') return true;
    return !ROOT_READ.some((r) => r.test(p));
  }

  // ================================================================ plantillas
  function cpIP(S) { return S.cpIP || '172.30.1.2'; }

  function staticManifests(S, v) {
    const ip = cpIP(S);
    const hp = (name, path, type) => ({ name, hostPath: { path, type: type || 'DirectoryOrCreate' } });
    const base = (name, command, image, mounts, vols, extra) => ({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { labels: { component: name, tier: 'control-plane' }, name, namespace: 'kube-system' },
      spec: Object.assign({
        containers: [{ command, image, imagePullPolicy: 'IfNotPresent', name, resources: { requests: { cpu: name === 'kube-apiserver' ? '250m' : '100m' } }, volumeMounts: mounts }],
        hostNetwork: true, priorityClassName: 'system-node-critical', volumes: vols,
      }, extra || {}),
    });
    const api = base('kube-apiserver', [
      'kube-apiserver', '--advertise-address=' + ip, '--allow-privileged=true', '--authorization-mode=Node,RBAC',
      '--client-ca-file=/etc/kubernetes/pki/ca.crt', '--enable-admission-plugins=NodeRestriction', '--enable-bootstrap-token-auth=true',
      '--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt', '--etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt',
      '--etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key', '--etcd-servers=https://127.0.0.1:2379',
      '--kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt', '--kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key',
      '--secure-port=6443', '--service-account-issuer=https://kubernetes.default.svc.cluster.local',
      '--service-account-key-file=/etc/kubernetes/pki/sa.pub', '--service-account-signing-key-file=/etc/kubernetes/pki/sa.key',
      '--service-cluster-ip-range=10.96.0.0/12', '--tls-cert-file=/etc/kubernetes/pki/apiserver.crt', '--tls-private-key-file=/etc/kubernetes/pki/apiserver.key',
    ], 'registry.k8s.io/kube-apiserver:' + v,
    [{ mountPath: '/etc/ssl/certs', name: 'ca-certs', readOnly: true }, { mountPath: '/etc/kubernetes/pki', name: 'k8s-certs', readOnly: true }],
    [hp('ca-certs', '/etc/ssl/certs'), hp('k8s-certs', '/etc/kubernetes/pki')]);
    api.metadata.annotations = { 'kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint': ip + ':6443' };
    const etcd = base('etcd', [
      'etcd', '--advertise-client-urls=https://' + ip + ':2379', '--cert-file=/etc/kubernetes/pki/etcd/server.crt', '--client-cert-auth=true',
      '--data-dir=/var/lib/etcd', '--initial-advertise-peer-urls=https://' + ip + ':2380', '--initial-cluster=controlplane=https://' + ip + ':2380',
      '--key-file=/etc/kubernetes/pki/etcd/server.key', '--listen-client-urls=https://127.0.0.1:2379,https://' + ip + ':2379',
      '--listen-peer-urls=https://' + ip + ':2380', '--name=controlplane', '--peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt',
      '--peer-key-file=/etc/kubernetes/pki/etcd/peer.key', '--peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt',
      '--snapshot-count=10000', '--trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt',
    ], 'registry.k8s.io/etcd:3.6.4-0',
    [{ mountPath: '/var/lib/etcd', name: 'etcd-data' }, { mountPath: '/etc/kubernetes/pki/etcd', name: 'etcd-certs' }],
    [hp('etcd-certs', '/etc/kubernetes/pki/etcd'), hp('etcd-data', '/var/lib/etcd')]);
    const sched = base('kube-scheduler', [
      'kube-scheduler', '--authentication-kubeconfig=/etc/kubernetes/scheduler.conf', '--authorization-kubeconfig=/etc/kubernetes/scheduler.conf',
      '--bind-address=127.0.0.1', '--kubeconfig=/etc/kubernetes/scheduler.conf', '--leader-elect=true',
    ], 'registry.k8s.io/kube-scheduler:' + v,
    [{ mountPath: '/etc/kubernetes/scheduler.conf', name: 'kubeconfig', readOnly: true }],
    [hp('kubeconfig', '/etc/kubernetes/scheduler.conf', 'FileOrCreate')]);
    const cm = base('kube-controller-manager', [
      'kube-controller-manager', '--allocate-node-cidrs=true', '--authentication-kubeconfig=/etc/kubernetes/controller-manager.conf',
      '--authorization-kubeconfig=/etc/kubernetes/controller-manager.conf', '--bind-address=127.0.0.1', '--client-ca-file=/etc/kubernetes/pki/ca.crt',
      '--cluster-cidr=192.168.0.0/16', '--cluster-name=kubernetes', '--cluster-signing-cert-file=/etc/kubernetes/pki/ca.crt',
      '--cluster-signing-key-file=/etc/kubernetes/pki/ca.key', '--controllers=*,bootstrapsigner,tokencleaner',
      '--kubeconfig=/etc/kubernetes/controller-manager.conf', '--leader-elect=true', '--root-ca-file=/etc/kubernetes/pki/ca.crt',
      '--service-account-private-key-file=/etc/kubernetes/pki/sa.key', '--use-service-account-credentials=true',
    ], 'registry.k8s.io/kube-controller-manager:' + v,
    [{ mountPath: '/etc/kubernetes/pki', name: 'k8s-certs', readOnly: true }, { mountPath: '/etc/kubernetes/controller-manager.conf', name: 'kubeconfig', readOnly: true }],
    [hp('k8s-certs', '/etc/kubernetes/pki'), hp('kubeconfig', '/etc/kubernetes/controller-manager.conf', 'FileOrCreate')]);
    return { 'kube-apiserver': api, etcd, 'kube-scheduler': sched, 'kube-controller-manager': cm };
  }

  const KUBEADM_DROPIN = [
    '# Note: This dropin only works with kubeadm and kubelet v1.11+',
    '[Service]',
    'Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"',
    'Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"',
    'EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env',
    'EnvironmentFile=-/etc/default/kubelet',
    'ExecStart=',
    'ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS',
    '',
  ].join('\n');

  const KUBELET_CONFIG = [
    'apiVersion: kubelet.config.k8s.io/v1beta1',
    'authentication:',
    '  anonymous:',
    '    enabled: false',
    '  webhook:',
    '    cacheTTL: 0s',
    '    enabled: true',
    '  x509:',
    '    clientCAFile: /etc/kubernetes/pki/ca.crt',
    'authorization:',
    '  mode: Webhook',
    'cgroupDriver: systemd',
    'clusterDNS:',
    '- 10.96.0.10',
    'clusterDomain: cluster.local',
    'containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock',
    'kind: KubeletConfiguration',
    'rotateCertificates: true',
    'staticPodPath: /etc/kubernetes/manifests',
    '',
  ].join('\n');

  function nodeFs(S, name, isCp, v) {
    const fs = fsOf(S, name);
    const w = (p, c) => { mkdirp(fs, parentOf(p)); fs.files[p] = c; };
    w('/etc/kubernetes/pki/ca.crt', '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIK8s (CA del clúster)\n-----END CERTIFICATE-----\n');
    w('/etc/kubernetes/kubelet.conf', 'apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://' + cpIP(S) + ':6443\n  name: kubernetes\n');
    w('/var/lib/kubelet/config.yaml', KUBELET_CONFIG);
    w('/var/lib/kubelet/kubeadm-flags.env', 'KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.10"\n');
    w('/usr/lib/systemd/system/kubelet.service', '[Unit]\nDescription=kubelet: The Kubernetes Node Agent\nDocumentation=https://kubernetes.io/docs/\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/bin/kubelet\nRestart=always\nStartLimitInterval=0\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n');
    w('/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf', KUBEADM_DROPIN);
    w('/usr/bin/kubelet', '\u007fELF kubelet ' + v);
    w('/usr/bin/kubeadm', '\u007fELF kubeadm ' + v);
    w('/usr/bin/kubectl', '\u007fELF kubectl ' + v);
    w('/etc/containerd/config.toml', 'version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc.options]\n  SystemdCgroup = true\n');
    w('/etc/hosts', '127.0.0.1 localhost\n' + cpIP(S) + ' controlplane\n');
    w('/etc/apt/sources.list.d/kubernetes.list', 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/' + v.replace(/^v(\d+\.\d+).*/, 'v$1') + '/deb/ /\n');
    mkdirp(fs, '/etc/kubernetes/manifests');
    mkdirp(fs, '/home/candidate');
    mkdirp(fs, '/root');
    mkdirp(fs, '/tmp');
    mkdirp(fs, '/opt');
    mkdirp(fs, '/etc/cni/net.d');
    mkdirp(fs, '/etc/sysctl.d');
    fs.files['/etc/sysctl.d/99-sysctl.conf'] = '# Parámetros del kernel (ver sysctl.d(5))\n';
    if (isCp) {
      for (const f of ['ca.key', 'apiserver.crt', 'apiserver.key', 'apiserver-etcd-client.crt', 'apiserver-etcd-client.key', 'apiserver-kubelet-client.crt', 'apiserver-kubelet-client.key', 'front-proxy-ca.crt', 'sa.key', 'sa.pub']) w('/etc/kubernetes/pki/' + f, '(material criptográfico ' + f + ')\n');
      for (const f of ['ca.crt', 'ca.key', 'server.crt', 'server.key', 'peer.crt', 'peer.key', 'healthcheck-client.crt', 'healthcheck-client.key']) w('/etc/kubernetes/pki/etcd/' + f, '(material criptográfico etcd ' + f + ')\n');
      w('/etc/kubernetes/admin.conf', 'apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: LS0tLS1CRUdJTi...\n    server: https://' + cpIP(S) + ':6443\n  name: kubernetes\ncontexts:\n- context:\n    cluster: kubernetes\n    user: kubernetes-admin\n  name: kubernetes-admin@kubernetes\ncurrent-context: kubernetes-admin@kubernetes\n');
      w('/etc/kubernetes/scheduler.conf', 'apiVersion: v1\nkind: Config\n# kubeconfig de kube-scheduler\n');
      w('/etc/kubernetes/controller-manager.conf', 'apiVersion: v1\nkind: Config\n# kubeconfig de kube-controller-manager\n');
      w('/etc/kubernetes/super-admin.conf', 'apiVersion: v1\nkind: Config\n');
      const m = staticManifests(S, v);
      for (const k of Object.keys(m)) w('/etc/kubernetes/manifests/' + k + '.yaml', C.toYaml(m[k]));
      mkdirp(fs, '/var/lib/etcd/member/snap');
      w('/var/lib/etcd/member/snap/db', '(base de datos de etcd)');
      w('/root/.kube/config', fsOf(S, name).files['/etc/kubernetes/admin.conf']);
      w('/home/candidate/.kube/config', fsOf(S, name).files['/etc/kubernetes/admin.conf']);
    }
  }

  function makeNode(S, name, opts) {
    const isCp = !!opts.cp;
    const v = opts.version;
    const ip = opts.ip;
    const pv = v.replace(/^v/, '');
    const labels = { 'beta.kubernetes.io/arch': 'amd64', 'beta.kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux' };
    if (isCp) { labels['node-role.kubernetes.io/control-plane'] = ''; labels['node.kubernetes.io/exclude-from-external-load-balancers'] = ''; }
    Object.assign(labels, opts.labels || {});
    const n = {
      apiVersion: 'v1', kind: 'Node',
      metadata: { name, labels, annotations: { 'kubeadm.alpha.kubernetes.io/cri-socket': 'unix:///var/run/containerd/containerd.sock', 'node.alpha.kubernetes.io/ttl': '0' } },
      spec: { podCIDR: '192.168.' + opts.idx + '.0/24', taints: isCp ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] : [] },
      status: {
        addresses: [{ type: 'InternalIP', address: ip }, { type: 'Hostname', address: name }],
        capacity: { cpu: String(opts.cpu || 2), 'ephemeral-storage': '19221248Ki', memory: (opts.memMi || 4000) * 1024 + 'Ki', pods: '110' },
        allocatable: { cpu: String(opts.cpu || 2), 'ephemeral-storage': '17714119975', memory: ((opts.memMi || 4000) - 100) * 1024 + 'Ki', pods: '110' },
        nodeInfo: { architecture: 'amd64', containerRuntimeVersion: 'containerd://2.1.4', kernelVersion: '6.8.0-79-generic', kubeProxyVersion: v, kubeletVersion: v, operatingSystem: 'linux', osImage: 'Ubuntu 24.04.3 LTS' },
        conditions: [],
      },
      _sim: {
        cp: isCp,
        svc: { kubelet: { active: true, enabled: true }, containerd: { active: true, enabled: true } },
        pkgs: { kubeadm: pv, kubelet: pv, kubectl: pv },
        held: { kubeadm: true, kubelet: true, kubectl: true },
        runningKubelet: pv,
        unitLoaded: KUBEADM_DROPIN,
        baseCpu: opts.baseCpu || (isCp ? 180 : 60),
        baseMem: opts.baseMem || (isCp ? 1100 : 600),
      },
    };
    if (opts.taints) n.spec.taints = n.spec.taints.concat(opts.taints);
    put(S, n, { ageMs: 30 * 86400000 });
    nodeFs(S, name, isCp, v);
    return n;
  }

  function sysDeploy(S, ns, name, image, replicas, labels, extra) {
    const d = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name, namespace: ns, labels: Object.assign({}, labels) },
      spec: {
        replicas, selector: { matchLabels: labels },
        template: { metadata: { labels: Object.assign({}, labels) }, spec: Object.assign({ containers: [{ name: extra && extra.cname || name, image }] }, extra && extra.spec || {}) },
      },
      _sim: Object.assign({}, extra && extra.sim || {}),
    };
    return put(S, d, { ageMs: 30 * 86400000 });
  }

  function sysDS(S, ns, name, image, labels, tolerateAll) {
    return put(S, {
      apiVersion: 'apps/v1', kind: 'DaemonSet',
      metadata: { name, namespace: ns, labels: Object.assign({}, labels) },
      spec: {
        selector: { matchLabels: labels },
        template: { metadata: { labels: Object.assign({}, labels) }, spec: { containers: [{ name, image }], tolerations: tolerateAll ? [{ operator: 'Exists' }] : undefined } },
      },
    }, { ageMs: 30 * 86400000 });
  }

  /**
   * Construye un clúster kubeadm realista.
   * opts: host, cp, workers[], version, cni ('calico'|'flannel'|null), cpuPerNode, memMi
   */
  function buildCluster(opts) {
    opts = Object.assign({ host: 'cka000059', cp: 'controlplane', workers: ['node01'], version: 'v1.35.1', cni: 'calico' }, opts || {});
    const S = C.newState();
    S.version = opts.version;
    S.taskHost = opts.host;
    S.cpName = opts.cp;
    S.cpIP = '172.30.1.2';
    S.alias = {};
    S.alias[opts.host] = opts.cp;
    S.cni = opts.cni;
    S.hosts.base = { files: {}, dirs: {} };
    mkdirp(S.hosts.base, '/home/candidate');
    mkdirp(S.hosts.base, '/tmp');
    S.hosts.base.files['/home/candidate/.bashrc'] = 'alias k=kubectl\n';
    S.hosts.base.files['/etc/hosts'] = '127.0.0.1 localhost\n';
    ['default', 'kube-system', 'kube-public', 'kube-node-lease'].forEach((ns) => put(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { 'kubernetes.io/metadata.name': ns } } }, { ageMs: 30 * 86400000 }));
    makeNode(S, opts.cp, { cp: true, version: opts.version, ip: S.cpIP, idx: 0, cpu: opts.cpuPerNode, memMi: opts.memMi });
    opts.workers.forEach((w, i) => {
      const ip = '172.30.2.' + (2 + i);
      makeNode(S, w, { version: opts.version, ip, idx: i + 1, cpu: opts.cpuPerNode, memMi: opts.memMi, labels: (opts.nodeLabels || {})[w], taints: (opts.nodeTaints || {})[w] });
      fsOf(S, opts.cp).files['/etc/hosts'] += ip + ' ' + w + '\n';
    });
    S.hosts.base.files['/etc/hosts'] += '# ' + opts.host + ' -> ' + S.cpIP + '\n';
    // Sistema
    put(S, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'default' } }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', labels: { component: 'apiserver', provider: 'kubernetes' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }] } }, { ageMs: 30 * 86400000 });
    sysDeploy(S, 'kube-system', 'coredns', 'registry.k8s.io/coredns/coredns:v1.12.1', 2, { 'k8s-app': 'kube-dns' }, { spec: { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }], priorityClassName: 'system-cluster-critical' } });
    put(S, { apiVersion: 'v1', kind: 'Service', metadata: { name: 'kube-dns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }] } }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'coredns', namespace: 'kube-system' }, data: { Corefile: '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n' } }, { ageMs: 30 * 86400000 });
    sysDS(S, 'kube-system', 'kube-proxy', 'registry.k8s.io/kube-proxy:' + opts.version, { 'k8s-app': 'kube-proxy' }, true);
    if (opts.cni === 'calico') installCni(S, 'calico');
    if (opts.cni === 'flannel') installCni(S, 'flannel');
    sysDeploy(S, 'kube-system', 'metrics-server', 'registry.k8s.io/metrics-server/metrics-server:v0.8.0', 1, { 'k8s-app': 'metrics-server' });
    // RBAC por defecto
    put(S, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'cluster-admin' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }] }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'admin' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'networking.k8s.io', 'autoscaling'], resources: ['*'], verbs: ['*'] }] }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'edit' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'networking.k8s.io', 'autoscaling'], resources: ['pods', 'deployments', 'services', 'configmaps', 'secrets', 'jobs', 'cronjobs', 'statefulsets', 'daemonsets', 'replicasets', 'ingresses', 'persistentvolumeclaims'], verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] }] }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'view' }, rules: [{ apiGroups: ['', 'apps', 'batch', 'networking.k8s.io', 'autoscaling'], resources: ['pods', 'deployments', 'services', 'configmaps', 'jobs', 'cronjobs', 'statefulsets', 'daemonsets', 'replicasets', 'ingresses', 'persistentvolumeclaims'], verbs: ['get', 'list', 'watch'] }] }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'kubeadm:cluster-admins' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeadm:cluster-admins' }] }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-cluster-critical' }, value: 2000000000, description: 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.' }, { ageMs: 30 * 86400000 });
    put(S, { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-node-critical' }, value: 2000001000, description: 'Used for system critical pods that must not be moved from their current node.' }, { ageMs: 30 * 86400000 });
    reconcile(S);
    // Todos los pods del sistema aparecen con antigüedad
    for (const o of S.objs) if (o.kind === 'Pod' || o.kind === 'ReplicaSet') o.metadata.creationTimestamp = new Date(S.now - 30 * 86400000).toISOString();
    return S;
  }

  function installCni(S, which) {
    if (which === 'calico') {
      put(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'calico-system', labels: { 'kubernetes.io/metadata.name': 'calico-system' } } }, { ageMs: 30 * 86400000 });
      sysDS(S, 'calico-system', 'calico-node', 'docker.io/calico/node:v3.30.3', { 'k8s-app': 'calico-node' }, true);
      sysDeploy(S, 'calico-system', 'calico-kube-controllers', 'docker.io/calico/kube-controllers:v3.30.3', 1, { 'k8s-app': 'calico-kube-controllers' });
      S.cni = 'calico';
    } else if (which === 'flannel') {
      put(S, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-flannel', labels: { 'kubernetes.io/metadata.name': 'kube-flannel' } } }, { ageMs: 30 * 86400000 });
      sysDS(S, 'kube-flannel', 'kube-flannel-ds', 'ghcr.io/flannel-io/flannel:v0.27.3', { app: 'flannel' }, true);
      S.cni = 'flannel';
    }
    for (const n of list(S, 'Node')) {
      fsWrite(S, n.metadata.name, '/etc/cni/net.d/' + (which === 'calico' ? '10-calico.conflist' : '10-flannel.conflist'), '{ "name": "' + which + '", "cniVersion": "1.0.0" }\n');
    }
  }

  // ================================================================ salud del plano de control
  function flagsOf(manifest) {
    const c = manifest && manifest.spec && manifest.spec.containers && manifest.spec.containers[0];
    const cmd = (c && (c.command || []).concat(c.args || [])) || [];
    const flags = {};
    for (const a of cmd) { const m = String(a).match(/^--([^=]+)=(.*)$/); if (m) flags[m[1]] = m[2]; }
    return { bin: cmd[0], flags, image: c && c.image };
  }

  function readManifest(S, comp) {
    const txt = fsRead(S, S.cpName, '/etc/kubernetes/manifests/' + comp + '.yaml');
    if (txt == null) return { missing: true };
    try {
      const d = C.yaml.load(txt);
      if (!d || !d.spec || !d.spec.containers) return { error: 'manifiesto inválido: falta spec.containers' };
      return { doc: d };
    } catch (e) {
      return { error: 'error parsing /etc/kubernetes/manifests/' + comp + '.yaml: ' + String(e.message).split('\n')[0] };
    }
  }

  function cpHealth(S) {
    const cpNode = find(S, 'Node', null, S.cpName);
    const kubeletOk = cpNode && cpNode._sim.svc.kubelet.active && cpNode._sim.svc.containerd.active;
    const r = {};
    const down = (reason) => ({ ok: false, reason });
    // etcd
    const em = readManifest(S, 'etcd');
    if (!kubeletOk) r.etcd = down('kubelet no está en ejecución en el plano de control');
    else if (em.missing) r.etcd = down('no existe /etc/kubernetes/manifests/etcd.yaml');
    else if (em.error) r.etcd = down(em.error);
    else {
      const f = flagsOf(em.doc);
      const dataDir = f.flags['data-dir'] || '/var/lib/etcd';
      const c = em.doc.spec.containers[0];
      let hostDir = null;
      for (const vm of c.volumeMounts || []) {
        if (dataDir === vm.mountPath || dataDir.startsWith(vm.mountPath + '/')) {
          const vol = (em.doc.spec.volumes || []).find((v) => v.name === vm.name);
          if (vol && vol.hostPath) hostDir = norm(vol.hostPath.path + dataDir.slice(vm.mountPath.length));
        }
      }
      if (!hostDir) r.etcd = down('el directorio --data-dir=' + dataDir + ' no está montado desde el host (revisa volumeMounts/volumes)');
      else if (f.bin !== 'etcd') r.etcd = down('exec: "' + f.bin + '": executable file not found in $PATH');
      else if (hostDir === S.etcd.dataDir) r.etcd = { ok: true, dir: hostDir };
      else if (S.etcdDirs[hostDir]) {
        const restored = S.etcdDirs[hostDir];
        const nodes = S.objs.filter((o) => o.kind === 'Node');
        S.objs = nodes.concat(clone(restored).filter((o) => o.kind !== 'Node'));
        delete S.etcdDirs[hostDir];
        S.etcd.dataDir = hostDir;
        S.etcd.restoredFrom = restored._from || hostDir;
        S.flags.etcdRestored = hostDir;
        r.etcd = { ok: true, dir: hostDir };
      } else if (fsIsDir(S, S.cpName, hostDir + '/member')) {
        r.etcd = down('member directory ' + hostDir + '/member no pertenece a este clúster');
      } else {
        r.etcd = down('open ' + hostDir + '/member/snap/db: no such file or directory (el directorio de datos no contiene una base restaurada)');
      }
    }
    // apiserver
    const am = readManifest(S, 'kube-apiserver');
    if (!kubeletOk) r.apiserver = down('kubelet no está en ejecución en el plano de control');
    else if (am.missing) r.apiserver = down('no existe /etc/kubernetes/manifests/kube-apiserver.yaml');
    else if (am.error) r.apiserver = down(am.error);
    else {
      const f = flagsOf(am.doc);
      const ep = f.flags['etcd-servers'] || '';
      const miss = ['client-ca-file', 'etcd-cafile', 'etcd-certfile', 'etcd-keyfile', 'tls-cert-file', 'tls-private-key-file'].find((k) => f.flags[k] && !fsExists(S, S.cpName, f.flags[k]));
      if (f.bin !== 'kube-apiserver') r.apiserver = down('exec: "' + f.bin + '": executable file not found in $PATH');
      else if (!/:2379(\b|$)/.test(ep) || !/127\.0\.0\.1|localhost|172\.30\.1\.2/.test(ep)) r.apiserver = down('W grpc: addrConn.createTransport failed to connect to {Addr: "' + ep.replace(/^https?:\/\//, '') + '"}. Err: connection error: desc = "transport: Error while dialing: dial tcp ' + ep.replace(/^https?:\/\//, '') + ': connect: connection refused"\nF Error: context deadline exceeded');
      else if (miss) r.apiserver = down('E run.go: open ' + f.flags[miss] + ': no such file or directory');
      else if (!r.etcd.ok) r.apiserver = down('F Error creating leases: error creating storage factory: context deadline exceeded (etcd no disponible)');
      else if (f.image && !/registry\.k8s\.io\/kube-apiserver:v\d/.test(f.image)) r.apiserver = down('Failed to pull image "' + f.image + '": not found');
      else r.apiserver = { ok: true };
    }
    const simple = (comp, bin) => {
      const m = readManifest(S, comp);
      if (!kubeletOk) return down('kubelet no está en ejecución en el plano de control');
      if (m.missing) return down('no existe /etc/kubernetes/manifests/' + comp + '.yaml');
      if (m.error) return down(m.error);
      const f = flagsOf(m.doc);
      if (f.bin !== bin) return down('exec: "' + f.bin + '": executable file not found in $PATH: unknown');
      if (f.flags.kubeconfig && !fsExists(S, S.cpName, f.flags.kubeconfig)) return down('stat ' + f.flags.kubeconfig + ': no such file or directory');
      if (f.image && !new RegExp('registry\\.k8s\\.io/' + bin + ':v\\d').test(f.image)) return down('Failed to pull image "' + f.image + '"');
      return { ok: true };
    };
    r.scheduler = simple('kube-scheduler', 'kube-scheduler');
    r.controllerManager = simple('kube-controller-manager', 'kube-controller-manager');
    S.cp = r;
    return r;
  }

  function mirrorPods(S) {
    const map = { 'kube-apiserver': 'apiserver', etcd: 'etcd', 'kube-scheduler': 'scheduler', 'kube-controller-manager': 'controllerManager' };
    const dir = '/etc/kubernetes/manifests/';
    for (const comp of Object.keys(map)) {
      const name = comp + '-' + S.cpName;
      const m = readManifest(S, comp);
      let p = find(S, 'Pod', 'kube-system', name);
      if (m.doc) {
        const spec = clone(m.doc.spec);
        spec.nodeName = S.cpName;
        const np = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'kube-system', labels: m.doc.metadata.labels || {}, annotations: { 'kubernetes.io/config.source': 'file' }, ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: S.cpName, controller: true }] }, spec, status: {} };
        if (!p || C.stable(p.spec) !== C.stable(spec)) { p = put(S, np, { ageMs: p ? 0 : 30 * 86400000 }); }
      }
      if (p) {
        const h = S.cp[map[comp]];
        p._sim = p._sim || {};
        p._sim.static = true;
        p._sim.crash = !(h && h.ok);
        p._sim.crashReason = h && h.reason;
      }
    }
    // Pods estáticos en cualquier nodo (p. ej. /etc/kubernetes/manifests en workers)
    for (const n of list(S, 'Node')) {
      const nn = n.metadata.name;
      if (!n._sim.svc.kubelet.active) continue;
      const fs = fsOf(S, nn);
      for (const f of Object.keys(fs.files)) {
        if (!f.startsWith(dir) || !/\.ya?ml$/.test(f)) continue;
        const base = f.slice(dir.length);
        if (nn === S.cpName && ['kube-apiserver.yaml', 'etcd.yaml', 'kube-scheduler.yaml', 'kube-controller-manager.yaml'].includes(base)) continue;
        let doc;
        try { doc = C.yaml.load(fs.files[f]); } catch (e) { continue; }
        if (!doc || doc.kind !== 'Pod' || !doc.metadata || !doc.metadata.name) continue;
        const ns = doc.metadata.namespace || 'default';
        const name = doc.metadata.name + '-' + nn;
        const spec = clone(doc.spec || {});
        spec.nodeName = nn;
        const existing = find(S, 'Pod', ns, name);
        if (!existing || C.stable(existing.spec) !== C.stable(spec)) {
          put(S, { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels: doc.metadata.labels || {}, annotations: { 'kubernetes.io/config.source': 'file' }, ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: nn, controller: true }] }, spec, status: {}, _sim: { static: true, staticFile: nn + ':' + f } });
        }
      }
    }
    // eliminar pods estáticos cuyo archivo ya no existe
    for (const p of list(S, 'Pod')) {
      if (p._sim && p._sim.staticFile) {
        const [nn, f] = p._sim.staticFile.split(':');
        if (fsRead(S, nn, f) == null) remove(S, p);
      }
    }
  }

  // ================================================================ nodos
  function kubeletCheck(S, n) {
    const nn = n.metadata.name;
    const svc = n._sim.svc;
    if (!svc.containerd.active) return 'E0930 run.go:72] "command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \\"unix:///var/run/containerd/containerd.sock\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix /var/run/containerd/containerd.sock: connect: no such file or directory\\""';
    const unit = n._sim.unitLoaded || '';
    const exec = unit.split('\n').filter((l) => /^ExecStart=/.test(l.trim())).map((l) => l.trim().slice(10).trim()).filter(Boolean).pop() || '';
    const bin = exec.split(/\s+/)[0];
    if (bin && !fsExists(S, nn, bin)) return 'kubelet.service: Failed at step EXEC spawning ' + bin + ': No such file or directory';
    const cfgArg = (unit.match(/--config=(\S+?)["\s]/) || [])[1] || '/var/lib/kubelet/config.yaml';
    const cfg = fsRead(S, nn, cfgArg);
    if (cfg == null) return 'E0930 run.go:72] "command failed" err="failed to load kubelet config file, path: ' + cfgArg + ', error: failed to load Kubelet config file ' + cfgArg + ', error failed to read kubelet config file \\"' + cfgArg + '\\", error: open ' + cfgArg + ': no such file or directory"';
    let doc;
    try { doc = C.yaml.load(cfg); } catch (e) { return 'E0930 run.go:72] "command failed" err="failed to load kubelet config file ' + cfgArg + ': ' + String(e.message).split('\n')[0] + '"'; }
    const ca = doc && doc.authentication && doc.authentication.x509 && doc.authentication.x509.clientCAFile;
    if (ca && !fsExists(S, nn, ca)) return 'E0930 run.go:72] "command failed" err="failed to construct kubelet dependencies: unable to load client CA file ' + ca + ': open ' + ca + ': no such file or directory"';
    if (doc && doc.staticPodPath && doc.staticPodPath !== '/etc/kubernetes/manifests' && n._sim.cp) return null;
    return null;
  }

  function nodeConditions(S) {
    for (const n of list(S, 'Node')) {
      const s = n._sim.svc;
      let ready = 'True'; let reason = 'KubeletReady'; let msg = 'kubelet is posting ready status';
      if (!s.kubelet.active) { ready = 'Unknown'; reason = 'NodeStatusUnknown'; msg = 'Kubelet stopped posting node status.'; }
      else if (!s.containerd.active) { ready = 'False'; reason = 'KubeletNotReady'; msg = 'container runtime is down'; }
      else if (!S.cni) { ready = 'False'; reason = 'KubeletNotReady'; msg = 'container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized'; }
      const t = new Date(S.now - 3600000).toISOString();
      n.status.conditions = [
        { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: 'kubelet has sufficient memory available', lastHeartbeatTime: t, lastTransitionTime: t },
        { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: 'kubelet has no disk pressure', lastHeartbeatTime: t, lastTransitionTime: t },
        { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: 'kubelet has sufficient PID available', lastHeartbeatTime: t, lastTransitionTime: t },
        { type: 'Ready', status: ready, reason, message: msg, lastHeartbeatTime: t, lastTransitionTime: t },
      ];
      n.status.nodeInfo.kubeletVersion = 'v' + n._sim.runningKubelet;
      const taints = (n.spec.taints || []).filter((x) => !['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable', 'node.kubernetes.io/unschedulable'].includes(x.key));
      if (ready === 'False') taints.push({ key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' });
      if (ready === 'Unknown') taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' });
      if (n.spec.unschedulable) taints.push({ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' });
      n.spec.taints = taints;
    }
  }

  function nodeReady(n) {
    const c = (n.status.conditions || []).find((x) => x.type === 'Ready');
    return c && c.status === 'True';
  }

  // ================================================================ controladores
  function ownerOf(o) { return (o.metadata.ownerReferences || [])[0] || null; }
  function ownedBy(S, kind, owner) {
    return S.objs.filter((o) => o.kind === kind && C.nsOf(o) === C.nsOf(owner) && (o.metadata.ownerReferences || []).some((r) => r.uid === owner.metadata.uid));
  }
  function ownerRef(o) { return { apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true, blockOwnerDeletion: true }; }

  function podFromTemplate(S, tpl, name, ns, extraLabels, owner, simExtra) {
    const t = clone(tpl || {});
    const p = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: ns, labels: Object.assign({}, (t.metadata && t.metadata.labels) || {}, extraLabels || {}), annotations: (t.metadata && t.metadata.annotations) || undefined, ownerReferences: owner ? [ownerRef(owner)] : undefined },
      spec: t.spec || { containers: [] },
      status: {},
      _sim: Object.assign({}, simExtra || {}),
    };
    if (!p.spec.restartPolicy) p.spec.restartPolicy = 'Always';
    if (p.spec.priorityClassName) { const pc = find(S, 'PriorityClass', null, p.spec.priorityClassName); if (pc) p.spec.priority = pc.value; }
    if (!p.spec.serviceAccountName) p.spec.serviceAccountName = 'default';
    return put(S, p);
  }

  function scaleOwned(S, owner, tpl, want, labelsExtra, mkName, simExtra) {
    const pods = ownedBy(S, 'Pod', owner).filter((p) => !(p._sim && p._sim.terminating));
    const ns = C.nsOf(owner);
    if (pods.length > want) {
      pods.sort((a, b) => (a.status.phase === 'Pending' ? -1 : 1) - (b.status.phase === 'Pending' ? -1 : 1));
      for (const p of pods.slice(0, pods.length - want)) remove(S, p);
    }
    for (let i = pods.length; i < want; i++) podFromTemplate(S, tpl, mkName(i), ns, labelsExtra, owner, simExtra);
  }

  function reconcileDeployment(S, d) {
    const ns = C.nsOf(d);
    d._sim = d._sim || {};
    const tpl = d.spec.template || {};
    const hash = C.hashStr(C.stable(tpl), 10);
    const rsName = d.metadata.name + '-' + hash;
    const allRs = ownedBy(S, 'ReplicaSet', d);
    const maxRev = allRs.reduce((m, r) => Math.max(m, +((r.metadata.annotations || {})['deployment.kubernetes.io/revision'] || 0)), 0);
    let rs = find(S, 'ReplicaSet', ns, rsName);
    const cause = (d.metadata.annotations || {})['kubernetes.io/change-cause'];
    if (!rs) {
      const t = clone(tpl);
      t.metadata = t.metadata || {};
      t.metadata.labels = Object.assign({}, t.metadata.labels, { 'pod-template-hash': hash });
      rs = put(S, {
        apiVersion: 'apps/v1', kind: 'ReplicaSet',
        metadata: { name: rsName, namespace: ns, labels: Object.assign({}, t.metadata.labels), annotations: { 'deployment.kubernetes.io/revision': String(maxRev + 1) }, ownerReferences: [ownerRef(d)] },
        spec: { replicas: 0, selector: { matchLabels: Object.assign({}, (d.spec.selector || {}).matchLabels, { 'pod-template-hash': hash }) }, template: t },
        status: {},
      });
      if (cause) rs.metadata.annotations['kubernetes.io/change-cause'] = cause;
      d._sim.activeRS = rsName;
    } else if (d._sim.activeRS !== rsName) {
      rs.metadata.annotations = rs.metadata.annotations || {};
      rs.metadata.annotations['deployment.kubernetes.io/revision'] = String(maxRev + 1);
      if (cause) rs.metadata.annotations['kubernetes.io/change-cause'] = cause;
      d._sim.activeRS = rsName;
    }
    if (cause) { rs.metadata.annotations = rs.metadata.annotations || {}; rs.metadata.annotations['kubernetes.io/change-cause'] = cause; }
    d.metadata.annotations = d.metadata.annotations || {};
    d.metadata.annotations['deployment.kubernetes.io/revision'] = rs.metadata.annotations['deployment.kubernetes.io/revision'];
    const want = d.spec.replicas == null ? 1 : +d.spec.replicas;
    if (d.spec.replicas == null) d.spec.replicas = 1;
    for (const other of allRs) {
      if (other.metadata.name === rsName) continue;
      other.spec.replicas = 0;
      for (const p of ownedBy(S, 'Pod', other)) remove(S, p);
    }
    rs.spec.replicas = want;
    scaleOwned(S, rs, rs.spec.template, want, {}, () => rs.metadata.name + '-' + C.rand(5), d._sim.podSim);
    const pods = ownedBy(S, 'Pod', rs);
    const ready = pods.filter(podIsReady).length;
    rs.status = { replicas: pods.length, readyReplicas: ready, availableReplicas: ready, fullyLabeledReplicas: pods.length, observedGeneration: rs.metadata.generation };
    // quitar RS viejos más allá del límite de historial
    const limit = d.spec.revisionHistoryLimit == null ? 10 : d.spec.revisionHistoryLimit;
    const old = allRs.filter((r) => r.metadata.name !== rsName).sort((a, b) => (+a.metadata.annotations['deployment.kubernetes.io/revision']) - (+b.metadata.annotations['deployment.kubernetes.io/revision']));
    while (old.length > limit) remove(S, old.shift());
    d.status = { observedGeneration: d.metadata.generation, replicas: pods.length, updatedReplicas: pods.length, readyReplicas: ready, availableReplicas: ready, unavailableReplicas: Math.max(0, want - ready) || undefined,
      conditions: [{ type: 'Available', status: ready >= want ? 'True' : 'False', reason: ready >= want ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable' }, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: 'ReplicaSet "' + rsName + '" has successfully progressed.' }] };
  }

  function reconcileSts(S, s) {
    const ns = C.nsOf(s);
    const want = s.spec.replicas == null ? 1 : +s.spec.replicas;
    const pods = ownedBy(S, 'Pod', s);
    for (const p of pods) { const i = +p.metadata.name.split('-').pop(); if (i >= want) remove(S, p); }
    for (let i = 0; i < want; i++) {
      const name = s.metadata.name + '-' + i;
      let p = find(S, 'Pod', ns, name);
      if (!p) {
        const tpl = clone(s.spec.template);
        tpl.spec = tpl.spec || {};
        tpl.spec.volumes = tpl.spec.volumes || [];
        for (const vct of s.spec.volumeClaimTemplates || []) {
          const pvcName = vct.metadata.name + '-' + name;
          if (!find(S, 'PersistentVolumeClaim', ns, pvcName)) put(S, { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels: (s.spec.selector || {}).matchLabels }, spec: clone(vct.spec), status: { phase: 'Pending' } });
          tpl.spec.volumes.push({ name: vct.metadata.name, persistentVolumeClaim: { claimName: pvcName } });
        }
        p = podFromTemplate(S, tpl, name, ns, { 'statefulset.kubernetes.io/pod-name': name, 'apps.kubernetes.io/pod-index': String(i) }, s);
      }
    }
    const ready = ownedBy(S, 'Pod', s).filter(podIsReady).length;
    s.status = { replicas: want, readyReplicas: ready, currentReplicas: want, availableReplicas: ready };
  }

  function reconcileDs(S, ds) {
    const ns = C.nsOf(ds);
    const nodes = list(S, 'Node');
    const pods = ownedBy(S, 'Pod', ds);
    const tplHash = C.hashStr(C.stable(ds.spec.template), 6);
    let want = 0; let ready = 0;
    for (const n of nodes) {
      const tpl = clone(ds.spec.template);
      tpl.spec = tpl.spec || {};
      tpl.spec.tolerations = (tpl.spec.tolerations || []).concat([
        { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/unschedulable', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoSchedule' },
      ]);
      const fit = nodeFits(S, { spec: tpl.spec, metadata: { namespace: ns } }, n, { ignoreResources: true, ignoreUnschedulable: true, ignoreReady: true });
      let p = pods.find((x) => x.spec.nodeName === n.metadata.name);
      if (!fit.ok) { if (p) remove(S, p); continue; }
      want++;
      if (p && p._sim && p._sim.tplHash !== tplHash) { remove(S, p); p = null; }
      if (!p) {
        tpl.spec.nodeName = n.metadata.name;
        p = podFromTemplate(S, tpl, ds.metadata.name + '-' + C.rand(5), ns, { 'controller-revision-hash': tplHash }, ds, { tplHash });
      }
      if (podIsReady(p)) ready++;
    }
    for (const p of pods) if (!nodes.find((n) => n.metadata.name === p.spec.nodeName)) remove(S, p);
    ds.status = { desiredNumberScheduled: want, currentNumberScheduled: want, numberReady: ready, numberAvailable: ready, updatedNumberScheduled: want };
  }

  function reconcileJob(S, j) {
    const ns = C.nsOf(j);
    const want = j.spec.completions == null ? 1 : +j.spec.completions;
    const pods = ownedBy(S, 'Pod', j);
    for (let i = pods.length; i < want; i++) {
      const p = podFromTemplate(S, j.spec.template, j.metadata.name + '-' + C.rand(5), ns, { 'batch.kubernetes.io/job-name': j.metadata.name, 'job-name': j.metadata.name }, j, { job: true });
      p.spec.restartPolicy = (j.spec.template.spec || {}).restartPolicy || 'Never';
    }
    const done = ownedBy(S, 'Pod', j).filter((p) => p.status.phase === 'Succeeded').length;
    j.status = { succeeded: done, active: Math.max(0, ownedBy(S, 'Pod', j).length - done) || undefined, completionTime: done >= want ? new Date(S.now).toISOString() : undefined, conditions: done >= want ? [{ type: 'Complete', status: 'True' }] : [] };
  }

  function reconcilePvcs(S) {
    const pods = list(S, 'Pod');
    for (const pvc of list(S, 'PersistentVolumeClaim')) {
      pvc.status = pvc.status || {};
      if (pvc.status.phase === 'Bound' && pvc.spec.volumeName && find(S, 'PersistentVolume', null, pvc.spec.volumeName)) continue;
      let scName = pvc.spec.storageClassName;
      if (scName === undefined) {
        const def = list(S, 'StorageClass').find((s) => (s.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true');
        if (def) { scName = def.metadata.name; pvc.spec.storageClassName = scName; }
      }
      const req = C.parseStorage((((pvc.spec.resources || {}).requests) || {}).storage);
      const modes = pvc.spec.accessModes || [];
      // estática
      const pv = list(S, 'PersistentVolume').find((v) => {
        v.status = v.status || {};
        if (v.status.phase && v.status.phase !== 'Available') return false;
        if (v.spec.claimRef && !(v.spec.claimRef.name === pvc.metadata.name && v.spec.claimRef.namespace === C.nsOf(pvc))) return false;
        if (pvc.spec.volumeName && pvc.spec.volumeName !== v.metadata.name) return false;
        if ((v.spec.storageClassName || '') !== (scName || '')) return false;
        if (C.parseStorage((v.spec.capacity || {}).storage) < req) return false;
        if (!modes.every((m) => (v.spec.accessModes || []).includes(m))) return false;
        if (pvc.spec.selector && !C.matchLabelSelector(v.metadata.labels, pvc.spec.selector)) return false;
        return true;
      });
      if (pv) { bind(S, pvc, pv); continue; }
      const sc = scName ? find(S, 'StorageClass', null, scName) : null;
      if (!sc) {
        pvc.status = { phase: 'Pending' };
        pvc._sim = pvc._sim || {};
        pvc._sim.why = scName ? 'storageclass.storage.k8s.io "' + scName + '" not found' : 'no persistent volumes available for this claim and no storage class is set';
        continue;
      }
      if (sc.provisioner === 'kubernetes.io/no-provisioner') { pvc.status = { phase: 'Pending' }; pvc._sim = { why: 'waiting for a volume to be created or a PV to be statically created' }; continue; }
      const users = pods.filter((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === pvc.metadata.name) && C.nsOf(p) === C.nsOf(pvc));
      if (sc.volumeBindingMode === 'WaitForFirstConsumer' && !users.length) { pvc.status = { phase: 'Pending' }; pvc._sim = { why: 'waiting for first consumer to be created before binding' }; continue; }
      const newPv = put(S, {
        apiVersion: 'v1', kind: 'PersistentVolume',
        metadata: { name: 'pvc-' + pvc.metadata.uid, annotations: { 'pv.kubernetes.io/provisioned-by': sc.provisioner } },
        spec: { capacity: { storage: pvc.spec.resources.requests.storage }, accessModes: modes, persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', storageClassName: scName, volumeMode: 'Filesystem', csi: { driver: sc.provisioner, volumeHandle: C.uid() } },
        status: { phase: 'Available' },
      });
      bind(S, pvc, newPv);
    }
    // PV liberados
    for (const v of list(S, 'PersistentVolume')) {
      if (v.status && v.status.phase === 'Bound' && v.spec.claimRef && !find(S, 'PersistentVolumeClaim', v.spec.claimRef.namespace, v.spec.claimRef.name)) {
        if (v.spec.persistentVolumeReclaimPolicy === 'Delete') remove(S, v);
        else v.status = { phase: 'Released' };
      }
    }
  }
  function bind(S, pvc, pv) {
    pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: C.nsOf(pvc), uid: pvc.metadata.uid };
    pv.status = { phase: 'Bound' };
    pvc.spec.volumeName = pv.metadata.name;
    pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: { storage: pv.spec.capacity.storage } };
    pvc._sim = {};
  }

  function reconcileHpa(S, h) {
    const ref = h.spec.scaleTargetRef || {};
    const t = find(S, ref.kind || 'Deployment', C.nsOf(h), ref.name);
    const cur = t ? (t.spec.replicas || 0) : 0;
    let desired = cur;
    if (t) {
      desired = Math.max(h.spec.minReplicas || 1, Math.min(h.spec.maxReplicas || 1, cur));
      if (desired !== cur && t.kind === 'Deployment') t.spec.replicas = desired;
    }
    const metric = (h.spec.metrics || [])[0];
    const target = metric && metric.resource && metric.resource.target ? metric.resource.target.averageUtilization : undefined;
    h.status = { currentReplicas: t ? t.spec.replicas : 0, desiredReplicas: desired, currentMetrics: target != null ? [{ type: 'Resource', resource: { name: metric.resource.name, current: { averageUtilization: 12 } } }] : [] };
  }

  // ================================================================ planificador
  function tolerates(tols, taint) {
    return (tols || []).some((t) => {
      if (t.effect && t.effect !== taint.effect) return false;
      if (t.operator === 'Exists') return !t.key || t.key === taint.key;
      return t.key === taint.key && String(t.value || '') === String(taint.value || '');
    });
  }

  function podRequests(spec) {
    let cpu = 0; let mem = 0;
    for (const c of spec.containers || []) {
      const r = (c.resources && (c.resources.requests || c.resources.limits)) || {};
      cpu += C.parseCpu(r.cpu); mem += C.parseMem(r.memory);
    }
    for (const c of spec.initContainers || []) {
      const r = (c.resources && (c.resources.requests || c.resources.limits)) || {};
      if (c.restartPolicy === 'Always') { cpu += C.parseCpu(r.cpu); mem += C.parseMem(r.memory); continue; }
      cpu = Math.max(cpu, C.parseCpu(r.cpu)); mem = Math.max(mem, C.parseMem(r.memory));
    }
    return { cpu, mem };
  }

  function nodeUsage(S, nodeName, exceptPod) {
    let cpu = 0; let mem = 0;
    for (const p of list(S, 'Pod')) {
      if (p === exceptPod || p.spec.nodeName !== nodeName || p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
      const r = podRequests(p.spec); cpu += r.cpu; mem += r.mem;
    }
    return { cpu, mem };
  }

  function termMatches(n, term) {
    for (const e of term.matchExpressions || []) if (!C.matchExpr(n.metadata.labels || {}, { key: e.key, op: e.operator, values: e.values })) return false;
    for (const e of term.matchFields || []) if (!C.matchExpr({ 'metadata.name': n.metadata.name }, { key: e.key, op: e.operator, values: e.values })) return false;
    return true;
  }

  function nodeFits(S, pod, n, o) {
    o = o || {};
    const spec = pod.spec;
    if (!o.ignoreReady && !nodeReady(n)) return { ok: false, r: 'node(s) had untolerated taint {node.kubernetes.io/not-ready: }' };
    if (!o.ignoreUnschedulable && n.spec.unschedulable && !tolerates(spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) return { ok: false, r: 'node(s) were unschedulable' };
    for (const t of n.spec.taints || []) {
      if (t.effect === 'PreferNoSchedule') continue;
      if (o.ignoreReady && /not-ready|unreachable/.test(t.key)) continue;
      if (o.ignoreUnschedulable && t.key === 'node.kubernetes.io/unschedulable') continue;
      if (!tolerates(spec.tolerations, t)) return { ok: false, r: 'node(s) had untolerated taint {' + t.key + ': ' + (t.value || '') + '}' };
    }
    if (spec.nodeSelector && !C.matchMap(n.metadata.labels, spec.nodeSelector)) return { ok: false, r: "node(s) didn't match Pod's node affinity/selector" };
    const req = spec.affinity && spec.affinity.nodeAffinity && spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (req && !(req.nodeSelectorTerms || []).some((t) => termMatches(n, t))) return { ok: false, r: "node(s) didn't match Pod's node affinity/selector" };
    const anti = spec.affinity && spec.affinity.podAntiAffinity && spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (anti) {
      for (const term of anti) {
        const ns = C.nsOf(pod) || 'default';
        const clash = list(S, 'Pod', ns).some((p) => p !== pod && p.spec.nodeName && sameTopo(S, p.spec.nodeName, n, term.topologyKey) && C.matchLabelSelector(p.metadata.labels, term.labelSelector));
        if (clash) return { ok: false, r: "node(s) didn't match pod anti-affinity rules" };
      }
    }
    const aff = spec.affinity && spec.affinity.podAffinity && spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (aff) {
      for (const term of aff) {
        const ns = C.nsOf(pod) || 'default';
        const ok = list(S, 'Pod', ns).some((p) => p !== pod && p.spec.nodeName && sameTopo(S, p.spec.nodeName, n, term.topologyKey) && C.matchLabelSelector(p.metadata.labels, term.labelSelector));
        if (!ok) return { ok: false, r: "node(s) didn't match pod affinity rules" };
      }
    }
    if (!o.ignoreResources) {
      const r = podRequests(spec);
      const used = nodeUsage(S, n.metadata.name, pod);
      if (r.cpu && used.cpu + r.cpu > C.parseCpu(n.status.allocatable.cpu)) return { ok: false, r: 'Insufficient cpu' };
      if (r.mem && used.mem + r.mem > C.parseMem(n.status.allocatable.memory)) return { ok: false, r: 'Insufficient memory' };
    }
    return { ok: true };
  }

  function sameTopo(S, nodeName, n, key) {
    if (!key || key === 'kubernetes.io/hostname') return nodeName === n.metadata.name;
    const other = find(S, 'Node', null, nodeName);
    return other && (other.metadata.labels || {})[key] === (n.metadata.labels || {})[key];
  }

  function schedulePod(S, p) {
    const nodes = list(S, 'Node');
    // PVC
    for (const v of p.spec.volumes || []) {
      if (!v.persistentVolumeClaim) continue;
      const pvc = find(S, 'PersistentVolumeClaim', C.nsOf(p), v.persistentVolumeClaim.claimName);
      if (!pvc) return 'persistentvolumeclaim "' + v.persistentVolumeClaim.claimName + '" not found';
      if (!pvc.status || pvc.status.phase !== 'Bound') return 'pod has unbound immediate PersistentVolumeClaims. preemption: 0/' + nodes.length + ' nodes are available';
    }
    if (p.spec.priorityClassName && !find(S, 'PriorityClass', null, p.spec.priorityClassName)) return null;
    const counts = {};
    const fits = [];
    for (const n of nodes) {
      const f = nodeFits(S, p, n);
      if (f.ok) fits.push(n); else counts[f.r] = (counts[f.r] || 0) + 1;
    }
    if (!fits.length) {
      return '0/' + nodes.length + ' nodes are available: ' + Object.keys(counts).map((k) => counts[k] + ' ' + k).join(', ') + '. preemption: 0/' + nodes.length + ' nodes are available: ' + nodes.length + ' Preemption is not helpful for scheduling.';
    }
    const pref = (p.spec.affinity && p.spec.affinity.nodeAffinity && p.spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution) || [];
    const score = (n) => pref.reduce((s, t) => s + (termMatches(n, t.preference || {}) ? (t.weight || 1) : 0), 0);
    const load = (n) => list(S, 'Pod').filter((x) => x.spec.nodeName === n.metadata.name).length;
    fits.sort((a, b) => (score(b) - score(a)) || (load(a) - load(b)) || a.metadata.name.localeCompare(b.metadata.name));
    p.spec.nodeName = fits[0].metadata.name;
    event(S, p, 'Normal', 'Scheduled', 'Successfully assigned ' + C.nsOf(p) + '/' + p.metadata.name + ' to ' + p.spec.nodeName);
    return null;
  }

  // ================================================================ estado de pods
  const KNOWN_IMAGES = ['nginx', 'busybox', 'httpd', 'redis', 'consul', 'alpine', 'memcached', 'mysql', 'mariadb', 'postgres', 'wordpress', 'curl', 'netshoot', 'ubuntu', 'debian', 'python', 'node', 'golang', 'traefik', 'haproxy', 'stress', 'nginxdemos', 'hello', 'echoserver', 'agnhost', 'pause', 'mongo', 'rabbitmq', 'tomcat', 'caddy', 'perl', 'bash'];
  function imageOk(S, image) {
    if (!image) return false;
    if ((S.badImages || []).includes(image)) return false;
    const noTag = image.split('@')[0];
    const lastColon = noTag.lastIndexOf(':');
    const hasTag = lastColon > noTag.lastIndexOf('/');
    const repo = hasTag ? noTag.slice(0, lastColon) : noTag;
    const tag = hasTag ? noTag.slice(lastColon + 1) : 'latest';
    if (/latestt|nonexist|doesnotexist|invalid/.test(tag)) return false;
    const base = repo.split('/').pop();
    if (repo.includes('/')) return /^[a-z0-9][a-z0-9._\-/]*$/.test(repo);
    if (!KNOWN_IMAGES.includes(base)) return false;
    if (base === 'nginx' && !/^(latest|stable|mainline|alpine|perl|\d+(\.\d+){0,2}(-(alpine|perl|bookworm|alpine-slim))?)$/.test(tag)) return false;
    return true;
  }

  function podIsReady(p) { return p.status && p.status.phase === 'Running' && (p.status.containerStatuses || []).every((c) => c.ready); }

  function missingRefs(S, p) {
    const ns = C.nsOf(p);
    for (const v of p.spec.volumes || []) {
      if (v.configMap && !v.configMap.optional && !find(S, 'ConfigMap', ns, v.configMap.name)) return { reason: 'ContainerCreating', msg: 'MountVolume.SetUp failed for volume "' + v.name + '" : configmap "' + v.configMap.name + '" not found' };
      if (v.secret && !v.secret.optional && !find(S, 'Secret', ns, v.secret.secretName)) return { reason: 'ContainerCreating', msg: 'MountVolume.SetUp failed for volume "' + v.name + '" : secret "' + v.secret.secretName + '" not found' };
    }
    for (const c of (p.spec.containers || []).concat(p.spec.initContainers || [])) {
      for (const e of c.env || []) {
        const vf = e.valueFrom || {};
        if (vf.configMapKeyRef && !vf.configMapKeyRef.optional) {
          const cm = find(S, 'ConfigMap', ns, vf.configMapKeyRef.name);
          if (!cm) return { reason: 'CreateContainerConfigError', msg: 'configmap "' + vf.configMapKeyRef.name + '" not found' };
          if (!cm.data || cm.data[vf.configMapKeyRef.key] === undefined) return { reason: 'CreateContainerConfigError', msg: "couldn't find key " + vf.configMapKeyRef.key + ' in ConfigMap ' + ns + '/' + vf.configMapKeyRef.name };
        }
        if (vf.secretKeyRef && !vf.secretKeyRef.optional) {
          const s = find(S, 'Secret', ns, vf.secretKeyRef.name);
          if (!s) return { reason: 'CreateContainerConfigError', msg: 'secret "' + vf.secretKeyRef.name + '" not found' };
          if (!s.data || s.data[vf.secretKeyRef.key] === undefined) return { reason: 'CreateContainerConfigError', msg: "couldn't find key " + vf.secretKeyRef.key + ' in Secret ' + ns + '/' + vf.secretKeyRef.name };
        }
      }
      for (const ef of c.envFrom || []) {
        if (ef.configMapRef && !ef.configMapRef.optional && !find(S, 'ConfigMap', ns, ef.configMapRef.name)) return { reason: 'CreateContainerConfigError', msg: 'configmap "' + ef.configMapRef.name + '" not found' };
        if (ef.secretRef && !ef.secretRef.optional && !find(S, 'Secret', ns, ef.secretRef.name)) return { reason: 'CreateContainerConfigError', msg: 'secret "' + ef.secretRef.name + '" not found' };
      }
      for (const m of c.volumeMounts || []) {
        if (!(p.spec.volumes || []).some((v) => v.name === m.name)) return { reason: 'Invalid', msg: 'volumeMount "' + m.name + '" no tiene un volumen con ese nombre' };
      }
    }
    return null;
  }

  function crashes(S, p, c) {
    if (p._sim && p._sim.crash) return true;
    if (p._sim && p._sim.crashContainers && p._sim.crashContainers.includes(c.name)) return true;
    const cmd = (c.command || []).concat(c.args || []).join(' ');
    if (/^(busybox|alpine)/.test(c.image || '') && cmd && !/sleep|tail|while|watch|httpd|nc |sh -c.*(sleep|tail|while)|top|yes|cat$|cat\s*$|infinity/.test(cmd) && !(p._sim && p._sim.job)) {
      if (p.spec.restartPolicy === 'Always') return true;
    }
    return false;
  }

  function computePodStatus(S, p) {
    p._sim = p._sim || {};
    if (p._sim.job || (p.metadata.ownerReferences || []).some((r) => r.kind === 'Job')) {
      if (p.spec.nodeName) { p.status = Object.assign(p.status || {}, { phase: 'Succeeded', containerStatuses: (p.spec.containers || []).map((c) => ({ name: c.name, image: c.image, ready: false, restartCount: 0, state: { terminated: { reason: 'Completed', exitCode: 0 } } })) }); }
      else p.status = { phase: 'Pending' };
      return;
    }
    const st = p.status || {};
    if (!p.spec.nodeName) { p.status = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: p._sim.schedMsg || '' }] }; return; }
    if (!st.podIP) { S.ipSeq++; st.podIP = '192.168.' + (1 + (S.ipSeq >> 8) % 200) + '.' + (S.ipSeq % 250 + 2); }
    const node = find(S, 'Node', null, p.spec.nodeName);
    st.hostIP = node ? node.status.addresses[0].address : '';
    if (p.spec.hostNetwork) st.podIP = st.hostIP;
    st.startTime = st.startTime || p.metadata.creationTimestamp;
    const miss = missingRefs(S, p);
    const init = (p.spec.initContainers || []);
    const statuses = [];
    let phase = 'Running';
    let initBlocking = null;
    for (const c of init) {
      if (c.restartPolicy === 'Always') continue;
      if (!imageOk(S, c.image)) { initBlocking = { reason: 'Init:ImagePullBackOff' }; break; }
      if (p._sim.initFail) { initBlocking = { reason: 'Init:CrashLoopBackOff' }; break; }
    }
    const prev = {};
    for (const cs of st.containerStatuses || []) prev[cs.name] = cs;
    const all = (p.spec.containers || []).concat(init.filter((c) => c.restartPolicy === 'Always'));
    for (const c of all) {
      const pr = prev[c.name] || { restartCount: 0 };
      let s;
      if (miss) s = { name: c.name, image: c.image, ready: false, restartCount: 0, started: false, state: { waiting: { reason: miss.reason, message: miss.msg } } };
      else if (initBlocking) s = { name: c.name, image: c.image, ready: false, restartCount: 0, state: { waiting: { reason: 'PodInitializing' } } };
      else if (!imageOk(S, c.image)) s = { name: c.name, image: c.image, ready: false, restartCount: 0, started: false, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "' + c.image + '"' } } };
      else if (crashes(S, p, c)) s = { name: c.name, image: c.image, ready: false, restartCount: (pr.restartCount || 0) + 1, started: false, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=' + c.name } }, lastState: { terminated: { exitCode: p._sim.exitCode || 1, reason: 'Error' } } };
      else s = { name: c.name, image: c.image, imageID: 'docker.io/library/' + c.image, ready: true, restartCount: pr.restartCount && prev[c.name].state && prev[c.name].state.running ? pr.restartCount : (p._sim.restarts || 0), started: true, state: { running: { startedAt: st.startTime } } };
      s.containerID = 'containerd://' + C.hashStr(p.metadata.uid + c.name, 16);
      statuses.push(s);
    }
    if (miss || initBlocking) phase = 'Pending';
    st.phase = phase;
    st.containerStatuses = statuses.filter((s) => (p.spec.containers || []).some((c) => c.name === s.name));
    st.initContainerStatuses = init.length ? init.map((c) => {
      const side = statuses.find((s) => s.name === c.name);
      if (side) return side;
      return { name: c.name, image: c.image, ready: !initBlocking, restartCount: 0, state: initBlocking ? { waiting: { reason: initBlocking.reason.replace('Init:', '') } } : { terminated: { reason: 'Completed', exitCode: 0 } } };
    }) : undefined;
    st.initBlocking = initBlocking ? initBlocking.reason : undefined;
    const ready = phase === 'Running' && st.containerStatuses.every((c) => c.ready);
    st.conditions = [{ type: 'PodScheduled', status: 'True' }, { type: 'Initialized', status: initBlocking ? 'False' : 'True' }, { type: 'ContainersReady', status: ready ? 'True' : 'False' }, { type: 'Ready', status: ready ? 'True' : 'False' }];
    st.qosClass = qos(p.spec);
    p.status = st;
    if (miss && !p._sim.evMiss) { p._sim.evMiss = true; event(S, p, 'Warning', miss.reason === 'ContainerCreating' ? 'FailedMount' : 'Failed', miss.msg); }
    for (const s of statuses) if (s.state.waiting && s.state.waiting.reason === 'ImagePullBackOff' && !p._sim['evImg' + s.name]) {
      p._sim['evImg' + s.name] = true;
      event(S, p, 'Warning', 'Failed', 'Failed to pull image "' + s.image + '": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/' + s.image + '": failed to resolve reference: docker.io/library/' + s.image + ': not found');
    }
  }

  function qos(spec) {
    const cs = spec.containers || [];
    const hasAny = cs.some((c) => c.resources && (c.resources.requests || c.resources.limits));
    if (!hasAny) return 'BestEffort';
    const guaranteed = cs.every((c) => c.resources && c.resources.limits && c.resources.limits.cpu && c.resources.limits.memory && (!c.resources.requests || (C.parseCpu(c.resources.requests.cpu || c.resources.limits.cpu) === C.parseCpu(c.resources.limits.cpu) && C.parseMem(c.resources.requests.memory || c.resources.limits.memory) === C.parseMem(c.resources.limits.memory))));
    return guaranteed ? 'Guaranteed' : 'Burstable';
  }

  function podDisplayStatus(p) {
    const st = p.status || {};
    if (p._sim && p._sim.terminating) return 'Terminating';
    if (st.phase === 'Succeeded') return 'Completed';
    if (st.phase === 'Failed') return 'Error';
    if (st.initBlocking) return st.initBlocking;
    if (!p.spec.nodeName) return 'Pending';
    for (const c of st.containerStatuses || []) if (c.state && c.state.waiting) return c.state.waiting.reason;
    if (st.initContainerStatuses && st.initContainerStatuses.some((c) => c.state && c.state.waiting && c.state.waiting.reason === 'PodInitializing')) return 'PodInitializing';
    return st.phase || 'Pending';
  }

  // ================================================================ reconcile
  function reconcile(S) {
    reconcileOnce(S);
    reconcileOnce(S);
  }

  function reconcileOnce(S) {
    for (const h of CKA.reconcileHooks || []) h(S);
    cpHealth(S);
    nodeConditions(S);
    if (!S.cp.apiserver.ok) return;
    const cmOk = S.cp.controllerManager.ok;
    if (cmOk) {
      for (const h of list(S, 'HorizontalPodAutoscaler')) reconcileHpa(S, h);
      for (const d of list(S, 'Deployment')) reconcileDeployment(S, d);
      for (const rs of list(S, 'ReplicaSet')) {
        if ((rs.metadata.ownerReferences || []).length) continue;
        scaleOwned(S, rs, rs.spec.template, rs.spec.replicas == null ? 1 : rs.spec.replicas, {}, () => rs.metadata.name + '-' + C.rand(5));
      }
      for (const s of list(S, 'StatefulSet')) reconcileSts(S, s);
      for (const d of list(S, 'DaemonSet')) reconcileDs(S, d);
      for (const j of list(S, 'Job')) reconcileJob(S, j);
      reconcilePvcs(S);
      // recolector de basura
      for (const o of S.objs.slice()) {
        const refs = o.metadata.ownerReferences || [];
        if (!refs.length || o.kind === 'Node') continue;
        const r = refs[0];
        if (r.kind === 'Node') continue;
        const alive = S.objs.some((x) => x.metadata.uid === r.uid);
        if (!alive) remove(S, o);
      }
      for (const ns of list(S, 'Namespace')) {
        if (!find(S, 'ServiceAccount', ns.metadata.name, 'default')) put(S, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: ns.metadata.name } });
        if (!find(S, 'ConfigMap', ns.metadata.name, 'kube-root-ca.crt')) put(S, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: ns.metadata.name }, data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n' } });
      }
    }
    mirrorPods(S);
    for (const p of list(S, 'Pod')) {
      if (!p.spec.nodeName) {
        if (S.cp.scheduler.ok) { const why = schedulePod(S, p); p._sim = p._sim || {}; if (why && p._sim.schedMsg !== why) { event(S, p, 'Warning', 'FailedScheduling', why); } p._sim.schedMsg = why || ''; }
      }
      computePodStatus(S, p);
    }
    for (const ing of list(S, 'Ingress')) {
      const cls = ingressClassFor(S, ing);
      ing.status = cls ? { loadBalancer: { ingress: [{ ip: S.ingressIP || '172.30.1.100' }] } } : { loadBalancer: {} };
    }
    for (const g of list(S, 'Gateway')) {
      const gc = find(S, 'GatewayClass', null, g.spec.gatewayClassName);
      g.status = gc ? { addresses: [{ type: 'IPAddress', value: S.gatewayIP || '172.30.1.101' }], conditions: [{ type: 'Accepted', status: 'True' }, { type: 'Programmed', status: 'True' }] } : { conditions: [{ type: 'Accepted', status: 'Unknown', reason: 'Pending' }] };
    }
    for (const s of list(S, 'Service')) {
      if (!s.spec.clusterIP && s.spec.clusterIP !== 'None') { S.svcSeq++; s.spec.clusterIP = '10.' + (96 + (S.svcSeq >> 16)) + '.' + ((S.svcSeq >> 8) & 255) + '.' + (S.svcSeq & 255); }
      if (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') for (const pt of s.spec.ports || []) if (!pt.nodePort) pt.nodePort = 30000 + Math.floor(Math.random() * 2767);
    }
  }

  function ingressClassFor(S, ing) {
    const name = ing.spec.ingressClassName || (ing.metadata.annotations || {})['kubernetes.io/ingress.class'];
    if (name) return find(S, 'IngressClass', null, name);
    return list(S, 'IngressClass').find((c) => (c.metadata.annotations || {})['ingressclass.kubernetes.io/is-default-class'] === 'true') || null;
  }

  // ================================================================ red
  function podPorts(p) {
    const ports = [];
    for (const c of p.spec.containers || []) for (const cp of c.ports || []) ports.push({ port: cp.containerPort, name: cp.name, protocol: cp.protocol || 'TCP' });
    for (const l of (p._sim && p._sim.listen) || []) ports.push({ port: l, protocol: 'TCP' });
    if (!ports.length) {
      const img = ((p.spec.containers || [])[0] || {}).image || '';
      if (/nginx|httpd|wordpress|caddy|echoserver|hello/.test(img)) ports.push({ port: 80, protocol: 'TCP' });
      if (/redis/.test(img)) ports.push({ port: 6379, protocol: 'TCP' });
      if (/mysql|mariadb/.test(img)) ports.push({ port: 3306, protocol: 'TCP' });
    }
    return ports;
  }
  function listens(p, port) { return podPorts(p).some((x) => x.port === +port); }
  function resolvePortName(p, portOrName) {
    if (typeof portOrName === 'number' || /^\d+$/.test(String(portOrName))) return +portOrName;
    const f = podPorts(p).find((x) => x.name === portOrName);
    return f ? f.port : null;
  }

  function nsLabels(S, ns) { const o = find(S, 'Namespace', null, ns); return (o && o.metadata.labels) || {}; }

  function peerMatch(S, peer, policyNs, other) {
    if (!other) return !!peer.ipBlock;
    const ons = C.nsOf(other);
    if (peer.ipBlock) return false;
    const nsOk = peer.namespaceSelector ? C.matchLabelSelector(nsLabels(S, ons), peer.namespaceSelector) || (Object.keys(peer.namespaceSelector).length === 0) || (!(peer.namespaceSelector.matchLabels) && !(peer.namespaceSelector.matchExpressions)) : ons === policyNs;
    if (!nsOk) return false;
    if (peer.podSelector) {
      const ps = peer.podSelector;
      if (!ps.matchLabels && !ps.matchExpressions) return true;
      return C.matchLabelSelector(other.metadata.labels, ps);
    }
    return true;
  }
  function selectsPod(np, pod) {
    if (C.nsOf(np) !== C.nsOf(pod)) return false;
    const ps = np.spec.podSelector || {};
    if (!ps.matchLabels && !ps.matchExpressions) return true;
    return C.matchLabelSelector(pod.metadata.labels, ps);
  }
  function policyTypes(np) {
    if (np.spec.policyTypes && np.spec.policyTypes.length) return np.spec.policyTypes;
    return np.spec.egress ? ['Ingress', 'Egress'] : ['Ingress'];
  }
  function portOk(rulePorts, dstPod, port) {
    if (!rulePorts || !rulePorts.length) return true;
    return rulePorts.some((rp) => {
      if (rp.port === undefined) return true;
      const p = resolvePortName(dstPod, rp.port);
      if (p == null) return false;
      if (rp.endPort) return port >= p && port <= rp.endPort;
      return p === +port;
    });
  }

  function netAllowed(S, src, dst, port) {
    if (S.cni === 'flannel') return { ok: true, note: 'flannel no aplica NetworkPolicies' };
    if (!S.cni) return { ok: false, why: 'sin CNI' };
    // ingress en el destino
    const ing = list(S, 'NetworkPolicy', C.nsOf(dst)).filter((np) => selectsPod(np, dst) && policyTypes(np).includes('Ingress'));
    if (ing.length) {
      const ok = ing.some((np) => (np.spec.ingress || []).some((rule) => {
        const fromOk = !rule.from || !rule.from.length || rule.from.some((peer) => peerMatch(S, peer, C.nsOf(np), src));
        return fromOk && portOk(rule.ports, dst, port);
      }));
      if (!ok) return { ok: false, why: 'ingress bloqueado por NetworkPolicy en ' + C.nsOf(dst) + ' (' + ing.map((n) => n.metadata.name).join(', ') + ')' };
    }
    if (src) {
      const eg = list(S, 'NetworkPolicy', C.nsOf(src)).filter((np) => selectsPod(np, src) && policyTypes(np).includes('Egress'));
      if (eg.length) {
        const ok = eg.some((np) => (np.spec.egress || []).some((rule) => {
          const toOk = !rule.to || !rule.to.length || rule.to.some((peer) => peerMatch(S, peer, C.nsOf(np), dst));
          return toOk && portOk(rule.ports, dst, port);
        }));
        if (!ok) return { ok: false, why: 'egress bloqueado por NetworkPolicy en ' + C.nsOf(src) + ' (' + eg.map((n) => n.metadata.name).join(', ') + ')' };
      }
    }
    return { ok: true };
  }

  function dnsWorks(S) {
    const pods = list(S, 'Pod', 'kube-system').filter((p) => (p.metadata.labels || {})['k8s-app'] === 'kube-dns' && podIsReady(p));
    return pods.length > 0;
  }

  function svcEndpoints(S, svc) {
    if (!svc.spec.selector) return [];
    return list(S, 'Pod', C.nsOf(svc)).filter((p) => C.matchMap(p.metadata.labels, svc.spec.selector) && podIsReady(p));
  }

  function resolveHost(S, host, fromNs) {
    host = String(host).toLowerCase();
    const ipRe = /^\d+\.\d+\.\d+\.\d+$/;
    if (ipRe.test(host)) {
      const svc = list(S, 'Service').find((s) => s.spec.clusterIP === host);
      if (svc) return { t: 'svc', svc };
      const pod = list(S, 'Pod').find((p) => p.status && p.status.podIP === host && !p.spec.hostNetwork);
      if (pod) return { t: 'pod', pod };
      const node = list(S, 'Node').find((n) => n.status.addresses[0].address === host);
      if (node) return { t: 'node', node };
      if (host === (S.ingressIP || '172.30.1.100')) return { t: 'ingress' };
      if (host === (S.gatewayIP || '172.30.1.101')) return { t: 'gateway' };
      return null;
    }
    const m = host.match(/^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc)?(?:\.cluster\.local)?$/);
    if (m) {
      const svc = find(S, 'Service', m[2] || fromNs || 'default', m[1]);
      if (svc) return { t: 'svc', svc };
    }
    const pm = host.match(/^(\d+)-(\d+)-(\d+)-(\d+)\.([a-z0-9-]+)\.pod(\.cluster\.local)?$/);
    if (pm) { const ip = pm.slice(1, 5).join('.'); const pod = list(S, 'Pod', pm[5]).find((p) => p.status.podIP === ip); if (pod) return { t: 'pod', pod }; }
    const node = find(S, 'Node', null, host);
    if (node) return { t: 'node', node };
    return null;
  }

  function podBody(p, path) {
    if (p._sim && p._sim.body) return p._sim.body;
    const img = ((p.spec.containers || [])[0] || {}).image || '';
    if (/nginx/.test(img)) return '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n</body>\n</html>';
    if (/httpd/.test(img)) return '<html><body><h1>It works!</h1></body></html>';
    return 'Hello from ' + p.metadata.name + (path && path !== '/' ? ' (' + path + ')' : '');
  }

  function hitPod(S, fromPod, pod, port, path) {
    if (!podIsReady(pod)) return { err: 'Failed to connect to ' + pod.status.podIP + ' port ' + port + ' after 1 ms: Couldn\'t connect to server', code: 7 };
    const na = netAllowed(S, fromPod, pod, port);
    if (!na.ok) return { err: 'Connection timed out after 5001 milliseconds', code: 28, why: na.why };
    if (!listens(pod, port)) return { err: 'Failed to connect to ' + pod.status.podIP + ' port ' + port + ' after 2 ms: Connection refused', code: 7, why: 'el pod ' + pod.metadata.name + ' no escucha en el puerto ' + port };
    return { status: 200, body: podBody(pod, path), pod };
  }

  function hitService(S, fromPod, svc, port, path, viaNodePort) {
    const sp = (svc.spec.ports || []).find((x) => (viaNodePort ? x.nodePort === +port : x.port === +port));
    if (!sp) return { err: 'Failed to connect to ' + svc.spec.clusterIP + ' port ' + port + ': Connection refused', code: 7, why: 'el Service ' + svc.metadata.name + ' no expone el puerto ' + port };
    const eps = svcEndpoints(S, svc);
    if (!eps.length) return { err: 'Failed to connect to ' + svc.spec.clusterIP + ' port ' + port + ' after 1 ms: Couldn\'t connect to server', code: 7, why: 'el Service ' + svc.metadata.name + ' no tiene endpoints (revisa el selector y que los pods estén Ready)' };
    const pod = eps[0];
    const tp = sp.targetPort === undefined ? sp.port : resolvePortName(pod, sp.targetPort);
    if (tp == null) return { err: 'Connection refused', code: 7, why: 'targetPort "' + sp.targetPort + '" no coincide con ningún puerto con nombre del pod' };
    return hitPod(S, fromPod, pod, tp, path);
  }

  function pathMatch(type, rulePath, path) {
    if (!rulePath) return true;
    if (type === 'Exact') return path === rulePath;
    if (rulePath === '/') return true;
    return path === rulePath || path.startsWith(rulePath.replace(/\/$/, '') + '/');
  }
  function hostMatch(ruleHost, host) {
    if (!ruleHost) return true;
    if (ruleHost.startsWith('*.')) return host.endsWith(ruleHost.slice(1));
    return ruleHost === host;
  }

  function routeIngress(S, hostHdr, path) {
    let best = null;
    for (const ing of list(S, 'Ingress')) {
      if (!ingressClassFor(S, ing)) continue;
      for (const r of ing.spec.rules || []) {
        if (!hostMatch(r.host, hostHdr)) continue;
        for (const p of (r.http && r.http.paths) || []) {
          if (!pathMatch(p.pathType, p.path, path)) continue;
          const len = (p.path || '').length;
          if (!best || len > best.len) best = { len, ing, backend: p.backend };
        }
      }
      if (!best && ing.spec.defaultBackend) best = { len: 0, ing, backend: ing.spec.defaultBackend };
    }
    if (!best) return { status: 404, body: '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>' };
    const b = best.backend.service;
    const svc = find(S, 'Service', C.nsOf(best.ing), b.name);
    if (!svc) return { status: 503, body: '503 Service Temporarily Unavailable', why: 'el Service ' + b.name + ' no existe en ' + C.nsOf(best.ing) };
    const port = b.port.number || ((svc.spec.ports || []).find((x) => x.name === b.port.name) || {}).port;
    const r = hitService(S, null, svc, port, path);
    if (r.err) return { status: 503, body: '503 Service Temporarily Unavailable', why: r.why };
    return r;
  }

  function routeGateway(S, hostHdr, path, scheme) {
    const gws = list(S, 'Gateway').filter((g) => find(S, 'GatewayClass', null, g.spec.gatewayClassName));
    for (const g of gws) {
      const listeners = (g.spec.listeners || []).filter((l) => (scheme === 'https' ? l.protocol === 'HTTPS' : l.protocol === 'HTTP') && hostMatch(l.hostname, hostHdr));
      if (!listeners.length) continue;
      for (const rt of list(S, 'HTTPRoute')) {
        const parents = (rt.spec.parentRefs || []).filter((pr) => pr.name === g.metadata.name && (pr.namespace || C.nsOf(rt)) === C.nsOf(g));
        if (!parents.length) continue;
        if (rt.spec.hostnames && rt.spec.hostnames.length && !rt.spec.hostnames.some((h) => hostMatch(h, hostHdr))) continue;
        for (const rule of rt.spec.rules || [{}]) {
          const ms = rule.matches && rule.matches.length ? rule.matches : [{ path: { type: 'PathPrefix', value: '/' } }];
          if (!ms.some((m) => !m.path || pathMatch(m.path.type === 'Exact' ? 'Exact' : 'Prefix', m.path.value, path))) continue;
          const br = (rule.backendRefs || [])[0];
          if (!br) continue;
          const svc = find(S, 'Service', br.namespace || C.nsOf(rt), br.name);
          if (!svc) return { status: 500, body: 'backend not found', why: 'el Service ' + br.name + ' no existe' };
          const r = hitService(S, null, svc, br.port, path);
          if (r.err) return { status: 503, body: 'no healthy upstream', why: r.why };
          if (scheme === 'https') r.tls = listeners[0].tls;
          return r;
        }
      }
    }
    return { status: 404, body: 'Not Found', why: 'ningún listener/HTTPRoute coincide con host=' + hostHdr + ' path=' + path };
  }

  function httpRequest(S, fromPod, url, hdrHost, resolveMap) {
    const m = String(url).match(/^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
    if (!m) return { err: 'URL rejected: Malformed input to a URL function', code: 3 };
    const scheme = m[1] || 'http';
    let host = m[2];
    const port = m[3] ? +m[3] : (scheme === 'https' ? 443 : 80);
    const path = m[4] || '/';
    let ip = host;
    if (resolveMap && resolveMap[host]) ip = resolveMap[host];
    else if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const hostsFile = fsRead(S, S.host, '/etc/hosts') || '';
      const line = hostsFile.split('\n').find((l) => l.split(/\s+/).slice(1).includes(host));
      if (line) ip = line.split(/\s+/)[0];
    }
    if (fromPod && !/^\d/.test(ip) && !dnsWorks(S)) return { err: 'Could not resolve host: ' + host, code: 6, why: 'CoreDNS no tiene pods Ready' };
    const target = resolveHost(S, ip, fromPod ? C.nsOf(fromPod) : 'default');
    if (!target) return { err: 'Could not resolve host: ' + host, code: 6 };
    const vhost = hdrHost || host;
    if (target.t === 'svc') { if (!fromPod && S.host === 'base') return { err: 'Failed to connect to ' + host + ' port ' + port + ': Connection timed out', code: 28, why: 'las IP de Service solo son accesibles desde dentro del clúster' }; return hitService(S, fromPod, target.svc, port, path); }
    if (target.t === 'pod') return hitPod(S, fromPod, target.pod, port, path);
    if (target.t === 'ingress') return routeIngress(S, vhost, path);
    if (target.t === 'gateway') return routeGateway(S, vhost, path, scheme);
    if (target.t === 'node') {
      const svc = list(S, 'Service').find((s) => (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') && (s.spec.ports || []).some((p) => p.nodePort === port));
      if (svc) return hitService(S, fromPod, svc, port, path, true);
      return { err: 'Failed to connect to ' + ip + ' port ' + port + ' after 0 ms: Couldn\'t connect to server', code: 7 };
    }
    return { err: 'Could not resolve host: ' + host, code: 6 };
  }

  // ================================================================ RBAC
  function subjectMatches(sub, who, bindingNs) {
    if (sub.kind === 'ServiceAccount') return who.sa && who.sa.name === sub.name && who.sa.ns === (sub.namespace || bindingNs);
    if (sub.kind === 'User') return who.user === sub.name;
    if (sub.kind === 'Group') return (who.groups || []).includes(sub.name);
    return false;
  }
  function ruleAllows(rule, verb, resource, group, name) {
    const verbs = rule.verbs || [];
    if (!(verbs.includes('*') || verbs.includes(verb))) return false;
    const groups = rule.apiGroups || [];
    if (!(groups.includes('*') || groups.includes(group))) return false;
    const res = rule.resources || [];
    if (!(res.includes('*') || res.includes(resource))) return false;
    if (rule.resourceNames && rule.resourceNames.length && !(name && rule.resourceNames.includes(name))) return false;
    return true;
  }
  function parseAs(as, groups) {
    const who = { user: as, groups: ['system:authenticated'].concat(groups || []) };
    const m = String(as || '').match(/^system:serviceaccount:([^:]+):(.+)$/);
    if (m) { who.sa = { ns: m[1], name: m[2] }; who.groups.push('system:serviceaccounts', 'system:serviceaccounts:' + m[1]); }
    return who;
  }
  function canI(S, who, verb, resourceWord, ns, name) {
    if (!who || who.user === 'kubernetes-admin' || (who.groups || []).includes('system:masters') || (who.groups || []).includes('kubeadm:cluster-admins')) return true;
    const [resPart, sub] = String(resourceWord).split('/');
    const def = C.resolveKind(S, resPart);
    const resource = def ? def.plural + (sub ? '/' + sub : '') : resourceWord;
    const group = def ? def.group : (resPart.includes('.') ? resPart.split('.').slice(1).join('.') : '');
    const verbs = verb === '*' ? ['*'] : [verb];
    const check = (roleKind, roleName, bindingNs) => {
      const role = roleKind === 'ClusterRole' ? find(S, 'ClusterRole', null, roleName) : find(S, 'Role', bindingNs, roleName);
      if (!role) return false;
      return (role.rules || []).some((r) => verbs.every((v) => ruleAllows(r, v, resource, group, name)));
    };
    for (const b of list(S, 'ClusterRoleBinding')) {
      if ((b.subjects || []).some((s) => subjectMatches(s, who, null)) && check('ClusterRole', b.roleRef.name)) return true;
    }
    if (ns && (!def || def.namespaced)) {
      for (const b of list(S, 'RoleBinding', ns)) {
        if ((b.subjects || []).some((s) => subjectMatches(s, who, ns)) && check(b.roleRef.kind, b.roleRef.name, ns)) return true;
      }
    }
    return false;
  }

  CKA.sim = {
    fsOf, norm, parentOf, mkdirp, fsRead, fsWrite, fsIsDir, fsExists, fsList, fsRemove, canWrite, canRead, hostKey,
    buildCluster, makeNode, installCni, staticManifests, reconcile, cpHealth, kubeletCheck, nodeReady, podIsReady, podDisplayStatus,
    podRequests, nodeUsage, tolerates, netAllowed, httpRequest, resolveHost, svcEndpoints, dnsWorks, listens, podPorts,
    canI, parseAs, imageOk, flagsOf, readManifest, sysDeploy, ownedBy, KUBEADM_DROPIN, KUBELET_CONFIG, ingressClassFor,
  };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
