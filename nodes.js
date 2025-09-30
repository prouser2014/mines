/** modes.js Управление узлами. */

if (typeof proj4 !== "undefined" && !proj4.defs["EPSG:28405"]) {
  proj4.defs(
    "EPSG:28405",
    "+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=5500000 +y_0=0 " +
      "+ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs"
  );
}

const LS_KEY_NODES = 'RFNodes.v1.nodes';
const SVG_NS = "http://www.w3.org/2000/svg";

const NODE_TYPES = Object.freeze({
  lamp1:     { label: '«Лампочка», 1-канальная',     channels: 1 },
  lamp2:     { label: '«Лампочка», 2-канальная',     channels: 2 },
  lamp4:     { label: '«Лампочка», 4-канальная',     channels: 4 },
  izmoroz:   { label: 'Приёмопередатчик «Изморозь»', channels: 0 },
  lampReset: { label: '«Лампочка» — сброс',          channels: 1 },
});

// Текущее выделение в интерфейсе
let selectedNodeId = null;

// Оценка радиовидимости и профиль местности
(function attachLinkRadioHelpers(global){
  const MARGIN_DB = 12;
  const N_EXP_DEFAULT = 3.3;
  const NEAR_GROUND_H_M = 10;

  function _deygoutLoss(terr, x0, xN, hTxAbs, hRxAbs, fMHz, hSea){
    try { return window.__DEYGOUT__.knifeEdgeDeygoutLoss(terr, x0, xN, hTxAbs, hRxAbs, fMHz, hSea) || 0; }
    catch { return 0; }
  }
  function _profileSamples(map, aNode, bNode, stepMeters=30){
    try { return window.getTerrainProfile(map, aNode.latlng, bNode.latlng, stepMeters) || []; }
    catch { return []; }
  }
  function _freqMHzFrom(a){ return Number((a.lora?.freqHz ?? 434000000) / 1e6) || 434; }

  function evalResidualOneWay(a, b, map){
    if (!a || !b || !map || !a.latlng || !b.latlng) return -Infinity;

    // Профиль рельефа между узлами
    const samples = _profileSamples(map, a, b, 30);

    const D = L.latLng(a.latlng.lat, a.latlng.lng).distanceTo(L.latLng(b.latlng.lat, b.latlng.lng));
    if (!(D > 0)) return -Infinity;

    const lA = a.lora || {}, lB = b.lora || {};
    const fMHz = _freqMHzFrom(a);

    const Pt   = Number(lA.txPowerDbm ?? 14);
    const Gt   = Number(lA.txAntGainDb ?? 0);
    const Gr   = Number(lB.rxAntGainDb ?? 0);
    const Sens = Number(lB.rxSensDbm   ?? -123);
    const txH  = Number(lA.txH ?? 1.5);
    const rxH  = Number(lB.rxH ?? 1.5);

    const hTxAbs = (Number(a.elevation) || 0) + txH;
    const hRxAbs = (Number(b.elevation) || 0) + rxH;

    const Lfs = 32.45 + 20*Math.log10(Math.max(0.001, D/1000)) + 20*Math.log10(Math.max(0.001, fMHz));

    let Ldif = 0;
    if (samples.length) {
      Ldif = _deygoutLoss(samples, 0, D, hTxAbs, hRxAbs, fMHz, 0);
      if (!Number.isFinite(Ldif) || Ldif < 0) Ldif = 0;
    }

    const nearGround = (txH < NEAR_GROUND_H_M) && (rxH < NEAR_GROUND_H_M);
    const nEff = nearGround ? N_EXP_DEFAULT : 2.0;
    const Lenv = 10 * nEff * Math.log10(Math.max(1e-3, D/1000));

    const Pr = Pt + Gt + Gr - (Lfs + Ldif + Lenv);
    return Pr - Sens - MARGIN_DB;
  }

  global.__RF_LINK__ = { evalResidualOneWay };
})(window);


