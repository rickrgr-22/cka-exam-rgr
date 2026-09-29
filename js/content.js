/* Kubelab CKA — contenido externo simulado: charts de Helm, manifiestos remotos y CRDs. */
(function (CKA) {
  'use strict';
  const C = CKA.core;
  const X = CKA.sim;

  // ------------------------------------------------------------ helpers
  function helmLabels(rel, chart, ver, comp) {
    const l = { 'app.kubernetes.io/instance': rel, 'app.kubernetes.io/managed-by': 'Helm', 'app.kubernetes.io/name': comp, 'helm.sh/chart': chart + '-' + ver };
    return l;
  }
  function dep(name, ns, labels, image, port, replicas) {
    const sel = { 'app.kubernetes.io/name': labels['app.kubernetes.io/name'], 'app.kubernetes.io/instance': labels['app.kubernetes.io/instance'] };
    return {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels },
      spec: { replicas: replicas == null ? 1 : replicas, selector: { matchLabels: sel }, template: { metadata: { labels: Object.assign({}, labels) }, spec: { containers: [{ name: labels['app.kubernetes.io/name'].split('-').pop(), image, ports: port ? [{ containerPort: port, name: 'http', protocol: 'TCP' }] : undefined }] } } },
    };
  }
  function svc(name, ns, labels, port, target, type) {
    return { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels }, spec: { type: type || 'ClusterIP', selector: { 'app.kubernetes.io/name': labels['app.kubernetes.io/name'], 'app.kubernetes.io/instance': labels['app.kubernetes.io/instance'] }, ports: [{ name: 'http', port, targetPort: target || port, protocol: 'TCP' }] } };
  }
  function crd(group, kind, plural, scope, schema, shortNames, extraLabels) {
    return {
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
      metadata: { name: plural + '.' + group, labels: extraLabels || undefined },
      spec: {
        group, scope: scope || 'Namespaced',
        names: { kind, plural, singular: kind.toLowerCase(), listKind: kind + 'List', shortNames: shortNames || undefined },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: schema || { type: 'object', properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true }, status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } } } }],
      },
    };
  }

  // ------------------------------------------------------------ charts
  const ARGO_URL = 'https://argoproj.github.io/argo-helm';
  const BITNAMI_URL = 'https://charts.bitnami.com/bitnami';
  const argoCrds = (rel, ver) => ['applications', 'applicationsets', 'appprojects'].map((p) => {
    const kind = { applications: 'Application', applicationsets: 'ApplicationSet', appprojects: 'AppProject' }[p];
    const c = crd('argoproj.io', kind, p, 'Namespaced', null, null, { 'app.kubernetes.io/name': p + '.argoproj.io', 'app.kubernetes.io/part-of': 'argocd' });
    if (rel) { c.metadata.labels['app.kubernetes.io/managed-by'] = 'Helm'; c.metadata.annotations = { 'meta.helm.sh/release-name': rel, 'helm.sh/resource-policy': 'keep' }; }
    return c;
  });

  CKA.charts = {
    'argo-cd': {
      name: 'argo-cd', url: ARGO_URL, description: 'A Helm chart for Argo CD, a declarative, GitOps continuous delivery tool for Kubernetes.',
      versions: ['7.6.12', '7.7.0', '7.7.3', '7.8.2', '8.0.17'], appVersion: 'v2.13.1', appVersions: { '7.6.12': 'v2.12.6', '7.7.0': 'v2.13.0', '7.7.3': 'v2.13.1', '7.8.2': 'v2.14.2', '8.0.17': 'v3.0.6' },
      defaults: { crds: { install: true, keep: true }, server: { replicas: 1, service: { type: 'ClusterIP' } }, redis: { enabled: true } },
      valuesYaml: '## Argo CD configuration\n## Ref: https://github.com/argoproj/argo-cd\n\ncrds:\n  # -- Install and upgrade CRDs\n  install: true\n  # -- Keep CRDs on chart uninstall\n  keep: true\n\nglobal:\n  domain: argocd.example.com\n\nserver:\n  replicas: 1\n  service:\n    type: ClusterIP\n\nredis:\n  enabled: true',
      render(rel, ns, v, ver) {
        const app = this.appVersions[ver] || this.appVersion;
        const full = rel.includes('argocd') ? rel : rel + '-argocd';
        const L = (c) => helmLabels(rel, 'argo-cd', ver, 'argocd-' + c);
        const out = [];
        if (v.crds && v.crds.install !== false && v.crds.install !== 'false') out.push(...argoCrds(rel, ver));
        out.push({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'argocd-server', namespace: ns, labels: L('server') } });
        out.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'argocd-cm', namespace: ns, labels: L('cm') }, data: { 'admin.enabled': 'true', 'server.rbac.log.enforce.enable': 'false', url: 'https://' + ((v.global || {}).domain || 'argocd.example.com') } });
        out.push(dep(full + '-server', ns, L('server'), 'quay.io/argoproj/argocd:' + app, 8080, (v.server || {}).replicas));
        out.push(dep(full + '-repo-server', ns, L('repo-server'), 'quay.io/argoproj/argocd:' + app, 8081));
        out.push(dep(full + '-applicationset-controller', ns, L('applicationset-controller'), 'quay.io/argoproj/argocd:' + app, 7000));
        if (!v.redis || v.redis.enabled !== false) out.push(dep(full + '-redis', ns, L('redis'), 'public.ecr.aws/docker/library/redis:7.4.1-alpine', 6379));
        const ctrl = dep(full + '-application-controller', ns, L('application-controller'), 'quay.io/argoproj/argocd:' + app, 8082);
        ctrl.kind = 'StatefulSet'; ctrl.spec.serviceName = full + '-application-controller';
        out.push(ctrl);
        out.push(svc(full + '-server', ns, L('server'), 80, 8080, (v.server && v.server.service && v.server.service.type) || 'ClusterIP'));
        out.push(svc(full + '-repo-server', ns, L('repo-server'), 8081));
        return out;
      },
    },
    nginx: {
      name: 'nginx', url: BITNAMI_URL, description: 'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.',
      versions: ['20.0.3', '21.0.0', '21.1.3'], appVersion: '1.29.1', appVersions: { '20.0.3': '1.27.5', '21.0.0': '1.29.0', '21.1.3': '1.29.1' },
      defaults: { replicaCount: 1, service: { type: 'LoadBalancer', ports: { http: 80 } }, image: {} },
      valuesYaml: 'replicaCount: 1\nimage:\n  registry: docker.io\n  repository: bitnami/nginx\n  tag: ""\nservice:\n  type: LoadBalancer\n  ports:\n    http: 80\nresources: {}',
      render(rel, ns, v, ver) {
        const L = helmLabels(rel, 'nginx', ver, 'nginx');
        const tag = (v.image && v.image.tag) || this.appVersions[ver];
        const d = dep(rel + '-nginx', ns, L, 'docker.io/bitnami/nginx:' + tag, 8080, v.replicaCount);
        d.spec.template.spec.containers[0].name = 'nginx';
        return [d, svc(rel + '-nginx', ns, L, (v.service && v.service.ports && v.service.ports.http) || 80, 'http', v.service && v.service.type)];
      },
    },
  };

  // ------------------------------------------------------------ manifiestos remotos
  const CALICO_OP = 'https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/tigera-operator.yaml';
  const CALICO_CR = 'https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/custom-resources.yaml';
  const FLANNEL = 'https://github.com/flannel-io/flannel/releases/download/v0.27.3/kube-flannel.yml';
  const docs = (arr) => arr.map((o) => C.toYaml(o)).join('---\n');

  CKA.remote = {};
  CKA.remote[CALICO_OP] = {
    createOnly: true,
    text: docs([
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'tigera-operator', labels: { name: 'tigera-operator', 'pod-security.kubernetes.io/enforce': 'privileged' } } },
      crd('operator.tigera.io', 'Installation', 'installations', 'Cluster'),
      crd('operator.tigera.io', 'APIServer', 'apiservers', 'Cluster'),
      crd('crd.projectcalico.org', 'IPPool', 'ippools', 'Cluster'),
      { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'tigera-operator', namespace: 'tigera-operator' } },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'tigera-operator' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'tigera-operator' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'tigera-operator' }, subjects: [{ kind: 'ServiceAccount', name: 'tigera-operator', namespace: 'tigera-operator' }] },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'tigera-operator', namespace: 'tigera-operator', labels: { 'k8s-app': 'tigera-operator' } }, spec: { replicas: 1, selector: { matchLabels: { name: 'tigera-operator' } }, template: { metadata: { labels: { name: 'tigera-operator', 'k8s-app': 'tigera-operator' } }, spec: { hostNetwork: true, serviceAccountName: 'tigera-operator', tolerations: [{ effect: 'NoExecute', operator: 'Exists' }, { effect: 'NoSchedule', operator: 'Exists' }], containers: [{ name: 'tigera-operator', image: 'quay.io/tigera/operator:v1.38.6' }] } } } },
    ]),
  };
  CKA.remote[CALICO_CR] = docs([
    { apiVersion: 'operator.tigera.io/v1', kind: 'Installation', metadata: { name: 'default' }, spec: { calicoNetwork: { ipPools: [{ name: 'default-ipv4-ippool', blockSize: 26, cidr: '192.168.0.0/16', encapsulation: 'VXLANCrossSubnet', natOutgoing: 'Enabled', nodeSelector: 'all()' }] } } },
    { apiVersion: 'operator.tigera.io/v1', kind: 'APIServer', metadata: { name: 'default' }, spec: {} },
  ]);
  CKA.remote[FLANNEL] = docs([
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-flannel', labels: { 'k8s-app': 'flannel', 'pod-security.kubernetes.io/enforce': 'privileged' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'flannel', namespace: 'kube-flannel' } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-flannel-cfg', namespace: 'kube-flannel' }, data: { 'net-conf.json': '{\n  "Network": "10.244.0.0/16",\n  "Backend": { "Type": "vxlan" }\n}\n' } },
    { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kube-flannel-ds', namespace: 'kube-flannel', labels: { app: 'flannel', 'k8s-app': 'flannel' } }, spec: { selector: { matchLabels: { app: 'flannel' } }, template: { metadata: { labels: { app: 'flannel' } }, spec: { hostNetwork: true, tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }], containers: [{ name: 'kube-flannel', image: 'ghcr.io/flannel-io/flannel:v0.27.3' }] } } } },
  ]);
  CKA.urls = { CALICO_OP, CALICO_CR, FLANNEL, ARGO_URL, BITNAMI_URL };

  CKA.reconcileHooks = [
    function cniHook(S) {
      if (S.cni) return;
      const inst = S.objs.find((o) => o.kind === 'Installation' && o.metadata.name === 'default');
      const op = C.find(S, 'Deployment', 'tigera-operator', 'tigera-operator');
      if (inst && op) { X.installCni(S, 'calico'); S.flags.cniInstalled = 'calico'; return; }
      if (C.find(S, 'DaemonSet', 'kube-flannel', 'kube-flannel-ds')) {
        S.cni = 'flannel'; S.flags.cniInstalled = 'flannel';
        for (const n of C.list(S, 'Node')) X.fsWrite(S, n.metadata.name, '/etc/cni/net.d/10-flannel.conflist', '{ "name": "cbr0", "cniVersion": "1.0.0" }\n');
      }
    },
  ];

  // ------------------------------------------------------------ CRDs de cert-manager (con esquema para kubectl explain)
  const subjectSchema = {
    type: 'object',
    description: 'Requested set of X509 certificate subject attributes. More info: https://datatracker.ietf.org/doc/html/rfc5280#section-4.1.2.6\n\nThe common name attribute is specified separately in the `commonName` field. Cannot be set if the `literalSubject` field is set.',
    properties: {
      countries: { type: 'array', description: 'Countries to be used on the Certificate.' },
      localities: { type: 'array', description: 'Cities to be used on the Certificate.' },
      organizationalUnits: { type: 'array', description: 'Organizational Units to be used on the Certificate.' },
      organizations: { type: 'array', description: 'Organizations to be used on the Certificate.' },
      postalCodes: { type: 'array', description: 'Postal codes to be used on the Certificate.' },
      provinces: { type: 'array', description: 'State/Provinces to be used on the Certificate.' },
      serialNumber: { type: 'string', description: 'Serial number to be used on the Certificate.' },
      streetAddresses: { type: 'array', description: 'Street addresses to be used on the Certificate.' },
    },
  };
  CKA.certManagerCrds = function () {
    const certSchema = { type: 'object', description: 'A Certificate resource should be created to ensure an up to date and signed X.509 certificate is stored in the Kubernetes Secret resource named in `spec.secretName`.', properties: { spec: { type: 'object', description: 'Specification of the desired state of the Certificate resource.', required: ['issuerRef', 'secretName'], properties: { commonName: { type: 'string', description: 'Requested common name X509 certificate subject attribute.' }, dnsNames: { type: 'array', description: 'Requested DNS subject alternative names.' }, duration: { type: 'string', description: 'Requested \'duration\' (i.e. lifetime) of the Certificate.' }, issuerRef: { type: 'object', description: 'Reference to the issuer responsible for issuing the certificate.' }, secretName: { type: 'string', description: 'Name of the Secret resource that will be automatically created and managed by this Certificate resource.' }, subject: subjectSchema } }, status: { type: 'object' } } };
    const lab = { 'app.kubernetes.io/instance': 'cert-manager', 'app.kubernetes.io/name': 'cert-manager', 'app.kubernetes.io/version': 'v1.18.2' };
    return [
      crd('cert-manager.io', 'Certificate', 'certificates', 'Namespaced', certSchema, ['cert', 'certs'], lab),
      crd('cert-manager.io', 'CertificateRequest', 'certificaterequests', 'Namespaced', null, ['cr', 'crs'], lab),
      crd('cert-manager.io', 'Issuer', 'issuers', 'Namespaced', null, null, lab),
      crd('cert-manager.io', 'ClusterIssuer', 'clusterissuers', 'Cluster', null, null, lab),
      crd('acme.cert-manager.io', 'Challenge', 'challenges', 'Namespaced', null, null, lab),
      crd('acme.cert-manager.io', 'Order', 'orders', 'Namespaced', null, null, lab),
    ];
  };
  CKA.argoCrds = () => argoCrds(null);
  CKA.crd = crd;
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
