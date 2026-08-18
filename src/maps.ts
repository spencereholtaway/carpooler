export function mapsLink(street: string, zip: string): string {
  const query = [street, zip].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
