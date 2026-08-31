console.log("==========================================================");
console.log(" CardVault Pokemon Event Collector 12.9.47");
console.log(" Motor: controles OutSystems reales (DoubleSwitch/Flatpickr)");
console.log("==========================================================");

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://events.pokemon.com/EventLocator/?locale=es-ES";
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.CARDVAULT_EVENT_SYNC_TOKEN;
const DEBUG = process.env.CARDVAULT_EVENT_DEBUG === "1";
const HEADLESS = process.env.CARDVAULT_EVENT_HEADLESS !== "0";

if (!SUPABASE_URL || !TOKEN) {
  throw new Error("Faltan SUPABASE_URL o CARDVAULT_EVENT_SYNC_TOKEN.");
}

console.log("[collector] VERSION=12.9.47 OUTSYSTEMS_REAL_CONTROLS_DATE_MAX");

const now = new Date();
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
const START = ymd(now);
const searches = [
  ["Madrid, España","Comunidad de Madrid"],
  ["Barcelona, España","Cataluña"],
  ["Valencia, España","Comunidad Valenciana"],
  ["Sevilla, España","Andalucía"],
  ["Málaga, España","Andalucía"],
  ["Granada, España","Andalucía"],
  ["Zaragoza, España","Aragón"],
  ["Bilbao, España","País Vasco"],
  ["A Coruña, España","Galicia"],
  ["Vigo, España","Galicia"],
  ["Valladolid, España","Castilla y León"],
  ["Toledo, España","Castilla-La Mancha"],
  ["Albacete, España","Castilla-La Mancha"],
  ["Murcia, España","Región de Murcia"],
  ["Oviedo, España","Principado de Asturias"],
  ["Santander, España","Cantabria"],
  ["Pamplona, España","Navarra"],
  ["Logroño, España","La Rioja"],
  ["Badajoz, España","Extremadura"],
  ["Palma, España","Islas Baleares"],
  ["Las Palmas de Gran Canaria, España","Canarias"],
  ["Santa Cruz de Tenerife, España","Canarias"]
];

const clean = v => v == null ? "" : String(v).replace(/\s+/g," ").trim();

function slug(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/gi,"_").replace(/^_|_$/g,"").toLowerCase();
}

async function saveDebug(page, city, suffix) {
  const dir = path.resolve("debug");
  fs.mkdirSync(dir,{recursive:true});
  const name = `${slug(city)}_${suffix}`;
  await page.screenshot({path:path.join(dir,`${name}.png`),fullPage:true}).catch(()=>{});
  fs.writeFileSync(path.join(dir,`${name}.html`),await page.content().catch(()=>""),"utf8");
  fs.writeFileSync(path.join(dir,`${name}.url.txt`),page.url(),"utf8");
  fs.writeFileSync(path.join(dir,`${name}.txt`),await page.locator("body").innerText().catch(()=>""),"utf8");
}

async function dismissCookies(page) {
  for (let i=0;i<20;i++) {
    const buttons = [
      page.getByRole("button",{name:/Aceptar todas|Aceptar todo|Accept All/i}).first(),
      page.getByRole("button",{name:/Rechazar todas|Reject All/i}).first(),
      page.locator("#onetrust-accept-btn-handler").first(),
      page.locator("#onetrust-reject-all-handler").first()
    ];
    for (const b of buttons) {
      try {
        if (await b.isVisible({timeout:150})) {
          await b.click({force:true});
          await page.waitForTimeout(500);
          return true;
        }
      } catch {}
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function visibleLocationInput(page) {
  const all = page.locator("input");
  for (let i=0;i<await all.count();i++) {
    const el = all.nth(i);
    if (!await el.isVisible().catch(()=>false)) continue;
    if (!await el.isEnabled().catch(()=>false)) continue;
    const ph = clean(await el.getAttribute("placeholder").catch(()=>null));
    const aria = clean(await el.getAttribute("aria-label").catch(()=>null));
    if (/introduce tu ciudad|ciudad|ubicaci|location/i.test(`${ph} ${aria}`)) return el;
  }
  return null;
}

async function clickTextControl(page, pattern) {
  // Click by DOM structure, not by brittle Playwright role assumptions.
  return await page.evaluate(({source,flags}) => {
    const rx = new RegExp(source,flags);
    const visible = el => {
      const r=el.getBoundingClientRect();
      const cs=getComputedStyle(el);
      return r.width>0 && r.height>0 && cs.display!=="none" && cs.visibility!=="hidden";
    };
    const nodes=[...document.querySelectorAll("button,label,span,div,a,p")];
    const target=nodes.find(el => visible(el) && rx.test((el.textContent||"").trim()) && (el.textContent||"").trim().length<80);
    if(!target) return false;

    let p=target;
    for(let i=0;i<4 && p;i++,p=p.parentElement){
      const interactive =
        p.matches("button,label,a,[role='button'],[role='switch']") ||
        p.querySelector("input[type='checkbox'],button,[role='switch']");
      if(interactive){
        const nested=p.matches("button,label,a,[role='button'],[role='switch']")
          ? p
          : p.querySelector("input[type='checkbox'],button,[role='switch']");
        nested.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));
        return true;
      }
    }
    target.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));
    return true;
  }, {source:pattern.source,flags:pattern.flags});
}

