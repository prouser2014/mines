/** file-storage.js — автосохранение узлов/мин в JSON-базу.
 * Порядок приоритета режимов:
 *  1) capacitor — @capacitor/filesystem → DATA/Loctar/data.json (без диалогов).
 *  2) server    — REST /db (если доступен).
 *  3) handle    — File System Access API по выбранному файлу.
 *  4) bundled   — стартовая подгрузка ./data.json (чтение до выбора/Capacitor/сервера).
 *
 * UI (в стиле карточек-чекбоксов):
 *  ─ «Выбрать файл сохранения»
 *  ─ «Сохранить сейчас»
 *  ─ [ ] «Автоматическое сохранение данных»  ← заменяет «Отключить»
 *    + ниже строки: «Файл базы данных: …», «Дата обновления: …»
 */
(() => {
  'use strict';

  // ===== Ключи локального кэша (как в приложении)
  const LS_KEY_NODES = window.LS_KEY_NODES || 'RFNodes.v1.nodes';
  const LS_KEY_MINES = window.LS_KEY_MINES || 'RFMines.v1.mines';

  // ===== Состояние
  const state = {
    mode: 'bundled',    // 'capacitor' | 'server' | 'handle' | 'bundled'
    handle: null,       // FileSystemFileHandle
    lastSaveAt: null,   // ts
    auto: true
  };

  // ===== helpers
  const pref = {
    get(key, defVal) {
      try {
        if (typeof window.ssGet === 'function') return window.ssGet(key, defVal);
        const v = sessionStorage.getItem(key); return v === null ? defVal : v;
      } catch { return defVal; }
    },
    set(key, val) {
      try {
        if (typeof window.ssSet === 'function') window.ssSet(key, val);
        else sessionStorage.setItem(key, val);
      } catch {}
    }
  };
  state.auto = pref.get('FS_AUTO_ENABLED', '1') !== '0';

  // ===== UI
  const ui = {
    rowChoose: null,
    rowSave: null,
    rowAuto: null,
    chkAuto: null,
    fileNameEl: null,
    updatedAtEl: null,
    statusEl: null
  };
  const fmt = (t) => t ? new Date(t).toLocaleString('ru-RU') : '—';
  const setMeta = (name, ts) => { if (ui.fileNameEl) ui.fileNameEl.textContent = name; if (ui.updatedAtEl) ui.updatedAtEl.textContent = fmt(ts); };
  const setRowDisabled = (el, on) => { if (!el) return; el.style.opacity = on ? .5 : 1; el.style.pointerEvents = on ? 'none' : 'auto'; };

  const toneClasses = ['muted', 'active', 'success', 'error'];
  function setStatus(text, tone = 'muted', sticky = false) {
    if (!ui.statusEl) return;
    toneClasses.forEach((c) => ui.statusEl.classList.remove(`is-${c}`));
    ui.statusEl.classList.add(`is-${tone}`);
    ui.statusEl.textContent = text;
    ui.statusEl.dataset.sticky = sticky ? '1' : '0';
    if (setStatus._timer) { clearTimeout(setStatus._timer); setStatus._timer = null; }
    if (sticky) {
      setStatus._timer = setTimeout(() => {
        if (!ui.statusEl) return;
        ui.statusEl.dataset.sticky = '0';
        refreshStatus();
      }, 5000);
    }
  }

  function refreshStatus() {
    if (!ui.statusEl || ui.statusEl.dataset.sticky === '1') return;
    let text = 'Выберите файл или подключите устройство, чтобы включить сохранение и горячие клавиши Ctrl+S / ⌘+S.';
    let tone = 'muted';

    if (state.mode === 'capacitor') {
      text = state.auto
        ? 'Capacitor: автосохранение активно. Для принудительного сохранения нажмите «Сохранить сейчас» или Ctrl+S / ⌘+S.'
        : 'Capacitor: нажмите «Сохранить сейчас» или используйте Ctrl+S / ⌘+S для записи в файл.';
      tone = 'success';
    } else if (state.mode === 'server') {
      text = state.auto
        ? 'Сервер: изменения будут отправляться автоматически. Для ручной записи используйте «Сохранить сейчас» или Ctrl+S / ⌘+S.'
        : 'Сервер: автосохранение выключено. Нажмите «Сохранить сейчас» или Ctrl+S / ⌘+S, когда потребуется выгрузить данные.';
      tone = 'success';
    } else if (state.mode === 'handle') {
      if (state.handle) {
        const name = state.handle.name || 'файл';
        text = state.auto
          ? `Файл «${name}»: автосохранение включено. При необходимости нажмите «Сохранить сейчас» или Ctrl+S / ⌘+S.`
          : `Файл «${name}»: выбрано ручное сохранение. Используйте «Сохранить сейчас» или Ctrl+S / ⌘+S.`;
        tone = 'success';
      } else {
        text = 'Выберите файл, чтобы записывать изменения.';
        tone = 'muted';
      }
    }

    setStatus(text, tone);
  }

  function mkRowButton({ id, icon, text }) {
    const row = document.createElement('div');
    row.className = 'card-row pseudo-btn';
    row.id = id;
    row.tabIndex = 0;
    row.role = 'button';
    row.innerHTML = `<img class="icon" src="${icon}" alt=""><span>${text}</span>`;
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
    return row;
  }
  function mkRowAuto() {
    const row = document.createElement('label');
    row.className = 'card-row';
    row.id = 'fsAutoRow';
    row.innerHTML = `
      <input id="fsAutoChk" type="checkbox">
      <span>Автоматическое сохранение данных</span>
    `;
    return row;
  }

  // ==========================
  //    CAPACITOR MODE
  // ==========================
  function isCapacitorNative() {
    const C = window.Capacitor;
    if (!C) return false;
    if (typeof C.isNativePlatform === 'function') return !!C.isNativePlatform();
    const p = String(C?.getPlatform?.() || '').toLowerCase();
    return p === 'ios' || p === 'android';
  }
  function capFS() { try { return window.Capacitor?.Plugins?.Filesystem || window.Capacitor?.Filesystem || window.Filesystem; } catch { return null; } }
  const CAP_DIR = 'DATA';
  const CAP_PATH = 'Loctar/data.json';

  async function tryCapacitor() {
    if (!isCapacitorNative()) return false;
    const FS = capFS();
    if (!FS) return false;

    try {
      // читаем/инициализируем файл
      try {
        const r = await FS.readFile({ path: CAP_PATH, directory: CAP_DIR, encoding: 'utf8' });
        const db = JSON.parse(r.data || r || '{}');
        if (!hasLocalData()) seedLocal(db);
        state.mode = 'capacitor';
        try { const st = await FS.stat({ path: CAP_PATH, directory: CAP_DIR }); state.lastSaveAt = st?.mtime || st?.mtimeMs || Date.now(); } catch { state.lastSaveAt = Date.now(); }
        setMeta('Capacitor DATA/Loctar/data.json', state.lastSaveAt);
        refreshWriteAvailability();
        return true;
      } catch {
        const init = { version: 1, savedAt: new Date().toISOString(), nodes: [], mines: [] };
        try {
          await FS.writeFile({ path: CAP_PATH, data: JSON.stringify(init, null, 2), directory: CAP_DIR, encoding: 'utf8', recursive: true });
          state.lastSaveAt = Date.now();
          if (!hasLocalData()) seedLocal(init);
          state.mode = 'capacitor';
          setRowDisabled(ui.rowChoose, true);
          setMeta('Capacitor DATA/Loctar/data.json', state.lastSaveAt);
          refreshWriteAvailability();
          return true;
        } catch (e) {
          console.warn('[capacitor] init write failed', e);
          return false;
        }
      }
    } catch { return false; }
  }
  async function capWrite(FS, payload) {
    await FS.writeFile({ path: CAP_PATH, data: JSON.stringify(payload, null, 2), directory: CAP_DIR, encoding: 'utf8', recursive: true });
    try { const st = await FS.stat({ path: CAP_PATH, directory: CAP_DIR }); state.lastSaveAt = st?.mtime || st?.mtimeMs || Date.now(); } catch { state.lastSaveAt = Date.now(); }
    setMeta('Capacitor DATA/Loctar/data.json', state.lastSaveAt);
  }

  // ==========================
  //    SERVER MODE (optional)
  // ==========================
  async function serverAvailable() {
    try { const r = await fetch('/db', { method: 'HEAD' }); return r.ok; } catch { return false; }
  }
  async function serverWrite(payload) {
    const r = await fetch('/db', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('server write failed');
    const ts = Date.now(); state.lastSaveAt = ts; setMeta('data.json (сервер)', ts);
  }

  // ==========================
  //    HANDLE MODE (browser)
  // ==========================
  async function chooseFile() {
    if (state.mode === 'capacitor' || state.mode === 'server') return;
    if (!window.showOpenFilePicker && !window.showSaveFilePicker) { alert('Ваш браузер не поддерживает прямую запись в файл. Используйте Capacitor или сервер.'); return; }
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }], excludeAcceptAllOption: false, multiple: false });
      state.handle = h;
      const f = await h.getFile();
      const text = await f.text();
      const db = JSON.parse(text || '{}');
      if (!hasLocalData()) seedLocal(db);
      state.mode = 'handle';
      state.lastSaveAt = f.lastModified || Date.now();
      setRowDisabled(ui.rowChoose, false);
      setMeta(h.name || 'файл', state.lastSaveAt);
      refreshWriteAvailability();
    } catch (e) { console.warn('[handle choose]', e); }
  }
  async function ensureHandlePerm() {
    if (!state.handle) return false;
    const q = await state.handle.queryPermission?.({ mode: 'readwrite' }) || 'prompt';
    if (q === 'granted') return true;
    const r = await state.handle.requestPermission?.({ mode: 'readwrite' });
    return r === 'granted';
  }

  // ==========================
  //    BUNDLED MODE (./data.json)
  // ==========================
  async function tryBundled() {
    try {
      const r = await fetch('./data.json', { cache: 'no-store' });
      if (!r.ok) return false;
      const db = await r.json();
      if (!hasLocalData()) seedLocal(db);
      state.mode = 'bundled';
      state.lastSaveAt = Date.parse(db.savedAt || db.exportedAt || '') || Date.now();
      setMeta('data.json', state.lastSaveAt);
      refreshWriteAvailability();
      return true;
    } catch { return false; }
  }

  // ==========================
  //    Работа с кэшем и снапшотом
  // ==========================
  function hasLocalData() {
    try { return !!localStorage.getItem(LS_KEY_NODES) || !!localStorage.getItem(LS_KEY_MINES); } catch { return false; }
  }
  function seedLocal(db) {
    try { localStorage.setItem(LS_KEY_NODES, JSON.stringify({ nodes: Array.isArray(db.nodes) ? db.nodes : [] })); } catch {}
    try { localStorage.setItem(LS_KEY_MINES, JSON.stringify({ mines: Array.isArray(db.mines) ? db.mines : [] })); } catch {}
    try { if (db && db.security && typeof window.applySecurityFromSnapshot === 'function') window.applySecurityFromSnapshot(db.security); } catch {}
    try { if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('fs:dbLoaded', { detail: { db } })); } catch {}
  }
  function buildSnapshot() {
    const nodes = Array.isArray(window.nodesManager?.nodes)
      ? window.nodesManager.nodes.map(n => (typeof window.nodesManager._serializeNode === 'function' ? window.nodesManager._serializeNode(n) : n))
      : [];
    const mines = Array.isArray(window.minesManager?.mines)
      ? window.minesManager.mines.map(m => (typeof window.minesManager._serializeMine === 'function' ? window.minesManager._serializeMine(m) : m))
      : [];
    return { version: 1, savedAt: new Date().toISOString(), nodes, mines, security: (typeof window.getSecuritySnapshot==='function' ? window.getSecuritySnapshot() : undefined) };
  }

  // ==========================
  //    Запись снапшота
  // ==========================
  async function writeNow() {
    if (state.mode === 'bundled') {
      setStatus('Сохранение недоступно: выберите файл или подключите устройство.', 'error', true);
      return;
    }

    setStatus('Сохраняю данные…', 'active', true);
    const payload = buildSnapshot();

    try {
      if (state.mode === 'capacitor') {
        const FS = capFS();
        if (!FS) throw new Error('Filesystem плагин недоступен.');
        await capWrite(FS, payload);
        setStatus('Данные сохранены в файловой системе устройства.', 'success', true);
        return;
      }

      if (state.mode === 'server') {
        await serverWrite(payload);
        setStatus('Данные отправлены на сервер.', 'success', true);
        return;
      }

      if (state.mode === 'handle' && state.handle) {
        if (!(await ensureHandlePerm())) throw new Error('Нет доступа к выбранному файлу.');
        const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
        const w = await state.handle.createWritable();
        await w.truncate(0); await w.write(blob); await w.close();
        state.lastSaveAt = Date.now();
        setMeta(state.handle.name || 'файл', state.lastSaveAt);
        setStatus(`Данные сохранены в «${state.handle.name || 'файл'}».`, 'success', true);
        return;
      }

      throw new Error('Не выбран источник для сохранения.');
    } catch (e) {
      console.warn('[writeNow]', e);
      const msg = e && typeof e.message === 'string' && e.message ? e.message : 'Неизвестная ошибка.';
      setStatus(`Ошибка сохранения: ${msg}`, 'error', true);
    }
  }

  // ==========================
  //    Инициализация UI
  // ==========================
  function refreshWriteAvailability() {
    const writeable = state.mode === 'capacitor' || state.mode === 'server' || (state.mode === 'handle' && state.handle);
    setRowDisabled(ui.rowSave, !writeable);
    refreshStatus();
  }

  async function boot() {
    // Встраивание UI в «Сохранение данных»
    const host = document.getElementById('dataPaneHost');
    if (host) {
      const wrap = document.createElement('div');
      wrap.id = 'fileSaveBlock';
      wrap.classList.add('v-stack', 'gap-md');

      const intro = document.createElement('div');
      intro.classList.add('fs-intro', 'v-stack', 'gap-xs');
      intro.innerHTML = `
        <p class="fs-instructions"><strong>Чтобы сохранить данные</strong>, выполните шаги ниже:</p>
        <ol class="fs-steps">
          <li>Выберите устройство или файл, куда будет записываться база.</li>
          <li>При включённом авто режим данные записываются сами после изменений.</li>
          <li>Для ручной записи нажмите «Сохранить сейчас» или сочетание клавиш <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd> на macOS).</li>
        </ol>
      `;

      ui.rowChoose  = mkRowButton({ id: 'fsChoose', icon: 'icons/save.svg', text: 'Выбрать файл сохранения' });
      ui.rowSave    = mkRowButton({ id: 'fsSave',   icon: 'icons/dwl.svg',  text: 'Сохранить сейчас' });
      ui.rowAuto    = mkRowAuto();

      const meta = document.createElement('div');
      meta.classList.add('v-stack', 'gap-xs', 'mt-xs', 'lh-snug');
      meta.innerHTML = `
        <div><span class="text-muted">Файл базы данных:</span> <span id="fsFileName">—</span></div>
        <div><span class="text-muted">Дата обновления:</span> <span id="fsUpdatedAt">—</span></div>
      `;

      const status = document.createElement('p');
      status.classList.add('fs-status', 'is-muted');
      status.id = 'fsStatus';

      wrap.append(intro, ui.rowChoose, ui.rowSave, ui.rowAuto, meta, status);
      host.appendChild(wrap);

      ui.fileNameEl  = meta.querySelector('#fsFileName');
      ui.updatedAtEl = meta.querySelector('#fsUpdatedAt');
      ui.chkAuto     = ui.rowAuto.querySelector('#fsAutoChk');
      ui.chkAuto.checked = !!state.auto;
      ui.statusEl    = status;
      refreshStatus();

      // события
      ui.rowChoose.addEventListener('click', chooseFile);
      ui.rowSave.addEventListener('click', writeNow);
      ui.rowAuto.addEventListener('change', (e) => {
        state.auto = !!ui.chkAuto.checked;
        pref.set('FS_AUTO_ENABLED', state.auto ? '1' : '0');
        refreshStatus();
      });
    }

    // Определяем доступный режим
    if (!(await tryCapacitor())) {
      if (await serverAvailable()) state.mode = 'server';
      else await tryBundled();
    }
    refreshWriteAvailability();
    refreshStatus();

    if (!window._fsHotkeyBound) {
      window.addEventListener('keydown', (e) => {
        if (!e || e.defaultPrevented) return;
        const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
        if (key === 's' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          writeNow();
        }
      }, true);
      window._fsHotkeyBound = true;
    }

    // Перехват автосейва из менеджеров
    function wrapSave(obj) {
      if (!obj || obj._fsWrapped || typeof obj._saveToStorage !== 'function') return;
      const orig = obj._saveToStorage.bind(obj);
      obj._saveToStorage = function (...a) {
        const r = orig(...a);
        try {
          if (state.auto && state.mode !== 'bundled') {
            clearTimeout(wrapSave._t);
            wrapSave._t = setTimeout(writeNow, 400);
          }
        } catch {}
        return r;
      };
      obj._fsWrapped = true;
    }
    const t = setInterval(() => {
      try { wrapSave(window.nodesManager); wrapSave(window.minesManager); } catch {}
      if (window.nodesManager?._fsWrapped && window.minesManager?._fsWrapped) clearInterval(t);
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // наружу — принудительное сохранение
  window.saveDataToFileNow = writeNow;
})();
