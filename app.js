// Application state
const state = {
    map: null,
    marker: null,
    watchId: null,
    accuracyCircle: null,
    pathLine: null,
    pathCoords: [],
    currentHeading: null,
    // removed mapRotationEnabled/currentMapRotation to disable map rotation
    deviceOrientationActive: false,
    lastGeocodeTime: 0,
    lastGeocodePos: null,
    GEOCODE_DISTANCE_THRESHOLD: 20, // meters
    GEOCODE_TIME_THROTTLE: 1100 // ms
};

// --- moved DOM lookups into init() to avoid nulls when script loads before DOM ---
// DOM Elements (initialized in init)
let elements = {
    startBtn: null,
    stopBtn: null,
    // removed rotateToggle lookup
    statusMessage: null,
    map: null
};

// Small improvements: heading smoothing and geocode accuracy guard
const HEADING_SMOOTHING_ALPHA = 0.18; // 0..1 (lower = smoother)
const MIN_GEOCODE_ACCURACY = 60; // meters - skip geocode when worse than this

// Initialize the application
function init() {
    // look up DOM elements after DOMContentLoaded
    elements = {
        startBtn: document.getElementById('startBtn'),
        stopBtn: document.getElementById('stopBtn'),
        // removed rotateToggle lookup
        statusMessage: document.getElementById('statusMessage'),
        map: document.getElementById('map')
    };

    // Load saved path if available
    loadSavedPath();
    
    // Set up event listeners (guard in case elements missing)
    if (elements.startBtn) elements.startBtn.addEventListener('click', startTracking);
    if (elements.stopBtn) elements.stopBtn.addEventListener('click', stopTracking);
    // removed rotateToggle listener

    // Initialize the map (without location)
    initializeMap([0, 0], 2); // Default to world view
}

// smoothing helper for headings (handles wrap-around)
function smoothHeading(prev, next) {
  if (typeof next !== 'number' || isNaN(next)) return prev;
  if (typeof prev !== 'number' || isNaN(prev)) return next;
  // normalize difference into [-180,180]
  let diff = ((next - prev + 540) % 360) - 180;
  return (prev + HEADING_SMOOTHING_ALPHA * diff + 360) % 360;
}

// Initialize the map
function initializeMap(center, zoom) {
    state.map = L.map('map').setView(center, zoom);
    
    // Add base layers
    const esriSat = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Tiles © Esri', maxZoom: 22 }
    ).addTo(state.map);

    const osmStreets = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '© OpenStreetMap contributors', maxZoom: 22 }
    );

    // Add layer control
    L.control.layers(
        { "Satellite View": esriSat, "Street Map": osmStreets }
    ).addTo(state.map);
    
    // Initialize path line
    state.pathLine = L.polyline(state.pathCoords, { 
        color: '#1a73e8', 
        weight: 4, 
        opacity: 0.9 
    }).addTo(state.map);
}

// Load saved path from localStorage
function loadSavedPath() {
    try {
        const saved = localStorage.getItem('realtimetracker.path');
        if (saved) {
            const arr = JSON.parse(saved);
            if (Array.isArray(arr) && arr.length) {
                state.pathCoords = arr;
            }
        }
    } catch (e) {
        console.error('Failed to load saved path:', e);
    }
}

// Start tracking
function startTracking() {
    if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
    }
    
    if (state.watchId) {
        showError("Already tracking location.");
        return;
    }

    // Update UI (guard)
    if (elements.startBtn) elements.startBtn.disabled = true;
    if (elements.stopBtn) elements.stopBtn.disabled = false;
    showStatus("Starting tracking...", "success");

    // Request location permissions
    state.watchId = navigator.geolocation.watchPosition(
        updatePosition, 
        handleGeolocationError, 
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 10000
        }
    );
    
    // Try to request device orientation permissions
    initDeviceOrientation();
}

// Stop tracking
function stopTracking() {
    if (state.watchId) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }
    
    // Update UI (guard)
    if (elements.startBtn) elements.startBtn.disabled = false;
    if (elements.stopBtn) elements.stopBtn.disabled = true;
    showStatus("Tracking stopped.", "success");
    
    // Clean up device orientation listeners
    cleanupDeviceOrientation();
}

// Initialize device orientation if available
function initDeviceOrientation() {
    if (typeof DeviceOrientationEvent !== 'undefined') {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            // iOS-specific permission request
            DeviceOrientationEvent.requestPermission()
                .then(response => {
                    if (response === 'granted') {
                        setupDeviceOrientationListeners();
                    }
                })
                .catch(console.error);
        } else {
            // Non-iOS devices
            setupDeviceOrientationListeners();
        }
    }
}

// Set up device orientation listeners
function setupDeviceOrientationListeners() {
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    state.deviceOrientationActive = true;
}

