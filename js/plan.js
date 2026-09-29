/* Kubelab CKA — plan de estudio del martes 29 de septiembre al sábado 3 de octubre de 2026. */
(function (CKA) {
  'use strict';
  CKA.plan = {
    examDate: '2026-10-03',
    days: [
      {
        date: '2026-09-29', label: 'Martes 29', hours: 3.5, theme: 'Arranque y las 17 preguntas del PDF',
        blocks: [
          { id: 'd1b1', mins: 20, text: 'Lee la chuleta: alias, `export do=...`, ajustes de vim y flujo ssh → sudo -i → exit.', view: 'cheat' },
          { id: 'd1b2', mins: 60, text: 'Laboratorio: preguntas PDF #1–#9 en modo práctica. Intenta sin pistas; abre la solución solo al terminar.', tasks: ['pdf01', 'pdf02', 'pdf05', 'pdf06', 'pdf07', 'pdf08', 'pdf09'] },
          { id: 'd1b3', mins: 70, text: 'Laboratorio: preguntas PDF #10–#17 (incluye etcd y upgrade: repítelas dos veces).', tasks: ['pdf10', 'pdf11', 'pdf12', 'pdf13', 'pdf14', 'pdf15', 'pdf16', 'pdf17', 'pdf03', 'pdf04'] },
          { id: 'd1b4', mins: 20, text: 'Quiz: 20 preguntas. Anota los conceptos que falles.', view: 'quiz' },
          { id: 'd1b5', mins: 30, text: 'Repite, contra reloj, las 3 preguntas del PDF que más tardaste.' },
        ],
      },
      {
        date: '2026-09-30', label: 'Miércoles 30', hours: 5, theme: 'Troubleshooting (30%) + arquitectura (25%)',
        blocks: [
          { id: 'd2b1', mins: 75, text: 'Troubleshooting del plano de control y nodos: apiserver, scheduler, controller-manager, kubelet (config y drop-in), containerd.', tasks: ['n-apiserver', 'n-scheduler', 'n-controller-mgr', 'n-kubelet-ca', 'n-kubelet-dropin', 'n-containerd'] },
          { id: 'd2b2', mins: 45, text: 'Troubleshooting de aplicaciones: imagen/ConfigMap, pod Pending, --previous, top, Service sin endpoints, DNS.', tasks: ['n-app-fix', 'n-heavy-pod', 'n-crash-prev', 'n-top-node', 'n-svc-fix', 'n-dns'] },
          { id: 'd2b3', mins: 60, text: 'Arquitectura: upgrade de worker, CNI, cri-dockerd + sysctl, certificados, CSR + RBAC, pod estático.', tasks: ['n-upgrade-worker', 'n-cni', 'n-cri-dockerd', 'n-certs', 'n-csr-rbac', 'n-static-pod'] },
          { id: 'd2b4', mins: 120, text: 'killer.sh — sesión 1 (incluida con tu registro del examen; cada sesión da 36 h de acceso). Hazla completa, con cronómetro de 2 h.' },
        ],
      },
      {
        date: '2026-10-01', label: 'Jueves 1', hours: 5, theme: 'Redes, almacenamiento, Helm/Kustomize/CRDs',
        blocks: [
          { id: 'd3b1', mins: 60, text: 'Revisa las soluciones de killer.sh sesión 1 y rehaz las que fallaste (el entorno sigue abierto 36 h).' },
          { id: 'd3b2', mins: 70, text: 'Servicios y redes: Gateway API con TLS, NetworkPolicies (archivos, egress/DNS), Ingress con host.', tasks: ['n-gateway', 'n-netpol-files', 'n-netpol-egress', 'n-ingress-hosts'] },
          { id: 'd3b3', mins: 45, text: 'Almacenamiento: StorageClass por defecto, PVC hacia PV retenido (MariaDB), PVC Pending.', tasks: ['n-sc-default', 'n-mariadb', 'n-pvc-pending'] },
          { id: 'd3b4', mins: 60, text: 'Extensiones del clúster: Helm (Argo CD sin CRDs, upgrade), Kustomize, CRDs de cert-manager, CR propio.', tasks: ['n-helm-argo', 'n-helm-upgrade', 'n-kustomize', 'n-crd-certmgr', 'n-cr-database'] },
          { id: 'd3b5', mins: 65, text: 'Workloads y scheduling: HPA, PriorityClass, recursos, ConfigMap inmutable, taints, afinidad, sidecar, CronJob, Secret, DaemonSet, LimitRange.', tasks: ['n-hpa', 'n-priority', 'n-resources', 'n-cm-immutable', 'n-taints', 'n-affinity', 'n-sidecar-native', 'n-cronjob', 'n-secret', 'n-daemonset', 'n-limits', 'n-rollout'] },
        ],
      },
      {
        date: '2026-10-02', label: 'Viernes 2', hours: 4, theme: 'Simulacro completo y logística',
        blocks: [
          { id: 'd4b1', mins: 120, text: 'Simulacro de examen en esta app: 17 tareas, 2 h, sin pistas. Meta ≥ 80 % (el mínimo para aprobar es 66 %).', view: 'exam' },
          { id: 'd4b2', mins: 60, text: 'Repasa las tareas falladas del simulacro y el dominio más débil del tablero.' },
          { id: 'd4b3', mins: 30, text: 'killer.sh sesión 2: repasa solo las preguntas que te costaron (no hagas otro examen completo hoy).' },
          { id: 'd4b4', mins: 30, text: 'Logística: prueba de sistema de PSI, identificación oficial vigente, escritorio despejado, webcam, cargador, cerrar apps. Duerme temprano.' },
        ],
      },
      {
        date: '2026-10-03', label: 'Sábado 3 · EXAMEN', hours: 0.75, theme: 'Calentamiento ligero y a presentar',
        blocks: [
          { id: 'd5b1', mins: 30, text: 'Calentamiento: 4 tareas rápidas (scale, nodeSelector, logs, NodePort) sin ver soluciones.', tasks: ['pdf07', 'pdf08', 'pdf12', 'pdf06'] },
          { id: 'd5b2', mins: 15, text: 'Relee la estrategia de examen de la chuleta. Nada de temas nuevos. Conéctate 30 min antes para el check-in.' },
        ],
      },
    ],
    strategy: [
      'Lee la pregunta completa y ejecuta el `ssh <host>` indicado ANTES de hacer nada. Al terminar, `exit` hasta volver a la terminal base.',
      'Primero las tareas rápidas y de peso alto; marca (flag) las largas y vuelve al final. Cada tarea suele valer entre 4 % y 13 %.',
      'Usa `kubectl … --dry-run=client -o yaml > archivo.yaml` y la documentación permitida (copiar/pegar con Ctrl+Shift+C / Ctrl+Shift+V en la terminal remota).',
      'Verifica siempre el estado final (`get`, `describe`, `auth can-i`, `curl`, `cat` del archivo de salida). Solo cuenta el estado final.',
      'Si algo no sale en ~8 minutos, márcalo y avanza. Aprobar requiere 66 %: no necesitas el 100 %.',
      'Cuidado con namespaces: añade siempre `-n <ns>` o fija el contexto con `kubectl config set-context --current --namespace=<ns>`.',
    ],
  };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
