console.log("==========================================================");
console.log(" CardVault Pokemon Event Collector 12.9.49");
console.log(" Motor: PokéData JSON API (sin Playwright)");
console.log("==========================================================");

const POKEDATA_BASE = "https://www.pokedata.ovh/events/api";
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.CARDVAULT_EVENT_SYNC_TOKEN;
const DEBUG = process.env.CARDVAULT_EVENT_DEBUG === "1";

if (!SUPABASE_URL || !TOKEN) {
  throw new Error("Faltan SUPABASE_URL o CARDVAULT_EVENT_SYNC_TOKEN.");
}

const clean = v => v == null ? "" : String(v).replace(/\s+/g, " ").trim();

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

const START = ymd(new Date());

/*
 * Centros solapados para cubrir España peninsular + Baleares + Canarias.
 * PokéData deduplica de forma natural gracias al guid; nosotros volvemos a
 * deduplicar antes de enviar a Supabase.
 *
 * El endpoint de referencia usa millas ("mi"), por eso mantenemos esa unidad.
 */
const AREAS = [
  { name:"Madrid", lat:40.4168, lon:-3.7038, radius:125 },
  { name:"Barcelona", lat:41.3874, lon:2.1686, radius:105 },
  { name:"Valencia", lat:39.4699, lon:-0.3763, radius:105 },
  { name:"Sevilla", lat:37.3891, lon:-5.9845, radius:115 },
  { name:"Málaga", lat:36.7213, lon:-4.4214, radius:95 },
  { name:"Zaragoza", lat:41.6488, lon:-0.8891, radius:115 },
  { name:"Bilbao", lat:43.2630, lon:-2.9350, radius:105 },
  { name:"A Coruña", lat:43.3623, lon:-8.4115, radius:110 },
  { name:"Valladolid", lat:41.6523, lon:-4.7245, radius:110 },
  { name:"Murcia", lat:37.9922, lon:-1.1307, radius:95 },
  { name:"Badajoz", lat:38.8794, lon:-6.9707, radius:100 },
  { name:"Palma", lat:39.5696, lon:2.6502, radius:75 },
  { name:"Las Palmas", lat:28.1235, lon:-15.4363, radius:65 },
  { name:"Tenerife", lat:28.4636, lon:-16.2518, radius:65 }
];

const TYPES = [
  { api:"cups", eventType:"league_cup" },
  { api:"challenges", eventType:"league_challenge" }
  // Si más adelante quieres prelanzamientos:
  // { api:"pre", eventType:"prerelease" }
];

const COMMUNITY_ALIASES = [
  [/madrid/i, "Comunidad de Madrid"],
  [/catalu|catalunya|barcelona|girona|lleida|tarragona/i, "Cataluña"],
  [/valenc|alicante|castell[oó]n/i, "Comunidad Valenciana"],
  [/andaluc|sevilla|m[aá]laga|granada|c[aá]diz|c[oó]rdoba|huelva|ja[eé]n|almer[ií]a/i, "Andalucía"],
  [/arag[oó]n|zaragoza|huesca|teruel/i, "Aragón"],
  [/pa[ií]s vasco|euskadi|bizkaia|vizcaya|gipuzkoa|guip[uú]zcoa|[aá]lava|araba|bilbao/i, "País Vasco"],
  [/galicia|coru[nñ]a|pontevedra|lugo|ourense|orense|vigo/i, "Galicia"],
  [/castilla y le[oó]n|valladolid|le[oó]n|burgos|salamanca|zamora|palencia|segovia|soria|[aá]vila/i, "Castilla y León"],
  [/castilla.?la mancha|toledo|albacete|cuenca|guadalajara|ciudad real/i, "Castilla-La Mancha"],
  [/murcia/i, "Región de Murcia"],
  [/asturias|oviedo|gij[oó]n/i, "Principado de Asturias"],
  [/cantabria|santander/i, "Cantabria"],
  [/navarra|pamplona|iru[nñ]a/i, "Navarra"],
  [/la rioja|logro[nñ]o/i, "La Rioja"],
  [/extremadura|badajoz|c[aá]ceres/i, "Extremadura"],
  [/balear|mallorca|menorca|ibiza|eivissa|palma/i, "Islas Baleares"],
  [/canarias|gran canaria|tenerife|lanzarote|fuerteventura|la palma/i, "Canarias"],
  [/ceuta/i, "Ceuta"],
  [/melilla/i, "Melilla"]
];

function inferCommunity(raw) {
  const haystack = clean([
    raw.state, raw.region, raw.province, raw.city,
    raw.street_address, raw.address, raw.shop, raw.name
  ].filter(Boolean).join(" | "));
  for (const [rx, community] of COMMUNITY_ALIASES) {
    if (rx.test(haystack)) return community;
  }
  return clean(raw.state || raw.region || raw.province || "");
}

function isSpain(raw) {
  const c = clean(raw.country || raw.country_code || raw.countryCode || raw.Country);
  if (!c) return true; // PokéData puede omitirlo en algunas respuestas.
  return /^(es|esp|spain|espa[nñ]a)$/i.test(c);
}