// Clean up device orientation listeners
function cleanupDeviceOrientation() {
    if (state.deviceOrientationActive) {
        window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
        window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
        state.deviceOrientationActive = false;
    }
}

// Handle device orientation events
function handleDeviceOrientation(event) {
    if (event && typeof event.alpha === 'number') {
        // apply smoothing
        state.currentHeading = smoothHeading(state.currentHeading, event.alpha);
        // only rotate the marker (no map rotation)
        rotateMarkerTo(state.currentHeading);
    }
}

// Update position from geolocation
async function updatePosition(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = position.coords.accuracy || 20;

    // If the fix is not precise enough, show accuracy circle and wait for a better fix.
    // This prevents adding noisy points to the path and avoids reverse-geocoding bad fixes.
    if (typeof accuracy === 'number' && accuracy > MIN_GEOCODE_ACCURACY) {
        // show a short status so the user knows why updates are paused
        showStatus(`Waiting for accurate GPS fix (≤ ${MIN_GEOCODE_ACCURACY} m). Current: ${Math.round(accuracy)} m`, 'error');
        // update accuracy circle so user sees current uncertainty
        updateAccuracyCircle(lat, lon, accuracy);
        // do not proceed with marker/path/geocode updates until accuracy improves
        return;
    }
    
    // Update heading if provided (with smoothing)
    if (typeof position.coords.heading === 'number' && !isNaN(position.coords.heading)) {
        state.currentHeading = smoothHeading(state.currentHeading, position.coords.heading);
    }

    // Add to path and save
    state.pathCoords.push([lat, lon]);
    savePathToStorage();

    // Create marker if it doesn't exist
    if (!state.marker) {
        state.marker = createRotatingMarker(lat, lon);
        state.marker.addTo(state.map);
    } else {
        // Update existing marker
        state.marker.setLatLng([lat, lon]);
        rotateMarkerTo(state.currentHeading);
    }

    // Update path line
    if (state.pathLine) state.pathLine.setLatLngs(state.pathCoords);

    // Update accuracy circle
    updateAccuracyCircle(lat, lon, accuracy);

    // Center map on current position
    if (state.map) state.map.panTo([lat, lon], { animate: true, duration: 1.0 });

    // Update address if needed (skip when accuracy is poor)
    await updateAddress(lat, lon, accuracy);

    // Rotate map if enabled
    if (state.mapRotationEnabled && typeof state.currentHeading === 'number') {
        rotateMapTo(state.currentHeading);
    }
}

// Create a rotating marker
function createRotatingMarker(lat, lon) {
    const html = `
        <div class="rt-marker">
            <svg width="56" height="56" viewBox="-28 -28 56 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
                <g class="arrow" transform="rotate(0)">
                    <path d="M0,-12 L6,8 L0,4 L-6,8 Z" fill="#ff5722" stroke="#ffffff" stroke-width="0.9"/>
                    <path class="arrow-tail" d="M0,4 L0,18" stroke="#ff5722" stroke-width="3"/>
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
    
    return L.marker([lat, lon], { icon });
}

// Rotate the marker to a specific heading
function rotateMarkerTo(heading) {
    if (!state.marker) return;
    
    const element = state.marker.getElement();
    if (!element) return;
    
    const arrow = element.querySelector('.arrow');
    if (!arrow) return;
    
    const headingNum = (typeof heading === 'number' && !isNaN(heading)) ? heading : 0;
    arrow.setAttribute('transform', `rotate(${headingNum})`);
}

// Update the accuracy circle
function updateAccuracyCircle(lat, lon, accuracy) {
    if (state.accuracyCircle) {
        state.accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
    } else {
        state.accuracyCircle = L.circle([lat, lon], {
            radius: accuracy,
            color: '#1a73e8',
            fillColor: '#1a73e8',
            fillOpacity: 0.08,
            weight: 1
        }).addTo(state.map);
    }
}

// Update address information
async function updateAddress(lat, lon, accuracy) {
    const now = Date.now();
    let shouldGeocode = false;
    
    // skip reverse-geocode when accuracy is poor
    if (typeof accuracy === 'number' && accuracy > MIN_GEOCODE_ACCURACY) {
        showQuickCoordinates(lat, lon);
        return;
    }
    
    // Check if we should geocode based on distance and time thresholds
    if (!state.lastGeocodePos) {
        shouldGeocode = true;
    } else {
        const distance = calculateDistance(
            state.lastGeocodePos.lat, state.lastGeocodePos.lon, lat, lon
        );
        if (distance >= state.GEOCODE_DISTANCE_THRESHOLD) {
            shouldGeocode = true;
        }
    }
    
    if (shouldGeocode && (now - state.lastGeocodeTime) > state.GEOCODE_TIME_THROTTLE) {
        state.lastGeocodeTime = now;
        state.lastGeocodePos = { lat, lon };
        
        try {
            const address = await getAddress(lat, lon);
            const popupContent = createPopupContent(lat, lon, accuracy, address);
            
            if (state.marker) {
                state.marker
                    .bindPopup(popupContent, { closeButton: false })
                    .openPopup();
            }
        } catch (error) {
            console.error('Geocoding failed:', error);
            showQuickCoordinates(lat, lon);
        }
    } else {
        showQuickCoordinates(lat, lon);
    }
}

// Show quick coordinates in popup
function showQuickCoordinates(lat, lon) {
    const content = `<div>${lat.toFixed(6)}, ${lon.toFixed(6)}<br><small>${new Date().toLocaleTimeString()}</small></div>`;
    
    if (!state.marker) return;
    
    if (!state.marker.getPopup()) {
        state.marker.bindPopup(content).openPopup();
    } else {
        state.marker.getPopup().setContent(content);
        state.marker.openPopup();
    }
}

// Get address from coordinates using Nominatim
async function getAddress(lat, lon) {
    const email = encodeURIComponent('elijahgegeli@gmail.com');
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&email=${email}`;
    
    const response = await fetch(url, { 
        headers: { 'Accept-Language': 'en' } 
    });
    
    if (!response.ok) {
        throw new Error('Geocoding request failed');
    }
    
    const data = await response.json();
    const address = data.address || {};
    
    return {
        display_name: data.display_name || '',
        house_number: address.house_number || '',
        road: address.road || address.pedestrian || address.cycleway || address.footway || '',
        neighbourhood: address.neighbourhood || '',
        suburb: address.suburb || '',
        city: address.city || address.town || address.village || '',
        postcode: address.postcode || '',
        raw: data
    };
}

