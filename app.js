let map, marker, watchId, accuracyCircle, pathLine;
const pathCoords = [];
let lastGeocodeTime = 0;
let lastGeocodePos = null; // {lat, lon}
const GEOCODE_DISTANCE_THRESHOLD = 20; // meters
const GEOCODE_TIME_THROTTLE = 1100; // ms
let currentHeading = null;
let deviceOrientationActive = false;

// new globals for rotation
let MAP_ROTATION_ENABLED = true;
let currentMapRotation = 0;

function startTracking() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  if (watchId) return; // already tracking

  // enable/disable buttons (assumes buttons exist in HTML)
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  // Try to request DeviceOrientation permission on iOS (optional fallback)
  if (!deviceOrientationActive && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(response => {
      if (response === 'granted') {
        window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
        window.addEventListener('deviceorientation', handleDeviceOrientation, true);
        deviceOrientationActive = true;
      }
    }).catch(()=>{/* ignore */});
  } else if (!deviceOrientationActive && typeof DeviceOrientationEvent !== 'undefined') {
    // non-iOS: add listener directly
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    deviceOrientationActive = true;
  }

  // restore saved path if present
  const saved = localStorage.getItem('realtimetracker.path');
  if (saved) {
    try {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length) {
        pathCoords.push(...arr);
      }
    } catch (e) { /* ignore */ }
  }

  watchId = navigator.geolocation.watchPosition(updatePosition, showError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
    timeout: 10000
  });
}

function stopTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  // disable/enable buttons
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;

  // optionally remove device orientation listeners
  if (deviceOrientationActive) {
    window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
    deviceOrientationActive = false;
  }
}

async function updatePosition(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;

  // update heading if provided by Geolocation
  if (typeof position.coords.heading === 'number' && !isNaN(position.coords.heading)) {
    currentHeading = position.coords.heading; // degrees clockwise from true north
  }

  // push to path and persist
  pathCoords.push([lat, lon]);
  try { localStorage.setItem('realtimetracker.path', JSON.stringify(pathCoords)); } catch(e){/* quota ignore */ }

  // Initialize map once
  if (!map) {
    // if saved path exists, center on last saved coordinate after restoring above
    const centerLatLon = pathCoords.length ? pathCoords[pathCoords.length-1] : [lat, lon];
    map = L.map('map', { zoomControl: true }).setView([centerLatLon[0], centerLatLon[1]], 19);

    const esriSat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles © Esri', maxZoom: 22 }
    ).addTo(map);

    const osmStreets = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: '© OpenStreetMap contributors', maxZoom: 22 }
    );

    L.control.layers(
      { "Satellite View": esriSat, "Street Map": osmStreets }
    ).addTo(map);

    // create rotating marker using DivIcon with inline SVG arrow
    marker = createRotatingMarker(lat, lon);
    marker.addTo(map);

    // draw path if any
    pathLine = L.polyline(pathCoords, { color: '#1a73e8', weight: 4, opacity: 0.9 }).addTo(map);

    // accuracy circle (created below)
  } else {
    // update marker position & rotate
    marker.setLatLng([lat, lon]);
    rotateMarkerTo(currentHeading);
    pathLine.setLatLngs(pathCoords);
    map.panTo([lat, lon], { animate: true, duration: 1.0 });
  }

  // accuracy circle
  const accuracy = position.coords.accuracy || 20;
  if (accuracyCircle) {
    accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
  } else {
    accuracyCircle = L.circle([lat, lon], {
      radius: accuracy,
      color: '#1a73e8',
      fillColor: '#1a73e8',
      fillOpacity: 0.08,
      weight: 1
    }).addTo(map);
  }

  // Determine whether to geocode: moved enough distance AND throttle time
  const now = Date.now();
  let doGeocode = false;
  if (!lastGeocodePos) {
    doGeocode = true;
  } else {
    const d = distanceMeters(lastGeocodePos.lat, lastGeocodePos.lon, lat, lon);
    if (d >= GEOCODE_DISTANCE_THRESHOLD) doGeocode = true;
  }
  if (doGeocode && (now - lastGeocodeTime) > GEOCODE_TIME_THROTTLE) {
    lastGeocodeTime = now;
    lastGeocodePos = { lat, lon };

    // get structured geocode info
    const geo = await getAddress(lat, lon);

    // build popup html showing precise coords, house number and address
    const popupHtml = makePopupHtml(lat, lon, accuracy, geo);

    // update popup and open
    marker.bindPopup(popupHtml, { closeButton: false }).openPopup();
  } else {
    // show quick coords while waiting
    const short = `<div>${lat.toFixed(6)}, ${lon.toFixed(6)}<br><small>${new Date().toLocaleTimeString()}</small></div>`;
    if (!marker.getPopup()) marker.bindPopup(short).openPopup();
    else {
      marker.getPopup().setContent(short);
      marker.openPopup();
    }
  }

  // after updating marker position/rotation, rotate map if enabled
  rotateMarkerTo(currentHeading);
  if (MAP_ROTATION_ENABLED && typeof currentHeading === 'number') {
    rotateMapTo(currentHeading);
  }
}

