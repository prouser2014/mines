/** map.js Картография проекта. */
(function () {
  "use strict";

  // Создание карты
  window.map = L.map("map", {
    attributionControl: false,
    zoomControl: false,
  }).setView([48.776151, 44.669464], 14); // о-в Зелёный, Волгоград

  // Отрисовка зоны радиопокрытия. 
  (function ensureFresnelPane() {
    try {
      const pane = window.map.createPane("fresnel-pane");
      pane.style.zIndex = 510;
      pane.style.pointerEvents = "none";
    } catch (e) {
      console.debug("[map] fresnel-pane: создать не удалось", e);
    }
  })();

  // Источники базового слоя карты
  const baseLayers = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }),
    opentopo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors",
      maxZoom: 17,
    }),
    "google-hybrid": L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
      attribution: "© Google",
      maxZoom: 20,
    }),
    "google-sat": L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
      attribution: "© Google",
      maxZoom: 20,
    }),
  };

  let currentLayer = baseLayers.osm.addTo(window.map);
  window.currentLayer = currentLayer;
  window.baseLayers = baseLayers;

  // Переключение базового слоя
  window.setBaseLayer = function setBaseLayer(key) {
    if (!baseLayers[key]) return;
    try { if (currentLayer) window.map.removeLayer(currentLayer); } catch {}
    currentLayer = baseLayers[key].addTo(window.map);
    window.currentLayer = currentLayer;
  };

  // Кнопки зума на карте
  window._controls = window._controls || {};
  window._controls.zoom = L.control.zoom({ position: "topright" });
  window._controls.zoom.addTo(window.map);

  // Обновление позиций объектов при движении/зуме
  window.refresh = function refresh() {
    window.nodesManager?.updatePositions?.();
    window.minesManager?.updatePositions?.();
  };
  window.map.on("move zoom resize", window.refresh);
  window.addEventListener("resize", window.refresh);

  // Иконки для правого бокового меню
  const searchIcon = () => `<img class="icon" src="icons/search.svg" width="18" height="18" alt="Поиск">`;
  const locateIcon = () => `<img class="icon" src="icons/gps.svg" width="18" height="18" alt="Моё местоположение">`;
  const clearIcon  = () => `<img class="icon" src="icons/delete.svg" width="18" height="18" alt="Очистить карту">`;

  // Кнопка поиска
  class SearchControl extends L.Control {
    onAdd(map) {
      const el = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-control-search");
      el.innerHTML = `<a href="#" title="Поиск">${searchIcon()}</a>`;
      el.onclick = (e) => {
        e.preventDefault();
        document.getElementById("searchModal")?.classList.add("show");
      };
      return el;
    }
  }

  // Кнопка "Найди меня"
  class LocateControl extends L.Control {
    onAdd(map) {
      const el = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-control-locate");
      el.innerHTML = `<a href="#" title="Моё местоположение">${locateIcon()}</a>`;
      el.onclick = (e) => {
        e.preventDefault();
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            map.setView([latitude, longitude], Math.max(map.getZoom(), 16));
            const m = L.circleMarker([latitude, longitude], {
              radius: 7,
              color: "#2196f3",
              weight: 2,
              fillColor: "#2196f3",
              fillOpacity: 0.6,
            }).addTo(map);
            setTimeout(() => { try { map.removeLayer(m); } catch {} }, 2000);
          },
          (err) => console.debug("[locate] error:", err),
          { enableHighAccuracy: true, timeout: 7000, maximumAge: 10000 }
        );
      };
      return el;
    }
  }

  // Кнопка "очистка карты"
  class ClearMapControl extends L.Control {
    onAdd(map) {
      const el = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-control-clear");
      el.innerHTML = `<a href="#" title="Очистить карту">${clearIcon()}</a>`;
      el.onclick = (e) => {
        e.preventDefault();
        const btn = document.getElementById("clearMapBtn");
        if (btn) btn.click();
        else console.debug("[clear] #clearMapBtn не найден");
      };
      return el;
    }
  }

  // Размещение кнопок
  try { window._controls.search = new SearchControl({ position: "topright" }); window._controls.search.addTo(window.map); } catch {}
  try { window._controls.locate = new LocateControl({ position: "topright" }); window._controls.locate.addTo(window.map); } catch {}
  try { window._controls.clear  = new ClearMapControl({ position: "topright" }); window._controls.clear.addTo(window.map); } catch {}

  // Управление видимостью кнопок
  window.setControlVisible = function (key, visible) {
    try {
      const c = (window._controls || {})[key];
      if (!c || !window.map) return;
      const has = !!c._map;
      if (visible && !has) c.addTo(window.map);
      if (!visible && has) window.map.removeControl(c);
    } catch (e) {
      console.debug("[controls] setControlVisible:", key, e);
    }
  };

  // Поисковая панель (вкладки и обработчики)
  (function wireSearchUI() {
    const $ = (id) => document.getElementById(id);

    const tabBtns = Array.from(document.querySelectorAll(".tabs .tab"));
    const panes = { tabCoords: $("tabCoords"), tabAddress: $("tabAddress") };
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const target = btn.getAttribute("data-tab");
        Object.keys(panes).forEach((k) => {
          panes[k]?.toggleAttribute("hidden", k !== target);
        });
      });
    });

    $("btnGoCoords")?.addEventListener("click", () => {
      const lat = parseFloat($("latInput")?.value);
      const lng = parseFloat($("lngInput")?.value);
      if (!isFinite(lat) || !isFinite(lng)) return;
      try { window.map.setView([lat, lng], Math.max(window.map.getZoom(), 16)); } catch {}
    });

    $("btnSearch")?.addEventListener("click", async () => {
      const q = $("searchInput")?.value?.trim();
      const box = $("searchResults");
      if (!q || !box) return;
      box.innerHTML = "Ищем…";
      try {
        const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=12&q=" + encodeURIComponent(q);
        const r = await fetch(url, { headers: { "Accept-Language": "ru" } });
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) {
          box.innerHTML = "<em>Ничего не найдено.</em>";
          return;
        }
        box.innerHTML = data.map((it) => `
          <div class="search-item" data-lat="${it.lat}" data-lon="${it.lon}">
            <div class="search-item-title">${(it.display_name || "").replace(/</g, "&lt;")}</div>
            <div class="search-item-subtitle">${it.type || ""} (${it.class || ""})</div>
          </div>
        `).join("");

        Array.from(box.querySelectorAll(".search-item")).forEach(div => {
          div.addEventListener("click", () => {
            const lat = parseFloat(div.getAttribute("data-lat"));
            const lon = parseFloat(div.getAttribute("data-lon"));
            if (isFinite(lat) && isFinite(lon)) {
              window.map.setView([lat, lon], 17);
              document.getElementById("searchModal")?.classList.remove("show");
            }
          });
        });
      } catch (e) {
        console.debug("[search] nominatim:", e);
        box.innerHTML = "<em>Ошибка поиска.</em>";
      }
    });

    $("latInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnGoCoords")?.click(); });
    $("lngInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnGoCoords")?.click(); });
    $("searchInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSearch")?.click(); });
  })();

  // Индикатор масштаба (метры/пиксель)
  (function wireScale() {
    const el = document.getElementById("mapScale");
    if (!el) return;
    const update = () => {
      const lat = window.map?.getCenter()?.lat ?? 0;
      const mpp = 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, window.map.getZoom());
      const text = mpp >= 1000 ? `≈ ${(mpp / 1000).toFixed(2)} км/пкс` : `≈ ${mpp.toFixed(1)} м/пкс`;
      el.textContent = text;
    };
    window.map.on("move zoom", update);
    update();
  })();

  // Отображение офлайн карты
  if (typeof window.MBTilesOverlay !== "function") {
    const TRANSPARENT_PX =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO0QAAAABJRU5ErkJggg==";

    class MBTilesOverlay extends L.GridLayer {
      constructor(db, meta = {}, opts = {}) {
        super({ tileSize: 256, updateWhenIdle: false, ...opts });
        this._db = db;
        this._format = (meta.format || "png").toLowerCase();
        this._scheme = (meta.scheme || "tms").toLowerCase();
        this._stmt = null;
        this._cache = new Map();
        this.setZIndex(650);
      }
      _ensureStmt() {
        if (!this._stmt) {
          this._stmt = this._db.prepare("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?");
        }
      }
      _tmsY(z, y) { const n = 1 << z; return (n - 1 - y); }
      _mime() { return this._format.startsWith("jp") ? "image/jpeg" : "image/png"; }
      _getTileData(coords) {
        try {
          const y = (this._scheme === "xyz") ? coords.y : this._tmsY(coords.z, coords.y);
          const key = `${coords.z}_${coords.x}_${y}`;
          if (this._cache.has(key)) return this._cache.get(key);
          this._ensureStmt();
          this._stmt.bind([coords.z, coords.x, y]);
          const has = this._stmt.step();
          const obj = has ? this._stmt.getAsObject() : null;
          this._stmt.reset();
          const buf = obj?.tile_data || null;
          if (buf) this._cache.set(key, buf);
          return buf;
        } catch (e) {
          console.debug("[mbtiles] query:", e);
          return null;
        }
      }
      createTile(coords, done) {
        const img = document.createElement("img");
        img.alt = "";
        L.DomEvent.on(img, "load", () => {
          done(null, img);
          if (img._objectURL) setTimeout(() => URL.revokeObjectURL(img._objectURL), 3000);
        });
        L.DomEvent.on(img, "error", () => done(null, img));
        const data = this._getTileData(coords);
        if (!data) { img.src = TRANSPARENT_PX; return img; }
        const blob = new Blob([data], { type: this._mime() });
        const url = URL.createObjectURL(blob);
        img._objectURL = url;
        img.src = url;
        return img;
      }
      onRemove(map) { try { this._stmt?.free(); } catch {} super.onRemove(map); }
    }
    window.MBTilesOverlay = MBTilesOverlay;
  }

  // Открытие MBTiles, установка как базового слоя и позиционирование карты
  async function openMbtiles(file) {
    try {
      const buf = await file.arrayBuffer();
      const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/" + f });
      const db = new SQL.Database(new Uint8Array(buf));
      const meta = {};
      try {
        const res = db.exec("SELECT name, value FROM metadata");
        res?.[0]?.values.forEach(([name, value]) => { meta[name] = value; });
      } catch {}
      if (window.setBaseLayer) window.setBaseLayer("osm");
      try { window.mbtilesLayer?.remove(); } catch {}
      window.mbtilesLayer = new MBTilesOverlay(db, meta, { attribution: "MBTiles overlay" });
      window.mbtilesLayer.addTo(window.map);

      if (meta.bounds) {
        const b = meta.bounds.split(",").map(Number);
        if (b.length === 4 && b.every(isFinite)) {
          window.map.fitBounds(L.latLngBounds(L.latLng(b[1], b[0]), L.latLng(b[3], b[2])));
        }
      } else if (meta.center) {
        const c = meta.center.split(",").map(Number);
        if (c.length >= 2 && c.slice(0, 2).every(isFinite)) {
          const z = Number.isFinite(c[2]) ? c[2] : Math.max(window.map.getZoom(), 10);
          window.map.setView([c[1], c[0]], z);
        }
      }
    } catch (e) {
      console.error("[mbtiles] open:", e);
      throw e;
    }
  }
  window.openMbtiles = openMbtiles;

  // Переключатели источника карты (онлайн/MBTiles)
  (function wireMapSourceRadios() {
    const radios = Array.from(document.querySelectorAll('input[name="mapSource"]'));
    if (!radios.length) return;
    let prevSource = radios.find(r => r.checked)?.value || "osm";
    if (prevSource === "mbtiles") prevSource = "osm";

    function activateOnline(val) {
      try { window.mbtilesLayer?.remove(); window.mbtilesLayer = null; } catch {}
      if (window.setBaseLayer) window.setBaseLayer(val);
      prevSource = val;
    }
    function promptMbtiles() {
      const input = document.getElementById("mbtilesInput");
      if (!input) return alert("Поле выбора MBTiles не найдено.");
      const revert = () => {
        const r = document.querySelector(`input[name="mapSource"][value="${prevSource}"]`);
        if (r) r.checked = true;
        activateOnline(prevSource);
      };
      input.value = "";
      input.onchange = (e) => {
        const f = e.target.files?.[0];
        input.onchange = null;
        if (f) { Promise.resolve(openMbtiles(f)).catch(revert); }
        else { revert(); }
      };
      input.click();
    }
    radios.forEach(r => {
      r.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        const val = e.target.value;
        if (val === "mbtiles") { promptMbtiles(); }
        else { activateOnline(val); }
      });
    });
    activateOnline(prevSource);
  })();

  // Выдвижная панель быстрого доступа
  (function wireSlideOutPanel() {
    const container = document.getElementById("slideOutContainer");
    const toggleBtn = document.getElementById("slideOutToggle");
    if (!container || !toggleBtn) return;

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = container.classList.toggle("open");
      if (isOpen) {
        toggleBtn.innerHTML = "&gt;";
        toggleBtn.title = "Закрыть панель";
      } else {
        toggleBtn.innerHTML = "&lt;";
        toggleBtn.title = "Открыть панель";
      }
    });
  })();

})();