async function forceEventsMode(page, city) {
  // HTML real del Locator:
  // <div class="double-toggle"> ... <input data-switch class="switch"
  // type="checkbox" id="...DoubleSwitch"> ... Eventos
  const toggle = page.locator('.double-toggle input[data-switch][type="checkbox"]').first();

  if (!await toggle.count()) {
    throw new Error(`${city}: no encuentro el DoubleSwitch real Ubicaciones/Eventos.`);
  }

  // Checkbox marcado = lado derecho = Eventos.
  if (!await toggle.isChecked()) {
    await toggle.check({ force:true });
    await page.waitForTimeout(500);
  }

  const checked = await toggle.isChecked();
  if (DEBUG) console.log(`[${city}] DoubleSwitch checked=${checked} => ${checked ? "Eventos" : "Ubicaciones"}`);

  if (!checked) {
    throw new Error(`${city}: no se pudo dejar DoubleSwitch en Eventos.`);
  }
}
async function setFilters(page, city) {
  const wanted = [
    /Copa de Liga/i,
    /Desaf[ií]o de Liga/i,
    /Juego de Cartas Coleccionables Pok[eé]mon/i
  ];

  for (const rx of wanted) {
    const candidates = page.locator('.el-tag-select[role="button"]');
    let found = false;

    for (let i=0; i<await candidates.count(); i++) {
      const el = candidates.nth(i);
      if (!await el.isVisible().catch(()=>false)) continue;

      const text = clean(await el.innerText().catch(()=>""));
      if (!rx.test(text)) continue;

      found = true;
      const selected = (await el.getAttribute("aria-selected")) === "True";
      if (!selected) {
        await el.click({force:true});
        await page.waitForTimeout(250);
      }

      const finalSelected = (await el.getAttribute("aria-selected")) === "True";
      if (DEBUG) console.log(`[${city}] filtro "${text}" selected=${finalSelected}`);

      if (!finalSelected) {
        throw new Error(`${city}: no se pudo seleccionar filtro "${text}".`);
      }
      break;
    }

    if (!found) {
      throw new Error(`${city}: no encuentro uno de los filtros requeridos (${rx}).`);
    }
  }
}
async function setDates(page, city) {
  const start = page.locator('input[type="date"][id$="Input_StartDate"]').first();
  const end = page.locator('input[type="date"][id$="Input_EndDate2"]').first();
  const endVisible = page.locator('input[type="text"][placeholder*="Hasta" i][readonly]').first();

  if (!await start.count()) throw new Error(`${city}: no encuentro Input_StartDate.`);
  if (!await end.count()) throw new Error(`${city}: no encuentro Input_EndDate2.`);

  // Primero fijamos el inicio real.
  await start.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, val); else el.value = val;
    el.dispatchEvent(new Event("input", {bubbles:true}));
    el.dispatchEvent(new Event("change", {bubbles:true}));
  }, START);
  await page.waitForTimeout(250);

  // Abrimos el Flatpickr REAL de "Hasta..." para que exista su instancia y podamos
  // consultar qué fechas acepta Pokémon en este momento.
  if (await endVisible.count()) {
    await endVisible.click({force:true}).catch(()=>{});
    await page.waitForTimeout(350);
  }

  const dateInfo = await page.evaluate(() => {
    const hidden = document.querySelector('input[type="date"][id$="Input_EndDate2"]');
    const visible = document.querySelector('input[type="text"][placeholder*="Hasta" i][readonly]');
    const wrapper = hidden?.closest(".osui-datepicker");

    const fp =
      hidden?._flatpickr ||
      visible?._flatpickr ||
      wrapper?._flatpickr ||
      (visible && window.flatpickr && visible._flatpickr);

    let maxDate = fp?.config?.maxDate || null;
    let minDate = fp?.config?.minDate || null;

    // Fallback muy útil para OutSystems: leer el calendario que ya renderizó.
    let maxYear = null;
    let maxMonth = null;
    const calendarId = visible?.getAttribute("aria-controls");
    const calendar = calendarId ? document.getElementById(calendarId) : null;

    if (calendar) {
      const yearInput = calendar.querySelector("input.cur-year");
      const monthSelect = calendar.querySelector("select.flatpickr-monthDropdown-months");

      if (yearInput) {
        const max = Number(yearInput.getAttribute("max"));
        if (Number.isFinite(max)) maxYear = max;
      }

      if (monthSelect) {
        const values = [...monthSelect.options]
          .map(o => Number(o.value))
          .filter(Number.isFinite);
        if (values.length) maxMonth = Math.max(...values);
      }
    }

    return {
      hasFlatpickr: !!fp,
      maxDate: maxDate instanceof Date && !Number.isNaN(maxDate.getTime())
        ? maxDate.toISOString()
        : null,
      minDate: minDate instanceof Date && !Number.isNaN(minDate.getTime())
        ? minDate.toISOString()
        : null,
      maxYear,
      maxMonth
    };
  });

  // Objetivo normal: ~90 días. Es suficiente para calendario competitivo y,
  // sobre todo, permanece dentro del rango que el Locator suele exponer.
  const desired = new Date(now);
  desired.setDate(desired.getDate() + 90);

  let allowedMax = null;

  if (dateInfo.maxDate) {
    allowedMax = new Date(dateInfo.maxDate);
  } else if (dateInfo.maxYear != null) {
    // Si Flatpickr no expone config.maxDate, el dropdown del calendario nos dice
    // el último mes realmente permitido por Pokémon.
    const month = dateInfo.maxMonth != null ? dateInfo.maxMonth : 11;
    allowedMax = new Date(dateInfo.maxYear, month + 1, 0, 12, 0, 0);
  }

  let target = desired;
  if (allowedMax && desired > allowedMax) target = allowedMax;

  // Nunca permitir una fecha anterior al inicio.
  const startDate = new Date(`${START}T12:00:00`);
  if (target < startDate) {
    throw new Error(`${city}: el Locator no ofrece un rango de fechas futuro válido.`);
  }

  const targetValue = ymd(target);

  if (DEBUG) {
    console.log(
      `[${city}] Flatpickr: instancia=${dateInfo.hasFlatpickr}, ` +
      `maxDate=${dateInfo.maxDate || "(sin config)"}, ` +
      `maxYear=${dateInfo.maxYear ?? "(?)"}, maxMonth=${dateInfo.maxMonth ?? "(?)"}`
    );
    console.log(`[${city}] fecha Hasta elegida=${targetValue}`);
  }

  // Método 1: usar la instancia Flatpickr asociada al input visible/real.
  const usedFlatpickr = await page.evaluate((val) => {
    const hidden = document.querySelector('input[type="date"][id$="Input_EndDate2"]');
    const visible = document.querySelector('input[type="text"][placeholder*="Hasta" i][readonly]');
    const wrapper = hidden?.closest(".osui-datepicker");
    const fp = hidden?._flatpickr || visible?._flatpickr || wrapper?._flatpickr;

    if (!fp || typeof fp.setDate !== "function") return false;
    fp.setDate(val, true, "Y-m-d");
    return true;
  }, targetValue);

  await page.waitForTimeout(400);

  // Método 2 fallback: escribir sobre el input real y disparar los eventos que
  // OutSystems escucha. Solo se usa si Flatpickr no lo reflejó.
  let endValue = await end.inputValue().catch(()=>"");
  if (!endValue) {
    await end.evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, val); else el.value = val;

      for (const type of ["input","change","blur"]) {
        el.dispatchEvent(new Event(type, {bubbles:true}));
      }
    }, targetValue);
    await page.waitForTimeout(350);
    endValue = await end.inputValue().catch(()=>"");
  }

  // Método 3: si el framework vuelve a vaciar el input, seleccionar el día a través
  // del calendario visible. Esto utiliza el propio Flatpickr, no un valor inventado.
  if (!endValue && await endVisible.count()) {
    await endVisible.click({force:true}).catch(()=>{});
    await page.waitForTimeout(250);

    const picked = await page.evaluate((iso) => {
      const visible = document.querySelector('input[type="text"][placeholder*="Hasta" i][readonly]');
      const id = visible?.getAttribute("aria-controls");
      const cal = id ? document.getElementById(id) : null;
      if (!cal) return false;

      // Flatpickr days normally expose aria-label with a locale-formatted date.
      // Compare their internal dateObj when available.
      const [y,m,d] = iso.split("-").map(Number);
      const cells = [...cal.querySelectorAll(".flatpickr-day")];

      for (const cell of cells) {
        const obj = cell.dateObj;
        if (
          obj &&
          obj.getFullYear() === y &&
          obj.getMonth() === m - 1 &&
          obj.getDate() === d &&
          !cell.classList.contains("flatpickr-disabled")
        ) {
          cell.dispatchEvent(new MouseEvent("click", {
            bubbles:true, cancelable:true, view:window
          }));
          return true;
        }
      }
      return false;
    }, targetValue);

    if (DEBUG) console.log(`[${city}] selección por celda Flatpickr=${picked}`);
    await page.waitForTimeout(350);
    endValue = await end.inputValue().catch(()=>"");
  }

  const startValue = await start.inputValue().catch(()=>"");
  const visibleEndValue = await endVisible.inputValue().catch(()=>"");

  if (DEBUG) {
    console.log(
      `[${city}] fechas finales: ${startValue || "(vacío)"} -> ` +
      `${endValue || "(vacío)"} (visible="${visibleEndValue || "(vacío)"}", ` +
      `flatpickr=${usedFlatpickr})`
    );
  }

  if (!startValue || !endValue) {
    throw new Error(
      `${city}: Flatpickr no aceptó Hasta=${targetValue}. ` +
      `Real=${endValue || "(vacío)"}, visible=${visibleEndValue || "(vacío)"}.`
    );
  }

  return { startValue, endValue };
}
async function selectLocation(page, query, city) {
  const input = await visibleLocationInput(page);
  if (!input) throw new Error(`${city}: no encuentro el buscador visible de ciudad.`);

  await input.scrollIntoViewIfNeeded();
  await input.click();
  await input.fill("");
  await input.type(query,{delay:55});
  await page.waitForTimeout(1800);

  // Search all visible autocomplete-like nodes and pick one containing city.
  const selectors=['[role="option"]','.pac-item','[class*="suggest"]','[class*="autocomplete"] li','li'];
  for(const sel of selectors){
    const opts=page.locator(sel);
    const n=Math.min(await opts.count(),50);
    for(let i=0;i<n;i++){
      const o=opts.nth(i);
      if(!await o.isVisible().catch(()=>false)) continue;
      const txt=clean(await o.innerText().catch(()=>""));
      if(txt.toLowerCase().includes(city.toLowerCase())){
        await o.click({force:true});
        await page.waitForTimeout(1000);
        if(DEBUG) console.log(`[${city}] autocomplete: ${txt}`);
        return;
      }
    }
  }

  await input.press("ArrowDown");
  await input.press("Enter");
  await page.waitForTimeout(1000);
  if(DEBUG) console.log(`[${city}] autocomplete por teclado`);
}

