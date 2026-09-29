/* Kubelab CKA — interfaz: plan, laboratorio, simulacro, quiz y chuleta. */
(function (CKA) {
  'use strict';
  const TASKS = CKA.tasks.list;
  const DOM = CKA.tasks.DOMAINS;
  const byId = (id) => TASKS.find((t) => t.id === id);
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ------------------------------------------------------------ almacenamiento
  const KEY = 'kubelab-cka-v1';
  const store = {
    data: { done: {}, plan: {}, quizBest: {}, exams: [], examTime: '10:00', lastTask: 'pdf01', theme: null },
    load() { try { const raw = localStorage.getItem(KEY); if (raw) Object.assign(this.data, JSON.parse(raw)); } catch (e) { /* sin almacenamiento */ } },
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* sin almacenamiento */ } },
  };
  store.load();

  // ------------------------------------------------------------ utilidades
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  function copyText(text, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = 'Copiado'; setTimeout(() => { btn.textContent = o; }, 1200); } };
    try { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } catch (e) { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nada */ }
    ta.remove();
  }
  function examDeadline() {
    const [h, m] = (store.data.examTime || '10:00').split(':').map(Number);
    const d = new Date(2026, 9, 3, h || 10, m || 0, 0);
    return d.getTime();
  }
  function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ------------------------------------------------------------ tema
  function applyTheme() { if (store.data.theme) document.documentElement.setAttribute('data-theme', store.data.theme); else document.documentElement.removeAttribute('data-theme'); }
  applyTheme();
  $('#theme-btn').addEventListener('click', () => {
    const dark = store.data.theme ? store.data.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    store.data.theme = dark ? 'light' : 'dark'; store.save(); applyTheme();
  });

  // ------------------------------------------------------------ cuenta regresiva
  function renderCountdown() {
    const ms = examDeadline() - Date.now();
    const el = $('#countdown');
    if (ms <= 0) { el.textContent = '¡Hoy es el examen!'; return; }
    const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); const m = Math.floor((ms % 3600000) / 60000);
    el.textContent = 'Examen en ' + (d ? d + ' d ' : '') + h + ' h ' + String(m).padStart(2, '0') + ' m';
  }
  renderCountdown();
  setInterval(renderCountdown, 30000);

  // ================================================================ WORKSPACE
  const tpl = $('#workspace-tpl');

  class Workspace {
    constructor(slot, mode, ids) {
      this.mode = mode;
      this.ids = ids;
      this.sessions = {};
      this.current = null;
      this.el = tpl.content.firstElementChild.cloneNode(true);
      slot.innerHTML = '';
      slot.appendChild(this.el);
      this.q = (s) => this.el.querySelector(s);
      this.out = this.q('.term-out');
      this.input = this.q('.term-input');
      this.editorEl = this.q('.editor');
      this.bind();
      this.fillSelect();
      if (mode === 'exam') {
        this.q('.coach-toggle').hidden = true;
        this.q('.coach-cb').checked = false;
        this.q('.hint-btn').hidden = true;
        this.q('.sol-btn').hidden = true;
        this.q('.reset-btn').hidden = true;
        this.q('.task-select').hidden = true;
      }
    }

    fillSelect() {
      const sel = this.q('.task-select');
      sel.innerHTML = '';
      for (const d of Object.keys(DOM)) {
        const og = document.createElement('optgroup');
        og.label = DOM[d].name + ' · ' + DOM[d].pct + '%';
        for (const id of this.ids) {
          const t = byId(id);
          if (t.domain !== d) continue;
          const o = document.createElement('option');
          o.value = id;
          o.textContent = (store.data.done[id] ? '✓ ' : '') + t.n + '. ' + t.title + (t.src.startsWith('PDF') ? '  [' + t.src + ']' : '');
          og.appendChild(o);
        }
        if (og.children.length) sel.appendChild(og);
      }
      if (this.current) sel.value = this.current;
    }

    bind() {
      this.q('.task-select').addEventListener('change', (e) => this.setTask(e.target.value));
      this.q('.prev-task').addEventListener('click', () => this.step(-1));
      this.q('.next-task').addEventListener('click', () => this.step(1));
      this.q('.toggle-es').addEventListener('click', () => { const p = this.q('.es-summary'); p.hidden = !p.hidden; this.q('.toggle-es').textContent = p.hidden ? 'Ver resumen en español' : 'Ocultar resumen'; });
      this.q('.copy-host').addEventListener('click', () => { this.input.value = 'ssh ' + this.task().host; this.focus(); });
      this.q('.hint-btn').addEventListener('click', () => this.showHint());
      this.q('.sol-btn').addEventListener('click', () => this.showSolution());
      this.q('.reset-btn').addEventListener('click', () => this.resetTask());
      this.q('.clear-term').addEventListener('click', () => { this.sess().out = []; this.renderOut(); this.focus(); });
      this.q('.term').addEventListener('mouseup', () => { if (!String(window.getSelection && window.getSelection()).length) this.focus(); });
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      this.input.addEventListener('input', () => this.autosize());
      // editor
      const ta = this.q('.ed-text');
      const cmd = this.q('.ed-cmdline');
      ta.addEventListener('keydown', (e) => this.edKey(e));
      ta.addEventListener('input', () => { this.edDirty = true; this.edGutter(); });
      ta.addEventListener('scroll', () => { this.q('.ed-gutter').scrollTop = ta.scrollTop; });
      cmd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.edCommand(cmd.value.trim()); }
        else if (e.key === 'Escape') { e.preventDefault(); cmd.value = ''; this.edInsert(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.edCommand(':wq'); }
      });
      this.q('.ed-save').addEventListener('click', () => this.edCommand(':wq'));
      this.q('.ed-quit').addEventListener('click', () => this.edCommand(':q!'));
    }

    task() { return byId(this.current); }
    sess(id) {
      id = id || this.current;
      if (!this.sessions[id]) {
        const task = byId(id);
        const S = CKA.tasks.build(task);
        const s = { task, S, out: [], hist: [], hIdx: null, hints: 0, solShown: false, solArmed: false };
        s.checks = CKA.tasks.evaluate(task, S);
        this.sessions[id] = s;
        this.print(s, 'dim', 'Kubelab CKA · clúster kubeadm simulado (Kubernetes ' + (S.serverVersion || S.version) + ')\nEstás en la terminal base. Conéctate al host de la pregunta:  ssh ' + task.host + '\nEscribe help para ver los comandos disponibles. Tab autocompleta, ↑/↓ recorre el historial.\n');
      }
      return this.sessions[id];
    }

    step(delta) {
      const i = this.ids.indexOf(this.current);
      const n = this.ids[(i + delta + this.ids.length) % this.ids.length];
      this.setTask(n);
      if (this.onNavigate) this.onNavigate(n);
    }

    setTask(id) {
      if (!byId(id)) id = this.ids[0];
      this.closeEditor(true);
      this.current = id;
      if (this.mode === 'lab') { store.data.lastTask = id; store.save(); }
      const s = this.sess(id);
      const t = s.task;
      this.q('.task-select').value = id;
      const pos = this.ids.indexOf(id) + 1;
      const meta = this.q('.task-meta');
      meta.innerHTML = (this.mode === 'exam' ? '<span class="tag">Pregunta ' + pos + ' de ' + this.ids.length + '</span>' : '<span class="tag">Tarea ' + t.n + ' de ' + TASKS.length + '</span>') +
        '<span class="tag dom ' + t.domain + '">' + esc(DOM[t.domain].name) + '</span>' +
        '<span class="tag">Peso ' + t.weight + '%</span><span class="tag">~' + t.mins + ' min</span>' +
        (this.mode === 'lab' ? '<span class="tag">' + esc(t.src) + '</span>' : '') +
        (this.mode === 'lab' && store.data.done[id] ? '<span class="tag done">Resuelta</span>' : '') +
        (this.mode === 'exam' ? '<button class="mini flag-btn">' + (this.flags && this.flags.has(id) ? 'Quitar marca' : 'Marcar para revisar') + '</button>' : '');
      const fb = meta.querySelector('.flag-btn');
      if (fb) fb.addEventListener('click', () => { if (this.flags.has(id)) this.flags.delete(id); else this.flags.add(id); this.setTask(id); if (this.onNavigate) this.onNavigate(id); });
      this.q('.task-title').textContent = t.title;
      this.q('.host-cmd').textContent = 'ssh ' + t.host;
      let html = '';
      if (t.context) html += '<p class="context"><strong>Context</strong> — ' + md(t.context) + '</p>';
      let inList = false;
      for (const line of t.task) {
        if (/^\s*- /.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + md(line.replace(/^\s*- /, '')) + '</li>'; }
        else { if (inList) { html += '</ul>'; inList = false; } html += '<p>' + md(line) + '</p>'; }
      }
      if (inList) html += '</ul>';
      this.q('.statement').innerHTML = html;
      this.q('.es-summary').innerHTML = md(t.es);
      this.q('.es-summary').hidden = true;
      this.q('.toggle-es').textContent = 'Ver resumen en español';
      this.renderChecks();
      this.renderHints();
      this.renderSolution();
      this.renderOut();
      this.renderPrompt();
      this.q('.task-scroll').scrollTop = 0;
      this.focus();
    }

    renderChecks() {
      const s = this.sess();
      const ul = this.q('.checks');
      const block = this.q('.checks-block');
      if (this.mode === 'exam') {
        ul.innerHTML = '';
        this.q('.checks-score').textContent = '';
        let hidden = block.querySelector('.checks-hidden');
        if (!hidden) { hidden = document.createElement('p'); hidden.className = 'checks-hidden'; block.appendChild(hidden); }
        hidden.textContent = 'Como en el examen real, los requisitos se evalúan al terminar. Verifica tu trabajo con kubectl.';
        return;
      }
      ul.innerHTML = s.checks.map((c) => '<li class="' + (c.ok ? 'ok' : 'pending') + '">' + md(c.t) + '</li>').join('');
      this.q('.checks-score').textContent = s.checks.filter((c) => c.ok).length + '/' + s.checks.length;
    }

    renderHints() {
      const s = this.sess(); const t = s.task;
      this.q('.hints').innerHTML = t.hints.slice(0, s.hints).map((h, i) => '<div class="hint"><strong>Pista ' + (i + 1) + ':</strong> ' + md(h) + '</div>').join('');
      const b = this.q('.hint-btn');
      b.textContent = s.hints >= t.hints.length ? 'Sin más pistas' : 'Pista (' + (s.hints + 1) + '/' + t.hints.length + ')';
      b.disabled = s.hints >= t.hints.length;
    }
    showHint() { const s = this.sess(); if (s.hints < s.task.hints.length) { s.hints++; this.renderHints(); } }

    renderSolution() {
      const s = this.sess(); const t = s.task;
      const box = this.q('.solution');
      const btn = this.q('.sol-btn');
      btn.textContent = s.solShown ? 'Ocultar solución' : (s.solArmed ? '¿Seguro? Mostrar solución' : 'Ver solución');
      if (!s.solShown) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      const steps = ['ssh ' + t.host].concat(t.solution);
      box.innerHTML = '<h3>Solución de referencia</h3>' +
        steps.map((st, i) => '<div class="sol-step"><pre>' + esc(st) + '</pre><button class="mini" data-step="' + i + '">Pegar</button></div>').join('') +
        '<div class="explain">' + md(t.explain) + '</div>' +
        '<div class="docs">' + t.docs.map((d) => '<a href="' + esc(d) + '" target="_blank" rel="noopener">' + esc(d.replace(/^https:\/\//, '')) + '</a>').join('') + '</div>';
      box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { this.input.value = steps[+b.dataset.step]; this.autosize(); this.focus(); }));
    }
    showSolution() {
      const s = this.sess();
      if (s.solShown) { s.solShown = false; s.solArmed = false; this.renderSolution(); return; }
      if (!s.solArmed) { s.solArmed = true; this.renderSolution(); return; }
      s.solShown = true; s.usedSolution = true; this.renderSolution();
    }

    resetTask() {
      delete this.sessions[this.current];
      this.setTask(this.current);
    }

    // -------------------------------------------------------- terminal
    promptHTML(S) {
      const p = CKA.shell.prompt(S);
      return '<span class="p-user">' + esc(p.user + '@' + p.host) + '</span>:<span class="p-path">' + esc(p.cwd) + '</span>' + p.sym + ' ';
    }
    renderPrompt() {
      const s = this.sess();
      this.q('.prompt').innerHTML = this.promptHTML(s.S);
      this.q('.term-title').textContent = s.S.user + '@' + s.S.host + ' — ' + s.task.title;
    }
    print(s, cls, text, html) {
      s.out.push({ cls, html: html != null ? html : esc(text) });
      if (s.out.length > 700) s.out.splice(0, s.out.length - 700);
      if (s === this.sessions[this.current]) {
        const d = document.createElement('div');
        d.className = 't-' + cls;
        d.innerHTML = html != null ? html : esc(text);
        this.out.appendChild(d);
        while (this.out.children.length > 700) this.out.removeChild(this.out.firstChild);
      }
    }
    renderOut() {
      const s = this.sess();
      this.out.innerHTML = s.out.map((e) => '<div class="t-' + e.cls + '">' + e.html + '</div>').join('');
      this.scroll();
    }
    scroll() { const t = this.q('.term'); t.scrollTop = t.scrollHeight; }
    focus() { if (this.editorEl.hidden) this.input.focus({ preventScroll: true }); }
    autosize() { this.input.rows = Math.min(14, Math.max(1, this.input.value.split('\n').length)); }

    needsMore(text) {
      if (/\\$/.test(text)) return true;
      const m = text.match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
      if (m) { const lines = text.split('\n'); const idx = lines.findIndex((l) => /<<-?\s*['"]?[A-Za-z_]/.test(l)); return !lines.slice(idx + 1).some((l) => l.trim() === m[1]); }
      return false;
    }

    onKey(e) {
      const s = this.sess();
      const v = this.input.value;
      if (e.key === 'Enter' && !e.shiftKey) {
        if (this.needsMore(v)) { return; }
        e.preventDefault();
        this.input.value = ''; this.autosize();
        this.run(v);
        return;
      }
      if (e.key === 'ArrowUp' && !v.slice(0, this.input.selectionStart).includes('\n')) {
        if (!s.hist.length) return;
        e.preventDefault();
        s.hIdx = s.hIdx == null ? s.hist.length - 1 : Math.max(0, s.hIdx - 1);
        this.input.value = s.hist[s.hIdx]; this.autosize();
        return;
      }
      if (e.key === 'ArrowDown' && !v.slice(this.input.selectionEnd).includes('\n')) {
        if (s.hIdx == null) return;
        e.preventDefault();
        s.hIdx++;
        if (s.hIdx >= s.hist.length) { s.hIdx = null; this.input.value = ''; } else this.input.value = s.hist[s.hIdx];
        this.autosize();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const before = v.slice(0, this.input.selectionStart);
        const lastLine = before.split('\n').pop();
        const seg = lastLine.split(/\s*(?:\||&&|;)\s*/).pop();
        const c = CKA.shell.complete(s.S, seg);
        const word = seg.split(/\s+/).pop();
        if (c.length === 1) { const add = c[0].slice(word.length) + (c[0].endsWith('/') ? '' : ' '); this.input.value = before + add + v.slice(this.input.selectionStart); }
        else if (c.length > 1) {
          let pre = c[0];
          for (const x of c) while (!x.startsWith(pre)) pre = pre.slice(0, -1);
          if (pre.length > word.length) this.input.value = before + pre.slice(word.length) + v.slice(this.input.selectionStart);
          else { this.print(s, 'cmd', null, this.promptHTML(s.S) + esc(v)); this.print(s, 'dim', c.slice(0, 60).join('   ')); this.scroll(); }
        }
        return;
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); s.out = []; this.renderOut(); return; }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !this.input.value.slice(this.input.selectionStart, this.input.selectionEnd)) { e.preventDefault(); this.print(s, 'cmd', null, this.promptHTML(s.S) + esc(v) + '^C'); this.input.value = ''; this.autosize(); this.scroll(); }
    }

    run(text) {
      const s = this.sess();
      const S = s.S;
      const lines = text.split('\n');
      this.print(s, 'cmd', null, this.promptHTML(S) + esc(lines[0]) + (lines.length > 1 ? '\n' + lines.slice(1).map((l) => '> ' + esc(l)).join('\n') : ''));
      if (!text.trim()) { this.scroll(); return; }
      s.hist.push(text); s.hIdx = null;
      S.history.push(text.split('\n')[0]);
      const before = s.checks;
      let r;
      try { r = CKA.shell.runLine(S, text); } catch (err) { r = { chunks: [{ t: 'err', s: 'error interno del simulador: ' + err.message }], trace: [], code: 1 }; console.error(err); }
      if (r.clear) { s.out = []; this.renderOut(); }
      for (const c of r.chunks) this.print(s, c.t === 'err' ? 'err' : 'out', c.s);
      this.afterCommand(s, before, r, text);
      if (r.editor) this.openEditor(r.editor);
      this.renderPrompt();
      this.scroll();
    }

    afterCommand(s, before, r, line) {
      s.checks = CKA.tasks.evaluate(s.task, s.S);
      if (this.mode === 'lab') {
        if (this.q('.coach-cb').checked) {
          const msgs = CKA.coach.analyze({ line, result: r, S: s.S, task: s.task, before, after: s.checks });
          const lbl = { ok: 'Bien', warn: 'Ojo', tip: 'Tip', info: 'Info', done: 'Completa' };
          for (const m of msgs) this.print(s, 'coach ' + m.kind, null, '<span class="lbl">' + lbl[m.kind] + '</span>' + md(m.text));
        }
        this.renderChecks();
        if (s.checks.length && s.checks.every((c) => c.ok) && !store.data.done[s.task.id]) {
          store.data.done[s.task.id] = { at: Date.now(), usedSolution: !!s.usedSolution, hints: s.hints };
          store.save();
          this.fillSelect();
          this.setTaskMetaDone();
          if (this.onProgress) this.onProgress();
        }
      }
      if (this.onCommand) this.onCommand(s);
    }
    setTaskMetaDone() { const m = this.q('.task-meta'); if (!m.querySelector('.tag.done')) m.insertAdjacentHTML('beforeend', '<span class="tag done">Resuelta</span>'); }

    // -------------------------------------------------------- editor
    openEditor(ed) {
      this.ed = ed;
      this.edDirty = false;
      this.editorEl.hidden = false;
      this.q('.ed-title').textContent = ed.title;
      const ta = this.q('.ed-text');
      ta.value = ed.content;
      this.q('.ed-cmdline').value = '';
      this.edMsg('');
      this.edGutter();
      this.edInsert();
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
    }
    edGutter() {
      const n = this.q('.ed-text').value.split('\n').length;
      let g = ''; for (let i = 1; i <= n; i++) g += i + '\n';
      this.q('.ed-gutter').textContent = g;
    }
    edInsert() { this.q('.ed-mode').textContent = '-- INSERT --'; this.q('.ed-text').focus(); }
    edMsg(t) {
      let m = this.q('.ed-msg');
      if (!m) { m = document.createElement('span'); m.className = 'ed-msg'; this.q('.ed-foot').appendChild(m); }
      m.textContent = t;
    }
    edKey(e) {
      const ta = e.target;
      if (e.key === 'Escape') { e.preventDefault(); this.q('.ed-mode').textContent = '-- NORMAL --'; const c = this.q('.ed-cmdline'); c.value = ':'; c.focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.edCommand(':wq'); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const st = ta.selectionStart; const en = ta.selectionEnd; const v = ta.value;
        if (e.shiftKey) {
          const ls = v.lastIndexOf('\n', st - 1) + 1;
          if (v.slice(ls, ls + 2) === '  ') { ta.value = v.slice(0, ls) + v.slice(ls + 2); ta.setSelectionRange(Math.max(ls, st - 2), Math.max(ls, en - 2)); }
        } else { ta.value = v.slice(0, st) + '  ' + v.slice(en); ta.setSelectionRange(st + 2, st + 2); }
        this.edDirty = true; this.edGutter();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const st = ta.selectionStart; const v = ta.value;
        const ls = v.lastIndexOf('\n', st - 1) + 1;
        const line = v.slice(ls, st);
        let ind = (line.match(/^\s*/) || [''])[0];
        if (/:\s*$/.test(line)) ind += '  ';
        if (/^\s*- [^:]+:\s*\S/.test(line)) ind = ind + '  ';
        ta.value = v.slice(0, st) + '\n' + ind + v.slice(ta.selectionEnd);
        ta.setSelectionRange(st + 1 + ind.length, st + 1 + ind.length);
        this.edDirty = true; this.edGutter();
      }
    }
    edCommand(c) {
      if (!this.ed) return;
      c = c.replace(/^:/, '').trim();
      if (c === '' || c === 'i' || c === 'a') { this.edInsert(); return; }
      if (c === 'q!' || c === 'cq') { this.finishEditor(null); return; }
      if (c === 'q') { if (this.edDirty) { this.edMsg('E37: No write since last change (add ! to override)'); return; } this.finishEditor(null); return; }
      if (c === 'wq' || c === 'x' || c === 'wq!' || c === 'w' || c === 'w!') {
        const text = this.q('.ed-text').value;
        if (c.startsWith('w') && c.length <= 2 && c !== 'wq') {
          if (this.ed.path) { const r = this.ed.onSave(this.sess().S, text); if (r && r.err) { this.edMsg(r.err); return; } this.edDirty = false; this.edMsg('"' + this.ed.path.split('/').pop() + '" written'); this.q('.ed-cmdline').value = ''; this.edInsert(); return; }
        }
        this.finishEditor(text);
        return;
      }
      if (/^set\b/.test(c)) { this.edMsg(''); this.q('.ed-cmdline').value = ''; this.edInsert(); return; }
      if (/^\d+$/.test(c)) {
        const ta = this.q('.ed-text'); const L = ta.value.split('\n'); const n = Math.min(+c, L.length);
        const pos = L.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);
        ta.focus(); ta.setSelectionRange(pos, pos); this.q('.ed-cmdline').value = ''; this.edInsert(); return;
      }
      this.edMsg('E492: Not an editor command: ' + c);
    }
    finishEditor(text) {
      const s = this.sess();
      const ed = this.ed;
      if (!ed) return;
      const before = s.checks;
      let res = { out: '', err: '' };
      if (text != null) {
        try { res = ed.onSave(s.S, text) || res; } catch (err) { res = { err: 'error: ' + err.message }; }
        if (res.err && ed.path) { this.edMsg(res.err.split('\n')[0]); return; }
      }
      this.closeEditor();
      if (text == null && ed.title.startsWith('kubectl edit')) res = { out: 'Edit cancelled, no changes made.' };
      if (res.out) this.print(s, 'out', res.out);
      if (res.err) this.print(s, 'err', res.err);
      CKA.sim.reconcile(s.S);
      const r = { chunks: [].concat(res.out ? [{ t: 'out', s: res.out }] : [], res.err ? [{ t: 'err', s: res.err }] : []), trace: [], code: res.err ? 1 : 0 };
      this.afterCommand(s, before, r, ed.title);
      this.scroll();
    }
    closeEditor(silent) {
      if (!this.editorEl) return;
      this.editorEl.hidden = true;
      this.ed = null;
      if (!silent) this.focus();
    }
  }

  // ================================================================ ROUTER
  const views = ['plan', 'lab', 'exam', 'quiz', 'cheat'];
  let lab = null;
  function show(view) {
    if (!views.includes(view)) view = 'plan';
    for (const v of views) { $('#view-' + v).hidden = v !== view; $('#tab-' + v).setAttribute('aria-selected', String(v === view)); }
    if (view === 'lab') { ensureLab(); lab.focus(); }
    if (view === 'plan') renderPlan();
    if (view === 'exam') renderExamView();
    if (view === 'quiz' && !quiz.order) quizStart();
    if (view === 'cheat') renderCheat();
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  function ensureLab() {
    if (!lab) {
      lab = new Workspace($('#lab-slot'), 'lab', TASKS.map((t) => t.id));
      lab.onProgress = () => { if (!$('#view-plan').hidden) renderPlan(); };
      lab.setTask(store.data.lastTask || TASKS[0].id);
    }
    return lab;
  }
  function openTask(id) { ensureLab(); show('lab'); lab.setTask(id); }

  // ================================================================ PLAN
  function renderPlan() {
    const P = CKA.plan;
    const today = todayKey();
    let todayIdx = P.days.findIndex((d) => d.date === today);
    if (todayIdx < 0) todayIdx = today < P.days[0].date ? 0 : P.days.length - 1;
    const doneCount = Object.keys(store.data.done).filter((id) => byId(id)).length;
    const remainingMins = P.days.slice(todayIdx).flatMap((d) => d.blocks).filter((b) => !store.data.plan[b.id]).reduce((a, b) => a + b.mins, 0);
    const daysLeft = Math.max(0, Math.ceil((examDeadline() - Date.now()) / 86400000));
    $('#plan-lede').innerHTML = 'Plan de 5 días (unas 18 horas en total) con las 17 preguntas del PDF, ' + (TASKS.length - 17) + ' tareas nuevas alineadas al currículo CKA 2026, killer.sh y un simulacro cronometrado. Marca cada bloque al terminarlo; tu avance se guarda en este navegador.';
    $('#hero-stats').innerHTML =
      '<div class="stat"><b>' + daysLeft + '</b><span>días para el examen</span></div>' +
      '<div class="stat"><b>' + (Math.round(remainingMins / 6) / 10) + ' h</b><span>de estudio pendiente</span></div>' +
      '<div class="stat"><b>' + doneCount + '/' + TASKS.length + '</b><span>tareas resueltas</span></div>';
    $('#exam-time').value = store.data.examTime || '10:00';
    $('#plan-days').innerHTML = P.days.map((d, i) => {
      const blocks = d.blocks.map((b) => {
        const chips = (b.tasks || []).map((id) => { const t = byId(id); return '<button class="chip' + (store.data.done[id] ? ' ok' : '') + '" data-task="' + id + '" title="' + esc(t.title) + '">' + t.n + '. ' + esc(t.title.length > 30 ? t.title.slice(0, 29) + '…' : t.title) + '</button>'; }).join('');
        const viewBtn = b.view ? ' <button class="linkish" data-view="' + b.view + '">Abrir</button>' : '';
        return '<div class="block' + (store.data.plan[b.id] ? ' done' : '') + '"><input type="checkbox" id="blk-' + b.id + '" data-block="' + b.id + '"' + (store.data.plan[b.id] ? ' checked' : '') + '><div><label class="btext" for="blk-' + b.id + '">' + md(b.text) + '</label>' + viewBtn + (chips ? '<div class="chips">' + chips + '</div>' : '') + '</div><span class="mins">' + b.mins + ' min</span></div>';
      }).join('');
      return '<article class="day' + (i === todayIdx ? ' today' : '') + '"><div class="day-head"><h2>' + esc(d.label) + '</h2>' + (i === todayIdx ? '<span class="pill-today">Hoy</span>' : '') + '<span class="theme">' + esc(d.theme) + '</span><span class="hours">' + d.hours + ' h</span></div>' + blocks + '</article>';
    }).join('');
    $$('#plan-days [data-block]').forEach((cb) => cb.addEventListener('change', () => { store.data.plan[cb.dataset.block] = cb.checked; store.save(); renderPlan(); }));
    $$('#plan-days [data-task]').forEach((c) => c.addEventListener('click', () => openTask(c.dataset.task)));
    $$('#plan-days [data-view]').forEach((c) => c.addEventListener('click', () => show(c.dataset.view)));
    $('#domain-bars').innerHTML = Object.keys(DOM).map((d) => {
      const all = TASKS.filter((t) => t.domain === d);
      const done = all.filter((t) => store.data.done[t.id]).length;
      const pct = Math.round((done / all.length) * 100);
      return '<div class="dbar"><div class="dbar-top"><span>' + esc(DOM[d].name) + ' <span class="muted">· ' + DOM[d].pct + '% del examen</span></span><b>' + done + '/' + all.length + '</b></div><div class="track"><div class="fill" style="width:' + pct + '%;background:var(--d-' + d + ')"></div></div></div>';
    }).join('');
    $('#strategy').innerHTML = P.strategy.map((s) => '<li>' + md(s) + '</li>').join('');
    const ex = store.data.exams || [];
    $('#exam-history').innerHTML = ex.length ? '<table><thead><tr><th>Fecha</th><th>Resultado</th></tr></thead><tbody>' + ex.slice(-6).reverse().map((e) => '<tr><td>' + esc(new Date(e.at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })) + '</td><td class="num">' + e.score + '% ' + (e.score >= 66 ? '✓' : '✗') + '</td></tr>').join('') + '</tbody></table>' : '<p class="muted">Aún no has hecho un simulacro. Hazlo el viernes: 17 tareas en 2 horas.</p>';
  }
  $('#exam-time').addEventListener('change', (e) => { store.data.examTime = e.target.value || '10:00'; store.save(); renderCountdown(); renderPlan(); });
  $('#go-today').addEventListener('click', () => {
    const P = CKA.plan; const today = todayKey();
    let d = P.days.find((x) => x.date === today) || (today < P.days[0].date ? P.days[0] : P.days[P.days.length - 1]);
    const blk = d.blocks.find((b) => !store.data.plan[b.id]) || d.blocks[0];
    if (blk.tasks) { const id = blk.tasks.find((x) => !store.data.done[x]) || blk.tasks[0]; openTask(id); }
    else if (blk.view) show(blk.view);
    else show('lab');
  });

  // ================================================================ SIMULACRO
  const exam = { active: null };
  const EXAM_MIX = { trbl: 5, arch: 4, net: 3, work: 3, stor: 2 };
  function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

  function renderExamView() {
    const startEl = $('#exam-start');
    if (exam.active && !exam.active.finished) { startEl.hidden = true; $('#exam-bar').hidden = false; $('#exam-results').hidden = true; $('#exam-slot').hidden = false; renderExamBar(); exam.active.ws.focus(); return; }
    if (exam.active && exam.active.finished) { startEl.hidden = true; $('#exam-bar').hidden = true; $('#exam-slot').hidden = true; $('#exam-results').hidden = false; return; }
    $('#exam-bar').hidden = true; $('#exam-results').hidden = true; $('#exam-slot').hidden = true; startEl.hidden = false;
    startEl.innerHTML = '<p class="eyebrow">Simulacro cronometrado</p><h1>Examen de práctica CKA</h1>' +
      '<p class="lede">17 tareas al azar con la misma proporción de dominios del examen real. Cada tarea tiene su propio clúster y su propio host de ssh. Sin pistas ni coach: los requisitos se califican al terminar, con crédito parcial por tarea.</p>' +
      '<div class="exam-rules"><div><b>2:00 h</b>Duración, igual que el examen.</div><div><b>66 %</b>Puntaje mínimo para aprobar.</div><div><b>17 tareas</b>5 troubleshooting · 4 arquitectura · 3 redes · 3 workloads · 2 almacenamiento.</div><div><b>ssh por tarea</b>Conéctate al host indicado y vuelve con exit.</div></div>' +
      '<button class="btn primary" id="exam-go">Comenzar simulacro</button>' +
      '<div class="panel"><h2>Consejos</h2><ul class="strategy">' + CKA.plan.strategy.map((s) => '<li>' + md(s) + '</li>').join('') + '</ul></div>';
    $('#exam-go').addEventListener('click', startExam);
  }

  function startExam() {
    let ids = [];
    for (const d of Object.keys(EXAM_MIX)) ids = ids.concat(shuffle(TASKS.filter((t) => t.domain === d).map((t) => t.id)).slice(0, EXAM_MIX[d]));
    ids = shuffle(ids);
    const ws = new Workspace($('#exam-slot'), 'exam', ids);
    ws.flags = new Set();
    exam.active = { ids, ws, start: Date.now(), dur: 120 * 60000, finished: false };
    ws.onNavigate = () => renderExamBar();
    ws.onCommand = () => renderExamBar();
    ws.setTask(ids[0]);
    exam.timer = setInterval(tickExam, 1000);
    renderExamView();
    tickExam();
  }
  function renderExamBar() {
    const a = exam.active; if (!a) return;
    $('#exam-q').innerHTML = a.ids.map((id, i) => '<button class="qbtn' + (a.ws.current === id ? ' cur' : '') + (a.ws.flags.has(id) ? ' flag' : '') + (a.ws.sessions[id] && a.ws.sessions[id].hist.length ? ' touched' : '') + '" data-q="' + id + '" title="' + esc(byId(id).title) + '">' + (i + 1) + '</button>').join('');
    $$('#exam-q [data-q]').forEach((b) => b.addEventListener('click', () => { a.ws.setTask(b.dataset.q); renderExamBar(); }));
  }
  function tickExam() {
    const a = exam.active; if (!a || a.finished) return;
    const left = Math.max(0, a.dur - (Date.now() - a.start));
    const m = Math.floor(left / 60000); const s = Math.floor((left % 60000) / 1000);
    const el = $('#exam-timer');
    el.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    el.classList.toggle('low', left < 15 * 60000);
    if (left <= 0) finishExam();
  }
  let finishArmed = false;
  $('#exam-finish').addEventListener('click', () => {
    if (!finishArmed) { finishArmed = true; $('#exam-finish').textContent = '¿Terminar? Clic otra vez'; setTimeout(() => { finishArmed = false; $('#exam-finish').textContent = 'Terminar examen'; }, 4000); return; }
    finishArmed = false; $('#exam-finish').textContent = 'Terminar examen';
    finishExam();
  });
  function finishExam() {
    const a = exam.active; if (!a || a.finished) return;
    a.finished = true;
    clearInterval(exam.timer);
    let tot = 0; let got = 0; const dom = {};
    const rows = a.ids.map((id, i) => {
      const t = byId(id);
      const S = a.ws.sessions[id] ? a.ws.sessions[id].S : CKA.tasks.build(t);
      const res = CKA.tasks.evaluate(t, S);
      const frac = res.filter((c) => c.ok).length / res.length;
      tot += t.weight; got += t.weight * frac;
      dom[t.domain] = dom[t.domain] || { tot: 0, got: 0 }; dom[t.domain].tot += t.weight; dom[t.domain].got += t.weight * frac;
      return { i, t, res, frac };
    });
    const score = Math.round((got / tot) * 100);
    store.data.exams = (store.data.exams || []).concat([{ at: Date.now(), score, domains: Object.fromEntries(Object.keys(dom).map((d) => [d, Math.round((dom[d].got / dom[d].tot) * 100)])) }]);
    store.save();
    const el = $('#exam-results');
    el.innerHTML = '<p class="eyebrow">Resultado del simulacro</p><div class="score-hero"><span class="score-num">' + score + '%</span><span class="verdict ' + (score >= 66 ? 'pass' : 'fail') + '">' + (score >= 66 ? 'Aprobado' : 'No aprobado') + '</span><span class="muted">Mínimo para aprobar: 66 %. Tiempo usado: ' + Math.round((Date.now() - a.start) / 60000) + ' min.</span></div>' +
      '<div class="panel"><h2>Por dominio</h2>' + Object.keys(dom).map((d) => { const p = Math.round((dom[d].got / dom[d].tot) * 100); return '<div class="dbar"><div class="dbar-top"><span>' + esc(DOM[d].name) + '</span><b>' + p + '%</b></div><div class="track"><div class="fill" style="width:' + p + '%;background:var(--d-' + d + ')"></div></div></div>'; }).join('') + '</div>' +
      '<h2 style="margin:1.2rem 0 .6rem">Detalle por pregunta</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Tarea</th><th>Peso</th><th>Obtenido</th><th></th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td class="num">' + (r.i + 1) + '</td><td><strong>' + esc(r.t.title) + '</strong><div class="small muted">' + esc(DOM[r.t.domain].name) + '</div>' + (r.frac < 1 ? '<ul class="fails">' + r.res.filter((c) => !c.ok).map((c) => '<li>' + md(c.t) + '</li>').join('') + '</ul>' : '') + '</td><td class="num">' + r.t.weight + '%</td><td class="num">' + Math.round(r.frac * 100) + '%</td><td><button class="mini" data-open="' + r.t.id + '">Practicar</button></td></tr>').join('') +
      '</tbody></table></div><div style="margin-top:1.2rem;display:flex;gap:.6rem;flex-wrap:wrap"><button class="btn primary" id="exam-new">Nuevo simulacro</button><button class="btn" id="exam-plan">Volver al plan</button></div>';
    $$('#exam-results [data-open]').forEach((b) => b.addEventListener('click', () => openTask(b.dataset.open)));
    $('#exam-new').addEventListener('click', () => { exam.active = null; renderExamView(); });
    $('#exam-plan').addEventListener('click', () => { exam.active = null; show('plan'); });
    renderExamView();
  }

  // ================================================================ QUIZ
  const quiz = { order: null, idx: 0, score: 0, answered: false };
  function quizStart() {
    const d = $('#quiz-domain').value;
    quiz.order = shuffle(CKA.quiz.list.filter((q) => d === 'all' || q.d === d));
    quiz.idx = 0; quiz.score = 0; quiz.answered = false;
    renderQuiz();
  }
  function renderQuiz() {
    const card = $('#quiz-card');
    if (quiz.idx >= quiz.order.length) {
      const d = $('#quiz-domain').value;
      const pct = Math.round((quiz.score / Math.max(1, quiz.order.length)) * 100);
      store.data.quizBest[d] = Math.max(store.data.quizBest[d] || 0, pct); store.save();
      card.innerHTML = '<p class="quiz-q">Resultado: ' + quiz.score + ' de ' + quiz.order.length + ' (' + pct + '%)</p><p class="muted">Mejor resultado en esta categoría: ' + store.data.quizBest[d] + '%. Repasa en el laboratorio los temas que fallaste.</p><div class="quiz-foot"><button class="btn primary" id="quiz-again">Otra ronda</button></div>';
      $('#quiz-again').addEventListener('click', quizStart);
      return;
    }
    const q = quiz.order[quiz.idx];
    card.innerHTML = '<div class="quiz-progress"><span>Pregunta ' + (quiz.idx + 1) + ' / ' + quiz.order.length + ' · ' + esc(q.d === 'exam' ? 'Formato del examen' : DOM[q.d].name) + '</span><span>Aciertos: ' + quiz.score + '</span></div><p class="quiz-q">' + md(q.q) + '</p><div class="opts">' + q.o.map((o, i) => '<button class="opt" data-i="' + i + '">' + md(o) + '</button>').join('') + '</div><div class="quiz-exp" hidden></div><div class="quiz-foot"><button class="btn primary" id="quiz-next" hidden>Siguiente</button></div>';
    $$('#quiz-card .opt').forEach((b) => b.addEventListener('click', () => {
      if (quiz.answered) return;
      quiz.answered = true;
      const i = +b.dataset.i;
      $$('#quiz-card .opt').forEach((x) => { x.disabled = true; if (+x.dataset.i === q.a) x.classList.add('right'); });
      if (i === q.a) quiz.score++; else b.classList.add('wrong');
      const exp = $('#quiz-card .quiz-exp');
      exp.hidden = false;
      exp.innerHTML = '<strong>' + (i === q.a ? 'Correcto.' : 'Incorrecto.') + '</strong> ' + md(q.e || '');
      const n = $('#quiz-next'); n.hidden = false; n.focus();
    }));
    $('#quiz-next').addEventListener('click', () => { quiz.idx++; quiz.answered = false; renderQuiz(); });
  }
  $('#quiz-domain').addEventListener('change', quizStart);
  $('#quiz-restart').addEventListener('click', quizStart);

  // ================================================================ CHULETA
  const CHEAT = [
    { t: 'Primeros 60 segundos en cada host', p: 'kubectl ya trae autocompletado en el examen. Ajusta tu shell y vim una vez por host si lo necesitas.', c: ['alias k=kubectl\nexport do="--dry-run=client -o yaml"\nexport now="--force --grace-period 0"\nsource <(kubectl completion bash)\ncomplete -o default -F __start_kubectl k', 'cat <<EOF >> ~/.vimrc\nset expandtab tabstop=2 shiftwidth=2 autoindent number\nEOF'] },
    { t: 'Flujo de cada pregunta', p: 'Conéctate al host indicado, eleva privilegios solo cuando haga falta y regresa al terminar.', c: ['ssh cka1234          # host de la pregunta\nsudo -i              # solo para systemctl, apt, etcd, /etc/kubernetes\nexit                 # sale de root\nexit                 # vuelve a candidate@base'] },
    { t: 'Generar YAML en segundos', p: 'Crea el esqueleto con kubectl y edítalo en lugar de escribirlo desde cero.', c: ['k run web --image=nginx:1.29 --port=80 $do > pod.yaml\nk create deploy web --image=nginx:1.29 --replicas=3 $do > deploy.yaml\nk expose deploy web --port=80 --target-port=8080 --type=NodePort $do\nk create cm app --from-literal=LOG=info $do\nk create secret generic db --from-literal=pass=S3cr3t $do\nk create job once --image=busybox $do -- sh -c "echo hi"\nk create cronjob c --image=busybox --schedule="*/5 * * * *" $do -- date\nk create ingress web --rule="host.com/api*=api:8080" --class=nginx $do\nk create role r --verb=get,list --resource=pods -n dev $do\nk create rolebinding rb --role=r --serviceaccount=dev:sa -n dev $do\nk create priorityclass high --value=1000 $do\nk create quota q --hard=pods=5 -n dev $do\nk autoscale deploy web --cpu-percent=50 --min=1 --max=4 $do'] },
    { t: 'RBAC', p: 'El alcance lo decide el binding: RoleBinding = un namespace; ClusterRoleBinding = todo el clúster.', c: ['k create clusterrole deploy-creator --verb=create --resource=deployments,statefulsets,daemonsets\nk create rolebinding x --clusterrole=deploy-creator --serviceaccount=ns1:sa1 -n ns1\nk auth can-i create deployments -n ns1 --as=system:serviceaccount:ns1:sa1\nk certificate approve jane'] },
    { t: 'etcd: respaldo y restauración', p: 'Todo como root en el plano de control. Toma rutas de certificados de /etc/kubernetes/manifests/etcd.yaml.', c: ['ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \\\n  --cacert=/etc/kubernetes/pki/etcd/ca.crt \\\n  --cert=/etc/kubernetes/pki/etcd/server.crt \\\n  --key=/etc/kubernetes/pki/etcd/server.key \\\n  snapshot save /opt/backup.db', 'etcdutl snapshot restore /opt/backup.db --data-dir /var/lib/etcd-restore\n# en /etc/kubernetes/manifests/etcd.yaml cambia el hostPath del volumen etcd-data:\n#   path: /var/lib/etcd  →  path: /var/lib/etcd-restore\nwatch crictl ps   # espera a que vuelvan etcd y kube-apiserver'] },
    { t: 'Upgrade con kubeadm', p: 'Plano de control: apply. Workers: node. Siempre kubeadm primero, kubelet al final.', c: ['k drain <nodo> --ignore-daemonsets\napt-mark unhold kubeadm && apt-get update && apt-get install -y kubeadm=1.35.2-1.1 && apt-mark hold kubeadm\nkubeadm upgrade plan\nkubeadm upgrade apply v1.35.2      # worker: kubeadm upgrade node\napt-mark unhold kubelet kubectl && apt-get install -y kubelet=1.35.2-1.1 kubectl=1.35.2-1.1 && apt-mark hold kubelet kubectl\nsystemctl daemon-reload && systemctl restart kubelet\nk uncordon <nodo>'] },
    { t: 'Troubleshooting: nodos y plano de control', p: 'Ve de afuera hacia adentro: estado del nodo → kubelet → runtime → manifiestos estáticos.', c: ['k get nodes; k describe node <n> | grep -A8 Conditions\nssh <n>; sudo systemctl status kubelet; sudo journalctl -u kubelet -n 30\nsudo systemctl status containerd\ncat /var/lib/kubelet/config.yaml; ls /usr/lib/systemd/system/kubelet.service.d/\nsudo systemctl daemon-reload && sudo systemctl enable --now kubelet', '# API server caído (kubectl no responde)\nsudo crictl ps -a | grep -E "apiserver|etcd|scheduler|controller"\nsudo crictl logs <id>\nls /var/log/pods/kube-system_*\nsudo vim /etc/kubernetes/manifests/kube-apiserver.yaml'] },
    { t: 'Troubleshooting: aplicaciones y red', p: 'Events, logs y endpoints resuelven la mayoría de los casos.', c: ['k get pods -A | grep -v Running\nk describe pod <p> | tail -20          # Events\nk logs <p> [-c cont] [--previous]\nk get endpoints <svc>; k get pods --show-labels\nk run tmp --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- -T2 http://svc.ns\nk run tmp --rm -it --image=busybox:1.36 --restart=Never -- nslookup svc.ns\nk get events -A --sort-by=.metadata.creationTimestamp | tail'] },
    { t: 'Salidas útiles', p: 'jsonpath, custom-columns y sort-by para escribir respuestas en archivos.', c: ["k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{\"\\t\"}{.spec.taints[*].effect}{\"\\n\"}{end}'\nk get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName\nk get pods -A --sort-by=.metadata.creationTimestamp\nk top pods -A --sort-by=cpu; k top nodes --sort-by=memory\nk get crd | grep cert-manager > ~/resources.yaml\nk explain certificate.spec.subject"] },
    { t: 'Helm y Kustomize', p: 'La documentación de helm.sh está permitida.', c: ['helm repo add argocd https://argoproj.github.io/argo-helm && helm repo update\nhelm search repo argocd --versions | head\nhelm show values argocd/argo-cd --version 7.7.3 | less\nhelm template argocd argocd/argo-cd --version 7.7.3 -n argocd --set crds.install=false > argo.yaml\nhelm install argocd argocd/argo-cd --version 7.7.3 -n argocd --create-namespace --set crds.install=false\nhelm upgrade web bitnami/nginx -n web --version 21.1.3 --set replicaCount=3\nhelm list -A; helm uninstall web -n web', 'k kustomize overlays/prod     # ver\nk apply -k overlays/prod      # aplicar'] },
    { t: 'Pods inmutables y cambios rápidos', p: 'Casi nada del spec de un Pod se puede editar en caliente.', c: ['k get pod p -o yaml > p.yaml   # editar\nk replace --force -f p.yaml\n# si kubectl edit falla, reutiliza la copia:\nk replace --force -f /tmp/kubectl-edit-XXXX.yaml\nk delete pod p $now'] },
    { t: 'vim en el examen', p: 'Lo mínimo para editar YAML sin sufrir.', c: ['i          insertar            Esc    salir de inserción\n:wq        guardar y salir     :q!    salir sin guardar\ndd / yy    borrar / copiar línea   p   pegar\nu          deshacer           /txt   buscar\n:set paste antes de pegar YAML (evita la sangría en cascada)\nV + > / <  indentar bloque seleccionado'] },
  ];
  const DOCS = [
    ['kubectl Quick Reference', 'https://kubernetes.io/docs/reference/kubectl/quick-reference/'],
    ['Upgrading kubeadm clusters', 'https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/'],
    ['Operating etcd clusters (backup/restore)', 'https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/'],
    ['Network Policies', 'https://kubernetes.io/docs/concepts/services-networking/network-policies/'],
    ['Gateway API (conceptos)', 'https://kubernetes.io/docs/concepts/services-networking/gateway/'],
    ['Gateway API: HTTPS/TLS', 'https://gateway-api.sigs.k8s.io/guides/tls/'],
    ['Ingress', 'https://kubernetes.io/docs/concepts/services-networking/ingress/'],
    ['Persistent Volumes', 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/'],
    ['Assign Pods to Nodes (affinity)', 'https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/'],
    ['HPA walkthrough', 'https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/'],
    ['Sidecar containers', 'https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/'],
    ['Debug clusters / nodes', 'https://kubernetes.io/docs/tasks/debug/debug-cluster/'],
    ['Helm commands', 'https://helm.sh/docs/helm/'],
    ['Candidate Handbook (Linux Foundation)', 'https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2'],
  ];
  let cheatDone = false;
  function renderCheat() {
    if (cheatDone) return;
    cheatDone = true;
    $('#cheat').innerHTML = '<p class="eyebrow">Referencia rápida</p><h1>Chuleta CKA</h1><p class="lede">Comandos que resuelven la mayoría de las tareas. Pruébalos en el laboratorio hasta escribirlos sin pensar.</p><div class="cheat-grid">' +
      CHEAT.map((c, i) => '<section class="cheat-card"><h2>' + esc(c.t) + '</h2><p>' + md(c.p) + '</p>' + c.c.map((code, j) => '<div class="codeblock"><pre>' + esc(code) + '</pre><button class="mini" data-copy="' + i + ':' + j + '">Copiar</button></div>').join('') + '</section>').join('') +
      '<section class="cheat-card"><h2>Páginas de documentación para tener a mano</h2><p>Úsalas desde el navegador permitido del examen. Confirma la lista vigente en el handbook.</p><div class="doclinks">' + DOCS.map((d) => '<a href="' + d[1] + '" target="_blank" rel="noopener">' + esc(d[0]) + '</a>').join('') + '</div></section></div>';
    $$('#cheat [data-copy]').forEach((b) => b.addEventListener('click', () => { const [i, j] = b.dataset.copy.split(':').map(Number); copyText(CHEAT[i].c[j], b); }));
  }

  // ================================================================ inicio
  show((location.hash || '#plan').slice(1));
})(window.CKA);
