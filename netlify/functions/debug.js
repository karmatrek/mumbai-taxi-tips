const https = require("https");
const http  = require("http");

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
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.slice(0, 500) }); }
      });
    });
    req.on("error", e => resolve({ error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

exports.handler = async () => {
  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const report   = {};

  // Ticketmaster
  const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json`
    + `?apikey=${TICKETMASTER_KEY}`
    + `&city=Mumbai&countryCode=IN`
    + `&startDateTime=${today}T00:00:00Z`
    + `&endDateTime=${tomorrow}T23:59:00Z`
    + `&size=5&sort=relevance,desc`;
  const tm = await fetchJSON(tmUrl);
  report.ticketmaster = {
    status:      tm.status,
    total:       tm.data?.page?.totalElements ?? "n/a",
    error:       tm.data?.fault?.faultstring || tm.error || null,
    sample:      (tm.data?._embedded?.events || []).slice(0,3).map(e => ({
      name:  e.name,
      venue: e._embedded?.venues?.[0]?.name,
      city:  e._embedded?.venues?.[0]?.city?.name,
      date:  e.dates?.start?.localDate,
    })),
  };

  // PredictHQ
  const phqUrl = `https://api.predicthq.com/v1/events/`
    + `?country=IN`
    + `&location_around.origin=19.0760,72.8777`
    + `&location_around.offset=40km`
    + `&start.gte=${today}&start.lte=${tomorrow}`
    + `&category=concerts,performing-arts,sports,festivals,expos,community`
    + `&limit=5&sort=rank`;
  const phq = await fetchJSON(phqUrl, { Authorization:`Bearer ${PREDICTHQ_KEY}` });
  report.predicthq = {
    status: phq.status,
    total:  phq.data?.count ?? "n/a",
    error:  phq.data?.error || phq.error || null,
    sample: (phq.data?.results || []).slice(0,3).map(e => ({
      title:    e.title,
      category: e.category,
      location: e.location,
      country:  e.country,
      start:    e.start,
    })),
  };

  // AviationStack
  const avsUrl = `http://api.aviationstack.com/v1/flights`
    + `?access_key=${AVIATIONSTACK_KEY}`
    + `&dep_iata=BOM&flight_status=scheduled&limit=5`;
  const avs = await fetchJSON(avsUrl);
  report.aviationstack = {
    status: avs.status,
    total:  avs.data?.pagination?.total ?? "n/a",
    error:  avs.data?.error?.info || avs.error || null,
    sample: (avs.data?.data || []).slice(0,3).map(f => ({
      flight:    f.flight?.iata,
      departure: f.departure?.scheduled,
      arrival:   f.arrival?.airport,
    })),
  };

  report.keys = {
    ticketmaster:  TICKETMASTER_KEY  ? `set (${TICKETMASTER_KEY.slice(0,6)}...)` : "MISSING",
    predicthq:     PREDICTHQ_KEY     ? `set (${PREDICTHQ_KEY.slice(0,6)}...)` : "MISSING",
    aviationstack: AVIATIONSTACK_KEY ? `set (${AVIATIONSTACK_KEY.slice(0,6)}...)` : "MISSING",
  };
  report.timestamp = new Date().toISOString();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report, null, 2),
  };
};
