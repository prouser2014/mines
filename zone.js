/** zone.js Расчет зоны радиовидимости. */
(function (global) {
  "use strict";

  // Физические константы
  const R_EARTH_M = 6_371_000; // Средний радиус Земли в метрах (6,371 км)
  const K_FACTOR = 1.33;                 // К-фактор (1.33)
  const R_EFF_M = R_EARTH_M * K_FACTOR; // Эффективный радиус Земли в метрах
  const MARGIN_DB = 12;                  // запас по чувствительности
  const COLOR_GRAY = "#9aa0a6";          // цвет лучей при отсутствии файла рельефа
  const WINDOW_HALF_M = 50;              // Половина ширины "окна"
  const DEYGOUT_MIN_SEG_M = 5; // Минимальная длина отрезка пути
  const DEYGOUT_V_CUTOFF  = -0.78;       // Пороговое значение для параметра дифракции
  const DEYGOUT_MAX_DEPTH = 20; // Максимальная глубина рекурсии для алгоритма

  // дополнительные потери радиосигнала
  const N_EXP_DEFAULT = 3.3; // Экспонента потерь пути по умолчанию
  const N_BREAK_M = 1000; // "Точка перелома" в метрах
  const NEAR_GROUND_H_M = 10; // Пороговая высота антенн в метрах
  function excessLossDb(dMeters, nEff) { // Средний радиус Земли в метрах (6,371 км)
    if (!Number.isFinite(dMeters) || dMeters <= N_BREAK_M || nEff <= 2) return 0; // Средний радиус Земли в метрах (6,371 км)
    return 10 * (nEff - 2) * Math.log10(dMeters / N_BREAK_M); // Средний радиус Земли в метрах (6,371 км)
  }

  // Canvas-рендер для Leaflet
  let cachedRenderer = null;
  function ensurePane(map) {
    if (!map?.getPane) return;
    if (!map.getPane("fresnel-pane")) {
      map.createPane?.("fresnel-pane");
      const pane = map.getPane("fresnel-pane");
      if (pane) { pane.style.zIndex = 410; pane.style.pointerEvents = "none"; }
    }
  }
  function ensureRenderer(map) {
    if (!map) return null;
    ensurePane(map);
    if (!cachedRenderer) cachedRenderer = L.canvas({ padding: 0.5, pane: "fresnel-pane" });
    return cachedRenderer;
  }

  // Геометрия и работа с рельефом
  function hasDemAt(lat, lng) {
    if (typeof global.getElevation !== "function") return false;
    const h = global.getElevation(lat, lng);
    return Number.isFinite(h);
  }
  const deg2rad = d => d * Math.PI / 180;
  const rad2deg = r => r * 180 / Math.PI;

  // Прямая геодезическая задача 
  function destPoint(lat, lng, azRad, dist) {
    const R = 6_371_000, δ = dist / R, φ1 = deg2rad(lat), λ1 = deg2rad(lng), θ = azRad;
    const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
    const φ2 = Math.asin(sinφ2);
    const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
    const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
    const λ2 = λ1 + Math.atan2(y, x);
    let lng2 = rad2deg(λ2);
    if (lng2 > 180) lng2 -= 360;
    if (lng2 < -180) lng2 += 360;
    return { lat: rad2deg(φ2), lng: lng2 };
  }

  // Потери при распространении сигнала в свободном пространстве
  function fsplDb(dMeters, fMHz) {
    const dkm = Math.max(0.001, dMeters / 1000);
    return 32.44 + 20 * Math.log10(dkm) + 20 * Math.log10(Math.max(1, fMHz));
  }

  // «Выпуклость» эффективной Земли (м)
  function earthBulge(d1, d2) { return (d1 * d2) / (2 * R_EFF_M); }

  // Потери на дифракцию по модели "острого края"
  function knifeEdgeLossDb(v) {
    if (v <= -0.78) return 0;
    const t = Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1;
    return 6.9 + 20 * Math.log10(t);
  }

  // Параметр дифракции
  function vParam(hObs, d1, d2, fMHz) {
    if (d1 <= 0 || d2 <= 0) return -999;
    const lambda = 299_792_458 / (fMHz * 1e6);
    return hObs * Math.sqrt((2 / lambda) * ((d1 + d2) / (d1 * d2)));
  }

  // Палитра по запасу по мощности(дБ)
  if (!global.Radio) global.Radio = {};
  global.Radio._marginColor = function (m) {
    if (!Number.isFinite(m)) return COLOR_GRAY;
    if (m < 0)   return "transparent";
    if (m < 3)   return "#fbbc04";
    if (m < 12)  return "#34a853";
    return "#0b8043";
  };

  // Модель дифракции Дейгута
  function findDominantApex(profile, s, e, hS, hE, fMHz) {
    let vmax = -Infinity, imax = -1;
    const span = e - s;
    if (!(span > 0)) return { imax, vmax };

    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      if (!p || !Number.isFinite(p.d) || !Number.isFinite(p.terr)) continue;
      const dObs = p.d;
      if (!(dObs > s && dObs < e)) continue;

      const d1 = dObs - s, d2 = e - dObs;
      if (!(d1 > 0 && d2 > 0)) continue;

      const hLine = hS + (hE - hS) * (d1 / span);
      const bulge = earthBulge(d1, d2);
      const hObs  = (p.terr + bulge) - hLine;
      const v     = vParam(hObs, d1, d2, fMHz);
      if (Number.isFinite(v) && v > vmax) { vmax = v; imax = i; }
    }
    return { imax, vmax };
  }

  function deygoutLoss(profile, s, e, hS, hE, fMHz, depth = 0) {
    if (depth > DEYGOUT_MAX_DEPTH) return 0;
    const span = e - s;
    if (!(span > DEYGOUT_MIN_SEG_M)) return 0;

    const { imax, vmax } = findDominantApex(profile, s, e, hS, hE, fMHz);
    if (imax < 0 || vmax <= DEYGOUT_V_CUTOFF) return 0;

    const L0 = knifeEdgeLossDb(vmax);
    const apex = profile[imax];
    const dA   = apex.d;
    const hA   = apex.terr;

    const L1 = deygoutLoss(profile, s, dA, hS, hA, fMHz, depth + 1);
    const L2 = deygoutLoss(profile, dA, e, hA, hE, fMHz, depth + 1);
    return L0 + L1 + L2;
  }

  // Трассировщик лучей
  function createPolarTracer(node, opts) {
    const origin = (opts && opts.origin) || node.latlng;
    const S = 360;
    const Rmax = Math.max(1000, Math.floor((opts && (opts.maxDist || opts.radius)) || 20000));

    const stepMeters = 100;
    const ringStep   = 100;

    // Радиопараметры
    const fMHz   = Number((opts && opts.freqMHz) || 433);
    const txH    = Number.isFinite(opts?.txH) ? Number(opts.txH) : 1.5;
    const rxHdef = Number.isFinite(opts?.rxH) ? Number(opts.rxH) : 1.5;
    const Pt     = Number(opts?.txPowerDbm ?? 14);
    const Gt     = Number(opts?.txAntGainDb ?? 0);
    const GrDef  = Number(opts?.rxAntGainDb ?? 0);
    const SensDef= Number(opts?.rxSensDbm   ?? -123);
    const rayOv  = opts?.rayOverrides || [];

    // Абсолютная высота передатчика
    const elevTx = (typeof global.getElevation === "function")
      ? global.getElevation(origin.lat, origin.lng)
      : 0;
    const hTxAbs = (Number.isFinite(elevTx) ? elevTx : 0) + txH;

    const azStep = (2 * Math.PI) / S;

    // Переменные и массивы для трасировки
    const profiles = Array.from({ length: S }, () => []);
    const azArr    = Array.from({ length: S }, (_, i) => i * azStep);
    const stopped  = new Array(S).fill(false);
    const badCount = new Array(S).fill(0);

    let lastDistComputed = 0;

    // Досчёт до нужной дистанции (м) 
    function extend(toMeters) {
      toMeters = Math.min(Rmax, Math.max(lastDistComputed, Math.ceil(toMeters / ringStep) * ringStep));
      if (toMeters <= lastDistComputed) return;

      for (let si = 0; si < S; si++) {
        if (stopped[si]) continue;

        const az = azArr[si];
        const prof = profiles[si];
        const ov = rayOv[si] || null;

        let dStart = Math.max(stepMeters, lastDistComputed + stepMeters);
        for (let d = dStart; d <= toMeters; d += stepMeters) {
          if (stopped[si]) break;

          const ll = destPoint(origin.lat, origin.lng, az, d);
          const terr = (typeof global.getElevation === "function") ? global.getElevation(ll.lat, ll.lng) : NaN;

          // Параметры приёмника в «окне»
          let Gr = GrDef, Sens = SensDef, rxHuse = rxHdef;
          if (ov && d >= ov.windowStart && d <= ov.windowEnd) {
            if (Number.isFinite(ov.rxAntGainDb)) Gr = ov.rxAntGainDb;
            if (Number.isFinite(ov.rxSensDbm))   Sens = ov.rxSensDbm;
            if (Number.isFinite(ov.rxH))         rxHuse = ov.rxH;
          }
          const hRxAbs = (Number.isFinite(terr) ? terr : 0) + rxHuse;

          // Потери
          const Lfs  = fsplDb(d, fMHz);

          let Ldif = 0;
          if (prof.length > 0) {
            const sub = prof.map(s => ({ d: s.d, terr: Number.isFinite(s.terr) ? s.terr : -Infinity }));
            Ldif = deygoutLoss(sub, 0, d, hTxAbs, hRxAbs, fMHz, 0);
            if (!Number.isFinite(Ldif) || Ldif < 0) Ldif = 0;
          }

          const nearGround = (txH < NEAR_GROUND_H_M) && (rxHuse < NEAR_GROUND_H_M);
          const nEff = nearGround ? N_EXP_DEFAULT : 2.0;
          const Lenv = excessLossDb(d, nEff);

          // Уровень на входе и запас
          const Pr = Pt + Gt + Gr - (Lfs + Ldif + Lenv);
          const residual = Pr - Sens - MARGIN_DB;

          prof.push({ d, ll, terr, residual });

          // Обрыв луча после 10 шагов (1000 м) с residual <= 0
          if (residual <= 0) {
            badCount[si] += 1;
            if (badCount[si] >= 10) stopped[si] = true;
          } else {
            badCount[si] = 0;
          }
        }
      }
      lastDistComputed = toMeters;
    }

    return {
      origin,
      S, Rmax, stepMeters, ringStep,
      get profiles() { return profiles; },
      get lastDist() { return lastDistComputed; },
      extend
    };
  }

  // Отрисовка свежего «кольца» профилей
  function renderProfilesRing({ profiles, origin, layer, renderer, fromMeters, toMeters }) {
    const buckets = new Map(); // color → segments[]
    const pushSeg = (color, a, b) => {
      if (!a || !b) return;
      if (!buckets.has(color)) buckets.set(color, []);
      buckets.get(color).push([a, b]);
    };
    const colorOf = (resid, ll) => {
      if (!hasDemAt(ll.lat, ll.lng)) return COLOR_GRAY;
      return (typeof Radio._marginColor === "function") ? Radio._marginColor(resid) : "#888";
    };

    for (let si = 0; si < profiles.length; si++) {
      const prof = profiles[si];
      if (!prof?.length) continue;

      let j = 0;
      while (j < prof.length && prof[j].d <= fromMeters) j++;
      if (j >= prof.length) continue;

      let lead;
      if (j - 1 >= 0) {
        const p = prof[j - 1];
        lead = [p.ll.lat, p.ll.lng];
      } else if (fromMeters <= 0) {
        lead = [origin.lat, origin.lng];
      } else {
        lead = null;
      }

      for (; j < prof.length; j++) {
        const pt = prof[j];
        if (pt.d > toMeters) break;
        const c   = colorOf(pt.residual, pt.ll);
        const cur = [pt.ll.lat, pt.ll.lng];
        if (lead) pushSeg(c, lead, cur);
        lead = cur;
      }
    }

    // Отрисовка рассчитанных сегментов лучей на карте
    buckets.forEach((segments, color) => {
      L.polyline(segments, {
        color,
        weight: 2.5,
        opacity: 1,
        smoothFactor: 1.0,
        renderer,
        pane: "fresnel-pane",
        interactive: false
      }).addTo(layer);
    });
  }

  // Добавочная трассировка для корреспондентов
  function bearing(a, b) {
    const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
    const Δλ = (b.lng - a.lng) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(ф1 = φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let az = Math.atan2(y, x) * 180 / Math.PI;
    if (az < 0) az += 360;
    if (az >= 360) az -= 360;
    if (Object.is(az, -0)) az = 0;
    az = Math.round(az * 1e6) / 1e6;
    return Number.isFinite(az) ? az : 0;
  }
  function computeSectorIndex(originLL, targetLL, sectors) {
    const az = bearing(originLL, targetLL);
    const step = 360 / sectors;
    let idx = Math.floor(az / step);
    if (Math.abs(az - idx * step) < 1e-9) idx = (idx + 1) % sectors; // граничный случай
    return idx;
  }
  function buildRayOverrides({ originLL, sectors, rxDefault, others }) {
    const rayOverrides = new Array(sectors).fill(null);
    if (!Array.isArray(others) || !others.length) return rayOverrides;

    others.forEach(n => {
      if (!n?.latlng) return;
      const targetLL = n.latlng;
      const idx = computeSectorIndex(originLL, targetLL, sectors);
      const distMeters = global.map ? global.map.distance(originLL, targetLL) : null;
      const d = Number.isFinite(distMeters) ? distMeters : 0;
      rayOverrides[idx] = {
        windowStart: Math.max(0, d - WINDOW_HALF_M),
        windowEnd: d + WINDOW_HALF_M,
        rxH: Number.isFinite(n?.lora?.rxH) ? n.lora.rxH : rxDefault,
        rxAntGainDb: Number.isFinite(n?.lora?.rxAntGainDb) ? n.lora.rxAntGainDb : undefined,
        rxSensDbm: Number.isFinite(n?.lora?.rxSensDbm) ? n.lora.rxSensDbm : undefined
      };
    });

    return rayOverrides;
  }

  // Публичный API
  const RFZone = {
    layer: null,
    _raf: 0,
    _movePreviewActive: false,
    _movePreviewNodeId: null,
    _tracer: null,
    _ringFrom: 0,
    _ringStep: 100,
    _radius: 0,

    hideCoverage(node) {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this.layer) {
        try {
          if (this.layer instanceof L.LayerGroup) {
            this.layer.clearLayers();
            this.layer.remove();
          } else {
            this.layer.remove();
          }
        } catch (e) { console.debug("[rfzone][hideCoverage]", e); }
      }
      this.layer = null;
      this._tracer = null;
      this._ringFrom = 0;

      if (node) {
        node._coverageHidden = true;
        node._coverageStale = true;
        if (node.petals) node.petals.layer = null;
      }
    },

    beginMovePreview(args) {
      const node = args && (args.node || args);
      try { this.hideCoverage(node); } catch (e) { console.debug("[rfzone][beginMovePreview]", e); }
      this._movePreviewActive = true;
      this._movePreviewNodeId = node && node.id || null;
    },

    endMovePreview() {
      this._movePreviewActive = false;
      this._movePreviewNodeId = null;
    },

    showCoverage(arg1, arg2) {
      let node, map, status = () => {}, opts = {};
      if (arg1 && typeof arg1 === "object" && "node" in arg1) {
        node = arg1.node;
        map = arg1.map || global.map;
        status = arg1.status || (() => {});
        opts = { radius: arg1.radius };
      } else {
        node = arg1;
        map = (arg2 && arg2.map) || global.map;
        status = (arg2 && arg2.status) || (() => {});
        opts = arg2 || {};
      }
      if (!node?.latlng || !map) return;

      this.hideCoverage();
      const renderer = ensureRenderer(map);
      if (!renderer) return;
      this.layer = L.layerGroup([], { pane: "fresnel-pane" }).addTo(map);

      // Радиопараметры из узла 
      const lora = node.lora || {};
      const freqMHz = (() => {
        const fmhz = Number(lora.freqMHz);
        const fhz  = Number(lora.freqHz);
        if (Number.isFinite(fmhz) && fmhz > 0) return fmhz;
        if (Number.isFinite(fhz)  && fhz  > 0) return fhz / 1e6;
        return 433;
      })();
      const txPowerDbm = Number(lora.txPowerDbm ?? 14);
      const txAntGainDb = Number(lora.txAntGainDb ?? 0);
      const rxAntGainDb = Number(lora.rxAntGainDb ?? 0);
      const rxSensDbm   = Number(lora.rxSensDbm   ?? -123);
      const txH = Number(lora.txH ?? 1.5);
      const rxH = Number(lora.rxH ?? 1.5);

      const sectors = 360;
      const radius  = Math.max(1000, Math.floor(opts.radius ?? lora.radius ?? 20000));
      this._radius = radius;

      const originLL = node.latlng;
      const others = (global.nodesManager && Array.isArray(global.nodesManager.nodes))
        ? global.nodesManager.nodes.filter(n => n && n.id !== node.id)
        : [];
      const rayOverrides = buildRayOverrides({ originLL, sectors, rxDefault: rxH, others });

      // Прогрессивный расчёт/отрисовка (кольца по 100 м)
      this._tracer = createPolarTracer(node, {
        origin: originLL,
        radius,
        freqMHz,
        txPowerDbm, txAntGainDb, rxAntGainDb, rxSensDbm, txH, rxH,
        rayOverrides
      });
      this._ringStep = 100;
      this._ringFrom = 0;

      const drawNextRing = () => {
        if (!this.layer || !this._tracer) { this._raf = 0; return; }

        const to = Math.min(this._radius, this._ringFrom + this._ringStep);

        // 1) расчёт профилей до внешней границы кольца
        this._tracer.extend(to);

        // 2) отрисовка только свежего диапазона
        renderProfilesRing({
          profiles: this._tracer.profiles,
          origin: this._tracer.origin,
          layer: this.layer,
          renderer,
          fromMeters: this._ringFrom,
          toMeters: to
        });

        this._ringFrom = to;

        if (this._ringFrom < this._radius) {
          this._raf = requestAnimationFrame(drawNextRing);
        } else {
          this._raf = 0;
        }
      };

      this._raf = requestAnimationFrame(drawNextRing);

      node._coverageHidden = false;
      node._coverageStale = false;
      if (!node.petals) node.petals = {};
      node.petals.layer = this.layer;
    }
  };

  global.RFZone = RFZone;
})(window);
