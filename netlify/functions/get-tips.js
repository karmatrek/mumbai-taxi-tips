const https = require("https");
const http  = require("http");

const ZONES = require("../../public/zones.json").zones;

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
        catch(e) { reject(new Error("Parse fail: " + data.slice(0,100))); }
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
  if (etype === "flight")  return ZONES.find(z => z.name_en.includes("Airport"));
  if (etype === "concert") return ZONES.find(z => z.name_en.includes("Bandra West"));
  return ZONES.find(z => z.name_en.includes("BKC")) || ZONES[3];
}

const MUMBAI_TERMS = [
  "mumbai","bombay","andheri","bandra","worli","dadar","kurla","thane",
  "powai","juhu","malad","goregaon","borivali","bkc","lower parel",
  "navi mumbai","vashi","belapur","chembur","ghatkopar","colaba",
  "nariman","churchgate","wadala","parel","vikhroli","kandivali",
  "dahisar","santacruz","vileparle","sahar","oshiwara","seepz",
];

function isMumbai(title, venue) {
  const s = (title + " " + venue).toLowerCase();
  return MUMBAI_TERMS.some(t => s.includes(t));
}

function scoreEvent(etype, zone, hour) {
  if (!zone) return 0;
  const ride   = { long:10, office:7, mixed:6 }[zone.ride_type] || 5;
  const star   = zone.ride_hindi.includes("⭐") ? 3 : 0;
  const traff  = { low:1.0, medium:0.75, heavy:0.5 }[zone.traffic] || 0.7;
  const type   = { wedding:10,flight:9,concert:8,sports:8,comedy:7,exhibition:6,other:5 }[etype] || 5;
  const night  = (hour >= 22 || hour <= 5) ? 1.2 : 1.0;
  return Math.round((ride + star) * type * traff * night * 10) / 10;
}

// ── PredictHQ ─────────────────────────────────────────────────────────────────
async function getPredictHQ() {
  if (!PREDICTHQ_KEY) return [];
  const today   = new Date().toISOString().slice(0,10);
  const in3days = new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const url = "https://api.predicthq.com/v1/events/"
    + "?place.exact=1275339"
    + "&start.gte=" + today + "&start.lte=" + in3days
    + "&category=concerts,performing-arts,sports,festivals,expos,community"
    + "&limit=20&sort=rank";
  try {
    const data  = await fetchJSON(url, { Authorization:"Bearer " + PREDICTHQ_KEY });
    const items = data.results || [];
    return items.map(ev => {
      const cat   = ev.category || "other";
      const etype = cat === "concerts"        ? "concert"
                  : cat === "performing-arts" ? "comedy"
                  : cat === "sports"          ? "sports"
                  : cat === "expos"           ? "exhibition"
                  : cat === "festivals"       ? "concert"
                  : "other";
      const vname = (ev.entities || []).find(e => e.type === "venue");
      const venue = vname ? vname.name : "Mumbai";
      const hour  = ev.start ? new Date(ev.start).getHours() : 20;
      // Convert UTC to IST
      const istHour = ev.start
        ? new Date(new Date(ev.start).getTime() + 5.5*3600000).getUTCHours()
        : 20;
      const zone  = matchZone(ev.title + " " + venue) || fallbackZone(etype);
      const score = scoreEvent(etype, zone, istHour);
      return { name:ev.title, venue, type:etype, hour:istHour, zone, score, source:"predicthq" };
    }).filter(e => e.score > 0);
  } catch(e) { console.log("PHQ error:", e.message); return []; }
}