class NodesManager {
  constructor(map) {
    this.map = map;
    this.nodes = [];
    this.svg = null;
    this.linksLayer = L.layerGroup().addTo(this.map);
    this.draggingNode = null;
    this._dragOffset = null;
    this._loading = false;
    this._initSvgOrDefer();
  }

  _initSvgOrDefer() {
    const tryBind = () => {
      const el = document.getElementById("nodesLayer");
      if (!el) return false;
      this.svg = el;
      this._installSvgHandlers();
      try { this._loadFromStorage(); } catch (e) { console.warn('[nodes] load storage failed', e); }
      this.updatePositions();
      this._recomputeLinks();
      try { updateNodeList(); } catch {}
      return true;
    };
    if (tryBind()) return;
    const obs = new MutationObserver(() => { if (tryBind()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('load', () => { tryBind(); }, { once: true });
  }

  _installSvgHandlers() {
    if (!this.svg) return;
    this.svg.addEventListener("mousedown", this.onMouseDown.bind(this));
    this.svg.addEventListener("touchstart", this.onMouseDown.bind(this), { passive: false });
    document.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false });
    document.addEventListener("touchmove", this.onMouseMove.bind(this), { passive: false });
    document.addEventListener("mouseup", this.onMouseUp.bind(this));
    document.addEventListener("touchend", this.onMouseUp.bind(this));
  }

  _defaultLora() {
    return {
      freqHz: 434000000, txPowerDbm: 30,
      txAntGainDb: 0, rxAntGainDb: 0,
      rxSensDbm: -123, txH: 10, rxH: 1.5,
      radius: 20000
    };
  }

  createNode(latlng, shouldSelect = false) {
    if (!this.svg) return null;

    const id = this.nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    const elevation = (typeof window.getElevation === "function")
      ? window.getElevation(latlng.lat, latlng.lng)
      : 0;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-id", id);
    g.style.cursor = "move";

    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("href", "icons/radio.svg");
    img.setAttribute("x", -32.5); img.setAttribute("y", -32.5);
    img.setAttribute("width", 65); img.setAttribute("height", 65);
    g.appendChild(img);

    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", -1.5); c.setAttribute("cy", 10.5); c.setAttribute("r", 13);
    c.setAttribute("fill", "#fff");
    c.setAttribute("stroke", "#2c3e50");
    c.setAttribute("stroke-width", "2");
    g.appendChild(c);

    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", -1.5); t.setAttribute("y", 14.5);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", "12px");
    t.setAttribute("font-weight", "bold");
    t.textContent = String(id);
    g.appendChild(t);

    this.svg.appendChild(g);

    const node = {
      id, latlng: { ...latlng },
      elevation: Number.isFinite(elevation) ? Number(elevation) : 0,
      name: "", type: 'lamp1', visible: true, svgGroup: g, circle: c,
      lora: this._defaultLora(), _rfZoneActive: false
    };
    this.nodes.push(node);

    this.updateNodeGlyph(node);
    this.updateNodePosition(node);
    this._recomputeLinks();

    if (shouldSelect) selectedNodeId = node.id;

    try { updateNodeList(); } catch {}
    this._saveToStorage();
    return node;
  }

  removeNode(id) {
    if (selectedNodeId === id) selectedNodeId = null;

    const i = this.nodes.findIndex(n => n.id === id);
    if (i < 0) return;

    const n = this.nodes[i];
    try { n.svgGroup?.remove(); } catch {}

    this.nodes.splice(i, 1);
    this._recomputeLinks();

    if (n._rfZoneActive && window.RFZone) { try { RFZone.hideCoverage(n); } catch {} }

    try { updateNodeList(); } catch {}
    this._saveToStorage();
  }

  updateNodePosition(node) {
    if (!node || !this.map || !this.svg) return;
    const p = this.map.latLngToContainerPoint(node.latlng);
    node.svgGroup.setAttribute("transform", `translate(${p.x}, ${p.y})`);
  }

  updateNodeGlyph(node) {
    if (!node || !node.svgGroup) return;
    const textEl = node.svgGroup.querySelector('text');
    if (!textEl) return;
    const name = node.name?.trim();
    textEl.textContent = name ? name : String(node.id);
  }

