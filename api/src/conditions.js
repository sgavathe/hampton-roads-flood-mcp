// Live context for an area: weather (Open-Meteo, no key) and the latest observed
// water level at the nearest NOAA tide gauge. Context only: not linked to the
// what-if scenario. Cached so the free upstream APIs are called sparingly.

const TTL_MS = 10 * 60_000;
const APP = 'hampton_roads_flood_mcp';

export function weatherUrl([lon, lat]) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'America/New_York',
    forecast_days: '5',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

export function tideUrl(stationId, datum) {
  const p = new URLSearchParams({
    date: 'latest',
    station: stationId,
    product: 'water_level',
    datum,
    units: 'metric',
    time_zone: 'lst_ldt',
    format: 'json',
    application: APP,
  });
  return `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${p}`;
}

// WMO weather codes -> short text.
export function describeWeather(code) {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

export function parseWeather(json) {
  const c = json.current ?? {};
  const d = json.daily ?? {};
  return {
    observedAt: c.time,
    tempF: c.temperature_2m,
    feelsLikeF: c.apparent_temperature,
    humidityPct: c.relative_humidity_2m,
    precipIn: c.precipitation,
    windMph: c.wind_speed_10m,
    windDir: Number.isFinite(c.wind_direction_10m) ? compass(c.wind_direction_10m) : null,
    summary: describeWeather(c.weather_code),
    daily: (d.time ?? []).map((date, i) => ({
      date,
      summary: describeWeather(d.weather_code?.[i]),
      code: d.weather_code?.[i],
      highF: d.temperature_2m_max?.[i],
      lowF: d.temperature_2m_min?.[i],
      precipChancePct: d.precipitation_probability_max?.[i],
    })),
  };
}

export function createConditions({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    return value;
  }

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { 'user-agent': APP } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function tide(station) {
    // Prefer NAVD88 so it is comparable with the scenario levels; some gauges only publish tidal datums.
    for (const datum of ['NAVD', 'MLLW']) {
      const json = await getJson(tideUrl(station.id, datum));
      const latest = json?.data?.[0];
      if (latest && Number.isFinite(Number(latest.v))) {
        return {
          stationId: station.id,
          station: station.name,
          waterLevelM: Number(latest.v),
          datum: datum === 'NAVD' ? 'NAVD88' : 'MLLW',
          comparableToScenario: datum === 'NAVD',
          observedAt: latest.t,
        };
      }
    }
    return null;
  }

  return async function conditions(area) {
    const [w, s, e, n] = area.bbox;
    const center = [(w + e) / 2, (s + n) / 2];
    const [weather, tideResult] = await Promise.allSettled([
      cached(`w:${area.id}`, async () => parseWeather(await getJson(weatherUrl(center)))),
      cached(`t:${area.id}`, () => tide(area.tideStation)),
    ]);
    return {
      area: area.id,
      weather: weather.status === 'fulfilled' ? weather.value : null,
      tide: tideResult.status === 'fulfilled' ? tideResult.value : null,
      note: 'Live context only; not linked to the what-if water level.',
      sources: { weather: 'Open-Meteo', tide: 'NOAA CO-OPS' },
    };
  };
}