async function setRangeInUrl(page) {
  // The site demonstrably serialises search state in the URL.
  // Preserve its coordinates/filters and set a wide metric radius as fallback.
  const u=new URL(page.url());
  u.searchParams.set("range","100");
  u.searchParams.set("iskm","true");
  u.searchParams.set("startdate",START);
  const fallbackEnd = new Date(now);
  fallbackEnd.setDate(fallbackEnd.getDate() + 90);
  u.searchParams.set("enddate",ymd(fallbackEnd));
  await page.evaluate(url=>history.replaceState(null,"",url),u.toString()).catch(()=>{});
}

async function clickSearch(page, city) {
  const button = page.getByRole("button",{name:/Buscar ubicaciones|Buscar eventos|Search/i}).first();
  try {
    if (await button.isVisible({timeout:1500})) {
      await button.click();
      return;
    }
  } catch {}
  const ok=await clickTextControl(page,/^Buscar (ubicaciones|eventos)$/i);
  if(!ok) throw new Error(`${city}: no encuentro el botón de búsqueda.`);
}

async function resultKind(page) {
  const toggle = page.locator('.double-toggle input[data-switch][type="checkbox"]').first();
  const checked = await toggle.isChecked().catch(()=>false);
  const body = clean(await page.locator("body").innerText().catch(()=>""));

  if (checked) {
    if (/\d+\s+Eventos/i.test(body) || /eventos? encontrados?/i.test(body)) return "events";
    if (/No se han encontrado eventos/i.test(body)) return "events-empty";
    return "events-ui";
  }

  if (/\d+\s+Ubicaciones de Play!? Pok[eé]mon encontradas/i.test(body)) return "locations";
  if (/No se han encontrado ubicaciones/i.test(body)) return "locations-empty";
  return "locations-ui";
}
async function executeSearch(page, city) {
  await clickSearch(page,city);
  await page.waitForTimeout(3500);
  await page.waitForLoadState("networkidle",{timeout:5000}).catch(()=>{});
}

