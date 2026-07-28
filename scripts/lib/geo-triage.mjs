// Post-harvest geographic triage. Keyword queries occasionally return
// records from obviously non-western places (e.g. Homestead, Pennsylvania —
// the steel town). We EXCLUDE records whose title or subjects explicitly
// name a clearly non-western state rather than require a western one, since
// many good records carry no location metadata at all.
//
// Gray-zone states deliberately NOT listed (kept): Minnesota, Iowa,
// Missouri, Arkansas, Louisiana, Alaska, Hawaii. Adjust the list to taste.

const NON_WESTERN_PLACES = [
  // Order matters: "West Virginia" must match before "Virginia".
  'West Virginia',
  'Virginia',
  'Maine', 'New Hampshire', 'Vermont', 'Massachusetts', 'Rhode Island',
  'Connecticut', 'New York', 'New Jersey', 'Pennsylvania', 'Delaware',
  'Maryland', 'North Carolina', 'South Carolina', 'Georgia', 'Florida',
  'Ohio', 'Indiana', 'Illinois', 'Michigan', 'Wisconsin', 'Kentucky',
  'Tennessee', 'Mississippi', 'Alabama',
  'District of Columbia',
];

// Bare "Washington" is a western state; only the capital forms are eastern.
const DC_RE = /\bWashington,?\s+D\.?\s?C\.?\b/i;

const PLACE_RES = NON_WESTERN_PLACES.map((name) => ({
  name,
  re: new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i'),
}));

// Returns the non-western place name that matched, or null if the record
// looks fine. "West Virginia" wins over "Virginia" by list order; a record
// naming both an excluded and a western state is still dropped (explicitly
// eastern signal outweighs ambiguity — conservative for a western explorer).
export function nonWesternMatch(record) {
  const haystacks = [record.title ?? '', ...(record.subjects ?? [])];
  for (const text of haystacks) {
    if (DC_RE.test(text)) return 'Washington, D.C.';
    for (const { name, re } of PLACE_RES) {
      if (re.test(text)) {
        // "West Virginia" precedes "Virginia" in the list, but a text like
        // "West Virginia" would also match the later bare-"Virginia" regex
        // on a different haystack pass; list order within one text handles it.
        return name;
      }
    }
  }
  return null;
}

// Splits records into {kept, dropped}; dropped entries carry the matched
// place for logging. Pure — used by both the orchestrator and triage CLI.
export function geoTriage(records) {
  const kept = [];
  const dropped = [];
  for (const r of records) {
    const place = nonWesternMatch(r);
    if (place) dropped.push({ record: r, place });
    else kept.push(r);
  }
  return { kept, dropped };
}

export function triageSummary(dropped) {
  const byPlace = {};
  for (const { place } of dropped) byPlace[place] = (byPlace[place] ?? 0) + 1;
  const parts = Object.entries(byPlace)
    .sort((a, b) => b[1] - a[1])
    .map(([place, n]) => `${place} ${n}`);
  return `geo-triage: dropped ${dropped.length}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
