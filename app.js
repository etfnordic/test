import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev";

/* --- Poll + animation tuning --- */
const POLL_MS = 3000;
const ANIM_MIN_MS = 350;
const ANIM_MAX_MS = Math.min(POLL_MS * 0.85, 2500);

let refreshing = false;

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
    'Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>',
}).addTo(map);

const markers = new Map();
const lastPos = new Map();
const lastBearing = new Map();
const bearingEstablished = new Map();

let timer = null;

/* ----------------------------
   Hover/Pin label-state
----------------------------- */
let hoverTrainId = null;
let hoverLabelMarker = null;

let pinnedTrainId = null;
let pinnedLabelMarker = null;

let isPointerOverTrain = false;

function buildLabelText(v) {
  if (v.unknown) return "?";
  return v.headsign ? `${v.line} → ${v.headsign}` : v.line;
}

function hideHoverLabel(trainId) {
  if (hoverTrainId !== trainId) return;
  if (pinnedTrainId === trainId) return;

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }
  hoverTrainId = null;
}

function showHoverLabel(v, pos) {
  if (pinnedTrainId === v.id) return;

  if (hoverTrainId && hoverTrainId !== v.id && hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }

  hoverTrainId = v.id;
  const icon = makeLabelIcon(v, buildLabelText(v), v.speedKmh, false);

  if (!hoverLabelMarker) {
    hoverLabelMarker = L.marker(pos, {
      icon,
      interactive: false,
      zIndexOffset: 2000,
    }).addTo(map);
  } else {
    hoverLabelMarker.setLatLng(pos);
    hoverLabelMarker.setIcon(icon);
  }
}

function togglePinnedLabel(v, pos) {
  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }
  isPointerOverTrain = false;

  if (pinnedTrainId === v.id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
    return;
  }

  if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);

  const icon = makeLabelIcon(v, buildLabelText(v), v.speedKmh, true);

  pinnedTrainId = v.id;
  pinnedLabelMarker = L.marker(pos, {
    icon,
    interactive: false,
    zIndexOffset: 2500,
  }).addTo(map);
}

map.on("click", () => {
  if (pinnedLabelMarker) {
    map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }

  closeSubchipPanel();
  isPointerOverTrain = false;
});

map.on("mousemove", () => {
  if (
    !isPointerOverTrain &&
    hoverTrainId &&
    hoverLabelMarker &&
    pinnedTrainId !== hoverTrainId
  ) {
    hideHoverLabel(hoverTrainId);
  }
});

/* ----------------------------
   Animation helpers
----------------------------- */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function computeAnimMs(fromLatLng, toLatLng) {
  const p1 = map.latLngToLayerPoint(fromLatLng);
  const p2 = map.latLngToLayerPoint(toLatLng);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const distPx = Math.sqrt(dx * dx + dy * dy);
  const ms = distPx * 7;
  return clamp(ms, ANIM_MIN_MS, ANIM_MAX_MS);
}

function animateTrainTo(m, toPos, durationMs, onFrame) {
  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  const from = m.arrowMarker.getLatLng();
  const to = L.latLng(toPos[0], toPos[1]);

  const dLat = Math.abs(from.lat - to.lat);
  const dLng = Math.abs(from.lng - to.lng);
  if (dLat < 1e-8 && dLng < 1e-8) {
    m.arrowMarker.setLatLng(to);
    onFrame?.(to);
    m.anim = null;
    return;
  }

  const start = performance.now();
  const anim = { raf: null };
  m.anim = anim;

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutCubic(t);

    const lat = from.lat + (to.lat - from.lat) * e;
    const lng = from.lng + (to.lng - from.lng) * e;
    const cur = L.latLng(lat, lng);

    m.arrowMarker.setLatLng(cur);
    onFrame?.(cur);

    if (t < 1) anim.raf = requestAnimationFrame(step);
    else {
      anim.raf = null;
      m.anim = null;
    }
  };

  anim.raf = requestAnimationFrame(step);
}

/* ----------------------------
   Utilities
----------------------------- */
function normalizeLine(rawLine) {
  const s = String(rawLine ?? "").trim();
  const m = s.match(/(\d+\s*[A-Z]+|\d+)/i);
  return (m ? m[1] : s).replace(/\s+/g, "").toUpperCase();
}

