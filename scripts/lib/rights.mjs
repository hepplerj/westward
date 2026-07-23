// Shared rights rule (see spec "Rights" notes): explicit open statement, or
// no statement at all on an item published before 1931 (US public domain).

const OPEN = /no known restrictions|public domain|no copyright|not in copyright/i;

export function yearOf(dateText) {
  const m = String(dateText ?? '').match(/\b(1[6-9]\d\d|20[0-2]\d|2030)\b/);
  return m ? Number(m[1]) : null;
}

export function isRightsOpen(rightsText, dateText) {
  const rights = String(rightsText ?? '').trim();
  if (rights) return OPEN.test(rights);
  const year = yearOf(dateText);
  return year !== null && year <= 1930;
}
