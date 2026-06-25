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
      pop: p.probabilityOfPrecipitation?.value ?? null,
    });
  }

  function toDay(bucket, label) {
    if (!bucket) return null;
    const temps = bucket.hours.map((h) => h.temp).filter((t) => t != null);
    const high = temps.length ? Math.max(...temps) : null;
    const low = temps.length ? Math.min(...temps) : null;
    const pops = bucket.hours.map((h) => h.pop).filter((p) => p != null);
    const pop = pops.length ? Math.max(...pops) : null;
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
      pop,
      condition: midday ? midday.short : null,
      conditionIsDay: midday ? midday.isDay : true,
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
      const temperature = cToF(o.temperature?.value);
      const heatIndex = cToF(o.heatIndex?.value);
      const windChill = cToF(o.windChill?.value);
      current = {
        temperature,
        textDescription: o.textDescription ?? null,
        heatIndex,
        feelsLike: heatIndex ?? windChill ?? temperature,
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

/* ---------- weather glyphs ---------- */

const ICON = {
  sun: `<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="5" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="3.5"/><line x1="12" y1="20.5" x2="12" y2="23"/><line x1="1" y1="12" x2="3.5" y2="12"/><line x1="20.5" y1="12" x2="23" y2="12"/><line x1="4" y1="4" x2="5.8" y2="5.8"/><line x1="18.2" y1="18.2" x2="20" y2="20"/><line x1="4" y1="20" x2="5.8" y2="18.2"/><line x1="18.2" y1="5.8" x2="20" y2="4"/></g></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="#e2e8f0"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" fill="#f1f5f9"/></svg>`,
  rain: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M17.5 15H9a6 6 0 1 1 5.75-7.71h1.75a4.25 4.25 0 1 1 0 8.5Z" fill="#f1f5f9"/><g stroke="#38bdf8" stroke-width="2" stroke-linecap="round"><line x1="8" y1="18" x2="7" y2="21"/><line x1="12" y1="18" x2="11" y2="21"/><line x1="16" y1="18" x2="15" y2="21"/></g></svg>`,
  storm: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M17.5 14H9a6 6 0 1 1 5.75-7.71h1.75a4.25 4.25 0 1 1 0 8.5Z" fill="#f1f5f9"/><path d="M12 13l-3 5h2.4l-1 4 4-6h-2.6l1.2-3z" fill="#facc15"/></svg>`,
  snow: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M17.5 14H9a6 6 0 1 1 5.75-7.71h1.75a4.25 4.25 0 1 1 0 8.5Z" fill="#f1f5f9"/><g fill="#bae6fd"><circle cx="8" cy="19" r="1.2"/><circle cx="12" cy="20.5" r="1.2"/><circle cx="16" cy="19" r="1.2"/></g></svg>`,
  fog: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M17.5 12H9a6 6 0 1 1 5.75-7.71h1.75a4.25 4.25 0 1 1 0 8.5Z" fill="#f1f5f9"/><g stroke="#cbd5e1" stroke-width="2" stroke-linecap="round"><line x1="5" y1="16" x2="19" y2="16"/><line x1="7" y1="20" x2="17" y2="20"/></g></svg>`,
};

// Map an NWS condition string to a sized weather glyph (HTML).
function weatherGlyph(text, isDay, size) {
  const t = (text || "").toLowerCase();
  const wrap = (inner) =>
    `<span class="glyph" style="position:relative;display:inline-block;flex:none;width:${size}px;height:${size}px">${inner}</span>`;
  const single = (svg) =>
    wrap(`<span style="position:absolute;top:0;left:0;width:100%;height:100%">${svg}</span>`);
  const composite = (bg) =>
    wrap(
      `<span style="position:absolute;left:0;top:0;width:${Math.round(size * 0.6)}px;height:${Math.round(size * 0.6)}px">${bg}</span>` +
        `<span style="position:absolute;right:0;bottom:0;width:${Math.round(size * 0.78)}px;height:${Math.round(size * 0.78)}px">${ICON.cloud}</span>`
    );

  if (t.includes("thunder") || t.includes("tstorm")) return single(ICON.storm);
  if (t.includes("snow") || t.includes("flurr") || t.includes("sleet") || t.includes("ice") || t.includes("wintry"))
    return single(ICON.snow);
  if (t.includes("rain") || t.includes("shower") || t.includes("drizzle"))
    return single(ICON.rain);
  if (t.includes("fog") || t.includes("haze") || t.includes("mist") || t.includes("smoke"))
    return single(ICON.fog);

  const partly = t.includes("partly") || t.includes("mostly sunny") || t.includes("mostly clear") || t.includes("few") || t.includes("scattered") || t.includes("intervals");
  const cloudy = t.includes("cloud") || t.includes("overcast");
  if (cloudy && !partly) return single(ICON.cloud);
  if (cloudy || partly) return composite(isDay ? ICON.sun : ICON.moon);
  return single(isDay ? ICON.sun : ICON.moon);
}

/* ---------- rendering ---------- */

function severityBadge(severity) {
  switch (severity) {
    case "Extreme":
    case "Severe":
      return { text: "SEVERE", cls: "sev-severe" };
    case "Moderate":
      return { text: "MODERATE", cls: "sev-moderate" };
    case "Minor":
      return { text: "MINOR", cls: "sev-minor" };
    default:
      return { text: (severity || "ALERT").toUpperCase(), cls: "sev-minor" };
  }
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    return `
      <section class="panel alerts-ok grow-2">
        <span class="alert-icon ok">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
        <p class="alerts-ok-text">No active weather alerts</p>
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
        <div class="alert-row">
          <span class="alert-badge-icon ${badge.cls}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          </span>
          <div class="alert-row-main">
            <p class="alert-event">${esc(a.event)}</p>
            ${ends ? `<p class="alert-until">Until ${esc(ends)}</p>` : ""}
          </div>
          <span class="alert-badge ${badge.cls}">${badge.text}</span>
        </div>`;
    })
    .join("");

  const count = alerts.length;
  return `
    <section class="panel alerts grow-3">
      <div class="alerts-head">
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <p>${count} Active Weather Alert${count > 1 ? "s" : ""}</p>
      </div>
      <div class="alerts-body">${rows}</div>
      <div class="alerts-note">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        <span>Stay weather aware and have a plan.</span>
      </div>
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
    <div class="metric">
      <span class="metric-icon">${icon}</span>
      <span class="metric-label">${esc(label)}</span>
      <span class="metric-value tabular">${esc(value)}</span>
    </div>`;
}