function normalizeDesc(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/* ============================
   BUS + BOAT colors & category
============================ */

/* Buss-huvudfärg (chip) */
const BUS_COLOR = "#020224";

/* Buss-kategori färger */
const BUS_RED = "#BA0D2B";
const BUS_BLUE = "#015CA3";
const BUS_REPL = "#F28C28";

/* Närtrafiken */
const BUS_NEAR_BG = "#FFFFFF";
const BUS_NEAR_STROKE = BUS_RED;

/* Tokens i selectedLines för buss-kategorier */
const BUS_RED_TOKEN = "__BUS_RED__";
const BUS_BLUE_TOKEN = "__BUS_BLUE__";
const BUS_REPL_TOKEN = "__BUS_REPL__";
const BUS_NEAR_TOKEN = "__BUS_NEAR__";

/* Båt */
const BOAT_COLOR = "#4A4AE0"; // marinblå (huvudchip)
const BOAT_PENDEL_BG = "#007DB8"; // ljusblå
const BOAT_WAX_YELLOW = "#F2C94C";
const BOAT_WAX_BLUE = "#1E4ED8";

/* Tokens för båt-kategorier */
const BOAT_PENDEL_TOKEN = "__BOAT_PENDEL__";
const BOAT_WAX_TOKEN = "__BOAT_WAX__";

function busCategoryTokenFromDesc(desc) {
  const d = normalizeDesc(desc);

  // Närtrafiken
  if (d.includes("nartrafik")) return BUS_NEAR_TOKEN;

  // Ersättning
  if (d.includes("ersatt") || d.includes("ersat")) return BUS_REPL_TOKEN;

  // Blå buss
  if (d.includes("blabuss") || d.includes("bla buss") || d.includes("blue"))
    return BUS_BLUE_TOKEN;

  // Fallback: default röd
  return BUS_RED_TOKEN;
}

function busCategoryTokenForVehicle(v) {
  return busCategoryTokenFromDesc(v?.desc);
}

function busColorStyleForVehicle(v) {
  const token = busCategoryTokenForVehicle(v);

  if (token === BUS_BLUE_TOKEN)
    return { bg: BUS_BLUE, labelText: "#FFFFFF", iconFill: BUS_BLUE, iconStroke: BUS_COLOR };
  if (token === BUS_REPL_TOKEN)
    return { bg: BUS_REPL, labelText: "#FFFFFF", iconFill: BUS_REPL, iconStroke: BUS_COLOR };

  if (token === BUS_NEAR_TOKEN) {
    // Vit + rödsträckad
    return {
      bg: BUS_NEAR_BG,
      labelText: BUS_NEAR_STROKE,
      labelBorder: `2px dashed ${BUS_NEAR_STROKE}`,
      iconFill: BUS_NEAR_BG,
      iconStroke: BUS_NEAR_STROKE,
      iconStrokeDash: "10 6",
    };
  }

  return { bg: BUS_RED, labelText: "#FFFFFF", iconFill: BUS_RED, iconStroke: BUS_COLOR };
}

function hasAnyBusCategoryToken() {
  return (
    selectedLines.has(BUS_RED_TOKEN) ||
    selectedLines.has(BUS_BLUE_TOKEN) ||
    selectedLines.has(BUS_REPL_TOKEN) ||
    selectedLines.has(BUS_NEAR_TOKEN)
  );
}

function boatCategoryTokenFromDesc(desc) {
  const d = normalizeDesc(desc);
  if (d.includes("pendelbat")) return BOAT_PENDEL_TOKEN;
  if (d.includes("waxholmsbolaget") || d.includes("waxholm")) return BOAT_WAX_TOKEN;
  // okänd båt -> default pendelbåt-look
  return BOAT_PENDEL_TOKEN;
}

function boatCategoryTokenForVehicle(v) {
  return boatCategoryTokenFromDesc(v?.desc);
}

function boatStyleForVehicle(v) {
  const token = boatCategoryTokenForVehicle(v);

  if (token === BOAT_WAX_TOKEN) {
    const bg = `linear-gradient(90deg,${BOAT_WAX_YELLOW} 0%,${BOAT_WAX_YELLOW} 50%,${BOAT_WAX_BLUE} 50%,${BOAT_WAX_BLUE} 100%)`;
    return {
      bg,
      labelText: "FFFFFF",
      iconType: "gradient",
      iconStroke: BOAT_COLOR,
    };
  }

  return {
    bg: BOAT_PENDEL_BG,
    labelText: "FFFFFF",
    iconType: "solid",
    iconFill: BOAT_PENDEL_BG,
    iconStroke: BOAT_COLOR,
  };
}

function hasAnyBoatCategoryToken() {
  return selectedLines.has(BOAT_PENDEL_TOKEN) || selectedLines.has(BOAT_WAX_TOKEN);
}

/* ============================
   Visible-category helpers (NEW)
============================ */

function getVisibleBusCategoryTokens() {
  const s = new Set();
  for (const m of markers.values()) {
    const v = m?.lastV;
    if (v?.type === 700) s.add(busCategoryTokenForVehicle(v));
  }
  return s;
}

function getVisibleBoatCategoryTokens() {
  const s = new Set();
  for (const m of markers.values()) {
    const v = m?.lastV;
    if (v?.type === 1000) s.add(boatCategoryTokenForVehicle(v));
  }
  return s;
}

function hasAnyVisibleType(type) {
  for (const m of markers.values()) {
    if (m?.lastV?.type === type) return true;
  }
  return false;
}

/* ============================
   Rail colors (unchanged)
============================ */
function colorForRailLine(line) {
  const l = normalizeLine(line);

  if (l === "7") return "#878C85";
  if (l === "10" || l === "11") return "#0091D2";
  if (l === "12") return "#738BA4";
  if (l === "13" || l === "14") return "#D71D24";
  if (l === "17" || l === "18" || l === "19") return "#00B259";
  if (l === "21") return "#B76934";
  if (l === "25" || l === "26") return "#21B6BA";
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE";
  if (l === "30" || l === "31") return "#E08A32";
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48")
    return "#ED66A5";

  return "#111827";
}

function darkenHex(hex, amount = 0.01) {
  const clamp255 = (v) => Math.max(0, Math.min(255, v));
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const dr = clamp255(Math.round(r * (1 - amount)));
  const dg = clamp255(Math.round(g * (1 - amount)));
  const db = clamp255(Math.round(b * (1 - amount)));

  return `#${dr.toString(16).padStart(2, "0")}${dg
    .toString(16)
    .padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

function headingFromPoints(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

/* ----------------------------
   Icons
----------------------------- */

// Rail arrow SVG
function railArrowSvg(fillColor, strokeColor, sizePx = 24) {
  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 50 L92 10 L62 50 L92 90 Z"
        fill="${fillColor}"
        stroke="${strokeColor}"
        stroke-width="4"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function unknownArrowSvg(fillColor, strokeColor, sizePx = 18) {
  // Avlång likbent triangel: bas till vänster, spets åt höger
  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 18 L12 82 L90 50 Z"
        fill="${fillColor}"
        stroke="${strokeColor}"
        stroke-width="5"
        stroke-linejoin="round"
      />
    </svg>
  `;
}


function makeRailIcon(line, bearingDeg, pop = false) {
  const color = colorForRailLine(line);
  const stroke = darkenHex(color, 0.01);

  const hasBearing = Number.isFinite(bearingDeg);
  const rot = hasBearing ? bearingDeg + 90 : 0;

  const html = `
    <div class="vehWrap railWrap ${hasBearing ? "hasBearing" : ""} ${pop ? "pop" : ""}"
         style="--rot:${rot}deg; --fill:${color}; --stroke:${stroke}; --size:34px; --dotSize:16px;">
      <div class="vehArrow">
        ${railArrowSvg("var(--fill)", "var(--stroke)", 24)}
      </div>
      <div class="vehDot"></div>
    </div>
  `;

  return L.divIcon({
    className: "vehIconWrap trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}



function makeUnknownIcon(bearingDeg, pop = false) {
  const color = "#111827";
  const stroke = "#0b1220";

  const hasBearing = Number.isFinite(bearingDeg);
  const rot = hasBearing ? (((bearingDeg - 90) % 360) + 360) % 360 : 0;

  const html = `
    <div class="vehWrap unknownWrap ${hasBearing ? "hasBearing" : ""} ${pop ? "pop" : ""}"
         style="--rot:${rot}deg; --fill:${color}; --stroke:${stroke}; --size:24px; --dotSize:10px;">
      <div class="vehArrow">
        ${railArrowSvg("var(--fill)", "var(--stroke)", 22)}
      </div>
      <div class="vehDot"></div>
    </div>
  `;

  return L.divIcon({
    className: "vehIconWrap",
    html,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}


/* Buss/Boat-ikon: arrow SVG med valfri dash/gradient */
function arrowSvg({ fill, stroke, strokeWidth = 5, dash = null, gradient = null, sizePx = 22 }) {
  const dashAttr = dash ? `stroke-dasharray="${dash}"` : "";
  const defs = gradient
    ? `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${gradient.left}"/>
          <stop offset="50%" stop-color="${gradient.left}"/>
          <stop offset="50%" stop-color="${gradient.right}"/>
          <stop offset="100%" stop-color="${gradient.right}"/>
        </linearGradient>
      </defs>
    `
    : "";

  const fillAttr = gradient ? `url(#g)` : fill;

  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <path
        d="M10 50 L92 10 L62 50 L92 90 Z"
        fill="${fillAttr}"
        stroke="${stroke}"
        stroke-width="${strokeWidth}"
        stroke-linejoin="round"
        ${dashAttr}
      />
    </svg>
  `;
}

function busArrowFillOnly({ fill, sizePx = 26 }) {
  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 64 64"
         xmlns="http://www.w3.org/2000/svg"
         shape-rendering="geometricPrecision"
         style="display:block">
      <path
        d="
          M32 6
          C29.5 6 27.6 7.4 26.3 9.7
          L15.8 29
          C14.8 30.8 15.2 33.0 16.8 34.2
          C18.4 35.4 20.8 35.1 22.3 33.5
          L30.2 25.2
          C31.2 24.2 32.8 24.2 33.8 25.2
          L41.7 33.5
          C43.2 35.1 45.6 35.4 47.2 34.2
          C48.8 33.0 49.2 30.8 48.2 29
          L37.7 9.7
          C36.4 7.4 34.5 6 32 6
          Z
        "
        fill="${fill}"
        stroke="none"
        fill-rule="evenodd"
      />
    </svg>
  `;
}


function makeBusIcon(bearingDeg, v) {
  const rot = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const size = 26;
  const style = busColorStyleForVehicle(v);

  const html = `
    <div class="vehWrap busWrap"
         style="--rot:${rot}deg; --fill:${style.iconFill}; --size:${size}px;">
      <div class="vehArrow" style="display:flex;">
        ${busArrowFillOnly({ fill: "var(--fill)", sizePx: size })}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "vehIconWrap busIconWrap",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}


function boatChevronSvg({ fill, sizePx = 24, gradient = null }) {
  const defs = gradient
    ? `
      <defs>
        <linearGradient id="boatGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${gradient.left}"/>
          <stop offset="50%" stop-color="${gradient.left}"/>
          <stop offset="50%" stop-color="${gradient.right}"/>
          <stop offset="100%" stop-color="${gradient.right}"/>
        </linearGradient>
      </defs>
    `
    : "";

  const strokeAttr = gradient ? "url(#boatGrad)" : fill;

  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 64 64"
         xmlns="http://www.w3.org/2000/svg"
         shape-rendering="geometricPrecision"
         style="display:block">
      ${defs}
      <path
        d="M22 14 L44 32 L22 50"
        fill="none"
        stroke="${strokeAttr}"
        stroke-width="14"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}


function makeBoatIcon(bearingDeg, v) {
  const rot = Number.isFinite(bearingDeg) ? bearingDeg - 90 : 0;
  const size = 24;
  const style = boatStyleForVehicle(v);

  const svg =
    style.iconType === "gradient"
      ? boatChevronSvg({
          sizePx: size,
          gradient: { left: BOAT_WAX_YELLOW, right: BOAT_WAX_BLUE },
        })
      : boatChevronSvg({
          sizePx: size,
          fill: "var(--fill)",
        });

  const fillForVar = style.iconFill ?? BOAT_PENDEL_BG;

  const html = `
    <div class="vehWrap boatWrap"
         style="--rot:${rot}deg; --fill:${fillForVar}; --size:${size}px;">
      <div class="vehArrow" style="display:flex;">
        ${svg}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "vehIconWrap boatIconWrap",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}


function getMarkerElCached(m) {
  if (m.el && m.el.isConnected) return m.el;
  const el = m.arrowMarker.getElement?.();
  if (el) m.el = el;
  return el || null;
}

function popOnce(el) {
  el.classList.add("pop");
  window.setTimeout(() => el.classList.remove("pop"), 350);
}

function updateRailOrUnknownEl(el, { rot, fill, stroke, hasBearing, pop }) {
  el.style.setProperty("--rot", `${rot}deg`);
  el.style.setProperty("--fill", fill);
  el.style.setProperty("--stroke", stroke);

  el.classList.toggle("hasBearing", !!hasBearing);
  if (pop) popOnce(el);
}

function updateBusEl(el, { rot, fill }) {
  el.style.setProperty("--rot", `${rot}deg`);
  el.style.setProperty("--fill", fill);
}

function updateBoatEl(el, { rot, fill }) {
  el.style.setProperty("--rot", `${rot}deg`);
  el.style.setProperty("--fill", fill);
}


function makeLabelIcon(v, labelText, speedKmh, pinned = false) {
  const text = `${labelText}${fmtSpeed(speedKmh)}`;

  let bg = colorForRailLine(v.line);
  let textColor = "#fff";
  let border = "1px solid rgba(0,0,0,0.25)";

  // Okänd -> svart label
  if (v.unknown) {
    bg = "#111827";
    textColor = "#fff";
    border = "1px solid rgba(0,0,0,0.35)";
  } else if (v.type === 700) {
    const st = busColorStyleForVehicle(v);
    bg = st.bg;
    textColor = st.labelText ?? "#fff";
    border = st.labelBorder ?? border;
  } else if (v.type === 1000) {
    const st = boatStyleForVehicle(v);
    bg = st.bg;
    textColor = st.labelText ?? "#fff";
    border = "1px solid rgba(0,0,0,0.25)";
  }

  const cls = pinned
    ? "trainLabel trainLabelPos trainLabelPinned"
    : "trainLabel trainLabelPos trainLabelHover";

  return L.divIcon({
    className: "trainLabelWrap",
    html: `
      <div class="${cls}" style="background:${bg}; color:${textColor}; border:${border};">
        ${text}
      </div>
    `,
    iconAnchor: [0, 0],
  });
}

/* ----------------------------
   enrich: line + headsign + type + desc
----------------------------- */
function enrich(v) {
  const tripId = v?.tripId;

  // Saknar tripId -> visa ändå (okänd)
  if (!tripId) {
    return {
      ...v,
      line: "?",
      headsign: null,
      type: null,
      desc: null,
      unknown: true,
    };
  }

  const info = TRIP_TO_LINE[tripId];

  // TripId finns men matchar inte i datafilen -> visa ändå (okänd)
  if (!info?.line) {
    return {
      ...v,
      line: "?",
      headsign: null,
      type: null,
      desc: null,
      tripId,
      unknown: true,
    };
  }

  // Match -> som vanligt
  return {
    ...v,
    line: info.line,
    headsign: info.headsign ?? null,
    type: info.type ?? null,
    desc: info.desc ?? null,
    unknown: false,
  };
}

/* =========================================================
   FILTER + CHIP UI
========================================================= */

const LS_KEY = "sl_live.selectedLines.v7";

let selectedLines = loadSelectedLines();

const MODE_DEFS = [
  {
    key: "metro",
    label: "Tunnelbana",
    chipBg:
      "linear-gradient(90deg,#00B259 0%,#00B259 33%,#D71D24 33%,#D71D24 66%,#0091D2 66%,#0091D2 100%)",
    lines: ["10", "11", "13", "14", "17", "18", "19"],
  },
  {
    key: "commuter",
    label: "Pendeltåg",
    chipBg: colorForRailLine("40"),
    lines: ["40", "41", "43", "43X", "48"],
  },
  { key: "tram", label: "Tvärbanan", chipBg: colorForRailLine("30"), lines: ["30", "31"] },
  {
    key: "roslags",
    label: "Roslagsbanan",
    chipBg: colorForRailLine("28"),
    lines: ["27", "27S", "28", "28S", "29"],
  },
  { key: "saltsjo", label: "Saltsjöbanan", chipBg: colorForRailLine("25"), lines: ["25", "26"] },
  { key: "lidingo", label: "Lidingöbanan", chipBg: colorForRailLine("21"), lines: ["21"] },
  { key: "nockeby", label: "Nockebybanan", chipBg: colorForRailLine("12"), lines: ["12"] },
  { key: "city", label: "Spårväg City", chipBg: colorForRailLine("7"), lines: ["7"] },

  // Buss (undermeny)
  { key: "bus", label: "Buss", chipBg: BUS_COLOR, lines: null },

  // Båt (undermeny)
  { key: "boat", label: "Färja", chipBg: BOAT_COLOR, lines: null },
];

function loadSelectedLines() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(normalizeLine) : []);
  } catch {
    return new Set();
  }
}
function saveSelectedLines() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...selectedLines]));
  } catch {}
}