function eventTypeFrom(raw, fallback) {
  const t = clean(raw.type || raw.name).toLowerCase();
  if (t.includes("cup")) return "league_cup";
  if (t.includes("challenge")) return "league_challenge";
  if (t.includes("pre")) return "prerelease";
  return fallback;
}

function parseWhen(raw) {
  const when = clean(raw.when);
  if (when) {
    // PokéData usa normalmente "YYYY-MM-DD HH:mm:ss".
    const m = when.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return madridIso(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  }

  const date = clean(raw.date);
  const time = clean(raw.time) || "10:00:00";
  const m = `${date} ${time}`.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return madridIso(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));

  return "";
}

/*
 * Devuelve ISO con offset correcto de Europe/Madrid (+01:00/+02:00).
 * Se calcula el offset con Intl para respetar cambio de hora.
 */
function madridIso(y, mo, d, h, mi, s) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    timeZoneName: "longOffset",
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
    hourCycle:"h23"
  });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map(p => [p.type, p.value]));
  const zone = (parts.timeZoneName || "GMT+01:00").replace("GMT", "");
  // El "guess" solo se usa para conocer el offset de esa fecha; conservamos la hora local de PokéData.
  return `${String(y).padStart(4,"0")}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}:${String(s).padStart(2,"0")}${zone}`;
}

function detailText(raw) {
  const contact = raw.contact_data && typeof raw.contact_data === "object"
    ? clean(raw.contact_data.Details || raw.contact_data.details)
    : "";
  return clean([
    raw.name,
    raw.status ? `Estado: ${raw.status}` : "",
    raw.cost ? `Coste: ${raw.cost}` : "",
    contact
  ].filter(Boolean).join(" · "));
}

function normalizeEvent(raw, fallbackType) {
  if (!raw || typeof raw !== "object") return null;
  if (!isSpain(raw)) return null;

  const startsAt = parseWhen(raw);
  if (!startsAt) return null;

  const guid = clean(raw.guid);
  if (!guid) return null;

  const shop = clean(raw.shop || raw.venue || raw.store);
  const name = clean(raw.name) || `${shop} - ${clean(raw.type || "Evento Pokémon")}`;
  const address = clean(raw.street_address || raw.address);
  const city = clean(raw.city);
  const community = inferCommunity(raw);
  const pokemonUrl = clean(raw.pokemon_url || raw.url);

  return {
    externalId: `pokedata-${guid}`,
    name,
    eventType: eventTypeFrom(raw, fallbackType),
    product: "TCG",
    startsAt,
    venueName: shop,
    address,
    city,
    region: community,
    autonomousCommunity: community,
    country: "ES",
    admissionCost: clean(raw.cost),
    details: detailText(raw),
    registrationUrl: pokemonUrl,
    sourceUrl: pokemonUrl || "https://www.pokedata.ovh/events/"
  };
}

async function fetchJson(url, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "accept": "application/json",
          "user-agent": "CardVault/12.9.49 (+Pokemon event calendar sync)"
        }
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("La respuesta no es un array JSON");
      return data;
    } catch (e) {
      lastError = e;
      console.warn(`[${label}] intento ${attempt}/${attempts}: ${e.message}`);
      if (attempt < attempts) await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastError;
}

async function collectArea(area, type) {
  const url =
    `${POKEDATA_BASE}/_tcg/${type.api}` +
    `/_latitude/${area.lat}/_longitude/${area.lon}` +
    `/_radius/${area.radius}/_unit/mi/_start/${START}`;

  if (DEBUG) console.log(`[API] ${area.name} ${type.api}: ${url}`);

  const raw = await fetchJson(url, `${area.name}/${type.api}`);
  const normalized = raw
    .map(e => normalizeEvent(e, type.eventType))
    .filter(Boolean);

  console.log(`${area.name} / ${type.api}: ${raw.length} recibidos, ${normalized.length} España válidos`);
  return normalized;
}

async function main() {
  const all = [];
  const failures = [];

  /*
   * Secuencial y con una pausa corta: es más respetuoso con el servicio
   * y suficiente para ejecutarse cada hora.
   */
  for (const area of AREAS) {
    for (const type of TYPES) {
      try {
        all.push(...await collectArea(area, type));
      } catch (e) {
        failures.push(`${area.name}/${type.api}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const unique = [...new Map(all.map(e => [e.externalId, e])).values()]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  console.log("----------------------------------------------------------");
  console.log(`Total bruto normalizado: ${all.length}`);
  console.log(`Total único por guid: ${unique.length}`);
  if (failures.length) {
    console.warn(`Consultas fallidas: ${failures.length}`);
    failures.forEach(x => console.warn(`  - ${x}`));
  }

  /*
   * No vaciamos Supabase accidentalmente si PokéData falla por completo.
   */
  if (!unique.length) {
    throw new Error("PokéData no devolvió ningún evento válido; se cancela la sincronización para proteger los datos existentes.");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-pokemon-events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cardvault-sync-token": TOKEN
    },
    body: JSON.stringify({
      source: "pokedata",
      events: unique
    })
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);

  console.log("Sincronización PokéData -> Supabase completada.");
  console.log(body);

  if (failures.length) {
    console.warn("AVISO: la sincronización terminó, pero hubo consultas parciales fallidas.");
  }
}

await main();