async function ensureEventResults(page, city) {
  let kind = await resultKind(page);
  if (DEBUG) console.log(`[${city}] resultado=${kind}`);

  const toggle = page.locator('.double-toggle input[data-switch][type="checkbox"]').first();
  if (!await toggle.isChecked().catch(()=>false)) {
    console.log(`[${city}] el DoubleSwitch volvió a Ubicaciones; corrigiendo y buscando otra vez...`);
    await forceEventsMode(page, city);
    await executeSearch(page, city);
    kind = await resultKind(page);
    if (DEBUG) console.log(`[${city}] resultado segundo intento=${kind}`);
  }

  if (!await toggle.isChecked().catch(()=>false)) {
    throw new Error(`${city}: el Locator no conserva el modo Eventos.`);
  }

  return kind;
}
function eventTypeFrom(text){
  const t=text.toLowerCase();
  if(t.includes("copa de liga")||t.includes("league cup")) return "league_cup";
  if(t.includes("desafío de liga")||t.includes("desafio de liga")||t.includes("league challenge")) return "league_challenge";
  return "league";
}

function parseDateTime(text){
  const months={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,
    septiembre:9,octubre:10,noviembre:11,diciembre:12};
  let d,m,y;
  let x=text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  if(x){d=+x[1];m=+x[2];y=+x[3];}
  if(!y){
    x=text.match(new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${Object.keys(months).join("|")})\\s+(?:de\\s+)?(20\\d{2})\\b`,"i"));
    if(x){d=+x[1];m=months[x[2].toLowerCase()];y=+x[3];}
  }
  if(!y) return "";
  const tm=text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const h=tm?+tm[1]:10, mi=tm?+tm[2]:0;
  const p=n=>String(n).padStart(2,"0");
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(mi)}:00+02:00`;
}

async function extractEvents(page,community){
  const raw=await page.evaluate(()=>{
    const all=[...document.querySelectorAll("article,li,[class*='event'],[class*='result'],[class*='card']")];
    const seen=new Set(), rows=[];
    for(const el of all){
      const txt=(el.innerText||el.textContent||"").replace(/\s+/g," ").trim();
      if(!txt || txt.length<15 || txt.length>2500) continue;
      if(!/Copa de Liga|Desaf[ií]o de Liga|League Cup|League Challenge/i.test(txt)) continue;
      if(seen.has(txt)) continue;
      seen.add(txt);
      const links=[...el.querySelectorAll("a[href]")].map(a=>a.href);
      const title=(
        el.querySelector(".event-info__title,h1,h2,h3,h4,[class*='title']")?.textContent||""
      ).trim();
      rows.push({text:txt,title,links});
    }
    return rows;
  });

  const output=[];
  for(const r of raw){
    const startsAt=parseDateTime(r.text);
    if(!startsAt) continue;
    const url=r.links.find(x=>/pokemon\.com/i.test(x))||"https://events.pokemon.com/EventLocator/";
    const official=(url+" "+r.text).match(/\b\d{2}-\d{2}-\d{6}\b/)?.[0];
    const name=clean(r.title)||clean(r.text).slice(0,140);
    const externalId=official||`dom-${slug(community)}-${slug(name)}-${startsAt.slice(0,16)}`.slice(0,180);
    output.push({
      externalId,
      name,
      eventType:eventTypeFrom(r.text),
      product:"TCG",
      startsAt,
      venueName:"",
      address:"",
      city:"",
      region:community,
      autonomousCommunity:community,
      country:"ES",
      admissionCost:"",
      details:clean(r.text),
      registrationUrl:url,
      sourceUrl:url
    });
  }
  return output;
}

async function prepareBase(page){
  await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForTimeout(1500);
  const cookies=await dismissCookies(page);
  if(DEBUG) console.log(`[inicio] cookies=${cookies?"cerradas/no presentes":"no localizadas"}`);
  await page.waitForTimeout(500);
}

async function searchCity(page,query,community,index){
  const city=query.split(",")[0];

  // Reload only when necessary; cookies remain in the same context.
  if(index>0){
    await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:60000});
    await page.waitForTimeout(700);
    await dismissCookies(page);
  }

  await forceEventsMode(page,city);
  await setFilters(page,city);
  await setDates(page,city);
  await selectLocation(page,query,city);

  if(DEBUG){
    const sw = page.locator('.double-toggle input[data-switch][type="checkbox"]').first();
    console.log(`[${city}] estado pre-búsqueda: Eventos=${await sw.isChecked().catch(()=>false)}`);
    console.log(`[${city}] URL pre-búsqueda: ${page.url()}`);
    await saveDebug(page,city,"antes");
  }

  await executeSearch(page,city);
  const kind=await ensureEventResults(page,city);
  const events=await extractEvents(page,community);

  if(DEBUG || events.length===0) await saveDebug(page,city,"resultado");

  console.log(`${city}: ${events.length} eventos (${kind})`);
  for(const e of events.slice(0,5)){
    if(DEBUG) console.log(`  -> ${e.eventType} | ${e.name} | ${e.startsAt}`);
  }
  return events;
}

