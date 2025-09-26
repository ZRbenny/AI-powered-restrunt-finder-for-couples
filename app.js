// ---- helpers ----
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Parse "Name — Note — lat,lng" (coords optional)
function parseList(text){
  return text
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const parts = l.split(/\s+—\s+/); // split on spaced em-dash
      const name = (parts[0] || l).trim();
      const note = (parts[1] || "").trim();
      let lat = null, lng = null;

      if (parts[2]) {
        const m = parts[2].match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (m) { lat = Number(m[1]); lng = Number(m[2]); }
      }
      return { name, note, lat, lng };
    });
}

function copy(text){
  if(navigator.clipboard){ return navigator.clipboard.writeText(text); }
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}

// Miles version of Haversine (inputs are {lat, lng})
function haversineMi(a, b){
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const toRad = d => (d * Math.PI) / 180;
  const R = 3958.7613; // miles
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function normalizeName(s){
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

// --- Overpass (OpenStreetMap) client ---
const OVERPASS_ENDPOINT = "https://overpass.kumi.systems/api/interpreter";

function buildOverpassQuery(lat, lng, radiusMeters, max = 120) {
  return `
[out:json][timeout:25];
(
  node(around:${radiusMeters},${lat},${lng})[amenity=restaurant];
  way(around:${radiusMeters},${lat},${lng})[amenity=restaurant];
  node(around:${radiusMeters},${lat},${lng})[cuisine];
  way(around:${radiusMeters},${lat},${lng})[cuisine];
);
out center ${max};
`;
}

// Normalize Overpass results to {name,note,lat,lng}
async function fetchNearbyRestaurants(lat, lng, radiusMi) {
  const meters = Math.max(100, Math.round(radiusMi * 1609.344));
  const ql = buildOverpassQuery(lat, lng, meters, 120);

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(ql)
  });
  if (!res.ok) throw new Error("Overpass error: " + res.status);
  const data = await res.json();

  const rows = [];
  const seenByKey = new Set();

  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const name = (tags.name || "").trim();
    if (!name) continue;

    const latNum = el.lat ?? el.center?.lat;
    const lngNum = el.lon ?? el.center?.lon;
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) continue;

    const cuisine = (tags.cuisine || "").replace(/_/g, " ");
    const noteBits = [];
    if (cuisine) noteBits.push(cuisine);
    const street = tags["addr:street"]; const housenumber = tags["addr:housenumber"];
    if (street) noteBits.push(housenumber ? `${housenumber} ${street}` : street);
    const note = noteBits.join(" · ");

    const key = `${name.toLowerCase()}@${latNum.toFixed(4)},${lngNum.toFixed(4)}`;
    if (seenByKey.has(key)) continue;
    seenByKey.add(key);

    rows.push({ name, note, lat: latNum, lng: lngNum });
  }

  rows.sort((a, b) => {
    const da = haversineMi({lat, lng}, a);
    const db = haversineMi({lat, lng}, b);
    return (da ?? 1e9) - (db ?? 1e9);
  });

  return rows;
}

// ---- state ----
let me = { lat: null, lng: null };
let places = [];
let likes = [];
let idx = 0;

// ---- dom ----
const setup = document.getElementById('setup');
const swipe = document.getElementById('swipe');
const results = document.getElementById('results');
const startBtn = document.getElementById('startBtn');
const loadDemo = document.getElementById('loadDemo');
const fetchNearbyBtn = document.getElementById('fetchNearby');

const countEl = document.getElementById('count');
const radiusEl = document.getElementById('radius');
const latEl = document.getElementById('lat');
const lngEl = document.getElementById('lng');
const useLocationBtn = document.getElementById('useLocation');
const geoStatus = document.getElementById('geoStatus');

const listEditor = document.getElementById('listEditor');
const passBtn = document.getElementById('passBtn');
const likeBtn = document.getElementById('likeBtn');
const progress = document.getElementById('progress');
const rangeInfo = document.getElementById('rangeInfo');
const cardTitle = document.getElementById('cardTitle');
const cardNote = document.getElementById('cardNote');
const cardDist = document.getElementById('cardDist');
const cardMap = document.getElementById('cardMap');
const likesCount = document.getElementById('likesCount');
const likesList = document.getElementById('likesList');
const copyLikes = document.getElementById('copyLikes');
const newRound = document.getElementById('newRound');
const partnerLikes = document.getElementById('partnerLikes');
const calcOverlapBtn = document.getElementById('calcOverlap');
const overlapOut = document.getElementById('overlapOut');

