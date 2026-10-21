import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/** OpenStreetMap map with one pin. Click to move the pin (when onPick is given). */
export function MapView({ lat, lon, onPick, height = 260 }: { lat: number | null; lon: number | null; onPick?: (lat: number, lon: number) => void; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.CircleMarker | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: [22.5, 79], zoom: 4, scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    map.current = m;
    return () => { m.remove(); map.current = null; pin.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (lat == null || lon == null) { pin.current?.remove(); pin.current = null; return; }
    if (!pin.current) pin.current = L.circleMarker([lat, lon], { radius: 9, color: "#2b3f9e", weight: 3, fillColor: "#2b3f9e", fillOpacity: 0.35 }).addTo(m);
    else pin.current.setLatLng([lat, lon]);
    m.setView([lat, lon], Math.max(m.getZoom(), 15));
  }, [lat, lon]);

  return (
    <div className="mapwrap">
      <div ref={el} style={{ height }} className="map" role="img" aria-label={lat != null ? `Map pin at ${lat}, ${lon}` : "Map of India"} />
      {onPick && <div className="hint">Click the map to move the pin to the exact plot.</div>}
    </div>
  );
}