async function main(){
  const browser=await chromium.launch({
    headless:HEADLESS,
    args:["--disable-blink-features=AutomationControlled","--disable-dev-shm-usage","--no-sandbox"]
  });

  const context=await browser.newContext({
    locale:"es-ES",
    timezoneId:"Europe/Madrid",
    viewport:{width:1440,height:1100},
    userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  });

  const page=await context.newPage();
  const all=[];

  try{
    await prepareBase(page);
    for(let i=0;i<searches.length;i++){
      const [query,community]=searches[i];
      try{
        const rows=await searchCity(page,query,community,i);
        all.push(...rows);
      }catch(e){
        console.warn(`${query.split(",")[0]}: ERROR - ${e.message}`);
        if(!page.isClosed()) await saveDebug(page,query.split(",")[0],"error");
        // If the website itself killed/replaced the page, recreate it rather than cascade failures.
        if(page.isClosed()) throw e;
      }
    }
  }finally{
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }

  const unique=[...new Map(all.map(e=>[e.externalId,e])).values()];
  if(!unique.length){
    throw new Error("No se extrajo ningún evento. Revisa debug/*_resultado.txt/png/html.");
  }

  console.log(`Total único: ${unique.length}`);

  const response=await fetch(`${SUPABASE_URL}/functions/v1/sync-pokemon-events`,{
    method:"POST",
    headers:{"content-type":"application/json","x-cardvault-sync-token":TOKEN},
    body:JSON.stringify({source:"cardvault-adaptive-locator",events:unique})
  });
  const body=await response.text();
  if(!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  console.log("Sincronización completada.");
  console.log(body);
}

await main();