// Create popup content with address information
function createPopupContent(lat, lon, accuracy, address) {
    const coords = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    const timestamp = new Date().toLocaleString();
    
    const housePart = address.house_number ? 
        `<span style="font-weight:700">${address.house_number} </span>` : '';
    
    const streetPart = address.road ? `${address.road}` : '';
    const placePart = address.city ? `, ${address.city}` : 
                        address.suburb ? `, ${address.suburb}` : '';
    
    const postcode = address.postcode ? ` ${address.postcode}` : '';
    
    const addressLine = (housePart || streetPart) ? 
        `${housePart}${streetPart}${placePart}${postcode}` : 
        address.display_name || 'Address not found';
    
    const accuracyHtml = accuracy ? 
        `Accuracy: ${Math.round(accuracy)} m<br>` : '';
    
    const osmLink = `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}" 
                        target="_blank" rel="noopener">Open in OSM</a>`;
    
    return `
        <div style="text-align:left; min-width:200px;">
            <div style="font-size:14px; color:#1a73e8; margin-bottom:6px;">
                <strong>${addressLine}</strong>
            </div>
            <div style="font-size:13px; color:#333;">
                Coordinates: <code>${coords}</code>
            </div>
            <div style="font-size:13px; color:#333;">
                ${accuracyHtml}
            </div>
            <div style="font-size:12px; color:#666; margin-top:6px;">
                ${timestamp}
            </div>
            <div style="margin-top:8px;">
                ${osmLink}
            </div>
        </div>
    `;
}

// Calculate distance between two points in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const R = 6371000; // Earth's radius in meters
    
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
}

// Save path to localStorage
function savePathToStorage() {
    try {
        localStorage.setItem('realtimetracker.path', JSON.stringify(state.pathCoords));
    } catch (e) {
        console.error('Failed to save path:', e);
    }
}

// Handle geolocation errors
function handleGeolocationError(error) {
    let message = "An unknown error occurred.";
    
    switch(error.code) {
        case error.PERMISSION_DENIED:
            message = "Location access denied. Please enable location permissions to use this feature.";
            break;
        case error.POSITION_UNAVAILABLE:
            message = "Location information is unavailable.";
            break;
        case error.TIMEOUT:
            message = "The request to get your location timed out.";
            break;
    }
    
    showError(message);
    stopTracking();
}

// Show status message
function showStatus(message, type = "success") {
    if (elements.statusMessage) {
        elements.statusMessage.textContent = message;
        elements.statusMessage.className = `status-message ${type}`;
        elements.statusMessage.style.display = '';
    }
    
    // Auto-hide success messages after 3 seconds
    if (type === "success") {
        setTimeout(() => {
            if (elements.statusMessage) elements.statusMessage.style.display = 'none';
        }, 3000);
    }
}

// Show error message
function showError(message) {
    showStatus(message, "error");
}

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', init);