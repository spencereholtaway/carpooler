// iPadOS 13+ identifies as "MacIntel" in the UA string, unlike a real Mac,
// so a touch-capable "Mac" is actually an iPad.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

// Directions (not just a dropped pin) to the address, opening whatever maps
// app the device prefers: Apple Maps on iOS, otherwise Google Maps — which
// Android hands off to its installed Maps app, and which is the sensible
// default everywhere else (desktop).
export function mapsLink(street: string, zip: string): string {
  const query = [street, zip].filter(Boolean).join(", ");
  const destination = encodeURIComponent(query);
  return isIOS()
    ? `https://maps.apple.com/?daddr=${destination}`
    : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

// Directions through multiple stops in order, ending at the last one. Like
// mapsLink, no origin is passed, so both apps start from current location.
export function multiStopMapsLink(stops: { street: string; zip: string }[]): string {
  const addresses = stops.map((s) => encodeURIComponent([s.street, s.zip].filter(Boolean).join(", ")));
  if (isIOS()) {
    return `https://maps.apple.com/?daddr=${addresses.join("+to:")}`;
  }
  const destination = addresses[addresses.length - 1];
  const waypoints = addresses.slice(0, -1);
  const waypointsParam = waypoints.length > 0 ? `&waypoints=${waypoints.join("|")}` : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${waypointsParam}`;
}
