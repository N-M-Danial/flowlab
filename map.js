/* ============================================================
   KL Traffic LOS Dashboard — map.js
   Pixel-perfect match to original KL_Traffic_LOS_17Feb2026.html
   Data is fetched from /api/traffic-data instead of being baked in.
   ============================================================ */

// ── Module-level state (populated after API fetch) ────────────────────────────
let TRAFFIC_DATA = {};
let ROAD_COORDS  = {};
let MAP_BOUNDS   = null;

const LOS_COLOR = {
  A:'#00c853', B:'#7ecb20', C:'#ffd600',
  D:'#ff9100', E:'#ff3d00', F:'#b71c1c'
};
const HOURS = [
  '12:00 AM','1:00 AM','2:00 AM','3:00 AM','4:00 AM','5:00 AM',
  '6:00 AM','7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM',
  '12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM',
  '6:00 PM','7:00 PM','8:00 PM','9:00 PM','10:00 PM','11:00 PM'
];

// ── Map setup (runs immediately — data loaded after) ──────────────────────────
const map = L.map('map', { zoomControl:false });

// Try tile providers in order
const TILE_PROVIDERS = [
  {
    url:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    opts: { attribution:'&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:19 }
  },
  {
    url:  'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    opts: { attribution:'&copy; Stadia Maps &copy; OpenStreetMap', maxZoom:20 }
  },
  {
    url:  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { attribution:'&copy; OpenStreetMap contributors', maxZoom:19 }
  }
];

let tileFailCount = 0;
function tryTileProvider(index) {
  if (index >= TILE_PROVIDERS.length) {
    document.getElementById('tile-status').style.display = 'block';
    return;
  }
  const p = TILE_PROVIDERS[index];
  const layer = L.tileLayer(p.url, p.opts);
  layer.on('tileerror', () => {
    tileFailCount++;
    if (tileFailCount > 3) {
      tileFailCount = 0;
      map.removeLayer(layer);
      tryTileProvider(index + 1);
    }
  });
  layer.addTo(map);
}
tryTileProvider(0);

// Popup styling — injected once
const ps = document.createElement('style');
ps.textContent = [
  '.road-popup .leaflet-popup-content-wrapper{background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.5);padding:6px 10px}',
  '.road-popup .leaflet-popup-tip{background:#161b22}',
  '.road-popup .leaflet-popup-content{margin:0;font-size:12px;font-weight:600}',
  '.info-popup .leaflet-popup-content-wrapper{background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.7);padding:10px 16px}',
  '.info-popup .leaflet-popup-tip{background:#161b22}',
  '.info-popup .leaflet-popup-content{margin:0}',
  '.info-popup .leaflet-popup-close-button{color:#8b949e!important;font-size:18px!important;top:6px!important;right:10px!important;}'
].join('');
document.head.appendChild(ps);

// Tick labels — built once
const tc = document.getElementById('tick-labels');
const majorTicks = [0,6,12,18,23];
for (let i = 0; i < 24; i++) {
  const t = document.createElement('span');
  t.className = 'tick' + (majorTicks.includes(i) ? ' major' : '');
  t.textContent = majorTicks.includes(i) ? HOURS[i] : '·';
  tc.appendChild(t);
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let maxVolume    = 0;
let roadLayers   = {};
let selectedRoad = null;
let currentHour  = 0;
let isPlaying    = false;
let playInterval = null;
let playSpeed    = 800;
let ROAD_ORDER   = [];


// ── Polyline helpers (handles LineString and MultiLineString) ─────────────────
function isMulti(coords) { return Array.isArray(coords[0][0]); }

function makePolyline(coords, opts) {
  if (isMulti(coords)) {
    const layers = coords.map(seg => L.polyline(seg.map(c => [c[1], c[0]]), opts));
    return L.layerGroup(layers);
  }
  return L.polyline(coords.map(c => [c[1], c[0]]), opts);
}

function setPolyStyle(layer, style) {
  if (layer instanceof L.LayerGroup) layer.eachLayer(l => l.setStyle(style));
  else layer.setStyle(style);
}

function getPolyWeight(layer) {
  let w = 4;
  if (layer instanceof L.LayerGroup) layer.eachLayer(l => { w = l.options.weight; });
  else w = layer.options.weight;
  return w;
}

function bindPolyEvents(layer, road) {
  const handler = poly => {
    poly.on('click', e => selectRoad(road, e.latlng));
    poly.on('mouseover', e => {
      if (road !== selectedRoad)
        setPolyStyle(layer, { opacity:1, weight:getPolyWeight(layer)+2 });
      if (!selectedRoad) {
        L.popup({ closeButton:false, className:'road-popup' })
          .setLatLng(e.latlng).setContent(road).openOn(map);
      }
    });
    poly.on('mouseout', () => {
      if (road !== selectedRoad)
        setPolyStyle(layer, { opacity:0.85, weight:getWeight(road, currentHour) });
      if (!selectedRoad) map.closePopup();
    });
  };
  if (layer instanceof L.LayerGroup) layer.eachLayer(handler);
  else handler(layer);
}

function getWeight(road, h) {
  const d = TRAFFIC_DATA[road]?.[h];
  return d ? Math.max(4, Math.round(4 + (d.total / maxVolume) * 10)) : 4;
}

// ── Build road layers on the map ──────────────────────────────────────────────
function buildMapLayers() {
  // Remove existing layers
  for (const road in roadLayers) {
    const layer = roadLayers[road];
    if (layer instanceof L.LayerGroup) layer.eachLayer(l => map.removeLayer(l));
    else map.removeLayer(layer);
  }
  roadLayers = {};

  const DEFAULT_STYLE = { color:'#00c853', weight:5, opacity:0.85, lineCap:'round', lineJoin:'round' };
  for (const road in ROAD_COORDS) {
    const layer = makePolyline(ROAD_COORDS[road], { ...DEFAULT_STYLE });
    layer.addTo(map);
    bindPolyEvents(layer, road);
    roadLayers[road] = layer;
  }
}

// ── Side panel ────────────────────────────────────────────────────────────────
function buildSidePanel() {
  const list = document.getElementById('road-list');
  list.innerHTML = '';
  for (const road of ROAD_ORDER) {
    if (!TRAFFIC_DATA[road]) continue;
    const row = document.createElement('div');
    row.className = 'road-row';
    row.id = 'row-' + road;
    const shortName = road.replace('Jalan ','Jln ').replace('Lebuhraya ','Leb. ');
    row.innerHTML = `
      <div class="road-row-top">
        <span class="road-name-txt" title="${road}">${shortName}</span>
        <span class="road-los-badge" id="badge-${road}">—</span>
      </div>
      <div class="road-vc-bar-wrap">
        <div class="road-vc-bar-bg"><div class="road-vc-bar-fill" id="bar-${road}" style="width:0%"></div></div>
        <span class="road-vc-txt" id="vc-${road}">—</span>
      </div>
      <canvas class="road-spark" id="spark-${road}" width="196" height="22"></canvas>
    `;
    row.addEventListener('click', () => {
      const coords = ROAD_COORDS[road];
      if (coords) {
        const flat = Array.isArray(coords[0][0]) ? coords.flat() : coords;
        const lats = flat.map(c=>c[1]), lngs = flat.map(c=>c[0]);
        const midLat = (Math.min(...lats)+Math.max(...lats))/2;
        const midLng = (Math.min(...lngs)+Math.max(...lngs))/2;
        selectRoad(road, L.latLng(midLat, midLng));
        map.panTo([midLat, midLng]);
      }
    });
    list.appendChild(row);
  }
}

function drawSparkline(canvas, road, currentH) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const vals = TRAFFIC_DATA[road].map(d => d.vc);
  const max = Math.max(...vals, 1);
  // Background segments by LOS zone
  const zones = [
    {limit:0.60, color:'rgba(0,200,83,0.08)'},
    {limit:0.70, color:'rgba(126,203,32,0.08)'},
    {limit:0.80, color:'rgba(255,214,0,0.08)'},
    {limit:0.90, color:'rgba(255,145,0,0.08)'},
    {limit:1.00, color:'rgba(255,61,0,0.08)'},
    {limit:9999, color:'rgba(183,28,28,0.08)'}
  ];
  let prevY = H;
  for (const zone of zones) {
    const zoneY = H - (zone.limit / Math.min(max*1.1, 1.2)) * H;
    ctx.fillStyle = zone.color;
    ctx.fillRect(0, Math.max(0, zoneY), W, prevY - Math.max(0, zoneY));
    prevY = Math.max(0, zoneY);
    if (zoneY <= 0) break;
  }
  // Draw line
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length-1)) * W;
    const y = H - (v / Math.min(max*1.1, 1.2)) * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const d = TRAFFIC_DATA[road][currentH];
  ctx.strokeStyle = LOS_COLOR[d.los];
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Current hour marker
  const cx = (currentH / 23) * W;
  const cv = vals[currentH];
  const cy = H - (cv / Math.min(max*1.1, 1.2)) * H;
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI*2);
  ctx.fillStyle = LOS_COLOR[d.los];
  ctx.fill();
}

