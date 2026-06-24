// Standalone weather display — fetches the National Weather Service API directly
// from the browser (NWS and zippopotam.us both allow CORS). No API key required.

const DEFAULT_ZIP = "10001";
const REFRESH_MS = 5 * 60 * 1000;

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

/* ---------- helpers ---------- */

function cToF(c) {
  if (c === null || c === undefined) return null;
  return Math.round((c * 9) / 5 + 32);
}

function kmhToMph(kmh) {
  if (kmh === null || kmh === undefined) return null;
  return Math.round(kmh * 0.621371);
}

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

async function getWeather(zip) {
  const { lat, lon, label } = await resolveZip(zip);
  const point = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsData = await nwsFetch(`https://api.weather.gov/points/${point}`);
  const props = pointsData.properties;

  const [forecastData, stationsData, alertsData] = await Promise.all([
    nwsFetch(props.forecast),
    nwsFetch(props.observationStations),
    nwsFetch(`https://api.weather.gov/alerts/active?point=${point}`),
  ]);

  const periods = forecastData.properties?.periods ?? [];

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
        humidity:
          o.relativeHumidity?.value != null
            ? Math.round(o.relativeHumidity.value)
            : null,
        windSpeed: kmhToMph(o.windSpeed?.value),
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
    periods: periods.slice(0, 4),
    alerts,
  };
}

/* ---------- rendering ---------- */

function severityClasses(severity) {
  switch (severity) {
    case "Extreme":
    case "Severe":
      return "border-red-300 bg-red-50 text-red-800";
    case "Moderate":
      return "border-amber-300 bg-amber-50 text-amber-800";
    default:
      return "border-blue-300 bg-blue-50 text-blue-800";
  }
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    return `
      <section class="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-emerald-800">
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          <p class="text-lg font-semibold">No active weather alerts</p>
        </div>
      </section>`;
  }

  const cards = alerts
    .map((a) => {
      const ends = a.ends
        ? new Date(a.ends).toLocaleString(undefined, {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })
        : null;
      return `
        <div class="rounded-2xl border-2 px-5 py-4 ${severityClasses(a.severity)}">
          <div class="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <p class="text-xl font-bold">${esc(a.event)}</p>
          </div>
          ${a.headline ? `<p class="mt-1 text-base leading-relaxed">${esc(a.headline)}</p>` : ""}
          ${ends ? `<p class="mt-1 text-sm font-medium opacity-80">Until ${esc(ends)}</p>` : ""}
        </div>`;
    })
    .join("");

  return `<section class="flex flex-col gap-3">${cards}</section>`;
}

function renderCurrent(current) {
  if (!current) {
    return `
      <section class="rounded-2xl border border-slate-200 bg-white px-6 py-6">
        <p class="text-sm font-semibold uppercase tracking-wide text-slate-400">Current Conditions</p>
        <p class="mt-2 text-lg text-slate-400">Observation unavailable</p>
      </section>`;
  }
  return `
    <section class="rounded-2xl border border-slate-200 bg-white px-6 py-6">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-400">Current Conditions</p>
      <div class="mt-2 flex items-end justify-between gap-4">
        <div>
          <p class="text-7xl font-bold leading-none tabular">${current.temperature != null ? current.temperature + "°" : "--"}</p>
          <p class="mt-2 text-xl text-slate-600">${esc(current.textDescription || "")}</p>
        </div>
        <div class="text-right text-lg text-slate-600">
          ${current.humidity != null ? `<p>Humidity <span class="font-semibold tabular">${current.humidity}%</span></p>` : ""}
          ${current.windSpeed != null ? `<p class="mt-1">Wind <span class="font-semibold tabular">${current.windSpeed} mph</span></p>` : ""}
        </div>
      </div>
    </section>`;
}

function renderForecastCard(label, p) {
  if (!p) {
    return `
      <div class="flex-1 rounded-2xl border border-slate-200 bg-white px-6 py-5">
        <p class="text-sm font-semibold uppercase tracking-wide text-slate-400">${esc(label)}</p>
        <p class="mt-2 text-slate-400">Forecast unavailable</p>
      </div>`;
  }
  const pop = p.probabilityOfPrecipitation?.value;
  return `
    <div class="flex-1 rounded-2xl border border-slate-200 bg-white px-6 py-5">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-400">${esc(p.name || label)}</p>
      <p class="mt-2 text-5xl font-bold tabular">${p.temperature}°<span class="text-2xl font-medium text-slate-400">${esc(p.temperatureUnit || "")}</span></p>
      <p class="mt-2 text-lg leading-relaxed text-slate-700">${esc(p.shortForecast || "")}</p>
      <div class="mt-3 space-y-1 text-base text-slate-500">
        ${p.windSpeed ? `<p>Wind ${esc(p.windDirection || "")} ${esc(p.windSpeed)}</p>` : ""}
        ${pop != null ? `<p>Precipitation ${pop}%</p>` : ""}
      </div>
    </div>`;
}

function renderError(message) {
  return `
    <div class="rounded-2xl border-2 border-red-300 bg-red-50 px-6 py-5 text-red-800">
      <p class="text-xl font-semibold">Unable to load weather</p>
      <p class="mt-1 text-lg">${esc(message)}</p>
      <button id="retry-btn" class="mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 font-medium text-red-700 hover:bg-red-100">Retry</button>
    </div>`;
}

function render(data) {
  el.location.textContent = data.location || "Unknown location";

  const today = data.periods[0];
  const tomorrow = data.periods.find(
    (p, i) => i > 0 && p.isDaytime === (today ? today.isDaytime : true)
  );

  el.content.innerHTML = `
    ${renderAlerts(data.alerts)}
    ${renderCurrent(data.current)}
    <div class="flex flex-col gap-6 sm:flex-row">
      ${renderForecastCard("Today", today)}
      ${renderForecastCard("Tomorrow", tomorrow)}
    </div>`;

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