function isShowNone() {
  return selectedLines.has("__NONE__");
}
function setShowNone() {
  selectedLines = new Set(["__NONE__"]);
  saveSelectedLines();
}
function setShowAll() {
  selectedLines = new Set(); // tom = allt
  saveSelectedLines();
}

function isLineSelected(line) {
  const l = normalizeLine(line);
  if (isShowNone()) return false;
  if (selectedLines.size === 0) return true;
  return selectedLines.has(l);
}

/**
 * Filter:
 * - __NONE__: inget
 * - empty set: allt
 * - non-empty:
 *    - spår: line i set
 *    - buss:
 *         om buss-kategorier valda -> matcha token via desc
 *         annars -> line i set
 *    - båt:
 *         om båt-kategorier valda -> matcha token via desc
 *         annars -> line i set
 */
function passesFilter(v) {
  if (isShowNone()) return false;

  // Inget filter -> visa allt, inklusive okända
  if (selectedLines.size === 0) return true;

  // Filter aktivt -> visa inte okända
  if (v.unknown) return false;

  const l = normalizeLine(v.line);

  if (v.type === 700) {
    if (hasAnyBusCategoryToken()) {
      const cat = busCategoryTokenForVehicle(v);
      return selectedLines.has(cat);
    }
    return selectedLines.has(l);
  }

  if (v.type === 1000) {
    if (hasAnyBoatCategoryToken()) {
      const cat = boatCategoryTokenForVehicle(v);
      return selectedLines.has(cat);
    }
    return selectedLines.has(l);
  }

  return selectedLines.has(l);
}