function updateSidePanel(h) {
  document.getElementById('side-hour-label').textContent = HOURS[h];
  for (const road of ROAD_ORDER) {
    const d = TRAFFIC_DATA[road]?.[h];
    if (!d) continue;
    const color = LOS_COLOR[d.los];
    const badge = document.getElementById('badge-'+road);
    const bar   = document.getElementById('bar-'+road);
    const vctxt = document.getElementById('vc-'+road);
    const spark = document.getElementById('spark-'+road);
    const row   = document.getElementById('row-'+road);
    if (badge) { badge.textContent = d.los; badge.style.background = color; }
    if (bar)   { bar.style.width = Math.min(d.vc*100, 100)+'%'; bar.style.background = color; }
    if (vctxt) { vctxt.textContent = d.vc.toFixed(2); }
    if (spark) { drawSparkline(spark, road, h); }
    if (row)   { row.classList.toggle('active', road === selectedRoad); }
  }
}

// ── Map update ────────────────────────────────────────────────────────────────
function updateMap(h) {
  currentHour = h;
  document.getElementById('hour-slider').value = h;
  document.getElementById('current-time').textContent = HOURS[h];
  const counts = {};
  for (const road in roadLayers) {
    const d = TRAFFIC_DATA[road]?.[h];
    if (!d) continue;
    setPolyStyle(roadLayers[road], { color:LOS_COLOR[d.los], weight:getWeight(road,h) });
    counts[d.los] = (counts[d.los]||0) + 1;
  }
  for (const g of ['A','B','C','D','E','F']) {
    const el = document.getElementById('sum-'+g);
    if (el) el.textContent = counts[g]||0;
  }
  updateSidePanel(h);
  if (selectedRoad) updateInfoPanel(selectedRoad, h);
}