function renderCurrent(current) {
  if (!current) {
    return `
      <section class="panel current grow-4">
        <p class="panel-label">Current Weather</p>
        <p class="current-desc">Observation unavailable</p>
      </section>`;
  }

  const wind =
    current.windSpeed != null
      ? `${current.windDirection ? current.windDirection + " " : ""}${current.windSpeed} mph`
      : null;

  const hour = new Date().getHours();
  const isDay = hour >= 6 && hour < 19;

  const metrics = [
    metricRow(METRIC_ICONS.heat, "Feels Like", current.feelsLike != null ? current.feelsLike + "°" : null),
    metricRow(METRIC_ICONS.wind, "Wind", wind),
    metricRow(METRIC_ICONS.humidity, "Humidity", current.humidity != null ? current.humidity + "%" : null),
    metricRow(METRIC_ICONS.pressure, "Pressure", current.pressure != null ? current.pressure + " in" : null),
    metricRow(METRIC_ICONS.visibility, "Visibility", current.visibility != null ? current.visibility + " mi" : null),
  ].join("");

  return `
    <section class="panel current grow-4">
      <p class="panel-label">Current Weather</p>
      <div class="current-body">
        <div class="current-main">
          ${weatherGlyph(current.textDescription, isDay, 110)}
          <p class="current-temp tabular">${current.temperature != null ? current.temperature : "--"}<span class="deg">°F</span></p>
          <p class="current-desc">${esc(current.textDescription || "")}</p>
        </div>
        <div class="current-metrics">
          ${metrics}
        </div>
      </div>
    </section>`;
}

function renderIntervalRow(readings) {
  if (!readings || !readings.length) {
    return `<p class="no-data">No hourly data</p>`;
  }
  return readings
    .map((r) => {
      const hour = r.time.toLocaleTimeString(undefined, { hour: "numeric" });
      return `
        <div class="interval">
          <span class="interval-hour tabular">${esc(hour)}</span>
          ${weatherGlyph(r.short, r.isDay, 48)}
          <span class="interval-temp tabular">${r.temp != null ? r.temp + "°" : "--"}</span>
          <span class="interval-pop">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5S5 10 5 14.5a7 7 0 0 0 14 0C19 10 12 2.5 12 2.5Z"/></svg>
            ${r.pop != null ? r.pop + "%" : "0%"}
          </span>
        </div>`;
    })
    .join("");
}

function renderDots(count, idx) {
  if (count <= 1) return "";
  return Array.from({ length: count })
    .map((_, i) => `<span class="dot${i === idx ? " active" : ""}"></span>`)
    .join("");
}

function renderForecastCard(key, day) {
  if (!day) {
    return `
      <div class="panel forecast grow-4">
        <p class="panel-label">${esc(key)}</p>
        <p class="current-desc">Forecast unavailable</p>
      </div>`;
  }
  return `
    <div class="panel forecast grow-4">
      <div class="forecast-head">
        <p class="panel-label">${esc(day.label)}</p>
        <p class="forecast-date">${esc(day.dateLabel)}</p>
      </div>
      <div class="forecast-body">
        <div class="forecast-summary">
          ${weatherGlyph(day.condition, day.conditionIsDay, 56)}
          <div class="forecast-summary-text">
            <div class="forecast-temps">
              <span class="hi tabular">${day.high != null ? day.high + "°" : "--"}</span>
              <span class="lo tabular">${day.low != null ? day.low + "°" : "--"}</span>
            </div>
            <p class="forecast-cond">${esc(day.condition || "")}</p>
            ${
              day.pop != null
                ? `<p class="forecast-pop">
                     <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5S5 10 5 14.5a7 7 0 0 0 14 0C19 10 12 2.5 12 2.5Z"/></svg>
                     ${day.pop}% Chance of Rain
                   </p>`
                : ""
            }
          </div>
        </div>
        <div id="${key}-intervals" class="intervals"></div>
      </div>
      <div id="${key}-dots" class="dots"></div>
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
    <div class="panel error">
      <p class="error-title">Unable to load weather</p>
      <p class="error-msg">${esc(message)}</p>
      <button id="retry-btn" class="btn">Retry</button>
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
    month: "long",
    day: "numeric",
    year: "numeric",
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
