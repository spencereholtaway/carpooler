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