function toggleRailLineSelection(line) {
  const l = normalizeLine(line);
  if (!l) return;

  if (isShowNone() || selectedLines.size === 0) {
    selectedLines = new Set([l]);
    saveSelectedLines();
    return;
  }

  if (selectedLines.has(l)) selectedLines.delete(l);
  else selectedLines.add(l);

  if (selectedLines.size === 0) {
    setShowNone();
    return;
  }

  saveSelectedLines();
}

function toggleBusCategoryToken(token) {
  if (selectedLines.size === 0 || isShowNone()) {
    selectedLines = new Set([token]);
    saveSelectedLines();
    return;
  }

  if (selectedLines.has(token)) selectedLines.delete(token);
  else selectedLines.add(token);

  if (selectedLines.size === 0) {
    setShowNone();
    return;
  }

  saveSelectedLines();
}

function toggleBoatCategoryToken(token) {
  if (selectedLines.size === 0 || isShowNone()) {
    selectedLines = new Set([token]);
    saveSelectedLines();
    return;
  }

  if (selectedLines.has(token)) selectedLines.delete(token);
  else selectedLines.add(token);

  if (selectedLines.size === 0) {
    setShowNone();
    return;
  }

  saveSelectedLines();
}

function setSelectionFromSearch(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => normalizeLine(s))
    .filter((s) => s && s !== "__NONE__");

  if (parts.length === 0) return;

  selectedLines = new Set(parts);
  saveSelectedLines();
}