  updatePositions() {
    this.nodes.forEach(n => this.updateNodePosition(n));
    this._recomputeLinks();
  }

  updateNodeVisibility(node) {
    if (!node || !node.svgGroup) return;
    node.svgGroup.style.display = node.visible ? "" : "none";
    this._recomputeLinks();
  }

  _startDrag(e, node) {
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    this.draggingNode = node;
    if (node.circle) node.circle.setAttribute("fill", "#e0e0e0");

    const p = this.map.latLngToContainerPoint(node.latlng);
    const sp = this.svg.createSVGPoint();
    sp.x = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
    sp.y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
    const cur = sp.matrixTransform(this.svg.getScreenCTM().inverse());
    this._dragOffset = { x: cur.x - p.x, y: cur.y - p.y };
  }

  onMouseDown(e) {
    if (!this.svg || (e.type === "mousedown" && e.button !== 0)) return;
    const el = e.target.closest("g[data-id]");
    if (!el) return;
    const id = Number(el.getAttribute("data-id"));
    const node = this.nodes.find(n => n.id === id);
    if (!node) return;
    this._startDrag(e, node);
  }

  onMouseMove(e) {
    if (!this.draggingNode || !this.svg) return;
    const sp = this.svg.createSVGPoint();
    sp.x = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
    sp.y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
    const cur = sp.matrixTransform(this.svg.getScreenCTM().inverse());
    const x = cur.x - this._dragOffset.x, y = cur.y - this._dragOffset.y;
    const ll = this.map.containerPointToLatLng(L.point(x, y));
    this.draggingNode.latlng = { lat: ll.lat, lng: ll.lng };

    if (typeof window.getElevation === "function") {
      const h = window.getElevation(ll.lat, ll.lng);
      if (Number.isFinite(h)) this.draggingNode.elevation = h;
    }

    this.updateNodePosition(this.draggingNode);
    this._recomputeLinks();
  }

  onMouseUp() {
    if (!this.draggingNode) return;
    if (this.draggingNode.circle) this.draggingNode.circle.setAttribute("fill", "#fff");
    const draggedNode = this.draggingNode;
    this.draggingNode = null;
    this._dragOffset = null;

    if (document.getElementById('nodeSettingsModal')?.classList.contains('show') && selectedNodeId === draggedNode.id) {
      try { updateNodeList(); } catch {}
    }
    this._saveToStorage();
  }

  _hasElevations() {
    try { return typeof window.getTerrainProfile === 'function'; }
    catch { return false; }
  }

  _recomputeLinks() {
    if (!this.linksLayer) return;
    this.linksLayer.clearLayers();
    if (!this._hasElevations()) return;

    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (!a.visible || !b.visible) continue;

        let rAB = -Infinity, rBA = -Infinity;
        try {
          rAB = window.__RF_LINK__.evalResidualOneWay(a, b, this.map);
          rBA = window.__RF_LINK__.evalResidualOneWay(b, a, this.map);
        } catch (e) { console.warn('[link] eval failed', e); }

        if (Number.isFinite(rAB) && Number.isFinite(rBA) && rAB >= 0 && rBA >= 0) {
          const styleOK  = { color: "#4caf50", weight: 2, opacity: 0.95, interactive: false };
          L.polyline([a.latlng, b.latlng], styleOK).addTo(this.linksLayer);
        }
      }
    }
  }

  _serializeNode(n) {
    return {
      id: Number(n.id),
      latlng: { lat: Number(n.latlng?.lat), lng: Number(n.latlng?.lng) },
      name: String(n.name || ""),
      type: n.type || 'izmoroz',
      channel: Number.isFinite(n.channel) ? Number(n.channel) : null,
      visible: !!n.visible,
      lora: Object.assign({}, this._defaultLora(), n.lora || {}),
      elevation: Number(n.elevation) || 0
    };
  }

  _saveToStorage() {
    if (this._loading) return;
    try {
      const payload = { nodes: this.nodes.map(n => this._serializeNode(n)) };
      localStorage.setItem(LS_KEY_NODES, JSON.stringify(payload));
    } catch (e) { console.warn('[nodes] save storage failed', e); }
  }

  _loadFromStorage() {
    let raw = null, data = null;
    try { raw = localStorage.getItem(LS_KEY_NODES); } catch {}
    if (!raw) return;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data?.nodes) return;
    if (!this.svg) return;

    this._loading = true;
    for (const st of data.nodes) {
      if (!st?.latlng) continue;
      const n = this.createNode(st.latlng);
      if (!n) continue;
      Object.assign(n, st, { svgGroup: n.svgGroup });
      this.updateNodeGlyph(n);
      try { n.svgGroup.setAttribute('data-id', String(n.id)); } catch {}
      this.updateNodeVisibility(n);
      this.updateNodePosition(n);
    }
    this._recomputeLinks();
    this._loading = false;
  }
}

