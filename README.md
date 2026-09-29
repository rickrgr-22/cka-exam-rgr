# Kubelab CKA

Guía y examen práctico interactivo para el **Certified Kubernetes Administrator (CKA)**, con un clúster Kubernetes v1.35 (kubeadm) **simulado en el navegador**, terminal tipo bash y retroalimentación en español para cada comando.

**Abrir la app:** https://rickrgr-22.github.io/cka-exam-rgr/ (o abre `index.html` localmente; no requiere instalación).

## Qué incluye

- **Plan de estudio** del martes 29 de septiembre al sábado 3 de octubre de 2026 (~18 h), con bloques marcables, avance por dominio y cuenta regresiva.
- **Laboratorio** con 59 tareas prácticas:
  - las 17 preguntas del PDF *CKA Exam* (RBAC, drain, upgrade, etcd, NetworkPolicy, NodePort, sidecar, PVC, Ingress…);
  - 42 tareas nuevas alineadas al currículo CKA 2025-2026: Helm, Kustomize, CRDs/operadores, CNI, cri-dockerd + sysctl, Gateway API con TLS, HPA, PriorityClass, sidecars nativos, StorageClass por defecto, recuperación de PV, troubleshooting de plano de control, kubelet, containerd, DNS, Services…
  - cada tarea tiene host de `ssh` propio (como el examen actual), requisitos que se verifican en vivo, pistas, solución de referencia y explicación con enlaces a la documentación oficial.
- **Terminal simulada**: `kubectl` (get/describe/create/apply/edit/patch/replace/expose/scale/set/rollout/label/taint/drain/logs/exec/top/auth can-i/explain…), `ssh`, `sudo`, `systemctl`, `journalctl`, `kubeadm`, `apt-get`/`apt-mark`, `dpkg`, `sysctl`, `etcdctl`/`etcdutl`, `helm`, `crictl`, `curl`/`wget`, tuberías, redirecciones, heredocs, variables (`$do`), alias y un editor estilo vim (`vim archivo.yaml`, `kubectl edit`).
- **Coach**: después de cada instrucción explica errores, sugiere atajos y avisa qué requisito se cumplió o se rompió.
- **Simulacro**: 17 tareas al azar con la proporción real de dominios, 2 horas, calificación con crédito parcial y umbral de 66 %.
- **Quiz** conceptual (54 preguntas) y **chuleta** con los comandos clave.

El progreso (tareas resueltas, plan, simulacros) se guarda en `localStorage` del navegador.

## Estructura

```
index.html          interfaz
css/app.css         estilos
js/core.js          tipos de recursos, JSONPath, tablas
js/sim.js           simulador del clúster (planificador, controladores, red, RBAC, plano de control)
js/kubectl.js       kubectl
js/shell.js         shell y herramientas de nodo
js/content.js       charts de Helm y manifiestos remotos simulados
js/tasks.js         banco de tareas
js/coach.js         retroalimentación
js/quiz.js, js/plan.js, js/app.js
test/               verificador de soluciones (Node ≥ 18)
```

## Pruebas

```bash
node test/run-solutions.mjs          # ejecuta la solución de cada tarea y comprueba sus requisitos
node test/run-solutions.mjs pdf04    # una sola tarea, con el log completo
```

## Aviso

Es un simulador educativo: reproduce el comportamiento relevante para el examen, no un clúster real. Confirma el formato vigente del examen (versión de Kubernetes, número de tareas, documentación permitida) en el Candidate Handbook de la Linux Foundation. Practica también en killer.sh (2 sesiones incluidas con tu registro).