// ── Info popup ────────────────────────────────────────────────────────────────
let infoPopup = null;

function buildPopupHTML(road, d) {
  if (!d) return '<div style="color:#8b949e;font-size:12px;">No data</div>';
  const color = LOS_COLOR[d.los];
  return `
    <div style="min-width:210px;">
      <div style="background:#21262d;margin:-10px -16px 10px;padding:8px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:13px;font-weight:700;color:#f0f6fc;">${road}</span>
        <span style="background:${color};color:#0d1117;font-weight:700;font-size:13px;padding:2px 8px;border-radius:4px;">${d.los}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr><td style="color:#8b949e;padding:2px 0;">V/C Ratio</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.vc.toFixed(4)}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Total Vehicles</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.total.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Volume (PCU)</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.pcu.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Capacity (PCU)</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.capacity.toLocaleString()}</td></tr>
        <tr><td colspan="2" style="border-top:1px solid #30363d;padding-top:6px;margin-top:4px;"></td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Cars</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.car.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Motorcycles</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.mc.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Vans</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.van.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Medium Lorries</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.ml.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Heavy Lorries</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.hl.toLocaleString()}</td></tr>
        <tr><td style="color:#8b949e;padding:2px 0;">Buses</td><td style="color:#e6edf3;font-weight:600;text-align:right;">${d.bus.toLocaleString()}</td></tr>
      </table>
    </div>`;
}

