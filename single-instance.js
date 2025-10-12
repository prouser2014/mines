/** single-instance.js Ограничивает работу приложения одной вкладкой. */
(() => {
  'use strict';

  const LOCK_KEY = 'app.single.lock';
  const CH_NAME = 'app.single.channel';

  // Временные интервалы для управления блокировкой вкладки
  const HEARTBEAT_MS = 2000;
  const STALE_MS = 6500;

  // Пользовательские строки
  const strings = {
    blocked:
      'Приложение уже открыто в другой вкладке.\nЧтобы продолжить работу, закройте это окно.',
  };

  // Инициализация переменных для управления состоянием
  const TAB_ID =
    (typeof crypto !== 'undefined' &&
      crypto.randomUUID &&
      crypto.randomUUID()) ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  let iOwnLock = false;
  let heartbeatTimer = 0;
  let reclaimTimer = 0;
  let channel = null;
  let overlayEl = null;

  //  Запись, чтение и стираеие информации о "Главной" страницы
  function readLock() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return rec && typeof rec === 'object'
        ? { tabId: rec.tabId, ts: Number(rec.ts) || 0 }
        : null;
    } catch (e) {
      console.warn('Ошибка чтения блокировки:', e);
      return null;
    }
  }

  function writeLock(rec) {
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify(rec));
      return true;
    } catch (e) {
      console.error('Ошибка записи блокировки:', e);
      return false;
    }
  }

  function removeOwnLock() {
    try {
      const rec = readLock();
      if (rec && rec.tabId === TAB_ID) localStorage.removeItem(LOCK_KEY);
    } catch (e) {
      console.warn('Ошибка удаления блокировки:', e);
    }
  }

  // Захват и удержание "Главной" страницы
  const isStale = (rec, t = Date.now()) => !rec || t - (rec.ts || 0) > STALE_MS;

  function acquireLock() {
    const t = Date.now();
    const rec = readLock();
    if (isStale(rec, t)) {
      iOwnLock = writeLock({ tabId: TAB_ID, ts: t });
      return iOwnLock;
    }
    return false;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (!iOwnLock) return;
      if (!writeLock({ tabId: TAB_ID, ts: Date.now() })) {
        iOwnLock = false;
        stopHeartbeat();
        showOverlay();
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
    }
  }

  // механизм перехватчика "Главной" страницы
  function startReclaimer() {
    stopReclaimer();
    reclaimTimer = window.setInterval(() => {
      if (iOwnLock) return;
      if (acquireLock()) {
        hideOverlay();
        startHeartbeat();
        announceOwnership();
      }
    }, Math.max(HEARTBEAT_MS, 1500));
  }

  function stopReclaimer() {
    if (reclaimTimer) {
      clearInterval(reclaimTimer);
      reclaimTimer = 0;
    }
  }

  //  Система общения между всеми открытыми вкладками приложения
  function setupChannel() {
    try {
      channel = new BroadcastChannel(CH_NAME);
      channel.onmessage = (e) => {
        const msg = e && e.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'who-owns-lock') {
          if (iOwnLock) channel.postMessage({ type: 'lock-owned', tabId: TAB_ID });
        } else if (msg.type === 'lock-owned') {
          if (!iOwnLock) showOverlay();
        }
      };
    } catch {
      // BroadcastChannel недоступен — работаем только через localStorage
      channel = null;
      console.info('Канал BroadcastChannel недоступен.');
    }
  }

  const pingOwner = () => {
    try {
      channel && channel.postMessage({ type: 'who-owns-lock', from: TAB_ID });
    } catch {}
  };

  const announceOwnership = () => {
    try {
      channel && channel.postMessage({ type: 'lock-owned', tabId: TAB_ID });
    } catch {}
  };

  // Создание визуального эффекта блокировки
  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    const el = document.createElement('div');
    el.setAttribute('data-single-instance-overlay', '1');
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#111',
      color: '#fff',
      zIndex: '2147483647',
      fontFamily:
        'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      whiteSpace: 'pre-line',
      textAlign: 'center',
      padding: '24px',
      lineHeight: '1.4',
    });
    el.textContent = strings.blocked;

    // Управление видимостью экрана блокировки
    document.addEventListener(
      'keydown',
      (ev) => {
        if (el.style.display !== 'none' && /^(Tab|Enter| |Spacebar)$/.test(ev.key)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      { capture: true }
    );

    overlayEl = el;
    return overlayEl;
  }

  function showOverlay() {
    const el = ensureOverlay();
    if (!document.body.contains(el)) document.body.appendChild(el);
    el.style.display = 'flex';
  }

  function hideOverlay() {
    if (!overlayEl) return;
    overlayEl.style.display = 'none';
  }

  // Обработчик событий
  function onStorageChange(e) {
    if (e && e.key !== LOCK_KEY) return;
    const rec = readLock();
    const t = Date.now();

    // Обработчик на действия другой вкладки
    if (rec && rec.tabId !== TAB_ID && !isStale(rec, t)) {
      if (iOwnLock) {
        iOwnLock = false;
        stopHeartbeat();
      }
      showOverlay();
      return;
    }
    // Инициализация скрипта при загрузке страницы
    if (!iOwnLock && isStale(rec, t)) {
      if (acquireLock()) {
        hideOverlay();
        startHeartbeat();
        announceOwnership();
      }
    }
  }

  function boot() {
    setupChannel();

    if (acquireLock()) {
      startHeartbeat();
      announceOwnership();
      pingOwner();
    } else {
      showOverlay();
      pingOwner();
      startReclaimer();
    }

    window.addEventListener('storage', onStorageChange);
    window.addEventListener(
      'beforeunload',
      () => {
        removeOwnLock();
        stopHeartbeat();
        stopReclaimer();
        try {
          channel && channel.close && channel.close();
        } catch {}
      },
      { capture: true }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