// ── AviationStack ─────────────────────────────────────────────────────────────
async function getFlights() {
  const az = ZONES.find(z => z.name_en.includes("Airport"));
  if (!az) return [];

  if (AVIATIONSTACK_KEY) {
    const url = "http://api.aviationstack.com/v1/flights"
      + "?access_key=" + AVIATIONSTACK_KEY
      + "&dep_iata=BOM&flight_status=scheduled&limit=20";
    try {
      const data  = await fetchJSON(url);
      const items = (data.data || []);
      const istOff = 5.5 * 3600000;
      const withHour = items.map(f => {
        const dep = f.departure && f.departure.scheduled;
        const istHour = dep
          ? new Date(new Date(dep).getTime() + istOff).getUTCHours()
          : 12;
        return { f, istHour, isNight: istHour >= 22 || istHour <= 5 };
      });
      const sorted = [
        ...withHour.filter(x => x.isNight),
        ...withHour.filter(x => !x.isNight),
      ].slice(0, 2);

      if (sorted.length > 0) {
        return sorted.map(function(x) {
          const dest = x.f.arrival && x.f.arrival.airport
            ? x.f.arrival.airport : "Domestic";
          return {
            name:   "Flight " + (x.f.flight && x.f.flight.iata || "") + " — " + dest,
            venue:  "T2 International Airport, Mumbai",
            type:   "flight", hour: x.istHour, zone: az,
            score:  scoreEvent("flight", az, x.istHour),
            source: "aviationstack",
          };
        });
      }
    } catch(e) { console.log("AVS error:", e.message); }
  }

  // Fallback defaults
  return [
    { fno:"6E-204", dest:"दुबई",     hour:1 },
    { fno:"AI-131", dest:"लंदन",     hour:2 },
  ].map(f => ({
    name:   "Flight " + f.fno + " — " + f.dest,
    venue:  "T2 International Airport, Mumbai",
    type:   "flight", hour: f.hour, zone: az,
    score:  scoreEvent("flight", az, f.hour), source: "default",
  }));
}

// ── Wedding rotation ──────────────────────────────────────────────────────────
function getWedding() {
  const venues = [
    { name:"Taj Lands End",         area:"Bandra West" },
    { name:"St Regis Mumbai",       area:"Lower Parel" },
    { name:"Trident Nariman Point", area:"South Mumbai" },
    { name:"JW Marriott Juhu",      area:"Juhu" },
    { name:"Grand Hyatt Mumbai",    area:"BKC" },
    { name:"ITC Maratha",           area:"Airport" },
    { name:"Renaissance Mumbai",    area:"Powai" },
  ];
  const pick = venues[new Date().getDate() % venues.length];
  const zone = matchZone(pick.name + " " + pick.area);
  if (!zone) return [];
  return [{
    name:   "शादी समारोह — " + pick.name,
    venue:  pick.name + ", Mumbai",
    type:   "wedding", hour: 23, zone,
    score:  scoreEvent("wedding", zone, 23), source: "pattern",
  }];
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async () => {
  const [phq, flights] = await Promise.all([getPredictHQ(), getFlights()]);
  const weddings = getWedding();

  console.log("PHQ:" + phq.length + " Flights:" + flights.length);

  const all = [...phq, ...flights, ...weddings]
    .sort((a, b) => b.score - a.score);

  const top3 = [], seen = new Set();
  for (const e of all) {
    const zid = e.zone && e.zone.id;
    if (zid && !seen.has(zid)) { top3.push(e); seen.add(zid); }
    if (top3.length === 3) break;
  }
  const final = top3.length > 0 ? top3 : all.slice(0, 3);

  const clean = final.map(t => ({
    name: t.name, venue: t.venue, type: t.type,
    hour: t.hour, score: t.score, source: t.source,
    zone: {
      id:           t.zone.id,
      name:         t.zone.name,
      name_en:      t.zone.name_en,
      belt_hindi:   t.zone.belt_hindi,
      ride_hindi:   t.zone.ride_hindi,
      wait_hindi:   t.zone.wait_hindi,
      tip_hindi:    t.zone.tip_hindi,
      traffic_warn: t.zone.traffic_warn,
      traffic:      t.zone.traffic,
    },
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      tips: clean,
      sources: { predicthq: phq.length, flights: flights.length },
      generated: new Date().toISOString(),
    }),
  };
};