// ---- view helpers ----
function show(id){
  for(const sec of [setup, swipe, results]) sec.classList.add('hidden');
  document.getElementById(id).classList.remove('hidden');
}

function renderCard(){
  if(idx >= places.length){ return endRound(); }
  const p = places[idx];
  cardTitle.textContent = p.name;
  cardNote.textContent  = p.note || '\u00A0';
  cardDist.textContent  = (typeof p.distanceMi === "number")
    ? `${p.distanceMi.toFixed(1)} mi away`
    : 'distance unknown';

  if (p.lat != null && p.lng != null) {
    const q = encodeURIComponent(`${p.lat},${p.lng}`);
    cardMap.innerHTML = `<a class="pill" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Open in Maps</a>`;
  } else {
    cardMap.innerHTML = '';
  }

  progress.textContent = `${idx+1} of ${places.length}`;
}

// ---- round flow ----
function start(){
  const myLat = Number(latEl.value);
  const myLng = Number(lngEl.value);
  me = {
    lat: Number.isFinite(myLat) ? myLat : me.lat,
    lng: Number.isFinite(myLng) ? myLng : me.lng
  };

  const all = parseList(listEditor.textContent);
  const n = clamp(Number(countEl.value) || 10, 5, 50);
  const radiusMi = clamp(Number(radiusEl.value) || 10, 1, 50);

  const withDistance = all.map(p => {
    const d = (me.lat!=null && me.lng!=null && p.lat!=null && p.lng!=null)
      ? haversineMi(me, {lat: p.lat, lng: p.lng})
      : null;
    return { ...p, distanceMi: d };
  });

  const inRange = withDistance.filter(p => p.distanceMi==null || p.distanceMi <= radiusMi);
  const shuffled = shuffle(inRange);
  places = shuffled.slice(0, Math.min(n, shuffled.length));
  likes = [];
  idx = 0;

  rangeInfo.textContent = `radius: ${radiusMi} mi`;
  show('swipe');
  renderCard();

  saveState();
}

function vote(v){
  const p = places[idx];
  if (v === 'like') likes.push((p.name || "").trim());
  idx++;
  if (idx >= places.length) endRound(); else renderCard();
}

function endRound(){
  show('results');
  likesCount.textContent = likes.length ? `${likes.length} liked` : 'No likes this round';
  likesList.innerHTML = places
    .filter(p => likes.includes(p.name))
    .map(p => {
      const dist = (typeof p.distanceMi === "number") ? ` — ${p.distanceMi.toFixed(1)} mi` : "";
      return `<li>${p.name}${dist}</li>`;
    }).join('');
}

// ---- overlap ----
function calcOverlaps(){
  let partner = [];
  try { partner = JSON.parse(partnerLikes.value || "[]"); }
  catch { overlapOut.textContent = "Invalid JSON"; return; }

  const partnerSet = new Set(partner.map(normalizeName));
  const both = likes.filter(n => partnerSet.has(normalizeName(n)));

  if (both.length) {
    overlapOut.innerHTML = `<strong>Overlap (${both.length})</strong><ul>` +
      both.map(n => `<li>${n}</li>`).join("") + `</ul>`;
  } else {
    overlapOut.textContent = "No overlap";
  }
}

// ---- persistence ----
const LS_KEYS = { list: 'rt_list', count: 'rt_count', radius: 'rt_radius', lat: 'rt_lat', lng: 'rt_lng' };

function saveState(){
  try {
    localStorage.setItem(LS_KEYS.list, listEditor.textContent);
    localStorage.setItem(LS_KEYS.count, String(countEl.value));
    localStorage.setItem(LS_KEYS.radius, String(radiusEl.value));
    if (Number.isFinite(Number(latEl.value))) localStorage.setItem(LS_KEYS.lat, String(latEl.value));
    if (Number.isFinite(Number(lngEl.value))) localStorage.setItem(LS_KEYS.lng, String(lngEl.value));
  } catch {}
}

