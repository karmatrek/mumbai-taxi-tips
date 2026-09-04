const https = require("https");
const http  = require("http");

const ZONES = require("../../public/zones.json").zones;

const TICKETMASTER_KEY  = process.env.TICKETMASTER_KEY  || "";
const PREDICTHQ_KEY     = process.env.PREDICTHQ_KEY     || "";
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY || "";

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent":"MumbaiDriverTips/1.0", "Accept":"application/json", ...headers },
      timeout: 12000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse fail: ${data.slice(0,120)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function matchZone(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const z of ZONES)
    for (const area of z.areas)
      if (lower.includes(area.toLowerCase())) return z;
  return null;
}

function fallbackZone(etype) {
  if (etype === "flight") return ZONES.find(z => z.name_en.includes("Airport"));
  if (etype === "concert" || etype === "comedy") return ZONES.find(z => z.name_en.includes("Bandra West"));
  return ZONES.find(z => z.name_en.includes("BKC")) || ZONES[3];
}


// ── Mumbai city filter ────────────────────────────────────────────────────────
const MUMBAI_TERMS = [
  "mumbai","bombay","andheri","bandra","worli","dadar","kurla","thane",
  "powai","juhu","malad","goregaon","borivali","versova","bkc","lower parel",
  "navi mumbai","vashi","belapur","chembur","ghatkopar","colaba","nariman",
  "churchgate","cst","wadala","parel","vikhroli","kandivali","dahisar",
  "mira road","mulund","airoli","nerul","seawoods","ghansoli","panvel",
  "hiranandani","oshiwara","seepz","chakala","sahar","santacruz","vileparle",
];

function isMumbaiEvent(title, venueName, locationText) {
  const combined = `${title} ${venueName} ${locationText}`.toLowerCase();
  return MUMBAI_TERMS.some(t => combined.includes(t));
}

function scoreEvent(etype, zone, hour) {
  if (!zone) return 0;
  const ride    = { long:10, office:7, mixed:6 }[zone.ride_type] || 5;
  const star    = zone.ride_hindi.includes("⭐") ? 3 : 0;
  const traffic = { low:1.0, medium:0.75, heavy:0.5 }[zone.traffic] || 0.7;
  const type    = { wedding:10,flight:9,concert:8,sports:8,comedy:7,exhibition:6,movie:5,other:5 }[etype] || 5;
  const night   = (hour >= 22 || hour <= 4) ? 1.2 : 1.0;
  return Math.round((ride + star) * type * traffic * night * 10) / 10;
}

// ── Ticketmaster ──────────────────────────────────────────────────────────────
async function getTicketmaster() {
  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const url = `https://app.ticketmaster.com/discovery/v2/events.json`
    + `?apikey=${TICKETMASTER_KEY}`
    + `&city=Mumbai&countryCode=IN`
    + `&startDateTime=${today}T00:00:00Z`
    + `&endDateTime=${tomorrow}T23:59:00Z`
    + `&size=20&sort=relevance,desc`;
  try {
    const data  = await fetchJSON(url);
    const items = data?._embedded?.events || [];
    return items.map(ev => {
      const seg   = (ev.classifications?.[0]?.segment?.name || "").toLowerCase();
      const genre = (ev.classifications?.[0]?.genre?.name   || "").toLowerCase();
      const venue = ev._embedded?.venues?.[0];
      const vtext = `${venue?.name || ""} ${venue?.address?.line1 || ""} ${venue?.city?.name || ""}`;
      const etype = seg.includes("music")     ? "concert"
                  : seg.includes("sport")     ? "sports"
                  : genre.includes("comedy")  ? "comedy"
                  : seg.includes("art")       ? "exhibition"
                  : "other";
      const hour  = parseInt((ev.dates?.start?.localTime || "20:00").split(":")[0]);
      const zone  = matchZone(vtext) || fallbackZone(etype);
      return { name:ev.name, venue:venue?.name||"Mumbai", type:etype, hour, zone,
               score:scoreEvent(etype,zone,hour), source:"ticketmaster" };
    }).filter(e => e.score > 0 && isMumbaiEvent(e.name, e.venue, "mumbai"));
  } catch(e) { console.log("TM error:", e.message); return []; }
}