/* ----------------------------
   Chip DOM
----------------------------- */

let dockEl = null;
let rowEl = null;
let subPanelEl = null;
let subPanelModeKey = null;

let searchInputEl = null;
let searchBtnEl = null;

function ensureChipStylesOnce() {
  if (document.getElementById("chipDockStyles")) return;

  const style = document.createElement("style");
  style.id = "chipDockStyles";
  style.textContent = `
    .chipDock{
      position:absolute;
      top:10px;
      right:10px;
      z-index:9999;
      pointer-events:none;
      max-width:calc(100vw - 20px);
    }
    .chipRowTop{
      display:flex;
      flex-wrap:nowrap;
      gap:8px;
      align-items:center;
      justify-content:flex-end;
      overflow-x:auto;
      overflow-y:hidden;
      padding:2px;
      pointer-events:auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .chipRowTop::-webkit-scrollbar{ display:none; }

    .uiChipBtn{
      border:0;
      background:transparent;
      padding:0;
      cursor:pointer;
      user-select:none;
    }
    .uiChipBtn:active{ transform: translateY(1px); }

    .uiChipFace{
      border-radius: 10px;
      padding: 6px 10px;
      font: 600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:#fff;
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
      text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      white-space: nowrap;
    }

    .uiChipBtn.is-inactive .uiChipFace{
      background: rgba(120,120,120,0.30) !important;
      color: rgba(255,255,255,0.85);
      box-shadow: 0 6px 14px rgba(0,0,0,0.12);
      text-shadow:none;
      backdrop-filter: blur(1px);
    }

    .uiChipBtn.is-activeMode .uiChipFace{
      outline: 2px solid rgba(255,255,255,0.90);
      outline-offset: 1px;
    }

    .uiMiniBtn{
      border-radius: 10px;
      padding: 6px 10px;
      border: 0;
      cursor: pointer;
      font: 600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #fff;
      background: rgba(17,24,39,0.65);
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
      white-space: nowrap;
    }
    .uiMiniBtn:active{ transform: translateY(1px); }

    .chipSearchWrap{
      display:flex;
      align-items:center;
      gap:6px;
      background: rgba(255,255,255,0.92);
      border-radius: 10px;
      padding: 4px 6px;
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
    }
    .chipSearch{
      width: 80px;
      border:0;
      outline:0;
      background: transparent;
      padding: 4px 6px;
      font: 600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:#111827;
    }
    .chipSearchBtn{
      border:0;
      background: rgba(17,24,39,0.10);
      border-radius: 8px;
      cursor:pointer;
      width: 26px;
      height: 26px;
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .chipSearchBtn:hover{ background: rgba(17,24,39,0.16); }
    .chipSearchBtn:active{ transform: translateY(1px); }
    .chipSearchIcon{ width: 16px; height: 16px; opacity: 0.8; }

    .subPanel{
      position:absolute;
      z-index:10000;
      pointer-events:auto;
      display:none;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
      padding: 8px;
      background: rgba(255,255,255,0.18);
      backdrop-filter: blur(2px);
      border-radius: 12px;
    }
    .subPanel.is-open{ display:flex; }

    .uiChipBtn.is-unselected .uiChipFace{
      background: rgba(140,140,140,0.26) !important;
      color: rgba(255,255,255,0.85);
      box-shadow: 0 6px 14px rgba(0,0,0,0.12);
      text-shadow:none;
    }

    .uiChipFace.is-near{
      color: ${BUS_NEAR_STROKE} !important;
      border: 2px dashed ${BUS_NEAR_STROKE};
      text-shadow: none !important;
    }
  `;
  document.head.appendChild(style);
}

