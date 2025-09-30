/** dem.js Загрузка рельефа местности. */
// Публичный API:
//   window.loadHgtArchive(file: File) — загрузить ZIP-файл с *.hgt
//   window.getElevation(lat: number, lng: number) => number|NaN (м)
//   window.hasLineOfSight(a:{lat,lng}, hA:number, b:{lat,lng}, hB:number) => boolean

(function () {
  'use strict';

  const HGT_NODATA = -32768;
  // key: 'N59E030' → { rows, cols, data:Int16Array, endian:'BE'|'LE' }
  const tiles = new Map();

  // --- Вспомогательные функции
  const pad = (n, w) => {
    const s = String(Math.abs(n));
    return s.length >= w ? s : '0'.repeat(w - s.length) + s;
  };
  function tileKeyFromLatLng(lat, lng) {
    // Математические расчёты и обработки строк до вывода отладочной информации
    if (lng === 180) lng = 179.999999;
    if (lat === 90)  lat = 89.999999;

    const latFloor = Math.floor(lat);
    const lngFloor = Math.floor(lng);
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    return `${ns}${pad(latFloor, 2)}${ew}${pad(lngFloor, 3)}`.toUpperCase();
  }
  function tileKeyFromFilename(path) {
    const base = path.split('/').pop().split('\\').pop();
    const m = /^([NS]\d{2}[EW]\d{3})\.hgt$/i.exec(base);
    return m ? m[1].toUpperCase() : null;
  }
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
  const clean = v => (v === HGT_NODATA ? NaN : v);
  function lerp(a, b, t) {
    if (Number.isNaN(a) && Number.isNaN(b)) return NaN;
    if (Number.isNaN(a)) return b;
    if (Number.isNaN(b)) return a;
    return a + (b - a) * t;
  }
  function haversineMeters(a, b) {
    const R = 6_371_000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = s1*s1 + Math.cos(lat1)*Math.cos(lat2)*s2*s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function logTileRange(key, size) {
    const lat0 = (key[0] === 'N' ? +key.slice(1, 3) : -+key.slice(1, 3));
    const isEast = key[3] === 'E';
    const lngAbs = +key.slice(4);
    const lng0 = isEast ? lngAbs : -lngAbs;
    const prettyLng0 = (isEast ? 'E' : 'W') + pad(lngAbs, 3);
    const prettyLng1 = (isEast ? 'E' : 'W') + pad(lngAbs + 1, 3);
    const prettyLat0 = (lat0 >= 0 ? 'N' : 'S') + pad(Math.abs(lat0), 2);
    const prettyLat1 = (lat0 + 1 >= 0 ? 'N' : 'S') + pad(Math.abs(lat0 + 1), 2);
    console.debug(`HGT: ${key} (${size}x${size}), lat ${prettyLat0}-${prettyLat1}, lng ${prettyLng0}-${prettyLng1}`);
    return { lat0, lng0 };
  }

  // --- Распаковка и предварительная обработка файлов рельефа
  async function loadHgtArchive(file) {
    console.debug('[DEM] load archive:', file && file.name);
    if (!file) return;

    if (typeof JSZip === 'undefined') {
      console.error('[DEM] JSZip not found. Include jszip.min.js before dem.js');
      alert('JSZip не найден. Подключите jszip.min.js до dem.js');
      return;
    }

    try {
      const zip = await JSZip.loadAsync(file);
      tiles.clear();

      const entries = Object.values(zip.files).filter(z => z.name.toLowerCase().endsWith('.hgt'));
      if (!entries.length) {
        alert('В архиве не найдено *.hgt');
        return;
      }

      for (const z of entries) {
        const key = tileKeyFromFilename(z.name);
        if (!key) { console.debug('[DEM] пропуск файла:', z.name); continue; }

        const buf = await z.async('arraybuffer');
        const n = buf.byteLength >>> 1;         // число int16
        const size = Math.round(Math.sqrt(n));  // 1201 (SRTM3) или 3601 (SRTM1)
        if (size * size !== n) {
          console.debug('[DEM] пропуск (длина файла не ожидаемая):', z.name, buf.byteLength);
          continue;
        }

        const dv = new DataView(buf);
        const readInt16Array = (littleEndian) => {
          const out = new Int16Array(n);
          for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, littleEndian);
          return out;
        };

        // Исправление неправильной загрузки координат
        const be = readInt16Array(false);
        let bad = 0, samples = 0;
        for (let i = 0; i < 1000 && i < n; i++) {
          const idx = (i * 977) % n;
          const v = be[idx];
          if (v < -500 || v > 9000 || (Math.abs(v) >= 1024 && (Math.abs(v) % 256) === 0)) bad++;
          samples++;
        }

        let data, endian = 'BE';
        if (samples && bad > samples * 0.3) {
          data = readInt16Array(true);
          endian = 'LE';
          console.warn('[DEM] обнаружен little-endian HGT:', z.name);
        } else {
          data = be;
        }

        tiles.set(key, { rows: size, cols: size, data, endian });
        logTileRange(key, size);
      }

      console.debug('[DEM] загружено тайлов:', tiles.size);
    } catch (e) {
      console.error('[DEM] ошибка загрузки архива:', e);
      alert(`Ошибка загрузки архива: ${e.message}`);
    }
  }

  // --- Получение высоты (м)
  function getElevation(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NaN;
    if (!tiles.size) return NaN;

    const key = tileKeyFromLatLng(lat, lng);
    const t = tiles.get(key);
    if (!t) return NaN;

    const { rows, cols, data } = t;

    // Положение внутри тайла (0..cols-1, 0..rows-1).
    // x — на восток, y — на юг. В HGT (0,0) — северо-запад.
    const latFloor = Math.floor(lat);
    const lngFloor = Math.floor(lng);
    const u = (lng - lngFloor) * (cols - 1);
    const v = (1 - (lat - latFloor)) * (rows - 1);

    const x0 = clamp(Math.floor(u), 0, cols - 1);
    const y0 = clamp(Math.floor(v), 0, rows - 1);
    const x1 = clamp(x0 + 1, 0, cols - 1);
    const y1 = clamp(y0 + 1, 0, rows - 1);

    const q11 = clean(data[y0 * cols + x0]);
    const q21 = clean(data[y0 * cols + x1]);
    const q12 = clean(data[y1 * cols + x0]);
    const q22 = clean(data[y1 * cols + x1]);

    const fx = u - x0;
    const fy = v - y0;

    const r1 = lerp(q11, q21, fx);
    const r2 = lerp(q12, q22, fx);
    const h  = lerp(r1, r2, fy);

    return h; // может быть NaN, если вокруг NODATA
  }

  // --- Прямая видимость (без кривизны Земли и Френеля)
  function hasLineOfSight(a, hA, b, hB) {
    if (!a || !b) return false;

    // Высоты антенн над грунтом.
    const gA = getElevation(a.lat, a.lng);
    const gB = getElevation(b.lat, b.lng);
    const startAlt = (Number.isFinite(gA) ? gA : 0) + (Number.isFinite(hA) ? hA : 0);
    const endAlt   = (Number.isFinite(gB) ? gB : 0) + (Number.isFinite(hB) ? hB : 0);

    const dist = haversineMeters(a, b);
    if (!Number.isFinite(dist) || dist <= 0) return true;

    const step = 30; // м
    const steps = Math.max(2, Math.ceil(dist / step));
    const dLng = (b.lng - a.lng) / steps;
    const dLat = (b.lat - a.lat) / steps;

    // Небольшой зазор над прямой (м)
    const clearance = 2;

    for (let i = 1; i < steps; i++) {
      const lat = a.lat + dLat * i;
      const lng = a.lng + dLng * i;
      const h = getElevation(lat, lng);
      if (!Number.isFinite(h)) continue;

      const f = i / steps;
      const lineAlt = startAlt + (endAlt - startAlt) * f + clearance;
      if (h > lineAlt) return false;
    }
    return true;
  }

  // --- Экспорт данных
  window.loadHgtArchive = loadHgtArchive;
  window.getElevation = getElevation;
  window.hasLineOfSight = hasLineOfSight;
})();
