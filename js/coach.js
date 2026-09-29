/* Kubelab CKA — coach: retroalimentación en español para cada instrucción ejecutada. */
(function (CKA) {
  'use strict';

  const ERR_RULES = [
    [/AlreadyExists|already exists/, 'El objeto ya existe. Usa `kubectl apply -f` para actualizarlo, `kubectl edit`, o bórralo y recréalo (`kubectl replace --force -f archivo.yaml`).'],
    [/pod updates may not change fields/, 'El spec de un Pod es inmutable (salvo imagen, tolerations nuevas y activeDeadlineSeconds). Exporta con `-o yaml`, edita y usa `kubectl replace --force -f archivo.yaml`. Si usaste `kubectl edit`, tus cambios quedaron en /tmp/kubectl-edit-*.yaml.'],
    [/error converting YAML|error parsing/, 'YAML inválido: revisa la indentación (solo espacios, 2 por nivel), los guiones de las listas y los dos puntos. En vim: `:set expandtab tabstop=2 shiftwidth=2`.'],
    [/no matches for kind/, 'apiVersion/kind incorrectos. Comprueba con `kubectl api-resources | grep -i <kind>` (p. ej. Deployment → apps/v1, Ingress → networking.k8s.io/v1, HPA → autoscaling/v2).'],
    [/doesn't have a resource type/, 'Tipo de recurso desconocido. Revisa el nombre (`kubectl api-resources`) o si la CRD está instalada.'],
    [/namespaces "[^"]+" not found/, 'Ese namespace no existe. Revisa la ortografía (`kubectl get ns`) o créalo si la tarea lo pide.'],
    [/Permission denied|Access denied|permission denied|are you root|Not superuser|not running as root|requires superuser/, 'Faltan privilegios de root. Antepone `sudo` o entra con `sudo -i` (sal con `exit` al terminar).'],
    [/command not found/, 'Ese comando no existe en este host o está mal escrito. Escribe `help` para ver lo disponible.'],
    [/Held packages were changed/, 'Los paquetes de Kubernetes están retenidos: `apt-mark unhold kubeadm kubelet kubectl` antes de instalar (y `hold` al terminar), o usa `--allow-change-held-packages`.'],
    [/is higher than the kubeadm version/, 'Primero actualiza el paquete kubeadm a la versión destino; kubeadm no puede actualizar a una versión mayor que la suya.'],
    [/Too long: may not be more than 262144 bytes/, 'Manifiesto demasiado grande para `kubectl apply` (anotación last-applied). Usa `kubectl create -f` o `kubectl apply --server-side -f`.'],
    [/`selector` does not match template `labels`/, 'Las etiquetas de `spec.template.metadata.labels` deben coincidir con `spec.selector.matchLabels`.'],
    [/field is immutable|spec is immutable/, 'Campo inmutable: hay que borrar y recrear el objeto (`kubectl replace --force -f`).'],
    [/pathType must be specified/, 'En networking.k8s.io/v1 cada path del Ingress necesita `pathType: Prefix` (o Exact / ImplementationSpecific).'],
    [/E212: Can't open file for writing/, 'No pudiste guardar el archivo: abre el editor con `sudo vim <archivo>` o entra con `sudo -i`.'],
    [/couldn't find port via --port flag/, 'Indica el puerto con `--port` (y `--target-port` si difiere).'],
    [/must specify one of -f and -k/, 'Falta el archivo: `kubectl apply -f archivo.yaml` (o `-f -` para leer de stdin/heredoc).'],
    [/is not supported anymore\. Use exec \[POD\] -- \[COMMAND\]/, 'Sintaxis actual: `kubectl exec <pod> -- <comando>` (con `--`).'],
    [/a container name must be specified/, 'El pod tiene varios contenedores: añade `-c <contenedor>`.'],
    [/context deadline exceeded/, 'etcdctl no pudo conectarse. Necesitas `--endpoints=https://127.0.0.1:2379 --cacert=… --cert=… --key=…` (tómalos de /etc/kubernetes/manifests/etcd.yaml o del enunciado) y ejecutarlo como root en el plano de control.'],
    [/only dynamically provisioned pvc can be resized/, 'Solo se pueden expandir PVCs de una StorageClass con `allowVolumeExpansion: true`.'],
    [/The connection to the server localhost:8080 was refused/, null],
    [/unknown flag|unknown shorthand flag/, 'Flag desconocido. Consulta `kubectl <comando> -h` (tiene ejemplos copiables).'],
    [/Unexpected args|exactly one NAME is required/, 'Revisa la sintaxis: `kubectl create <tipo> <nombre> [flags]`. `kubectl create <tipo> -h` muestra ejemplos.'],
    [/exceeded quota|failed quota/, 'Una ResourceQuota del namespace lo impide: `kubectl describe quota -n <ns>`.'],
    [/no PriorityClass with name/, 'La PriorityClass no existe: `kubectl get priorityclass`.'],
    [/Version '.*' for '.*' was not found/, 'Esa versión no está en el repositorio configurado: `apt-cache madison kubeadm` lista las disponibles.'],
    [/data-dir ".*" not empty/, 'El directorio destino del restore ya tiene datos: usa un directorio nuevo, p. ej. `--data-dir /var/lib/etcd-restore`.'],
  ];

  const HINTS = {
    NOHOST: 'Estás en la terminal base (candidate@base). En el examen cada pregunta indica un host: conéctate primero con `ssh <host>` (lo ves arriba del enunciado).',
    APIDOWN: 'El API server no responde, así que kubectl no sirve. Diagnóstico desde el plano de control: `sudo crictl ps -a | grep kube-apiserver`, `sudo crictl logs <id>`, `sudo journalctl -u kubelet | tail` y revisa /etc/kubernetes/manifests/.',
    WORKERKUBECTL: 'kubectl no está configurado en este nodo worker. Termina aquí lo de systemctl/apt y vuelve con `exit` al host del plano de control.',
  };

  function parseEvents(result) {
    return (result.trace || []).map((tr) => {
      let argv = tr.argv.slice();
      let sudo = false;
      if (argv[0] === 'sudo') { sudo = true; argv = argv.slice(1); }
      const isK = argv[0] === 'kubectl' || argv[0] === 'k';
      return { argv, sudo, kubectl: isK, args: isK ? argv.slice(1) : [], res: tr.res };
    });
  }

  function analyze(ctx) {
    const out = [];
    const seen = new Set();
    const push = (kind, text) => { if (text && !seen.has(text)) { seen.add(text); out.push({ kind, text }); } };
    const r = ctx.result;
    const errText = r.chunks.filter((c) => c.t === 'err').map((c) => c.s).join('\n');
    if (r.hint && HINTS[r.hint]) push('warn', HINTS[r.hint]);
    if (r.why) push('info', 'Por qué: ' + r.why + '.');
    for (const [re, msg] of ERR_RULES) if (msg && re.test(errText)) push('warn', msg);
    if (/Permission denied/.test(errText) && /^\s*sudo\s+\S.*>/.test(ctx.line)) push('tip', 'Con `sudo cmd > archivo` la redirección la hace tu shell sin privilegios. Usa `cmd | sudo tee archivo` o `sudo -i`.');
    const evs = parseEvents(r);
    for (const ev of evs) {
      const a = ev.argv;
      const line = a.join(' ');
      if (ev.kubectl) {
        if (a.includes('--record')) push('tip', '`--record` está obsoleto; sigue funcionando, pero la forma recomendada es `kubectl annotate <obj> kubernetes.io/change-cause="..."`.');
        if (/--dry-run(=client)?/.test(line) && /-o\s*yaml|-oyaml|--output=yaml/.test(line) && /[>|]/.test(ctx.line)) push('ok', 'Buen hábito: generar el YAML con `--dry-run=client -o yaml` y ajustarlo es la forma más rápida en el examen.');
        if (ev.args[0] === 'edit' && /^(po|pod|pods)(\/|$)/.test(ev.args[1] || '')) push('tip', 'Recuerda: casi nada del spec de un Pod es editable. Si el editor rechaza el cambio, aplica la copia de /tmp con `kubectl replace --force -f`.');
        if (ev.args[0] === 'config' && ev.args[1] === 'use-context') push('info', 'En el formato actual del examen cambias de clúster con `ssh <host>` por pregunta; use-context era el formato anterior.');
        if (ev.args[0] === 'delete' && a.includes('--force') && /--grace-period[= ]0/.test(line)) push('ok', 'Borrado inmediato: ahorra tiempo en el examen (`export now="--force --grace-period 0"`).');
        if (ev.args[0] === 'create' && ev.args[1] === 'clusterrolebinding' && ctx.task && /namespace/i.test((ctx.task.task || []).join(' ')) && ctx.task.domain === 'arch') push('tip', 'Si el permiso debe limitarse a un namespace, usa RoleBinding (puede referenciar una ClusterRole).');
        if (ev.args[0] === 'apply' && !ev.res.err && /created|configured/.test(ev.res.out)) push('info', 'Aplicado. Verifica el resultado (`kubectl get …`, `describe`): en el examen solo cuenta el estado final.');
      }
      if ((a[0] === 'vim' || a[0] === 'vi' || a[0] === 'nano') && ev.res.editor && ev.res.editor.content === '' && /\.ya?ml$/.test(a[1] || '')) push('tip', 'Archivo nuevo vacío: en lugar de escribir el YAML desde cero, genera el esqueleto con `kubectl ... --dry-run=client -o yaml > ' + (a[1] || 'archivo.yaml') + '` o copia el ejemplo de la documentación.');
      if (a[0] === 'systemctl' && (a[1] === 'start' || a[1] === 'restart') && a.includes('kubelet') && !ev.res.err) push('info', 'Si la tarea pide que el cambio sea permanente, confirma también `systemctl enable kubelet` (`systemctl is-enabled kubelet`).');
      if (a[0] === 'etcdctl' && a.includes('restore')) push('tip', 'En etcd 3.6 restaura con `etcdutl snapshot restore <archivo> --data-dir <dir-nuevo>`.');
      if (a[0] === 'etcdutl' && a.includes('restore') && !a.some((x) => /^--data-dir/.test(x)) && !ev.res.err) push('warn', 'Restauraste sin `--data-dir`: los datos quedaron en ./default.etcd de tu directorio actual. Lo usual es `--data-dir /var/lib/etcd-restore` y apuntar el hostPath etcd-data del manifiesto ahí.');
      if (a[0] === 'kubeadm' && a[1] === 'upgrade' && a[2] === 'apply' && !ev.res.err) push('ok', 'Plano de control actualizado. Faltan kubelet y kubectl del nodo: instala los paquetes, `systemctl daemon-reload` y `systemctl restart kubelet`, y luego uncordon.');
      if (a[0] === 'sysctl' && a[1] === '-w' && !ev.res.err) push('tip', '`sysctl -w` no es persistente: escribe también el parámetro en /etc/sysctl.d/<archivo>.conf y ejecuta `sysctl --system`.');
      if (a[0] === 'ssh' && !ev.res.err && ctx.task && a.includes(ctx.task.host)) push('ok', 'Conectado al host correcto de la pregunta.');
      if (ctx.task && typeof ctx.task.coach === 'function') { try { push('tip', ctx.task.coach(ev, ctx.S)); } catch (e) { /* ignorar */ } }
    }
    if (r.editor && r.editor.title && /^kubectl edit/.test(r.editor.title)) push('info', 'Se abrió el editor con el objeto en vivo. Guarda con Ctrl+S o `:wq`; si hay un error se te mostrará al guardar.');
    // cambios en los requisitos de la tarea
    if (ctx.before && ctx.after) {
      ctx.after.forEach((c, i) => {
        const b = ctx.before[i];
        if (c.ok && b && !b.ok) push('ok', '✓ Requisito cumplido: ' + c.t);
        if (!c.ok && b && b.ok) push('warn', '✗ Este requisito se cumplía y dejó de cumplirse: ' + c.t);
      });
      if (ctx.after.length && ctx.after.every((c) => c.ok) && !(ctx.before.every((c) => c.ok))) push('done', 'Todos los requisitos se cumplen. Tarea completa: verifica una última vez y pasa a la siguiente.');
    }
    if (!out.length && r.code && errText && !/localhost:8080/.test(errText)) push('info', 'El comando terminó con error (código ' + r.code + '). Lee la primera línea del mensaje: suele decir exactamente qué falta.');
    return out;
  }

  CKA.coach = { analyze };
})(typeof window !== 'undefined' ? (window.CKA = window.CKA || {}) : (globalThis.CKA = globalThis.CKA || {}));