// create a divIcon marker containing an SVG arrow with a tail (larger, colored)
function createRotatingMarker(lat, lon) {
  const html = `
    <div class="rt-marker">
      <svg width="56" height="56" viewBox="-28 -28 56 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <g class="arrow" transform="rotate(0)">
          <!-- arrow head -->
          <path d="M0,-12 L6,8 L0,4 L-6,8 Z" fill="#ff5722" stroke="#ffffff" stroke-width="0.9"/>
          <!-- tail / shaft -->
          <path class="arrow-tail" d="M0,4 L0,18" stroke="#ff5722" stroke-width="3"/>
          <!-- center cap -->
          <circle cx="0" cy="0" r="2.6" fill="#fff" stroke="#ff5722" stroke-width="0.9"/>
        </g>
      </svg>
    </div>
  `;
  const icon = L.divIcon({
    className: 'rt-divicon',
    html,
    iconSize: [56, 56],
    iconAnchor: [28, 28]
  });
  const m = L.marker([lat, lon], { icon });
  // apply initial heading if available
  setTimeout(() => rotateMarkerTo(currentHeading), 0);
  return m;
}

// rotate the visual map so heading faces "up"
// heading = degrees clockwise from true north (0..360)
function rotateMapTo(heading) {
  if (!map || typeof heading !== 'number' || isNaN(heading)) return;
  const container = map.getContainer();
  const mapPane = container.querySelector('.leaflet-map-pane');
  const controls = container.querySelector('.leaflet-control-container');

  const rotation = -heading; // rotate map pane opposite to heading
  currentMapRotation = rotation;

  if (mapPane) {
    mapPane.style.transition = 'transform 280ms ease-out';
    mapPane.style.transformOrigin = '50% 50%';
    mapPane.style.transform = `rotate(${rotation}deg)`;
  }
  // keep controls upright by counter-rotating them
  if (controls) {
    controls.style.transition = 'transform 280ms ease-out';
    controls.style.transformOrigin = '50% 50%';
    controls.style.transform = `rotate(${heading}deg)`;
    // ensure control hit areas remain correct
    controls.style.pointerEvents = 'auto';
  }
}

// update rotateMarkerTo to keep arrow oriented correctly when map is rotated
function rotateMarkerTo(heading) {
  if (!marker) return;
  const el = marker.getElement();
  if (!el) return;
  const g = el.querySelector('.arrow');
  if (!g) return;
  const headingNum = (typeof heading === 'number' && !isNaN(heading)) ? heading : 0;
  // marker arrow should be rotated by heading so after the map (which is rotated -heading)
  // the arrow visually points forward (up) relative to the viewport
  g.setAttribute('transform', `rotate(${headingNum})`);
}

// device orientation fallback handler
function handleDeviceOrientation(ev) {
  if (ev && typeof ev.alpha === 'number') {
    const alpha = ev.alpha; // 0..360
    currentHeading = alpha;
    rotateMarkerTo(currentHeading);
    if (MAP_ROTATION_ENABLED) rotateMapTo(currentHeading);
  }
}

async function getAddress(lat, lon) {
  try {
    // Replace with your contact email to comply with Nominatim usage policy
    const email = encodeURIComponent('elijahgegeli@gmail.com');
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&email=${email}`;
    const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!response.ok) return { display_name: null };

    const data = await response.json();
    const addr = (data && data.address) ? data.address : {};

    return {
      display_name: data.display_name || '',
      house_number: addr.house_number || '',
      road: addr.road || addr.pedestrian || addr.cycleway || addr.footway || '',
      neighbourhood: addr.neighbourhood || '',
      suburb: addr.suburb || '',
      city: addr.city || addr.town || addr.village || '',
      postcode: addr.postcode || '',
      raw: data
    };
  } catch (e) {
    return { display_name: null };
  }
}

// helper to build popup HTML with house number and coords
function makePopupHtml(lat, lon, accuracy, geo) {
  const coords = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const ts = new Date().toLocaleString();
  const housePart = geo && geo.house_number ? `<span style="font-weight:700">${geo.house_number} </span>` : '';
  const streetPart = geo && geo.road ? `${geo.road}` : '';
  const placePart = (geo && geo.city) ? `, ${geo.city}` : (geo && geo.suburb) ? `, ${geo.suburb}` : '';
  const postcode = geo && geo.postcode ? ` ${geo.postcode}` : '';
  const addressLine = (housePart || streetPart) ? `${housePart}${streetPart}${placePart}${postcode}` : (geo && geo.display_name) ? geo.display_name : '';

  const accuracyHtml = accuracy ? `Accuracy: ${Math.round(accuracy)} m<br>` : '';
  const osmLink = `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}" target="_blank" rel="noopener">Open in OSM</a>`;

  return `
    <div style="text-align:left; min-width:200px;">
      <div style="font-size:14px; color:#1a73e8; margin-bottom:6px;"><strong>${addressLine || 'Address not found'}</strong></div>
      <div style="font-size:13px; color:#333;">Coordinates: <code>${coords}</code></div>
      <div style="font-size:13px; color:#333;">${accuracyHtml}</div>
      <div style="font-size:12px; color:#666; margin-top:6px;">${ts}</div>
      <div style="margin-top:8px;">${osmLink}</div>
    </div>
  `;
}

// Haversine distance (meters)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showError(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      alert("User denied the request for Geolocation.");
      break;
    case error.POSITION_UNAVAILABLE:
      alert("Location information is unavailable.");
      break;
    case error.TIMEOUT:
      alert("The request to get user location timed out.");
      break;
    default:
      alert("An unknown error occurred.");
      break;
  }
}

// toggle rotation on/off from UI
function toggleMapRotation(enabled) {
  MAP_ROTATION_ENABLED = !!enabled;
  if (!map) return;
  const container = map.getContainer();
  const mapPane = container.querySelector('.leaflet-map-pane');
  const controls = container.querySelector('.leaflet-control-container');

  if (!MAP_ROTATION_ENABLED) {
    // reset transforms
    if (mapPane) mapPane.style.transform = 'none';
    if (controls) controls.style.transform = 'none';
  } else {
    // apply current heading if available
    if (typeof currentHeading === 'number') rotateMapTo(currentHeading);
  }
}