function ensureChipDock() {
  ensureChipStylesOnce();
  if (dockEl) return;

  dockEl = document.createElement("div");
  dockEl.className = "chipDock";

  rowEl = document.createElement("div");
  rowEl.className = "chipRowTop";
  dockEl.appendChild(rowEl);

  subPanelEl = document.createElement("div");
  subPanelEl.className = "subPanel";
  dockEl.appendChild(subPanelEl);

  document.body.appendChild(dockEl);

  document.addEventListener("click", (e) => {
    if (!subPanelEl.classList.contains("is-open")) return;
    const t = e.target;
    const clickedInside = dockEl.contains(t) || subPanelEl.contains(t);
    if (!clickedInside) closeSubchipPanel();
  });

  renderTopRow();
}

function makeChipButton({ label, bg, onClick, classes = [], faceClass = "" }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = ["uiChipBtn", ...classes].join(" ");
  btn.innerHTML = `<div class="uiChipFace ${faceClass}" style="background:${bg};">${label}</div>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function makeMiniButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uiMiniBtn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function magnifierSvg() {
  return `
    <svg class="chipSearchIcon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" stroke="currentColor" stroke-width="2"/>
      <path d="M16.3 16.3 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
}

function renderTopRow() {
  ensureChipDock();
  rowEl.innerHTML = "";

  for (const def of MODE_DEFS) {
    const btn = makeChipButton({
      label: def.label,
      bg: def.chipBg,
      onClick: (e) => {
        e.stopPropagation();
        toggleSubchipPanel(def.key, btn);
      },
    });
    btn.dataset.mode = def.key;
    rowEl.appendChild(btn);
  }

  rowEl.appendChild(
    makeMiniButton("Visa alla", () => {
      setShowAll();
      renderSubchips();
      refreshLive().catch(console.error);
    })
  );

  rowEl.appendChild(
    makeMiniButton("Rensa", () => {
      setShowNone();
      removeAllNow();
      renderSubchips();
    })
  );

  const searchWrap = document.createElement("div");
  searchWrap.className = "chipSearchWrap";

  searchInputEl = document.createElement("input");
  searchInputEl.className = "chipSearch";
  searchInputEl.type = "text";
  searchInputEl.placeholder = "Linje (4,17)…";

  searchBtnEl = document.createElement("button");
  searchBtnEl.type = "button";
  searchBtnEl.className = "chipSearchBtn";
  searchBtnEl.innerHTML = magnifierSvg();

  const runSearch = () => {
    const raw = searchInputEl.value;
    if (!raw || !raw.trim()) return;

    setSelectionFromSearch(raw);
    searchInputEl.value = "";

    renderSubchips();
    refreshLive().catch(console.error);
  };

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  searchBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    runSearch();
  });

  searchWrap.appendChild(searchInputEl);
  searchWrap.appendChild(searchBtnEl);
  rowEl.appendChild(searchWrap);

  updateModeChipInactiveStates();
}

function updateModeChipInactiveStates() {
  for (const btn of rowEl.querySelectorAll("button[data-mode]")) {
    const key = btn.dataset.mode;

    if (key === "bus") {
      // Aktiv om: inte Rensa + (tokens valda ELLER bussar syns på kartan)
      const active = !isShowNone() && (hasAnyBusCategoryToken() || hasAnyVisibleType(700));

      btn.classList.toggle("is-inactive", !active);
      btn.classList.toggle("is-activeMode", subPanelModeKey === "bus");
      continue;
    }

    if (key === "boat") {
      // Aktiv om: inte Rensa + (tokens valda ELLER båtar syns på kartan)
      const active = !isShowNone() && (hasAnyBoatCategoryToken() || hasAnyVisibleType(1000));

      btn.classList.toggle("is-inactive", !active);
      btn.classList.toggle("is-activeMode", subPanelModeKey === "boat");
      continue;
    }

    const def = MODE_DEFS.find((d) => d.key === key);
    if (!def?.lines) continue;

    let anySelected = false;

    if (isShowNone()) anySelected = false;
    else if (selectedLines.size === 0) anySelected = true;
    else {
      for (const l of def.lines) {
        if (isLineSelected(l)) {
          anySelected = true;
          break;
        }
      }
    }

    btn.classList.toggle("is-inactive", !anySelected);
    btn.classList.toggle("is-activeMode", subPanelModeKey === key);
  }
}

function toggleSubchipPanel(modeKey, modeBtnEl) {
  ensureChipDock();

  if (subPanelEl.classList.contains("is-open") && subPanelModeKey === modeKey) {
    closeSubchipPanel();
    return;
  }

  subPanelModeKey = modeKey;

  const rect = modeBtnEl.getBoundingClientRect();
  const dockRect = dockEl.getBoundingClientRect();

  const top = rect.bottom - dockRect.top + 8;
  const left = rect.left - dockRect.left;

  subPanelEl.style.top = `${top}px`;
  subPanelEl.style.left = `${left}px`;

  renderSubchips();
  subPanelEl.classList.add("is-open");
  updateModeChipInactiveStates();
}