function selectRoad(road, latlng) {
  selectedRoad = road;
  map.closePopup();
  for (const r in roadLayers)
    setPolyStyle(roadLayers[r], { opacity: r===road ? 1.0 : 0.4 });
  document.querySelectorAll('.road-row').forEach(r => r.classList.remove('active'));
  document.querySelectorAll('.peak-row').forEach(r => r.classList.remove('active'));
  const activeRow = document.getElementById('row-'+road);
  if (activeRow) {
    activeRow.classList.add('active');
    activeRow.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
  const activePeakRow = document.getElementById('peak-row-'+road);
  if (activePeakRow) {
    activePeakRow.classList.add('active');
    activePeakRow.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
  const d = TRAFFIC_DATA[road]?.[currentHour];
  infoPopup = L.popup({
    className: 'info-popup',
    maxWidth: 260,
    autoPan: true,
    closeOnClick: false
  })
    .setLatLng(latlng)
    .setContent(buildPopupHTML(road, d))
    .openOn(map);
  infoPopup.on('remove', () => closeInfo());
}

function updateInfoPanel(road, h) {
  if (!infoPopup) return;
  const d = TRAFFIC_DATA[road]?.[h];
  infoPopup.setContent(buildPopupHTML(road, d));
}

function closeInfo() {
  selectedRoad = null;
  infoPopup = null;
  for (const r in roadLayers) setPolyStyle(roadLayers[r], { opacity:0.85 });
  document.querySelectorAll('.road-row').forEach(r => r.classList.remove('active'));
  document.querySelectorAll('.peak-row').forEach(r => r.classList.remove('active'));
}

// ── Playback controls ─────────────────────────────────────────────────────────
function onSlider(v)   { updateMap(parseInt(v)); }
function stepHour(d)   { updateMap(((currentHour+d)+24)%24); }

function togglePlay() {
  isPlaying = !isPlaying;
  const btn = document.getElementById('btn-play');
  if (isPlaying) {
    btn.textContent = '⏸ Pause'; btn.classList.add('active');
    playInterval = setInterval(() => updateMap((currentHour+1)%24), playSpeed);
  } else {
    btn.textContent = '▶ Play'; btn.classList.remove('active');
    clearInterval(playInterval);
  }
}

function setSpeed(ms) {
  playSpeed = ms;
  const ids = {1500:'btn-slow',800:'btn-norm',300:'btn-fast',100:'btn-faster'};
  for (const id of Object.values(ids)) document.getElementById(id)?.classList.remove('active');
  document.getElementById(ids[ms])?.classList.add('active');
  if (isPlaying) {
    clearInterval(playInterval);
    playInterval = setInterval(() => updateMap((currentHour+1)%24), playSpeed);
  }
}

// ── Peak Hour Detection panel ─────────────────────────────────────────────────
function buildPeakPanel() {
  const list = document.getElementById('peak-list');
  list.innerHTML = '';

  // For each road find the hour with the highest V/C ratio
  const peaks = [];
  for (const road of ROAD_ORDER) {
    const hourly = TRAFFIC_DATA[road];
    if (!hourly) continue;
    let bestH = 0, bestVC = -1;
    hourly.forEach((d, h) => {
      if (d.vc > bestVC) { bestVC = d.vc; bestH = h; }
    });
    const bestD = hourly[bestH];
    peaks.push({ road, hour: bestH, vc: bestVC, los: bestD.los });
  }

  // Sort by worst V/C descending
  peaks.sort((a, b) => b.vc - a.vc);

  peaks.forEach((p, idx) => {
    const color     = LOS_COLOR[p.los];
    const shortName = p.road.replace('Jalan ','Jln ').replace('Lebuhraya ','Leb. ');

    const row = document.createElement('div');
    row.className = 'peak-row';
    row.id = 'peak-row-' + p.road;
    row.innerHTML = `
      <div class="peak-rank">#${idx + 1} worst</div>
      <div class="peak-road-name" title="${p.road}">${shortName}</div>
      <div class="peak-details">
        <span class="peak-time">${HOURS[p.hour]}</span>
        <span class="peak-vc">V/C ${p.vc.toFixed(2)}</span>
        <span class="peak-los-badge" style="background:${color}">${p.los}</span>
      </div>
    `;

    // Clicking a peak row pans the map to that road and jumps to its peak hour
    row.addEventListener('click', () => {
      // Jump timeline to peak hour
      updateMap(p.hour);

      // Pan map to road midpoint
      const coords = ROAD_COORDS[p.road];
      if (coords) {
        const flat = Array.isArray(coords[0][0]) ? coords.flat() : coords;
        const lats = flat.map(c => c[1]), lngs = flat.map(c => c[0]);
        const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
        const midLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
        selectRoad(p.road, L.latLng(midLat, midLng));
        map.panTo([midLat, midLng]);
      }

      // Highlight active row
      document.querySelectorAll('.peak-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });

    list.appendChild(row);
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────
function applyData(json) {
  TRAFFIC_DATA = json.trafficData;
  ROAD_COORDS  = json.roadCoords;
  MAP_BOUNDS   = json.mapBounds;

  // Subtitle
  document.getElementById('subtitle-text').textContent = isPredictedMode
    ? `${json.roadCount} Road Corridors · AI Predicted (Next Day)`
    : `${json.roadCount} Monitored Road Corridors · CCTV AI Camera Data`;

  // Compute max volume for stroke-weight scaling
  maxVolume = 0;
  for (const road in TRAFFIC_DATA)
    for (const h of TRAFFIC_DATA[road])
      if (h.total > maxVolume) maxVolume = h.total;

  ROAD_ORDER = Object.keys(TRAFFIC_DATA).sort();

  // Fit map bounds
  map.fitBounds(MAP_BOUNDS, { padding:[30,30] });

  // Reset selection state
  selectedRoad = null;
  infoPopup    = null;

  // Rebuild layers and UI
  buildMapLayers();
  buildSidePanel();
  buildPeakPanel();
  updateMap(0);
}

function showLoading(msg) {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = msg || 'Loading…';
  overlay.style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}

async function loadData() {
  showLoading('Loading traffic data…');
  try {
    const resp = await fetch('/api/traffic-data');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Unknown error');
    applyData(json);
  } catch (err) {
    document.getElementById('loading-text').textContent =
      '⚠ ' + err.message + '\nUpload your data files to continue.';
    // Don't hide overlay — keep visible with the error message
    return;
  }
  hideLoading();
}

// ── Upload handler ────────────────────────────────────────────────────────────
async function handleUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const status = document.getElementById('upload-status');
  status.className = '';
  status.textContent = 'Uploading…';
  showLoading('Processing uploaded file…');

  const fd = new FormData();
  fd.append('file', file);

  try {
    const resp = await fetch('/api/upload', { method:'POST', body:fd });
    const json = await resp.json();

    if (!json.success) throw new Error(json.error || 'Upload failed');

    applyData(json);
    status.className = 'ok';
    status.textContent = '✓ Data refreshed';
    setTimeout(() => { status.textContent = ''; }, 4000);
  } catch (err) {
    status.className = 'err';
    status.textContent = '✗ ' + err.message;
  } finally {
    hideLoading();
    input.value = ''; // reset so same file can be re-uploaded
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────


// ── Prediction mode state ─────────────────────────────────────────────────────
let isPredictedMode = false;

async function togglePrediction() {
  isPredictedMode = !isPredictedMode;
  const btn = document.getElementById('btn-predict');

  if (isPredictedMode) {
    btn.classList.add('active');
    btn.textContent = 'Live View';
    document.body.classList.add('predicted-mode');
    showLoading('Loading predicted data…');
    try {
      const resp = await fetch('/api/predicted-data');
      const json = await resp.json();
      if (!json.success) throw new Error(json.error || 'Predicted data unavailable');
      // Override subtitle to make it clear this is predicted
      json.dateLabel = 'AI Predicted (Next Day)';
      applyData(json);
    } catch (err) {
      document.getElementById('loading-text').textContent = '⚠ ' + err.message;
      // Revert toggle state on failure
      isPredictedMode = false;
      btn.classList.remove('active');
      btn.textContent = 'AI Prediction';
      document.body.classList.remove('predicted-mode');
      return;
    }
    hideLoading();
  } else {
    btn.classList.remove('active');
    btn.textContent = 'AI Prediction';
    document.body.classList.remove('predicted-mode');
    // Reload live data
    await loadData();
  }
}

// ──────────────────────────────────────────────────

loadData();

// ── Camera locations ──────────────────────────────────────────────────────────
const cameraLayer = L.layerGroup().addTo(map);
let camerasVisible = true;
let cameraMarkers = []; // store refs for fly-to

fetch('/api/camera-locations')
  .then(r => r.json())
  .then(json => {
    if (!json.success) return;

    const dropdown = document.getElementById('camera-dropdown');

    // Group by road
    const byRoad = {};
    json.cameras.forEach(cam => {
      if (!byRoad[cam.road]) byRoad[cam.road] = [];
      byRoad[cam.road].push(cam);
    });

    json.cameras.forEach(cam => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:10px;height:10px;border-radius:50%;background:#00b4d8;border:2px solid #fff;box-shadow:0 0 4px rgba(0,180,216,0.8);"></div>`,
        iconSize: [10, 10], iconAnchor: [5, 5],
      });
      const marker = L.marker([cam.lat, cam.lng], { icon })
        .bindPopup(`<div style="font-size:12px;color:#e6edf3;"><b style="color:#00b4d8">${cam.camera_id}</b><br>${cam.road}</div>`,
          { className: 'info-popup' })
        .addTo(cameraLayer);
      cameraMarkers.push({ cam, marker });
    });

    document.getElementById('btn-cameras').textContent = `Browse Cameras (${json.cameras.length})`;

    // Build dropdown grouped by road
    Object.entries(byRoad).forEach(([road, cams]) => {
      const header = document.createElement('div');
      header.textContent = road;
      header.style.cssText = 'padding:6px 12px 4px;font-size:10px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:0.6px;border-top:1px solid #30363d;';
      dropdown.appendChild(header);

      cams.forEach(cam => {
        const item = document.createElement('div');
        item.textContent = cam.camera_id;
        item.style.cssText = 'padding:6px 16px;font-size:12px;color:#e6edf3;cursor:pointer;transition:background 0.1s;';
        item.onmouseover = () => item.style.background = '#1c2128';
        item.onmouseout  = () => item.style.background = '';
        item.onclick = () => {
          map.flyTo([cam.lat, cam.lng], 17, { duration: 1 });
          // show the layer if hidden
          if (!camerasVisible) {
            camerasVisible = true;
            cameraLayer.addTo(map);
            document.getElementById('btn-cameras').classList.add('active');
          }
          // open that marker's popup
          const found = cameraMarkers.find(m => m.cam.camera_id === cam.camera_id);
          if (found) found.marker.openPopup();
          document.getElementById('camera-dropdown').style.display = 'none';
        };
        dropdown.appendChild(item);
      });
    });
  });

function toggleCameraDropdown() {
  const dd = document.getElementById('camera-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function toggleCameras() {
  camerasVisible = !camerasVisible;
  camerasVisible ? cameraLayer.addTo(map) : map.removeLayer(cameraLayer);
  document.getElementById('btn-cameras').classList.toggle('active', camerasVisible);
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('#btn-cameras') && !e.target.closest('#camera-dropdown')) {
    const dd = document.getElementById('camera-dropdown');
    if (dd) dd.style.display = 'none';
  }
});



//-------------------- PERFECT WORKING VERSION AS OF 25 FEB 2026
