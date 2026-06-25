// Standalone weather display — fetches the National Weather Service API directly
// from the browser (NWS and zippopotam.us both allow CORS). No API key required.

const DEFAULT_ZIP = "10001";
const REFRESH_MS = 5 * 60 * 1000;
const WINDOW_ROTATE_MS = 6 * 1000;

const NWS_HEADERS = { Accept: "application/geo+json" };

const el = {
  location: document.getElementById("location"),
  date: document.getElementById("date"),
  clock: document.getElementById("clock"),
  content: document.getElementById("content"),
  updated: document.getElementById("updated"),
  refreshIcon: document.getElementById("refresh-icon"),
  settingsBtn: document.getElementById("settings-btn"),
  editor: document.getElementById("editor"),
  zip: document.getElementById("zip"),
  saveBtn: document.getElementById("save-btn"),
};

let currentZip = localStorage.getItem("weather-tv-zip") || DEFAULT_ZIP;

// Holds parsed forecast days and the rotating window index for the interval rows.
let forecastState = { today: null, tomorrow: null, windowIndex: 0 };

/* ---------- helpers ---------- */

function cToF(c) {
  if (c === null || c === undefined) return null;
  return Math.round((c * 9) / 5 + 32);
}

function kmhToMph(kmh) {
  if (kmh === null || kmh === undefined) return null;
  return Math.round(kmh * 0.621371);
}

function paToInHg(pa) {
  if (pa === null || pa === undefined) return null;
  return (pa * 0.0002953).toFixed(2);
}

function metersToMiles(m) {
  if (m === null || m === undefined) return null;
  return Math.round((m / 1609.34) * 10) / 10;
}