// Обновление панели «Список узлов» и редактора
function updateNodeList() {
  const listContainer = document.getElementById("nodeListContainer");
  const editorPanel = document.getElementById("nodeEditorPanel");
  if (!listContainer || !editorPanel) return;
  renderNodeList(listContainer);
  renderNodeEditor(editorPanel);
}

// Отрисовка списка узлов
function renderNodeList(container) {
  const nodes = window.nodesManager?.nodes || [];
  const searchTerm = document.getElementById('nodeSearchInput')?.value.toLowerCase() || '';
  const filteredNodes = nodes.filter(n => (n.name || `Узел №${n.id}`).toLowerCase().includes(searchTerm));

  if (!filteredNodes.length) {
    container.innerHTML = '<div class="placeholder-small">Ничего не найдено</div>';
    return;
  }
  container.innerHTML = filteredNodes.map(n => `
    <div class="list-item ${n.id === selectedNodeId ? 'is-selected' : ''}" data-id="${n.id}">
      ${n.name || `Узел №${n.id}`}
    </div>
  `).join('');
  container.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      selectedNodeId = Number(item.dataset.id);
      updateNodeList();
    });
  });
}

// Редактор выбранного узла
function renderNodeEditor(panel) {
  if (selectedNodeId === null) {
    panel.innerHTML = '<div class="placeholder">Выберите узел из списка для редактирования</div>';
    return;
  }
  const n = window.nodesManager?.nodes.find(node => node.id === selectedNodeId);
  if (!n) {
    panel.innerHTML = '<div class="placeholder">Узел не найден.</div>';
    selectedNodeId = null;
    renderNodeList(document.getElementById('nodeListContainer'));
    return;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const { X, Y } = (() => {
    try {
      const p = proj4('EPSG:4326', 'EPSG:28405', [n.latlng.lng, n.latlng.lat]);
      return { X: Math.round(p[0]), Y: Math.round(p[1]) };
    } catch { return { X: '—', Y: '—' }; }
  })();

  const nameShown = n.name ? esc(n.name) : `Узел №${n.id}`;

  panel.innerHTML = `
    <div class="editor-header">
      <h3>${nameShown}</h3>
      <div class="header-meta">X: ${X}, Y: ${Y}</div>
      <div class="header-actions">
        <button class="icon-button node-goto-btn" data-id="${n.id}" title="Показать на карте">
          <img src="icons/gps.svg" alt="Показать на карте">
        </button>
        <button class="icon-button node-zone-btn" data-toggle="${n.id}" title="${n._rfZoneActive ? "Скрыть зону" : "Построить зону"}">
          <img src="icons/fresnel.svg" alt="Зона">
        </button>
        <button class="icon-button delete-btn node-remove-btn" data-del="${n.id}" title="Удалить">
          <img src="icons/delete.svg" alt="Удалить">
        </button>
      </div>
    </div>
    <div class="editor-body">
      <div class="form-grid-compact">
        <label>Имя узла:</label>
        <input type="text" class="node-name-input" data-id="${n.id}" value="${esc(n.name || '')}" maxlength="3" placeholder="1-999">

        <label>Тип устройства:</label>
        <select class="node-type-select" data-id="${n.id}">${Object.entries(NODE_TYPES).map(([k,v])=>`<option value="${k}" ${k===n.type?'selected':''}>${esc(v.label)}</option>`).join("")}</select>

        <label>Мощность устройства, dBm:</label>
        <input type="number" class="lora-param" data-param="txPowerDbm" value="${n.lora.txPowerDbm}">

        <label>Частота, МГц:</label>
        <input type="number" class="lora-param" data-param="freqHz" value="${(n.lora.freqHz||0)/1e6}">

        <label>Усиление антенны, dB:</label>
        <input type="number" class="lora-param" data-param="txAntGainDb" value="${n.lora.txAntGainDb}">

        <label>Чувствительность, dBm:</label>
        <input type="number" class="lora-param" data-param="rxSensDbm" value="${n.lora.rxSensDbm}">

        <label>Высота подъёма антенны, м:</label>
        <input type="number" class="lora-param" data-param="txH" value="${n.lora.txH}">
      </div>
    </div>
  `;
  attachNodeHandlers(panel, n);
}

// Обработчики для редактора
function attachNodeHandlers(root, node) {
  if (!root || !node) return;

  root.querySelector('.node-remove-btn')?.addEventListener('click', (e) => window.nodesManager.removeNode(Number(e.currentTarget.dataset.del)));

  root.querySelector('.node-goto-btn')?.addEventListener('click', () => {
    if (window.map && node.latlng) {
      window.map.setView(node.latlng, 16);
      document.getElementById('closeNodeModalBtn')?.click();
    }
  });

  root.querySelector('.node-name-input')?.addEventListener('change', (e) => {
    node.name = e.target.value.replace(/\D/g, '').slice(0, 3);
    window.nodesManager.updateNodeGlyph(node);
    window.nodesManager._saveToStorage();
    updateNodeList();
  });

  root.querySelector('.node-type-select')?.addEventListener('change', (e) => {
    node.type = e.target.value;
    window.nodesManager._saveToStorage();
    updateNodeList();
  });

  root.querySelectorAll('.lora-param').forEach(input => {
    input.addEventListener('change', (e) => {
      let value = Number(e.target.value);
      const param = e.target.dataset.param;
      if (param === 'freqHz') value *= 1e6; // ввод в МГц → храним в Гц
      node.lora[param] = value;
      window.nodesManager._saveToStorage();
    });
  });

  root.querySelector('.node-zone-btn')?.addEventListener('click', (e) => {
    const button = e.currentTarget;
    node._rfZoneActive = !node._rfZoneActive;
    if (node._rfZoneActive) {
      if (window.RFZone) RFZone.showCoverage({node});
    } else {
      if (window.RFZone) RFZone.hideCoverage(node);
    }
    button.title = node._rfZoneActive ? "Скрыть зону" : "Построить зону";
  });
}

// Инициализация панели и списка
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addNewNodeFromModalBtn')?.addEventListener('click', () => {
    window.nodesManager?.createNode(window.map.getCenter(), true);
  });
  document.getElementById('nodeSearchInput')?.addEventListener('input', () => {
    renderNodeList(document.getElementById('nodeListContainer'));
  });
});

// Экспортируемые функции
function initNodesManager() {
  if (window.map) {
    window.nodesManager = new NodesManager(window.map);
    window.map.on("move zoom resize", () => window.nodesManager.updatePositions());
  }
}

function setNodeVisible(id, visible) {
  const m = window.nodesManager;
  if (!m) return;
  const node = m.nodes.find(n => n.id === Number(id));
  if (!node) return;
  node.visible = !!visible;
  m.updateNodeVisibility(node);
  try { m._saveToStorage?.(); } catch {}
}

window.initNodesManager = initNodesManager;
window.updateNodeList = updateNodeList;
window.setNodeVisible = setNodeVisible;
