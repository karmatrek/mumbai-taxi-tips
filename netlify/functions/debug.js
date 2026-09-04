const https = require("https");
const http  = require("http");

const TICKETMASTER_KEY  = process.env.TICKETMASTER_KEY  || "";
const PREDICTHQ_KEY     = process.env.PREDICTHQ_KEY     || "";
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY || "";
const SCRAPERAPI_KEY    = process.env.SCRAPERAPI_KEY    || "";

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
        catch(e) { resolve({ status: res.statusCode, raw: data.slice(0,300) }); }
      });
    });
    req.on("error", e => resolve({ error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error:"timeout" }); });
  });
}

exports.handler = async () => {
  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const report   = { keys:{}, timestamp: new Date().toISOString() };

  report.keys = {
    ticketmaster:  TICKETMASTER_KEY  ? `set (${TICKETMASTER_KEY.slice(0,6)}...)`  : "MISSING",
    predicthq:     PREDICTHQ_KEY     ? `set (${PREDICTHQ_KEY.slice(0,6)}...)`     : "MISSING",
    aviationstack: AVIATIONSTACK_KEY ? `set (${AVIATIONSTACK_KEY.slice(0,6)}...)` : "MISSING",
    scraperapi:    SCRAPERAPI_KEY    ? `set (${SCRAPERAPI_KEY.slice(0,6)}...)`    : "MISSING",
  };

  // Ticketmaster
  const tm = await fetchJSON(
    `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TICKETMASTER_KEY}&city=Mumbai&countryCode=IN&startDateTime=${today}T00:00:00Z&endDateTime=${tomorrow}T23:59:00Z&size=5`
  );
  report.ticketmaster = {
    status: tm.status,
    total:  tm.data?.page?.totalElements ?? "n/a",
    error:  tm.data?.fault?.faultstring || tm.error || null,
    sample: (tm.data?._embedded?.events||[]).slice(0,3).map(e=>({
      name: e.name,
      venue: e._embedded?.venues?.[0]?.name,
      city:  e._embedded?.venues?.[0]?.city?.name,
      date:  e.dates?.start?.localDate,
    })),
  };

  // PredictHQ — using place.exact=1275339 (Mumbai)
  const phq = await fetchJSON(
    `https://api.predicthq.com/v1/events/?place.exact=1275339&start.gte=${today}&start.lte=${in3days}&category=concerts,performing-arts,sports,festivals,expos,community&limit=5&sort=rank`,
    { Authorization:`Bearer ${PREDICTHQ_KEY}` }
  );
  report.predicthq = {
    status:    phq.status,
    total:     phq.data?.count ?? "n/a",
    error:     phq.data?.error || phq.error || null,
    place_id:  "1275339 (Mumbai)",
    sample:    (phq.data?.results||[]).slice(0,3).map(e=>({
      title:    e.title,
      category: e.category,
      location: e.location,
      country:  e.country,
      start:    e.start,
    })),
  };

  // AviationStack — show all flights, IST hour calculated
  const avs = await fetchJSON(
    `http://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&dep_iata=BOM&flight_status=scheduled&limit=10`
  );
  const istOffset = 5.5 * 60 * 60 * 1000;
  report.aviationstack = {
    status:      avs.status,
    total:       avs.data?.pagination?.total ?? "n/a",
    error:       avs.data?.error?.info || avs.error || null,
    note:        "Free tier = domestic only. IST hours shown.",
    sample:      (avs.data?.data||[]).slice(0,5).map(f => {
      const dep = f.departure?.scheduled;
      const istHour = dep ? new Date(new Date(dep).getTime()+istOffset).getUTCHours() : "?";
      return {
        flight:   f.flight?.iata,
        dest:     f.arrival?.airport,
        dep_utc:  dep,
        ist_hour: istHour,
        is_night: istHour >= 22 || istHour <= 5,
      };
    }),
  };

  // BMS via ScraperAPI
  if (SCRAPERAPI_KEY) {
    const bmsDate = today.replace(/-/g,"");
    const bmsUrl  = encodeURIComponent(
      `https://in.bookmyshow.com/api/explore/v1/discover/shows?appCode=MOBAND2&appVersion=14390&language=en&regionCode=MUMBAI&subTypes=MT,PLAY,SP,EV,AC,SPORT&category=BMS&date=${bmsDate}`
    );
    const bms = await fetchJSON(
      `http://api.scraperapi.com?api_key=${SCRAPERAPI_KEY}&url=${bmsUrl}&country_code=in`
    );
    report.bookmyshow = {
      status: bms.status,
      total:  (bms.data?.BookMyShow?.arrEvent||[]).length,
      error:  bms.error || null,
      sample: (bms.data?.BookMyShow?.arrEvent||[]).slice(0,3).map(e=>({
        name:  e.EventName,
        venue: e.VenueName,
        time:  e.ShowTime,
        cat:   e.EventCategory,
      })),
    };
  } else {
    report.bookmyshow = { status:"skipped", note:"SCRAPERAPI_KEY not set" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(report, null, 2),
  };
};