function loadState(){
  try {
    const savedList   = localStorage.getItem(LS_KEYS.list);
    const savedCount  = localStorage.getItem(LS_KEYS.count);
    const savedRadius = localStorage.getItem(LS_KEYS.radius);
    const savedLat    = localStorage.getItem(LS_KEYS.lat);
    const savedLng    = localStorage.getItem(LS_KEYS.lng);

    if(savedList) listEditor.textContent = savedList;
    if(savedCount) countEl.value = Number(savedCount) || 10;
    if(savedRadius) radiusEl.value = Number(savedRadius) || 10;

    if (savedLat) { latEl.value = savedLat; me.lat = Number(savedLat); }
    if (savedLng) { lngEl.value = savedLng; me.lng = Number(savedLng); }
  } catch {}
}

// ---- geolocation ----
useLocationBtn.addEventListener('click', ()=>{
  geoStatus.textContent = 'Requesting location...';
  if (!navigator.geolocation){
    geoStatus.textContent = 'Geolocation not supported.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      latEl.value = me.lat.toFixed(5);
      lngEl.value = me.lng.toFixed(5);
      geoStatus.textContent = 'Location set ✔';
      saveState();
    },
    err => {
      geoStatus.textContent = 'Location denied or unavailable.';
      console.warn(err);
    },
    { enableHighAccuracy: false, timeout: 8000 }
  );
});

// ---- fetch nearby (OpenStreetMap Overpass) ----
fetchNearbyBtn.addEventListener('click', async () => {
  const myLat = Number(latEl.value);
  const myLng = Number(lngEl.value);
  if (!Number.isFinite(myLat) || !Number.isFinite(myLng)) {
    geoStatus.textContent = "Set your location first (type or click 'Use my location').";
    return;
  }
  const radiusMi = Math.max(1, Math.min(50, Number(radiusEl?.value || 10)));

  geoStatus.textContent = "Finding restaurants…";
  fetchNearbyBtn.disabled = true;

  try {
    const rows = await fetchNearbyRestaurants(myLat, myLng, radiusMi);
    if (!rows.length) {
      geoStatus.textContent = "No restaurants found in that radius.";
      fetchNearbyBtn.disabled = false;
      return;
    }

    const lines = rows.map(r => {
      const note = r.note ? ` — ${r.note}` : " — ";
      return `${r.name}${note} — ${r.lat.toFixed(6)},${r.lng.toFixed(6)}`;
    });
    listEditor.textContent = lines.join("\n");
    geoStatus.textContent = `Loaded ${rows.length} nearby spots ✔`;
    saveState();
  } catch (e) {
    console.error(e);
    geoStatus.textContent = "Error fetching places (try again).";
  } finally {
    fetchNearbyBtn.disabled = false;
  }
});

// ---- events ----
startBtn.addEventListener('click', start);
loadDemo.addEventListener('click', ()=>{
  listEditor.textContent = `Tatsu Ramen — Japanese — 41.5236,-90.5776
La Taquería Río — Mexican — 41.5089,-90.5783
Brickhouse Pizza — Pizza — 41.5361,-90.5671
Green Bowl — Healthy — 41.5192,-90.5650
Cedar BBQ — BBQ — 41.4920,-90.5630
Tandoori Flame — Indian — 41.4900,-90.5820
Sushi Garden — Sushi — 41.5205,-90.5710
Pho Square — Vietnamese — 41.5315,-90.5600
Bluebird Cafe — Brunch — 41.5200,-90.5900
Al-Amir — Middle Eastern — 41.5005,-90.5700`;
  saveState();
});
passBtn?.addEventListener('click', ()=>vote('pass'));
likeBtn?.addEventListener('click', ()=>vote('like'));

copyLikes?.addEventListener('click', ()=> copy(JSON.stringify(likes)).then(()=>{
  copyLikes.textContent = 'Copied!'; setTimeout(()=>copyLikes.textContent='Copy Likes JSON', 900);
}));

newRound?.addEventListener('click', ()=> show('setup'));
calcOverlapBtn?.addEventListener('click', calcOverlaps);

// persist when user edits fields
listEditor.addEventListener('input', saveState);
countEl.addEventListener('input', saveState);
radiusEl.addEventListener('input', saveState);
latEl.addEventListener('input', saveState);
lngEl.addEventListener('input', saveState);

// keyboard shortcuts: ← pass, → like, space = like
window.addEventListener('keydown', (e)=>{
  if(swipe.classList.contains('hidden')) return;
  if(e.key === 'ArrowLeft'){ e.preventDefault(); vote('pass'); }
  else if(e.key === 'ArrowRight' || e.key === ' '){ e.preventDefault(); vote('like'); }
});

// boot
loadState();
