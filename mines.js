/** mines.js Управление минами. */
(() => {
  'use strict';

  const LS_KEY_MINES = 'RFMines.v1.mines';

  // Размеры иконки
  const ICON_SIZE = 40;
  const ICON_HALF = ICON_SIZE / 2;

  // Оформление стандартной мины
  const MINE_INNER_R  = 12;
  const MINE_INNER_DX = 0;
  const MINE_INNER_DY = 0;
  const MINE_TEXT_DY  = 1;   // вертикальный сдвиг цифры
  const MINE_FONT_PX  = 12;  // размер шрифта

  // Оформление радиомины
  const RADIO_MINE_INNER_R  = 9;
  const RADIO_MINE_INNER_DX = 0;
  const RADIO_MINE_INNER_DY = 8;
  const RADIO_MINE_TEXT_DY  = 4;
  const RADIO_MINE_FONT_PX  = 12;

  // Иклнка номера канала
  const BADGE_R = 7.2;
  const BADGE_CX = 11;
  const BADGE_CY = 11;
  const BADGE_TEXT_Y = 14.2;

  // Цветовые фильтры
  const ICON_FILTER_GREEN = 'invert(48%) sepia(91%) saturate(545%) hue-rotate(86deg) brightness(90%) contrast(90%)';
  const ICON_FILTER_RED   = 'invert(22%) sepia(86%) saturate(5339%) hue-rotate(353deg) brightness(93%) contrast(109%)';
  const MINE_FILTER_RED   = 'invert(13%) sepia(94%) saturate(7487%) hue-rotate(1deg) brightness(93%) contrast(112%)';

  // Линия проводной связи
  const LINK_HIDE_DISTANCE_PX = 26;
  const WAVE_AMP_FACTOR = 0.10;
  const WAVE_AMP_MAX_PX = 18;
  const WAVE_AMP_MIN_PX = 6;
  const WAVE_TARGET_LAMBDA_PX = 60;
  const WAVE_POINTS_PER_LAMBDA = 20;

  const SVG_NS = "http://www.w3.org/2000/svg";

  let selectedMineId = null;

  function getMineDisplayName(mine) {
    if (mine && Number.isFinite(mine.assignedNodeId) && Number.isFinite(mine.channel)) {
      const node = window.nodesManager?.nodes.find(n => n.id === mine.assignedNodeId);
      const nodeName = node?.name?.trim();
      if (nodeName) return `${nodeName}-${mine.channel}`;
    }
    return `Мина №${mine.id}`;
  }

  function getMineFilter(mine) {
    if (mine.state === 'planned')   return 'filter:none;';
    if (mine.state === 'set')       return 'filter:brightness(0) sepia(100%) saturate(2000%) hue-rotate(10deg) brightness(0.95);';
    if (mine.state === 'armed')     return 'filter:brightness(0) sepia(100%) saturate(1000%) hue-rotate(120deg) brightness(0.9);';
    if (mine.state === 'disarmed')  return 'filter:brightness(0) sepia(100%) saturate(1000%) hue-rotate(180deg) brightness(1.1);';
    if (mine.state === 'exploded')  return `filter:${MINE_FILTER_RED};`;
    return '';
  }

  function getMineHeaderStatus(m) {
    if (m.reinitFailed && m.state === 'planned') return 'нет связи с узлом';
    if (m.pendingRequest) return 'отправлен запрос';
    if (m.state === 'armed') return 'нагрузка есть';
    if (m.state === 'disarmed') return 'нагрузки нет';
    switch (m.state) {
      case 'planned':  return 'запланирована';
      case 'set':      return 'установлена';
      case 'exploded': return 'взорвана';
      default:         return m.state || '—';
    }
  }

  function getStatusColorClass(state) {
    switch(state) {
      case 'armed': return 'status-green';
      case 'disarmed': return 'status-yellow';
      case 'exploded': return 'status-red';
      case 'planned':
      case 'set':
      default: return 'status-normal';
    }
  }

  function formatXY_SK42(latlng) {
    try {
      if (typeof proj4 === 'undefined' || !proj4.defs['EPSG:28405']) return '—';
      const p = proj4('EPSG:4326', 'EPSG:28405', [latlng.lng, latlng.lat]);
      return `X: ${Math.round(p[0])} Y: ${Math.round(p[1])}`;
    } catch { return '—'; }
  }

  function getMineIconHref(m) {
    const n = window.nodesManager?.nodes.find(x => x.id === Number(m.assignedNodeId));
    return (n && n.type === 'lampReset') ? 'icons/mine-radio.svg' : 'icons/mine.svg';
  }

  function formatExplodedWhen(iso) {
    if (!iso) return '(взорвана)';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '(взорвана)';
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `(взорвана ${date} в ${time})`;
  }

  class MinesManager {
    constructor(map) {
      this.map = map;
      this.mines = [];
      this.svg = null;
      this.draggingMine = null;
      this.dragOffset = null;
      this._loading = false;

      // Кеш путей волнистых линий
      this.linkPaths = new Map(); // mineId -> path
      this.linkPrev  = new Map(); // mineId -> { d }

      this._initSvgOrDefer();

      // Пересчёт позиций
      window.addEventListener('resize', () => { try { this.updatePositions(); } catch {} });

      // Поддержка перерисовки при перемещении узлов
      const keepAlive = () => {
        try {
          if (window.nodesManager?.draggingNode) this._renderStatic();
        } finally {
          requestAnimationFrame(keepAlive);
        }
      };
      requestAnimationFrame(keepAlive);

      window.addEventListener('node-status', (ev) => {
        try {
          const d = ev?.detail || {};
          this._applyStatusFromNode(d.nodeName, d.channel, d.value);
        } catch {}
      });
    }

    _initSvgOrDefer() {
      const tryBind = () => {
        const el = document.getElementById("nodesLayer");
        if (!el) return false;
        this.svg = el;
        this.svg.addEventListener("mousedown", this.onMouseDown.bind(this));
        document.addEventListener("mousemove", this.onMouseMove.bind(this));
        document.addEventListener("mouseup", this.onMouseUp.bind(this));
        this.svg.addEventListener("touchstart", this.onMouseDown.bind(this), { passive: false });
        document.addEventListener("touchmove", this.onMouseMove.bind(this), { passive: false });
        document.addEventListener("touchend", this.onMouseUp.bind(this));

        this._loadFromStorage();
        this.updatePositions();
        this._renderStatic();
        return true;
      };
      if (tryBind()) return;
      const obs = new MutationObserver(() => { if (tryBind()) obs.disconnect(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('load', () => { tryBind(); }, { once: true });
    }

    // --- Линии проводной связи ----------------------------------------------------

    _getCircleOffsetPx(circleEl) {
      if (!circleEl) return { x: 0, y: 0 };
      const cx = Number(circleEl.getAttribute('cx')) || 0;
      const cy = Number(circleEl.getAttribute('cy')) || 0;
      return { x: cx, y: cy };
    }

    _ensureWavePath(id) {
      let p = this.linkPaths.get(id);
      if (p) return p;
      if (!this.svg) return null;
      p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "#000");
      p.setAttribute("stroke-width", "1.5");
      p.setAttribute("stroke-opacity", "0.85");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      p.setAttribute("stroke-linecap", "round");
      p.style.pointerEvents = "none";
      // Размещается под иконками мин
      this.svg.insertBefore(p, this.svg.firstChild);
      this.linkPaths.set(id, p);
      return p;
    }

    _wavePixelsStrong(mine, node) {
      const gpMine = this.map.latLngToContainerPoint(mine.latlng);
      const gpNode = this.map.latLngToContainerPoint(node.latlng);
      const mOff = this._getCircleOffsetPx(mine.innerCircle);
      const nOff = this._getCircleOffsetPx(node.circle) || {x:0,y:0};
      const p0 = { x: gpMine.x + mOff.x, y: gpMine.y + mOff.y };
      const p1 = { x: gpNode.x + nOff.x, y: gpNode.y + nOff.y };

      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const L  = Math.hypot(dx, dy) || 1;
      if (L <= LINK_HIDE_DISTANCE_PX) return null;

      const tx = dx / L,  ty = dy / L;
      const nx = -ty,     ny = tx;

      const lambda = Math.max(24, WAVE_TARGET_LAMBDA_PX);
      const cycles = Math.max(2, Math.round(L / lambda));
      const ampRaw = Math.max(WAVE_AMP_MIN_PX, L * WAVE_AMP_FACTOR);
      const amp    = Math.min(WAVE_AMP_MAX_PX, ampRaw);

      const totalPoints = Math.max(20, cycles * WAVE_POINTS_PER_LAMBDA);
      const pts = new Array(totalPoints + 1);

      for (let i = 0; i <= totalPoints; i++) {
        const t = i / totalPoints;
        const sx = p0.x + dx * t;
        const sy = p0.y + dy * t;
        const s  = Math.sin(t * cycles * Math.PI * 2);
        pts[i] = { x: sx + nx * s * amp, y: sy + ny * s * amp };
      }
      return pts;
    }

    _wavePathD(pts) {
      if (!pts || !pts.length) return '';
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
      return d;
    }

    _renderStatic() {
      if (!this.svg) return;
      const nodes = window.nodesManager?.nodes || [];
      for (const mine of this.mines) {
        const pid = String(mine.id);
        let el = this.linkPaths.get(pid);

        const node = Number.isFinite(mine.assignedNodeId)
          ? nodes.find(n => n && n.id === Number(mine.assignedNodeId))
          : null;


        if (!node || node.type === 'lampReset') {
          if (el) { try { el.remove(); } catch {} this.linkPaths.delete(pid); this.linkPrev.delete(pid); }
          continue;
        }

        const pts = this._wavePixelsStrong(mine, node);
        if (!pts || pts.length < 2) {
          if (el) { try { el.remove(); } catch {} this.linkPaths.delete(pid); this.linkPrev.delete(pid); }
          continue;
        }

        const dNow = this._wavePathD(pts);
        const prev = this.linkPrev.get(pid);
        if (prev && prev.d === dNow && el) continue;

        if (!el) el = this._ensureWavePath(pid);
        if (!el) continue;

        el.setAttribute('d', dNow);
        this.linkPrev.set(pid, { d: dNow });
      }
    }

    // -----Создание объекта мина------------------------------------------------------------------

    createMine(latlng, shouldSelect = false) {
      if (!this.svg) return null;

      const g = document.createElementNS(SVG_NS, "g");
      const id = this.mines.reduce((max, m) => Math.max(max, m.id), 0) + 1;
      g.setAttribute("data-mine-id", String(id));
      g.style.cursor = "move";

      const img = document.createElementNS(SVG_NS, "image");
      img.setAttribute("href", "icons/mine.svg");
      img.setAttribute("width", ICON_SIZE); img.setAttribute("height", ICON_SIZE);
      img.setAttribute("x", -ICON_HALF); img.setAttribute("y", -ICON_HALF);
      g.appendChild(img);

      const innerCircle = document.createElementNS(SVG_NS, "circle");
      innerCircle.setAttribute("fill", "#fff");
      innerCircle.setAttribute("stroke", "#000");
      innerCircle.setAttribute("stroke-width", "1");
      innerCircle.setAttribute("vector-effect", "non-scaling-stroke");
      g.appendChild(innerCircle);

      const labelText = document.createElementNS(SVG_NS, "text");
      labelText.setAttribute("text-anchor", "middle");
      labelText.setAttribute("dominant-baseline", "middle");
      labelText.setAttribute("font-family", "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif");
      labelText.setAttribute("font-weight", "600");
      g.appendChild(labelText);

      const badgeCircle = document.createElementNS(SVG_NS, "circle");
      badgeCircle.setAttribute("fill", "#007bff");
      badgeCircle.setAttribute("stroke", "#0056b3");
      badgeCircle.setAttribute("stroke-width", "1");
      badgeCircle.style.display = "none";
      g.appendChild(badgeCircle);

      const badgeText = document.createElementNS(SVG_NS, "text");
      badgeText.setAttribute("text-anchor", "middle");
      badgeText.setAttribute("dominant-baseline", "middle");
      badgeText.setAttribute("font-family", "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif");
      badgeText.setAttribute("font-weight", "bold");
      badgeText.setAttribute("fill", "#fff");
      badgeText.style.display = "none";
      g.appendChild(badgeText);

      this.svg.appendChild(g);

      const mine = {
        id, latlng: { ...latlng }, img, innerCircle, labelText, svgGroup: g,
        assignedNodeId: null, channel: null, state: 'planned',
        badgeCircle, badgeText, _awaitTimerId: null, reinitFailed: false
      };
      this.mines.push(mine);

      // Оформление подписи и круга мины
      this._layoutMineGlyph(mine);

      this.updateMinePosition(mine);
      if (shouldSelect) selectedMineId = id;
      updateMineList();
      this._saveToStorage();
      this._renderStatic();
      return mine;
    }

    removeMine(id) {
      if (selectedMineId === id) selectedMineId = null;
      const idx = this.mines.findIndex(m => m.id === id);
      if (idx === -1) return;
      const mine = this.mines[idx];

      // Снять привязку и восстановить видимость узла при необходимости
      this.unassignAndShowNodeIfNeeded(mine);

      if (mine.svgGroup) try { mine.svgGroup.remove(); } catch {}
      // Удалить линию связи
      const pid = String(mine.id);
      const p = this.linkPaths.get(pid);
      if (p) { try { p.remove(); } catch {} this.linkPaths.delete(pid); this.linkPrev.delete(pid); }

      this.mines.splice(idx, 1);
      updateMineList();
      this._saveToStorage();
      this._renderStatic();
    }

    updatePositions() {
      this.mines.forEach(m => this.updateMinePosition(m));
      this._renderStatic();
    }

    updateMinePosition(mine) {
      if (!mine?.svgGroup) return;
      const gp = this.map.latLngToContainerPoint(mine.latlng);
      mine.svgGroup.setAttribute("transform", `translate(${gp.x.toFixed(1)}, ${gp.y.toFixed(1)})`);

      // Иконка и фильтр состояния
      const href = getMineIconHref(mine);
      try { mine.img.setAttribute("href", href); } catch {}
      try { mine.img.style.filter = getMineFilter(mine); } catch {}

      // Цвет внутреннего круга и текста
      if (mine.state === 'exploded') {
        mine.innerCircle.setAttribute('fill', 'var(--c-danger)');
        mine.innerCircle.setAttribute('stroke', 'var(--c-danger-hover)');
        mine.labelText.setAttribute('fill', 'white');
      } else {
        mine.innerCircle.setAttribute('fill', '#fff');
        mine.innerCircle.setAttribute('stroke', '#000');
        mine.labelText.setAttribute('fill', 'black');
      }

      // Параметры круга/текста с учётом типа
      this._layoutMineGlyph(mine);

      // Иконка канала
      this.updateBadge(mine);
    }

    _layoutMineGlyph(mine) {
      const isRadio = getMineIconHref(mine).includes('radio');

      const r   = isRadio ? RADIO_MINE_INNER_R  : MINE_INNER_R;
      const dx  = isRadio ? RADIO_MINE_INNER_DX : MINE_INNER_DX;
      const dy  = isRadio ? RADIO_MINE_INNER_DY : MINE_INNER_DY;
      const tdy = isRadio ? RADIO_MINE_TEXT_DY  : MINE_TEXT_DY;
      const fpx = isRadio ? RADIO_MINE_FONT_PX  : MINE_FONT_PX;

      // Круг
      mine.innerCircle.setAttribute("r",  String(r));
      mine.innerCircle.setAttribute("cx", String(dx));
      mine.innerCircle.setAttribute("cy", String(dy));

      // Текстовая подпись в мине
      let label = String(mine.id);
      if (Number.isFinite(mine.assignedNodeId)) {
        const node = window.nodesManager?.nodes.find(n => n.id === mine.assignedNodeId);
        const nodeName = node?.name?.trim();
        if (nodeName) label = nodeName;
      }
      mine.labelText.textContent = label;
      mine.labelText.setAttribute("x", String(dx));
      mine.labelText.setAttribute("y", String(dy + tdy));
      mine.labelText.setAttribute("font-size", String(fpx));
    }

    setAssignedNode(mineId, nodeId) {
      const mine = this.mines.find(m => m.id === mineId);
      if (!mine) return;

      // Восстановить видимость скрытого узла, если была привязка к узлу
      this.unassignAndShowNodeIfNeeded(mine);

      if (nodeId) {
        const node = window.nodesManager.nodes.find(n => n.id === Number(nodeId));
        if (!node || node.type === 'izmoroz') return;
        const free = this._freeChannelsForNode(node, mine.id);
        if (!free.length) return alert('У выбранного узла нет свободных каналов.');
        mine.assignedNodeId = node.id;
        mine.channel = free[0];

        // Узел скрывается, линия связи не рисуется
        if (node.type === 'lampReset') {
          window.setNodeVisible?.(node.id, false);
          const pid = String(mine.id);
          const p = this.linkPaths.get(pid);
          if (p) { try { p.remove(); } catch {} this.linkPaths.delete(pid); this.linkPrev.delete(pid); }
        }
      }
      this._layoutMineGlyph(mine);
      this.updateMinePosition(mine);
      this._renderStatic();
      updateMineList();
      this._saveToStorage();
    }

    _allowedChannelsForNode(node) {
      if (!node) return [];
      switch (node.type) {
        case 'lamp1': case 'lampReset': return [3];
        case 'lamp2': return [3, 4];
        case 'lamp4': return [3, 4, 5, 6];
        default: return [];
      }
    }

    _freeChannelsForNode(node, excludeMineId = null) {
      const allowed = this._allowedChannelsForNode(node);
      const used = new Set(this.mines.filter(m => m.assignedNodeId === node.id && m.id !== excludeMineId).map(m => m.channel));
      return allowed.filter(ch => !used.has(ch));
    }

    updateBadge(mine) {
      const show = Number.isFinite(mine.assignedNodeId) && Number.isFinite(mine.channel);
      mine.badgeCircle.style.display = show ? "" : "none";
      mine.badgeText.style.display = show ? "" : "none";
      if (show) {
        mine.badgeCircle.setAttribute("r", String(BADGE_R));
        mine.badgeCircle.setAttribute("cx", String(BADGE_CX));
        mine.badgeCircle.setAttribute("cy", String(BADGE_CY));
        mine.badgeText.textContent = String(mine.channel);
        mine.badgeText.setAttribute("x", String(BADGE_CX));
        mine.badgeText.setAttribute("y", String(BADGE_TEXT_Y));
      }
    }

    unassignAndShowNodeIfNeeded(mine) {
      if (!mine || !Number.isFinite(mine.assignedNodeId)) return;
      const node = window.nodesManager.nodes.find(n => n.id === mine.assignedNodeId);
      if (node?.type === 'lampReset') window.setNodeVisible?.(node.id, true);
      mine.assignedNodeId = null;
      mine.channel = null;

      // Удаление линии связи
      const pid = String(mine.id);
      const p = this.linkPaths.get(pid);
      if (p) { try { p.remove(); } catch {} this.linkPaths.delete(pid); this.linkPrev.delete(pid); }
    }

    setMineState(mine, state) {
      mine.state = state;
      if (state === 'exploded' && !mine.explodedAt) {
        mine.explodedAt = new Date().toISOString();
      }
      if (state !== 'planned') {
        mine.reinitFailed = false;
      }
      if (['set', 'armed', 'disarmed', 'exploded'].includes(state)) {
        mine.pendingRequest = false;
      }
      this.updateMinePosition(mine);
      updateMineList();
      this._saveToStorage();
      this._renderStatic();
    }

    // --- Механизм перетаскивания --------------------------------------------------------

    onMouseDown(e) {
      if (!this.svg || (e.type === "mousedown" && e.button !== 0)) return;
      const el = e.target.closest("g[data-mine-id]");
      if (!el) return;
      const id = Number(el.getAttribute("data-mine-id"));
      const mine = this.mines.find(m => m.id === id);
      if (!mine) return;
      this.draggingMine = mine;
      const p = this.map.latLngToContainerPoint(mine.latlng);
      const sp = this.svg.createSVGPoint();
      sp.x = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
      sp.y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
      const cur = sp.matrixTransform(this.svg.getScreenCTM().inverse());
      this.dragOffset = { x: cur.x - p.x, y: cur.y - p.y };
      try { e.preventDefault(); e.stopPropagation(); } catch {}
    }

    onMouseMove(e) {
      if (!this.draggingMine) return;
      const sp = this.svg.createSVGPoint();
      sp.x = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
      sp.y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
      const cur = sp.matrixTransform(this.svg.getScreenCTM().inverse());
      const x = cur.x - this.dragOffset.x;
      const y = cur.y - this.dragOffset.y;
      const ll = this.map.containerPointToLatLng(L.point(x, y));
      this.draggingMine.latlng = { lat: ll.lat, lng: ll.lng };
      this.updateMinePosition(this.draggingMine);
      this._renderStatic();
    }

    onMouseUp() {
      if (!this.draggingMine) return;
      const draggedMine = this.draggingMine;
      this.draggingMine = null;
      this.dragOffset = null;
      if (document.getElementById('minesSettingsModal')?.classList.contains('show') && selectedMineId === draggedMine.id) {
        updateMineList();
      }
      this._saveToStorage();
      this._renderStatic();
    }

    // -------Управление минами----------------------------------------------------------------

    _serializeMine(m) {
      return {
        id: Number(m.id),
        latlng: { lat: Number(m.latlng?.lat), lng: Number(m.latlng?.lng) },
        assignedNodeId: Number.isFinite(m.assignedNodeId) ? Number(m.assignedNodeId) : null,
        channel: Number.isFinite(m.channel) ? Number(m.channel) : null,
        state: m.state || 'planned',
        explodedAt: m.explodedAt || null,
        reinitFailed: !!m.reinitFailed
      };
    }

    _saveToStorage() {
      if (this._loading) return;
      try {
        const payload = { mines: this.mines.map(m => this._serializeMine(m)) };
        localStorage.setItem(LS_KEY_MINES, JSON.stringify(payload));
      } catch (e) { console.warn('[mines] save storage failed', e); }
    }

    _loadFromStorage() {
      let raw = null, data = null;
      try { raw = localStorage.getItem(LS_KEY_MINES); } catch {}
      if (!raw) return;
      try { data = JSON.parse(raw); } catch (e) { return; }
      if (!data?.mines) return;

      this._loading = true;
      this.mines = [];
      for (const st of data.mines) {
        if (!st?.latlng) continue;
        const m = this.createMine(st.latlng);
        if (!m) continue;
        Object.assign(m, st);
        this._layoutMineGlyph(m);
        this.updateMinePosition(m);
      }
      this._loading = false;
      updateMineList();
      this._renderStatic();
    }

    _startAwaitTimer(mine, ms = 10000, mode = 'check') {
      this._clearAwaitTimer(mine);
      mine._awaitTimerId = setTimeout(() => {
        mine._awaitTimerId = null;
        mine.pendingRequest = false;
        if (mode === 'reinit') {
          mine.reinitFailed = true;
          this.setMineState(mine, 'planned');
        } else {
          updateMineList();
        }
      }, ms);
    }

    _clearAwaitTimer(mine) {
      if (mine && mine._awaitTimerId) {
        clearTimeout(mine._awaitTimerId);
        mine._awaitTimerId = null;
      }
    }

    _applyStatusFromNode(nodeName, channel, value) {
      if (nodeName == null || !Number.isFinite(channel) || ![0, 1].includes(value)) return;
      const node = window.nodesManager.nodes.find(n => n.name?.trim() === String(nodeName).trim());
      if (!node) return;
      const list = this.mines.filter(m => m.assignedNodeId === node.id && m.channel === channel);
      for (const mine of list) {
        this._clearAwaitTimer(mine);
        mine.explodedAt = null; // успешный ответ сбрасывает время взрыва
        this.setMineState(mine, value === 1 ? 'armed' : 'disarmed');
      }
    }
  }

  function _validateMineAction(mine, options = {}) {
    if (!window.isSerialConnected) {
      return { valid: false, message: 'Устройство радиоуправления не подключено.' };
    }
    const node = window.nodesManager.nodes.find(n => n.id === mine.assignedNodeId);
    if (!node) {
      return { valid: false, message: 'Мина не привязана к узлу.' };
    }
    const nodeName = (node.name || '').trim();
    if (!nodeName) {
      return { valid: false, message: `Не задано имя для привязанного узла №${node.id}.` };
    }
    if (options.requireChannel && !Number.isFinite(mine.channel)) {
      return { valid: false, message: 'Для данной операции необходимо выбрать канал.' };
    }
    return { valid: true, node, nodeName };
  }

  // Панель быстрого доступа
  function renderMinesToSlideOutPanel() {
    const container = document.getElementById('slideOutMineList');
    if (!container) return;

    const mines = window.minesManager?.mines || [];
    if (!mines.length) {
      container.innerHTML = '<div class="placeholder-small">Нет активных мин</div>';
      return;
    }

    container.innerHTML = mines.map(m => {
      const iconHref = getMineIconHref(m);
      const filter = getMineFilter(m);
      const isRadio = iconHref.includes('radio');
      const isExploded = m.state === 'exploded';

      let payloadIcon = 'no.svg';
      let payloadFilter = '';
      if (m.state === 'armed') {
        payloadIcon = 'yes.svg';
        payloadFilter = `filter: ${ICON_FILTER_GREEN};`;
      } else if (m.state === 'disarmed') {
        payloadIcon = 'no.svg';
        payloadFilter = `filter: ${ICON_FILTER_RED};`;
      }

      const actionsHtml = isExploded ? '' : `
        <div class="mine-item-actions">
          <button class="slide-out-action-btn" data-action="check" data-mine-id="${m.id}" title="Проверить нагрузку">
            <img src="icons/${payloadIcon}" style="${payloadFilter}" alt="Нагрузка">
          </button>
          <button class="slide-out-action-btn" data-action="explode" data-mine-id="${m.id}" title="Взорвать">
            <img src="icons/fire.svg" alt="Взорвать">
          </button>
        </div>
      `;

      return `
        <div class="slide-out-mine-item ${isRadio ? 'is-radio' : ''} ${isExploded ? 'is-exploded' : ''}">
          <div class="mine-item-main-info" data-mine-id="${m.id}" title="Показать на карте">
            <div class="mine-icon-wrapper">
              <img src="${iconHref}" style="${filter}">
              <div class="mine-id-text-overlay">${m.id}</div>
            </div>
            <span>${getMineDisplayName(m)}</span>
          </div>
          ${actionsHtml}
        </div>
      `;
    }).join('');

    // Делегирование событий по клику
    container.onclick = (e) => {
      const mainInfo = e.target.closest('.mine-item-main-info');
      const actionBtn = e.target.closest('.slide-out-action-btn');

      if (mainInfo) {
        const mineId = Number(mainInfo.dataset.mineId);
        const mine = window.minesManager.mines.find(m => m.id === mineId);
        if (mine && window.map) {
          window.map.setView(mine.latlng, 17);
        }
        return;
      }

      if (actionBtn) {
        const mineId = Number(actionBtn.dataset.mineId);
        const action = actionBtn.dataset.action;
        const mine = window.minesManager.mines.find(m => m.id === mineId);
        if (!mine) return;

        if (action === 'check') {
          const validation = _validateMineAction(mine);
          if (!validation.valid) return alert(validation.message);

          mine.pendingRequest = true;
          updateMineList();
          window.minesManager._startAwaitTimer(mine, 10000, 'check');
          window.sendToSerial(`${validation.nodeName};s\n`);
        } else if (action === 'explode') {
          const validation = _validateMineAction(mine, { requireChannel: true });
          if (!validation.valid) return alert(validation.message);

          if (confirm(`Вы действительно хотите взорвать мину ${getMineDisplayName(mine)}?`)) {
            window.minesManager.setMineState(mine, 'exploded');
            window.sendToSerial(`${validation.nodeName};${mine.channel};1\n`);
          }
        }
      }
    };
  }

  function updateMineList() {
    renderMineList(document.getElementById('mineListContainer'));
    renderMineEditor(document.getElementById('mineEditorPanel'));
    renderMinesToSlideOutPanel();
  }

  // Список мин (левая колонка)
  function renderMineList(container) {
    if (!container) return;
    const mines = window.minesManager?.mines || [];
    const searchTerm = document.getElementById('mineSearchInput')?.value.toLowerCase() || '';
    const filteredMines = mines.filter(m => getMineDisplayName(m).toLowerCase().includes(searchTerm));

    container.innerHTML = filteredMines.length ? filteredMines.map(m => `
      <div class="list-item ${getStatusColorClass(m.state)} ${m.id === selectedMineId ? 'is-selected' : ''}" data-id="${m.id}">
        ${getMineDisplayName(m)}
      </div>
    `).join('') : '<div class="placeholder-small">Мины не найдены</div>';

    container.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => {
        selectedMineId = Number(item.dataset.id);
        updateMineList();
      });
    });
  }

  // Панель редактирования (правая колонка)
  function renderMineEditor(panel) {
    if (!panel) return;
    if (selectedMineId === null) {
      panel.innerHTML = '<div class="placeholder">Выберите мину из списка для редактирования</div>';
      return;
    }
    const m = window.minesManager.mines.find(mine => mine.id === selectedMineId);
    if (!m) {
      panel.innerHTML = '<div class="placeholder">Мина не найдена</div>';
      selectedMineId = null;
      return;
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const nodes = window.nodesManager?.nodes || [];
    const isExploded = m.state === 'exploded';
    const statusText = isExploded ? formatExplodedWhen(m.explodedAt) : `(${getMineHeaderStatus(m)})`;

    let actionsHtml = '';
    if (isExploded) {
      actionsHtml = `<button class="button button-warning mine-reinit-btn" data-mine="${m.id}">Повторно инициализировать</button>`;
    } else {
      actionsHtml = `
        <button class="button button-warning mine-set-btn" data-mine="${m.id}">Проверить нагрузку</button>
        <button class="button danger-solid mine-explode-btn" data-mine="${m.id}">Взорвать</button>
      `;
    }

    panel.innerHTML = `
      <div class="editor-header">
        <h3 class="${isExploded ? 'is-exploded' : ''}">${getMineDisplayName(m)} <span class="header-status">${statusText}</span></h3>
        <div class="header-meta">${formatXY_SK42(m.latlng)}</div>
        ${m.reinitFailed ? `<div class="editor-warning">Осторожно! Мина не сработала с первой попытки</div>` : ''}
        <div class="header-actions">
          <button class="icon-button mine-goto-btn" data-id="${m.id}" title="Показать на карте"><img src="icons/gps.svg" alt="Показать на карте"></button>
          <button class="icon-button delete-btn" data-del-mine="${m.id}" title="Удалить"><img src="icons/delete.svg" alt="Удалить"></button>
        </div>
      </div>
      <div class="editor-body">
        ${!isExploded ? `
        <div class="form-grid-compact">
          <label>Назначенный узел:</label>
          <select class="mine-assign-select" data-mine="${m.id}">
            <option value="">(не назначать)</option>
            ${nodes.filter(n => n.type !== 'izmoroz').map(n => {
              const freeCount = (window.minesManager._freeChannelsForNode(n, m.id) || []).length;
              const selected = n.id === m.assignedNodeId;
              if (!selected && freeCount === 0) return '';
              const title = selected ? `Узел #${n.id}${n.name ? ' — '+esc(n.name) : ''}` : `Узел #${n.id}${n.name ? ' — '+esc(n.name) : ''} (свободно: ${freeCount})`;
              return `<option value="${n.id}" ${selected ? 'selected' : ''}>${title}</option>`;
            }).join('')}
          </select>
        ${m.assignedNodeId ? `
          <label>Выбранный канал:</label>
          <select class="mine-channel-select" data-mine="${m.id}">
            ${(window.minesManager._allowedChannelsForNode(nodes.find(n=>n.id===m.assignedNodeId)) || []).map(ch => {
              const isUsedByOther = window.minesManager._freeChannelsForNode(nodes.find(n=>n.id===m.assignedNodeId), m.id).indexOf(ch) === -1;
              return `<option value="${ch}" ${m.channel === ch ? 'selected' : ''} ${isUsedByOther ? 'disabled' : ''}>Канал ${ch} ${isUsedByOther ? '(занято)' : ''}</option>`;
            }).join('')}
          </select>
        ` : ''}
        </div>
        ` : ''}
      </div>
      <div class="card-actions">${actionsHtml}</div>
    `;
    attachMineHandlers(panel);
  }

  function attachMineHandlers(root) {
    if (!root || selectedMineId === null) return;
    const mine = window.minesManager.mines.find(m => m.id === selectedMineId);
    if(!mine) return;

    root.querySelector('[data-del-mine]')?.addEventListener('click', (e) => {
      window.minesManager.removeMine(Number(e.currentTarget.dataset.delMine));
    });

    root.querySelector('.mine-goto-btn')?.addEventListener('click', () => {
      if (window.map && mine.latlng) {
        window.map.setView(mine.latlng, 16);
        document.getElementById('closeMinesModalBtn')?.click();
      }
    });

    root.querySelector('.mine-assign-select')?.addEventListener('change', (e) => {
      const nodeId = e.target.value ? Number(e.target.value) : null;
      window.minesManager.setAssignedNode(mine.id, nodeId);
    });

    root.querySelector('.mine-channel-select')?.addEventListener('change', (e) => {
      mine.channel = Number(e.target.value);
      window.minesManager.updateMinePosition(mine);
      window.minesManager._saveToStorage();
      updateMineList();
    });

    root.querySelector('.mine-set-btn')?.addEventListener('click', () => {
      const validation = _validateMineAction(mine);
      if (!validation.valid) return alert(validation.message);

      mine.pendingRequest = true;
      updateMineList();
      window.minesManager._startAwaitTimer(mine, 10000, 'check');
      window.sendToSerial(`${validation.nodeName};s\n`);
    });

    root.querySelector('.mine-explode-btn')?.addEventListener('click', () => {
      const validation = _validateMineAction(mine, { requireChannel: true });
      if (!validation.valid) return alert(validation.message);

      if (confirm(`Вы действительно хотите взорвать мину ${getMineDisplayName(mine)}?`)) {
        window.minesManager.setMineState(mine, 'exploded');
        window.sendToSerial(`${validation.nodeName};${mine.channel};1\n`);
      }
    });

    root.querySelector('.mine-reinit-btn')?.addEventListener('click', () => {
      const validation = _validateMineAction(mine);
      if (!validation.valid) return alert(validation.message);

      mine.pendingRequest = true;
      updateMineList();
      window.minesManager._startAwaitTimer(mine, 10000, 'reinit');
      window.sendToSerial(`${validation.nodeName};s\n`);
    });
  }

  // Инициализация интерфейса
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('addNewMineFromModalBtn')?.addEventListener('click', () => {
      window.minesManager?.createMine(window.map.getCenter(), true);
    });
    document.getElementById('mineSearchInput')?.addEventListener('input', () => {
      renderMineList(document.getElementById('mineListContainer'));
    });
  });

  window.updateMineList = updateMineList;

  function initMinesManager() {
    if (window.map) {
      window.minesManager = new MinesManager(window.map);
      window.map.on("move zoom resize", () => window.minesManager?.updatePositions());
    }
  }
  window.initMinesManager = initMinesManager;

})();
