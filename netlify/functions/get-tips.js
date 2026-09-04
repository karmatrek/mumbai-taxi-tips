const https = require("https");
const http = require("http");

const ZONES = require("../../public/zones.json").zones;

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "application/json, text/html, */*",
        ...headers,
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function matchZone(text) {
  const lower = text.toLowerCase();
  for (const z of ZONES) {
    for (const area of z.areas) {
      if (lower.includes(area.toLowerCase())) return z;
    }
  }
  return null;
}

function scoreEvent(etype, zone, hour) {
  if (!zone) return 0;
  const rideScore = { long: 10, office: 7, mixed: 6 }[zone.ride_type] || 5;
  const bonus     = zone.ride_hindi.includes("⭐") ? 3 : 0;
  const traffic   = { low: 1.0, medium: 0.75, heavy: 0.5 }[zone.traffic] || 0.7;
  const typeScore = { wedding:10, flight:9, concert:8, sports:8, comedy:7, exhibition:6, movie:5, other:5 }[etype] || 5;
  const hourBonus = (hour >= 22 || hour <= 4) ? 1.2 : 1.0;
  return Math.round((rideScore + bonus) * typeScore * traffic * hourBonus * 10) / 10;
}

async function getInsiderEvents() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0).getTime();
  const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 0).getTime();
  const url   = `https://api.insider.in/v1/get-filter-events?city=mumbai&type=events&start_time=${start}&end_time=${end}&page_size=30&page=1`;
  try {
    const res  = await fetchUrl(url);
    const data = JSON.parse(res.body);
    const items = data?.data?.items || [];
    return items.map(item => {
      const tags  = (item.tags || []).join(" ").toLowerCase();
      const venue = `${item.venue_name || ""} ${item.venue_locality || ""}`;
      const hour  = item.min_start_time ? new Date(item.min_start_time).getHours() : 20;
      const etype = tags.match(/music|concert|band|dj/) ? "concert"
                  : tags.match(/comedy|standup/)         ? "comedy"
                  : tags.match(/sport/)                  ? "sports"
                  : tags.match(/art|exhibit|fair/)       ? "exhibition"
                  : "other";
      const zone  = matchZone(venue + " " + item.name);
      const score = scoreEvent(etype, zone, hour);
      return score > 0 ? { name: item.name, venue: venue.trim(), type: etype, hour, zone, score, source: "insider" } : null;
    }).filter(Boolean);
  } catch (e) {
    console.log("insider error:", e.message);
    return [];
  }
}

async function getBMSEvents() {
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const url   = `https://in.bookmyshow.com/api/explore/v1/discover/shows?appCode=MOBAND2&appVersion=14390&language=en&regionCode=MUMBAI&subTypes=MT,PLAY,SP,EV,AC,SPORT&category=BMS&date=${today}`;
  try {
    const res   = await fetchUrl(url);
    const data  = JSON.parse(res.body);
    const shows = data?.BookMyShow?.arrEvent || [];
    return shows.slice(0, 40).map(show => {
      const cat   = (show.EventCategory || "").toLowerCase();
      const venue = `${show.VenueName || ""} ${show.VenueCity || ""}`;
      const etype = cat.match(/music|concert/) ? "concert"
                  : cat.match(/comedy/)         ? "comedy"
                  : cat.match(/sport/)           ? "sports"
                  : cat.match(/exhibit|fair/)    ? "exhibition"
                  : cat.match(/movie|film/)      ? "movie"
                  : "other";
      const m    = (show.ShowTime || "").match(/(\d+):/);
      const hour = m ? parseInt(m[1]) : 20;
      const zone = matchZone(venue + " " + show.EventName);
      const score = scoreEvent(etype, zone, hour);
      return score > 0 ? { name: show.EventName, venue: venue.trim(), type: etype, hour, zone, score, source: "bookmyshow" } : null;
    }).filter(Boolean);
  } catch (e) {
    console.log("BMS error:", e.message);
    return [];
  }
}

async function getFlights() {
  const airportZone = ZONES.find(z => z.name_en.includes("Airport"));
  if (!airportZone) return [];
  // Default realistic late-night international departures from Mumbai T2
  const now = new Date().getHours();
  const defaults = [
    { fno:"6E-204", dest:"दुबई",     hour:1 },
    { fno:"AI-131", dest:"लंदन",     hour:2 },
    { fno:"EK-500", dest:"सिंगापुर", hour:3 },
    { fno:"QR-556", dest:"दोहा",     hour:4 },
    { fno:"9W-118", dest:"बैंकॉक",   hour:23 },
  ];
  return defaults
    .filter(f => f.hour <= 5 || f.hour >= 22)
    .map(f => ({
      name:  `Flight ${f.fno} — ${f.dest}`,
      venue: "T2 International Airport, Mumbai",
      type:  "flight",
      hour:  f.hour,
      zone:  airportZone,
      score: scoreEvent("flight", airportZone, f.hour),
      source:"default"
    }));
}

function getWeddingTip() {
  const venues = [
    { name:"Taj Lands End",          area:"Bandra West" },
    { name:"St Regis Mumbai",        area:"Lower Parel" },
    { name:"Trident Nariman Point",  area:"South Mumbai" },
    { name:"JW Marriott Juhu",       area:"Juhu" },
    { name:"Grand Hyatt Mumbai",     area:"BKC" },
    { name:"ITC Maratha",            area:"Airport" },
    { name:"Renaissance Mumbai",     area:"Powai" },
  ];
  const pick = venues[new Date().getDate() % venues.length];
  const zone = matchZone(pick.name + " " + pick.area);
  if (!zone) return [];
  return [{
    name:  `शादी समारोह — ${pick.name}`,
    venue: `${pick.name}, Mumbai`,
    type:  "wedding",
    hour:  23,
    zone,
    score: scoreEvent("wedding", zone, 23),
    source:"pattern"
  }];
}

exports.handler = async (event, context) => {
  try {
    console.log("Fetching all sources...");
    const [insider, bms, flights] = await Promise.all([
      getInsiderEvents(),
      getBMSEvents(),
      getFlights(),
    ]);
    const weddings = getWeddingTip();

    const all = [...insider, ...bms, ...flights, ...weddings]
      .sort((a, b) => b.score - a.score);

    // Top 3, one per zone
    const top3 = [];
    const seen = new Set();
    for (const e of all) {
      const zid = e.zone?.id;
      if (zid && !seen.has(zid)) {
        top3.push(e);
        seen.add(zid);
      }
      if (top3.length === 3) break;
    }
    const final = top3.length === 3 ? top3 : all.slice(0, 3);

    // Strip zone blob for leaner response — keep only needed fields
    const clean = final.map(t => ({
      name:    t.name,
      venue:   t.venue,
      type:    t.type,
      hour:    t.hour,
      score:   t.score,
      source:  t.source,
      zone: {
        id:            t.zone.id,
        name:          t.zone.name,
        name_en:       t.zone.name_en,
        belt_hindi:    t.zone.belt_hindi,
        ride_hindi:    t.zone.ride_hindi,
        wait_hindi:    t.zone.wait_hindi,
        tip_hindi:     t.zone.tip_hindi,
        traffic_warn:  t.zone.traffic_warn,
        traffic:       t.zone.traffic,
      }
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tips: clean, generated: new Date().toISOString() }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