function degToCompass(deg) {
  if (deg === null || deg === undefined) return null;
  const dirs = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function nwsFetch(url) {
  const res = await fetch(url, { headers: NWS_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`NWS request failed (${res.status})`);
  return res.json();
}

async function resolveZip(zip) {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Invalid ZIP code");
  const data = await res.json();
  const place = data.places && data.places[0];
  if (!place) throw new Error("ZIP code not found");
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    label: `${place["place name"]}, ${place["state abbreviation"]}`,
  };
}

/* ---------- data ---------- */

// Group hourly periods into the first two calendar days and derive, for each:
// high/low, a representative daytime condition, and 2-hour-interval readings
// split into 8-hour windows (4 readings each).
function buildForecastDays(hourlyPeriods) {
  const byDate = [];
  const index = new Map();
  for (const p of hourlyPeriods) {
    const d = new Date(p.startTime);
    const key = d.toDateString();
    if (!index.has(key)) {
      const bucket = { key, date: d, hours: [] };
      index.set(key, bucket);
      byDate.push(bucket);
    }
    index.get(key).hours.push({
      time: d,
      temp: p.temperature,
      short: p.shortForecast,
      isDay: p.isDaytime,
    });
  }

  function toDay(bucket, label) {
    if (!bucket) return null;
    const temps = bucket.hours.map((h) => h.temp).filter((t) => t != null);
    const high = temps.length ? Math.max(...temps) : null;
    const low = temps.length ? Math.min(...temps) : null;
    // Prefer a midday daytime reading for the headline condition.
    const midday =
      bucket.hours.find((h) => h.isDay && h.time.getHours() >= 12) ||
      bucket.hours.find((h) => h.isDay) ||
      bucket.hours[0];
    const intervals = bucket.hours.filter((h) => h.time.getHours() % 2 === 0);
    return {
      label,
      dateLabel: bucket.date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
      high,
      low,
      condition: midday ? midday.short : null,
      windows: chunk(intervals, 4),
    };
  }

  return {
    today: toDay(byDate[0], "Today"),
    tomorrow: toDay(byDate[1], "Tomorrow"),
  };
}

async function getWeather(zip) {
  const { lat, lon, label } = await resolveZip(zip);
  const point = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsData = await nwsFetch(`https://api.weather.gov/points/${point}`);
  const props = pointsData.properties;

  const [hourlyData, stationsData, alertsData] = await Promise.all([
    nwsFetch(props.forecastHourly),
    nwsFetch(props.observationStations),
    nwsFetch(`https://api.weather.gov/alerts/active?point=${point}`),
  ]);

  const hourlyPeriods = hourlyData.properties?.periods ?? [];
  const forecast = buildForecastDays(hourlyPeriods);

  let current = null;
  try {
    const stationId =
      stationsData.features?.[0]?.properties?.stationIdentifier;
    if (stationId) {
      const obs = await nwsFetch(
        `https://api.weather.gov/stations/${stationId}/observations/latest`
      );
      const o = obs.properties;
      current = {
        temperature: cToF(o.temperature?.value),
        textDescription: o.textDescription ?? null,
        heatIndex: cToF(o.heatIndex?.value),
        humidity:
          o.relativeHumidity?.value != null
            ? Math.round(o.relativeHumidity.value)
            : null,
        windSpeed: kmhToMph(o.windSpeed?.value),
        windDirection: degToCompass(o.windDirection?.value),
        pressure: paToInHg(o.barometricPressure?.value),
        visibility: metersToMiles(o.visibility?.value),
      };
    }
  } catch {
    current = null;
  }

  const alerts = (alertsData.features ?? []).map((f) => ({
    id: f.id,
    event: f.properties.event,
    severity: f.properties.severity,
    headline: f.properties.headline,
    ends: f.properties.ends ?? f.properties.expires,
  }));

  return {
    location: label,
    updated: new Date().toISOString(),
    current,
    forecast,
    alerts,
  };
}

/* ---------- rendering ---------- */

function severityBadge(severity) {
  switch (severity) {
    case "Extreme":
    case "Severe":
      return { text: "SEVERE", color: "bg-red-500" };
    case "Moderate":
      return { text: "MODERATE", color: "bg-amber-500" };
    case "Minor":
      return { text: "MINOR", color: "bg-sky-500" };
    default:
      return { text: (severity || "ALERT").toUpperCase(), color: "bg-sky-500" };
  }
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    return `
      <section class="flex h-[15vh] shrink-0 items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-900/40 px-6 text-emerald-100 shadow-lg backdrop-blur">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
        <p class="text-xl font-bold">No active weather alerts</p>
      </section>`;
  }

  const rows = alerts
    .map((a) => {
      const ends = a.ends
        ? new Date(a.ends).toLocaleString(undefined, {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })
        : null;
      const badge = severityBadge(a.severity);
      return `
        <div class="flex items-center gap-3 border-t border-white/15 py-2 first:border-t-0">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-full ${badge.color} text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-lg font-bold uppercase leading-tight text-white">${esc(a.event)}</p>
            ${ends ? `<p class="text-sm text-white/70">Until ${esc(ends)}</p>` : ""}
          </div>
          <span class="shrink-0 rounded-md ${badge.color} px-3 py-1 text-sm font-bold tracking-wide text-white">${badge.text}</span>
        </div>`;
    })
    .join("");

  const count = alerts.length;
  return `
    <section class="flex h-[15vh] shrink-0 flex-col overflow-hidden rounded-2xl border border-red-400/40 bg-gradient-to-b from-red-700/85 to-red-900/85 px-5 py-2 text-white shadow-lg backdrop-blur">
      <div class="flex shrink-0 items-center gap-2 pb-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <p class="text-lg font-extrabold uppercase tracking-wide">${count} Active Weather Alert${count > 1 ? "s" : ""}</p>
      </div>
      <div class="flex-1 overflow-y-auto">${rows}</div>
    </section>`;
}

