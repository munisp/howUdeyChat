// map.js — zero-tile offline map. No CDN, no tile server, no network: a
// canvas, equirectangular projection, pins and trails. Same doctrine as the
// platform's ambulance map. The projection core is pure so it is testable
// in node; the DOM part is thin.

// project(lat, lon, bounds, w, h) → {x, y}. bounds: {minLat, maxLat, minLon, maxLon}
export function project(lat, lon, bounds, w, h) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const x = ((lon - minLon) / (maxLon - minLon || 1e-9)) * w;
  const y = ((maxLat - lat) / (maxLat - minLat || 1e-9)) * h; // north up
  return { x, y };
}

// fitBounds(points, padRatio) → bounds covering all points with padding.
export function fitBounds(points, padRatio = 0.15) {
  if (!points.length) return { minLat: 6.4, maxLat: 6.6, minLon: 3.3, maxLon: 3.5 }; // Lagos fallback
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const dLat = (maxLat - minLat || 0.01) * padRatio;
  const dLon = (maxLon - minLon || 0.01) * padRatio;
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

// haversineKm — distance between two points, for "your clinic is 2.3 km away".
export function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// draw(canvas, { pins, trail, labels }) — render. pins: [{lat, lon, label, kind}]
// kind: "clinic" | "patient" | "ambulance". trail: [{lat, lon}] oldest→newest.
export function draw(canvas, { pins = [], trail = [] }) {
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const bounds = fitBounds([...pins, ...trail]);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#e8f0ea"; // land — flat, calm
  ctx.fillRect(0, 0, w, h);
  // grid lines give scale without tiles
  ctx.strokeStyle = "#d3e0d6";
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath(); ctx.moveTo((w / 6) * i, 0); ctx.lineTo((w / 6) * i, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (h / 6) * i); ctx.lineTo(w, (h / 6) * i); ctx.stroke();
  }
  if (trail.length > 1) {
    ctx.strokeStyle = "#146b4f"; ctx.lineWidth = 3 * devicePixelRatio;
    ctx.beginPath();
    trail.forEach((p, i) => {
      const { x, y } = project(p.lat, p.lon, bounds, w, h);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  for (const p of pins) {
    const { x, y } = project(p.lat, p.lon, bounds, w, h);
    const r = 7 * devicePixelRatio;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "patient" ? "#2563eb" : p.kind === "ambulance" ? "#d97706" : "#0b3d2e";
    ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * devicePixelRatio; ctx.stroke();
    if (p.label) {
      ctx.font = `${12 * devicePixelRatio}px system-ui`;
      ctx.fillStyle = "#17251e";
      ctx.fillText(p.label, x + r + 4, y + 4 * devicePixelRatio);
    }
  }
}