function closeSubchipPanel() {
  if (!subPanelEl) return;
  subPanelEl.classList.remove("is-open");
  subPanelModeKey = null;
  updateModeChipInactiveStates();
}

function renderSubchips() {
  ensureChipDock();
  subPanelEl.innerHTML = "";

  if (!subPanelModeKey) {
    updateModeChipInactiveStates();
    return;
  }

  // Buss undermeny
  if (subPanelModeKey === "bus") {
    const defs = [
      { label: "Röd", token: BUS_RED_TOKEN, bg: BUS_RED, faceClass: "" },
      { label: "Blå", token: BUS_BLUE_TOKEN, bg: BUS_BLUE, faceClass: "" },
      { label: "Ersättning", token: BUS_REPL_TOKEN, bg: BUS_REPL, faceClass: "" },
      { label: "Närtrafiken", token: BUS_NEAR_TOKEN, bg: BUS_NEAR_BG, faceClass: "is-near" },
    ];

    const visibleBusCats = getVisibleBusCategoryTokens();

    for (const d of defs) {
      const btn = makeChipButton({
        label: d.label,
        bg: d.bg,
        faceClass: d.faceClass,
        onClick: (e) => {
          e.stopPropagation();
          toggleBusCategoryToken(d.token);
          renderSubchips();
          updateModeChipInactiveStates();
          refreshLive().catch(console.error);
        },
      });

      // Tänd om vald ELLER syns på kartan
      const lit = selectedLines.has(d.token) || visibleBusCats.has(d.token);
      btn.classList.toggle("is-unselected", !lit);

      subPanelEl.appendChild(btn);
    }

    updateModeChipInactiveStates();
    return;
  }

  // Båt undermeny
  if (subPanelModeKey === "boat") {
    const defs = [
      { label: "Pendelbåt", token: BOAT_PENDEL_TOKEN, bg: BOAT_PENDEL_BG, faceClass: "" },
      {
        label: "Waxholmsbolaget",
        token: BOAT_WAX_TOKEN,
        bg: `linear-gradient(90deg,${BOAT_WAX_YELLOW} 0%,${BOAT_WAX_YELLOW} 50%,${BOAT_WAX_BLUE} 50%,${BOAT_WAX_BLUE} 100%)`,
        faceClass: "",
      },
    ];

    const visibleBoatCats = getVisibleBoatCategoryTokens();

    for (const d of defs) {
      const btn = makeChipButton({
        label: d.label,
        bg: d.bg,
        faceClass: d.faceClass,
        onClick: (e) => {
          e.stopPropagation();
          toggleBoatCategoryToken(d.token);
          renderSubchips();
          updateModeChipInactiveStates();
          refreshLive().catch(console.error);
        },
      });

      // Tänd om vald ELLER syns på kartan
      const lit = selectedLines.has(d.token) || visibleBoatCats.has(d.token);
      btn.classList.toggle("is-unselected", !lit);

      subPanelEl.appendChild(btn);
    }

    updateModeChipInactiveStates();
    return;
  }

  // Spår undermeny
  const def = MODE_DEFS.find((d) => d.key === subPanelModeKey);
  if (!def || !def.lines) return;

  for (const line of def.lines.map(normalizeLine)) {
    const bg = colorForRailLine(line);
    const btn = makeChipButton({
      label: line,
      bg,
      onClick: (e) => {
        e.stopPropagation();
        toggleRailLineSelection(line);
        renderSubchips();
        updateModeChipInactiveStates();
        refreshLive().catch(console.error);
      },
    });

    btn.classList.toggle("is-unselected", !isLineSelected(line));
    subPanelEl.appendChild(btn);
  }

  updateModeChipInactiveStates();
}

/* =========================================================
   Marker lifecycle helpers
========================================================= */

function removeVehicleCompletely(id) {
  const m = markers.get(id);
  if (!m) return;

  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  map.removeLayer(m.group);
  markers.delete(id);

  lastPos.delete(id);
  lastBearing.delete(id);
  bearingEstablished.delete(id);

  if (hoverTrainId === id) hideHoverLabel(id);

  if (pinnedTrainId === id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }
}

function removeAllNow() {
  for (const [id, m] of markers.entries()) {
    if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);
    map.removeLayer(m.group);
    markers.delete(id);
  }
  lastPos.clear();
  lastBearing.clear();
  bearingEstablished.clear();

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }
  if (pinnedLabelMarker) {
    map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }
}