// ── PredictHQ ─────────────────────────────────────────────────────────────────
async function getPredictHQ() {
  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  // place_id 1275339 = Mumbai (more reliable than radius for PredictHQ India)
  const url = `https://api.predicthq.com/v1/events/`
    + `?place.scope=1275339`
    + `&start.gte=${today}&start.lte=${tomorrow}`
    + `&category=concerts,performing-arts,sports,festivals,expos,community`
    + `&limit=20&sort=rank`;
  try {
    const data  = await fetchJSON(url, { Authorization:`Bearer ${PREDICTHQ_KEY}` });
    const items = data?.results || [];
    return items.map(ev => {
      const cat   = ev.category || "other";
      const etype = cat==="concerts"?"concert":cat==="performing-arts"?"comedy"
                  : cat==="sports"?"sports":cat==="expos"?"exhibition"
                  : cat==="festivals"?"concert":"other";
      const hour  = ev.start ? new Date(ev.start).getHours() : 20;
      const vname = ev.entities?.find(e=>e.type==="venue")?.name || "";
      const zone  = matchZone(ev.title+" "+vname) || fallbackZone(etype);
      return { name:ev.title, venue:vname||"Mumbai", type:etype, hour, zone,
               score:scoreEvent(etype,zone,hour), source:"predicthq" };
    }).filter(e => e.score > 0 && isMumbaiEvent(e.name, e.venue, \"\"));
  } catch(e) { console.log("PHQ error:", e.message); return []; }
}

// ── AviationStack ─────────────────────────────────────────────────────────────

// ── BookMyShow via ScraperAPI ─────────────────────────────────────────────────
async function getBMSEvents() {
  const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || "";
  if (!SCRAPERAPI_KEY) return [];
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const bmsUrl = encodeURIComponent(
    "https://in.bookmyshow.com/api/explore/v1/discover/shows?appCode=MOBAND2&appVersion=14390&language=en&regionCode=MUMBAI&subTypes=MT,PLAY,SP,EV,AC,SPORT&category=BMS&date=" + today
  );
  const url = "http://api.scraperapi.com?api_key=" + SCRAPERAPI_KEY + "&url=" + bmsUrl + "&country_code=in";
  try {
    const data  = await fetchJSON(url);
    const shows = data && data.BookMyShow && data.BookMyShow.arrEvent ? data.BookMyShow.arrEvent : [];
    return shows.slice(0,40).map(function(show) {
      const cat   = (show.EventCategory||"").toLowerCase();
      const vtext = (show.VenueName||"") + " " + (show.VenueCity||"");
      const etype = cat.indexOf("music") >= 0 || cat.indexOf("concert") >= 0 ? "concert"
                  : cat.indexOf("comedy") >= 0 ? "comedy"
                  : cat.indexOf("sport") >= 0  ? "sports"
                  : cat.indexOf("exhibit") >= 0 || cat.indexOf("fair") >= 0 ? "exhibition"
                  : cat.indexOf("movie") >= 0 || cat.indexOf("film") >= 0 ? "movie"
                  : "other";
      const mTime = (show.ShowTime||"").match(/([0-9]+):/);
      const hour  = mTime ? parseInt(mTime[1]) : 20;
      const zone  = matchZone(vtext) || fallbackZone(etype);
      const score = scoreEvent(etype, zone, hour);
      return (score > 0 && isMumbaiEvent(show.EventName, vtext, "mumbai"))
        ? {name:show.EventName, venue:(show.VenueName||"Mumbai").trim(),
           type:etype, hour:hour, zone:zone, score:score, source:"bookmyshow"}
        : null;
    }).filter(function(e){ return e !== null; });
  } catch(e) { console.log("BMS error:", e.message); return []; }
}

async function getFlights() {
  const az = ZONES.find(z => z.name_en.includes("Airport"));
  if (!az) return [];
  const url = `http://api.aviationstack.com/v1/flights`
    + `?access_key=${AVIATIONSTACK_KEY}`
    + `&dep_iata=BOM&flight_status=scheduled&limit=20`;
  try {
    const data  = await fetchJSON(url);
    const items = data?.data || [];
    const night = items.filter(f => {
      const dep = f.departure?.scheduled;
      if (!dep) return false;
      // Convert to IST (UTC+5:30)
      const depDate = new Date(dep);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istHour = new Date(depDate.getTime() + istOffset).getUTCHours();
      return istHour >= 22 || istHour <= 5;
    }).slice(0, 3);

    const pool = night.length > 0 ? night : items.slice(0, 3);
    if (pool.length > 0) {
      return pool.map(f => {
        const istOffset = 5.5 * 60 * 60 * 1000;
        const hour = new Date(new Date(f.departure.scheduled).getTime() + istOffset).getUTCHours();
        const dest = f.arrival?.airport || f.airline?.name || "International";
        return { name:`Flight ${f.flight?.iata||""} — ${dest}`,
                 venue:"T2 International Airport, Mumbai",
                 type:"flight", hour, zone:az,
                 score:scoreEvent("flight",az,hour), source:"aviationstack" };
      });
    }
  } catch(e) { console.log("AVS error:", e.message); }

  // Fallback defaults
  return [
    { fno:"6E-204", dest:"दुबई",     hour:1 },
    { fno:"AI-131", dest:"लंदन",     hour:2 },
    { fno:"EK-500", dest:"सिंगापुर", hour:3 },
  ].map(f => ({ name:`Flight ${f.fno} — ${f.dest}`,
                venue:"T2 International Airport, Mumbai",
                type:"flight", hour:f.hour, zone:az,
                score:scoreEvent("flight",az,f.hour), source:"default" }));
}

// ── Wedding rotation ──────────────────────────────────────────────────────────
function getWedding() {
  const venues = [
    {name:"Taj Lands End",         area:"Bandra West"},
    {name:"St Regis Mumbai",       area:"Lower Parel"},
    {name:"Trident Nariman Point", area:"South Mumbai"},
    {name:"JW Marriott Juhu",      area:"Juhu"},
    {name:"Grand Hyatt Mumbai",    area:"BKC"},
    {name:"ITC Maratha",           area:"Airport"},
    {name:"Renaissance Mumbai",    area:"Powai"},
  ];
  const pick = venues[new Date().getDate() % venues.length];
  const zone = matchZone(pick.name+" "+pick.area);
  if (!zone) return [];
  return [{ name:`शादी समारोह — ${pick.name}`, venue:`${pick.name}, Mumbai`,
             type:"wedding", hour:23, zone,
             score:scoreEvent("wedding",zone,23), source:"pattern" }];
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async () => {
  const [tm, phq, bms, flights] = await Promise.all([
    getTicketmaster(), getPredictHQ(), getBMSEvents(), getFlights()
  ]);
  const weddings = getWedding();

  console.log(`TM:${tm.length} PHQ:${phq.length} BMS:${bms.length} Flights:${flights.length}`);

  const all = [...tm, ...phq, ...bms, ...flights, ...weddings]
    .sort((a,b) => b.score - a.score);

  const top3 = [], seen = new Set();
  for (const e of all) {
    const zid = e.zone?.id;
    if (zid && !seen.has(zid)) { top3.push(e); seen.add(zid); }
    if (top3.length === 3) break;
  }
  const final = top3.length > 0 ? top3 : all.slice(0,3);

  const clean = final.map(t => ({
    name:t.name, venue:t.venue, type:t.type, hour:t.hour,
    score:t.score, source:t.source,
    zone:{
      id:t.zone.id, name:t.zone.name, name_en:t.zone.name_en,
      belt_hindi:t.zone.belt_hindi, ride_hindi:t.zone.ride_hindi,
      wait_hindi:t.zone.wait_hindi, tip_hindi:t.zone.tip_hindi,
      traffic_warn:t.zone.traffic_warn, traffic:t.zone.traffic,
    }
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      tips:clean,
      sources:{ ticketmaster:tm.length, predicthq:phq.length, flights:flights.length },
      generated: new Date().toISOString()
    }),
  };
};