const METRIC_ICONS = {
  heat: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>',
  wind: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>',
  humidity: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7Z"/></svg>',
  pressure: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  visibility: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

function metricRow(icon, label, value) {
  if (value === null || value === undefined || value === "") return "";
  return `
    <div class="flex items-center gap-2 border-t border-white/10 py-1.5 first:border-t-0">
      <span class="text-sky-300">${icon}</span>
      <span class="text-sm text-sky-100/80">${esc(label)}</span>
      <span class="ml-auto text-base font-bold tabular text-white">${esc(value)}</span>
    </div>`;
}

function renderCurrent(current) {
  if (!current) {
    return `
      <section class="flex h-[20vh] shrink-0 flex-col justify-center rounded-2xl border border-sky-400/25 bg-blue-950/65 px-6 py-3 text-white shadow-lg backdrop-blur">
        <p class="text-sm font-bold uppercase tracking-widest text-sky-300/80">Current Weather</p>
        <p class="mt-2 text-lg text-sky-200/70">Observation unavailable</p>
      </section>`;
  }

  const wind =
    current.windSpeed != null
      ? `${current.windDirection ? current.windDirection + " " : ""}${current.windSpeed} mph`
      : null;

  const metrics = [
    metricRow(METRIC_ICONS.heat, "Heat Index", current.heatIndex != null ? current.heatIndex + "°" : null),
    metricRow(METRIC_ICONS.wind, "Wind", wind),
    metricRow(METRIC_ICONS.humidity, "Humidity", current.humidity != null ? current.humidity + "%" : null),
    metricRow(METRIC_ICONS.pressure, "Pressure", current.pressure != null ? current.pressure + " in" : null),
    metricRow(METRIC_ICONS.visibility, "Visibility", current.visibility != null ? current.visibility + " mi" : null),
  ].join("");

  return `
    <section class="flex h-[20vh] shrink-0 flex-col rounded-2xl border border-sky-400/25 bg-blue-950/65 px-6 py-3 text-white shadow-lg backdrop-blur">
      <p class="text-sm font-bold uppercase tracking-widest text-sky-300/80">Current Weather</p>
      <div class="mt-1 flex flex-1 items-center gap-6">
        <div class="flex shrink-0 flex-col justify-center">
          <p class="text-6xl font-bold leading-none tabular">${current.temperature != null ? current.temperature : "--"}<span class="align-top text-2xl text-sky-300">°F</span></p>
          <p class="mt-1 text-lg text-sky-100/80">${esc(current.textDescription || "")}</p>
        </div>
        <div class="flex flex-1 flex-col justify-center self-stretch">
          ${metrics}
        </div>
      </div>
    </section>`;
}

function renderIntervalRow(readings) {
  if (!readings || !readings.length) {
    return `<p class="py-4 text-center text-sky-200/60">No hourly data</p>`;
  }
  return readings
    .map((r) => {
      const hour = r.time.toLocaleTimeString(undefined, { hour: "numeric" });
      return `
        <div class="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-blue-900/50">
          <span class="text-sm font-medium text-sky-200/70 tabular">${esc(hour)}</span>
          <span class="text-2xl font-bold tabular text-white">${r.temp != null ? r.temp + "°" : "--"}</span>
        </div>`;
    })
    .join("");
}

function renderDots(count, idx) {
  if (count <= 1) return "";
  return Array.from({ length: count })
    .map(
      (_, i) =>
        `<span class="size-2 rounded-full ${i === idx ? "bg-sky-300" : "bg-white/25"}"></span>`
    )
    .join("");
}

function renderForecastCard(key, day) {
  if (!day) {
    return `
      <div class="flex h-[20vh] shrink-0 flex-col justify-center rounded-2xl border border-sky-400/25 bg-blue-950/65 px-6 py-3 text-white shadow-lg backdrop-blur">
        <p class="text-sm font-bold uppercase tracking-widest text-sky-300/80">${esc(key)}</p>
        <p class="mt-2 text-sky-200/70">Forecast unavailable</p>
      </div>`;
  }
  return `
    <div class="flex h-[20vh] shrink-0 flex-col rounded-2xl border border-sky-400/25 bg-blue-950/65 px-6 py-3 text-white shadow-lg backdrop-blur">
      <div class="flex items-baseline justify-between gap-2">
        <p class="text-sm font-bold uppercase tracking-widest text-sky-300/80">${esc(day.label)}</p>
        <p class="text-sm text-sky-200/60">${esc(day.dateLabel)}</p>
      </div>
      <div class="mt-1 flex flex-1 items-center gap-6">
        <div class="flex w-44 shrink-0 flex-col justify-center">
          <div class="flex items-baseline gap-2">
            <span class="text-4xl font-bold tabular text-white">${day.high != null ? day.high + "°" : "--"}</span>
            <span class="text-2xl font-semibold text-sky-300 tabular">${day.low != null ? day.low + "°" : "--"}</span>
          </div>
          <p class="mt-1 text-sm leading-snug text-sky-100/80">${esc(day.condition || "")}</p>
        </div>
        <div id="${key}-intervals" class="flex flex-1 items-stretch gap-2 self-stretch py-1"></div>
      </div>
      <div id="${key}-dots" class="flex items-center justify-center gap-1.5"></div>
    </div>`;
}

// Fill the rotating interval rows for both forecast cards using windowIndex.
function updateIntervals() {
  for (const key of ["today", "tomorrow"]) {
    const day = forecastState[key];
    const container = document.getElementById(`${key}-intervals`);
    const dots = document.getElementById(`${key}-dots`);
    if (!day || !container || !day.windows.length) continue;
    const idx = forecastState.windowIndex % day.windows.length;
    container.innerHTML = renderIntervalRow(day.windows[idx]);
    if (dots) dots.innerHTML = renderDots(day.windows.length, idx);
  }
}

function renderError(message) {
  return `
    <div class="rounded-2xl border border-red-400/40 bg-red-900/60 px-6 py-5 text-white shadow-lg backdrop-blur">
      <p class="text-xl font-semibold">Unable to load weather</p>
      <p class="mt-1 text-lg text-red-100/90">${esc(message)}</p>
      <button id="retry-btn" class="mt-3 rounded-lg border border-white/30 bg-white/10 px-4 py-2 font-medium text-white hover:bg-white/20">Retry</button>
    </div>`;
}

function render(data) {
  el.location.textContent = data.location || "Unknown location";

  forecastState.today = data.forecast.today;
  forecastState.tomorrow = data.forecast.tomorrow;
  forecastState.windowIndex = 0;

  el.content.innerHTML = `
    ${renderAlerts(data.alerts)}
    ${renderCurrent(data.current)}
    ${renderForecastCard("today", data.forecast.today)}
    ${renderForecastCard("tomorrow", data.forecast.tomorrow)}`;

  updateIntervals();

  const updatedTime = new Date(data.updated).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  el.updated.textContent = `Data from the National Weather Service · Updated ${updatedTime}`;
}

/* ---------- load + clock ---------- */

async function load() {
  el.refreshIcon.classList.add("animate-spin");
  try {
    const data = await getWeather(currentZip);
    render(data);
  } catch (err) {
    el.location.textContent = "Weather unavailable";
    el.content.innerHTML = renderError(err.message || "Failed to load weather.");
    const retry = document.getElementById("retry-btn");
    if (retry) retry.addEventListener("click", load);
  } finally {
    el.refreshIcon.classList.remove("animate-spin");
  }
}

function tickClock() {
  const now = new Date();
  el.clock.textContent = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  el.date.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/* ---------- events ---------- */

el.settingsBtn.addEventListener("click", () => {
  el.editor.classList.toggle("hidden");
  el.editor.classList.toggle("flex");
  el.zip.value = currentZip;
  el.zip.focus();
});

function saveZip() {
  const cleaned = el.zip.value.trim();
  if (!/^\d{5}$/.test(cleaned)) return;
  currentZip = cleaned;
  localStorage.setItem("weather-tv-zip", cleaned);
  el.editor.classList.add("hidden");
  el.editor.classList.remove("flex");
  load();
}

el.saveBtn.addEventListener("click", saveZip);
el.zip.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveZip();
  if (e.key === "Escape") {
    el.editor.classList.add("hidden");
    el.editor.classList.remove("flex");
  }
});

/* ---------- start ---------- */

tickClock();
setInterval(tickClock, 1000);
load();
setInterval(load, REFRESH_MS);
setInterval(() => {
  forecastState.windowIndex++;
  updateIntervals();
}, WINDOW_ROTATE_MS);