/* =========================================================
   Upsert vehicle
========================================================= */
function upsertVehicle(v) {
  v.line = normalizeLine(v.line);
  const pos = [v.lat, v.lon];

  let bearing = null;
  let establishedNow = false;

  if (Number.isFinite(v.bearing) && v.bearing > 0) {
    bearing = v.bearing;
    establishedNow = true;
  }

  const prev = lastPos.get(v.id);
  if (bearing == null && prev && prev.lat != null && prev.lon != null) {
    const moved =
      Math.abs(v.lat - prev.lat) > 0.00002 ||
      Math.abs(v.lon - prev.lon) > 0.00002;

    if (moved) {
      bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
      establishedNow = true;
    }
  }

  if (establishedNow) {
    bearingEstablished.set(v.id, true);
    lastBearing.set(v.id, bearing);
  }

  if (
    bearing == null &&
    bearingEstablished.get(v.id) === true &&
    lastBearing.has(v.id)
  ) {
    bearing = lastBearing.get(v.id);
  }

  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

  const hasBearingNow = Number.isFinite(bearing);

  if (!markers.has(v.id)) {
    const icon =
      v.type === 700
        ? makeBusIcon(hasBearingNow ? bearing : NaN, v)
        : v.type === 1000
          ? makeBoatIcon(hasBearingNow ? bearing : NaN, v)
          : v.unknown
            ? makeUnknownIcon(hasBearingNow ? bearing : NaN, false)
            : makeRailIcon(v.line, hasBearingNow ? bearing : NaN, false);
    const group = L.layerGroup();
    const arrowMarker = L.marker(pos, {
      icon,
      interactive: true,
      zIndexOffset: 500,
    });

    arrowMarker.on("mouseover", () => {
      isPointerOverTrain = true;
      const m = markers.get(v.id);
      if (m?.lastV) showHoverLabel(m.lastV, m.lastPos);
    });

    arrowMarker.on("mouseout", () => {
      isPointerOverTrain = false;
      hideHoverLabel(v.id);
    });

    arrowMarker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      const m = markers.get(v.id);
      if (m?.lastV) togglePinnedLabel(m.lastV, m.lastPos);
    });

    group.addLayer(arrowMarker);
    group.addTo(map);

    markers.set(v.id, {
      group,
      arrowMarker,
      lastV: v,
      lastPos: pos,
      hasBearing: hasBearingNow,
      anim: null,
    });
  } else {
    const m = markers.get(v.id);

    const hadBearingBefore = m.hasBearing === true;
    const pop = !hadBearingBefore && hasBearingNow;

    m.lastV = v;
    m.lastPos = pos;
    
m.hasBearing = hasBearingNow;

// Uppdatera ikon visuellt UTAN setIcon() (mindre DOM-churn)
const el = getMarkerElCached(m);
if (el) {
  const wrap = el.querySelector(".vehWrap") ?? el;

  if (v.type === 700) {
    const style = busColorStyleForVehicle(v);
    updateBusEl(wrap, {
      rot: hasBearingNow ? bearing : 0,
      fill: style.iconFill,
    });
  } else if (v.type === 1000) {
    const style = boatStyleForVehicle(v);
    updateBoatEl(wrap, {
      rot: hasBearingNow ? bearing - 90 : 0,
      fill: style.iconFill ?? BOAT_PENDEL_BG,
    });
  } else if (v.unknown) {
    updateRailOrUnknownEl(wrap, {
      rot: hasBearingNow ? ((((bearing - 90) % 360) + 360) % 360) : 0,
      fill: "#111827",
      stroke: "#0b1220",
      hasBearing: hasBearingNow,
      pop,
    });
  } else {
    const color = colorForRailLine(v.line);
    const stroke = darkenHex(color, 0.01);
    updateRailOrUnknownEl(wrap, {
      rot: hasBearingNow ? bearing + 90 : 0,
      fill: color,
      stroke,
      hasBearing: hasBearingNow,
      pop,
    });
  }
} else {
  // Fallback om element inte finns ännu: sätt ikon en gång
  if (v.type === 700) {
    m.arrowMarker.setIcon(makeBusIcon(hasBearingNow ? bearing : NaN, v));
  } else if (v.type === 1000) {
    m.arrowMarker.setIcon(makeBoatIcon(hasBearingNow ? bearing : NaN, v));
  } else if (v.unknown) {
    m.arrowMarker.setIcon(makeUnknownIcon(hasBearingNow ? bearing : NaN, pop));
  } else {
    m.arrowMarker.setIcon(makeRailIcon(v.line, hasBearingNow ? bearing : NaN, pop));
  }
}

    const from = m.arrowMarker.getLatLng();
    const to = L.latLng(pos[0], pos[1]);
    const dur = computeAnimMs(from, to);

    animateTrainTo(m, pos, dur, (curLatLng) => {
      if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
        hoverLabelMarker.setLatLng(curLatLng);
      }
      if (pinnedTrainId === v.id && pinnedLabelMarker) {
        pinnedLabelMarker.setLatLng(curLatLng);
      }
    });

    if (pinnedTrainId === v.id && pinnedLabelMarker) {
      pinnedLabelMarker.setIcon(makeLabelIcon(v, buildLabelText(v), v.speedKmh, true));
    }

    if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
      hoverLabelMarker.setIcon(makeLabelIcon(v, buildLabelText(v), v.speedKmh, false));
    }
  }
}

/* =========================================================
   refreshLive
========================================================= */
async function refreshLive() {
  if (document.visibilityState !== "visible") return;
  if (refreshing) return;
  refreshing = true;

  try {
  ensureChipDock();

  const res = await fetch(API_URL, { cache: "no-store"
  } finally {
    refreshing = false;
  }
}
);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const seen = new Set();

  if (isShowNone()) {
    removeAllNow();
    updateModeChipInactiveStates();
    renderSubchips();
    return;
  }

  for (const raw of data) {
    if (!raw?.id || raw.lat == null || raw.lon == null) continue;

    const v = enrich(raw);
    if (!v) continue;

    v.line = normalizeLine(v.line);

    if (!passesFilter(v)) {
      if (markers.has(v.id)) removeVehicleCompletely(v.id);
      continue;
    }

    seen.add(v.id);
    upsertVehicle(v);
  }

  for (const [id] of markers.entries()) {
    if (!seen.has(id)) removeVehicleCompletely(id);
  }

  updateModeChipInactiveStates();
  renderSubchips();
}

/* =========================================================
   polling
========================================================= */
function startPolling() {
  stopPolling();
  timer = setInterval(() => refreshLive().catch(console.error), POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

startPolling();
refreshLive().catch(console.error);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startPolling();
    refreshLive().catch(console.error);
  } else {
    stopPolling();
  }
});
