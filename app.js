// Western Explorer — masonry grid, infinite scroll, lazy fade-in.
// Data: data/index.json + data/manifest-NNN.json (see harvest pipeline).

'use strict';

const GUTTER = 10;
const TARGET_COL_WIDTH = 300; // px; actual width derived from viewport
const MAX_TILES = 9000;       // safety cap on DOM growth from looping

const grid = document.getElementById('grid');
const sentinel = document.getElementById('sentinel');

const state = {
  chunkCount: 0,
  nextChunk: 0,
  displayList: [],   // every record shown, in display order (repeats on loop)
  tiles: [],         // parallel array of tile elements
  columnHeights: [],
  columnCount: 0,
  columnWidth: 0,
  loading: false,
};

// Replaced with a real implementation by the lightbox (Task 8).
// eslint-disable-next-line no-unused-vars
let openLightbox = function (displayIndex) {};

function computeColumns() {
  const width = document.documentElement.clientWidth;
  const count = Math.max(2, Math.round(width / TARGET_COL_WIDTH));
  const columnWidth = (width - GUTTER * (count + 1)) / count;
  return { count, columnWidth };
}

function shortestColumn() {
  let min = 0;
  for (let i = 1; i < state.columnHeights.length; i++) {
    if (state.columnHeights[i] < state.columnHeights[min]) min = i;
  }
  return min;
}

function placeTile(tile, record) {
  const col = shortestColumn();
  const height = Math.round(record.height * (state.columnWidth / record.width));
  tile.style.width = `${Math.floor(state.columnWidth)}px`;
  tile.style.height = `${height}px`;
  tile.style.left = `${GUTTER + col * (state.columnWidth + GUTTER)}px`;
  tile.style.top = `${state.columnHeights[col]}px`;
  state.columnHeights[col] += height + GUTTER;
}

function updateGridHeight() {
  grid.style.height = `${Math.max(...state.columnHeights, 0)}px`;
}

function relayout() {
  const { count, columnWidth } = computeColumns();
  state.columnCount = count;
  state.columnWidth = columnWidth;
  state.columnHeights = new Array(count).fill(GUTTER);
  state.tiles.forEach((tile, i) => {
    if (tile) placeTile(tile, state.displayList[i]);
  });
  updateGridHeight();
}

function addTile(record) {
  const displayIndex = state.displayList.length;
  state.displayList.push(record);

  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';
  tile.setAttribute('aria-label', record.title);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = record.title;
  img.src = record.thumbUrl;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    // Museums occasionally move derivatives; drop the tile and close the gap.
    state.tiles[displayIndex] = null;
    tile.remove();
    relayout();
  });

  tile.appendChild(img);
  tile.addEventListener('click', () => openLightbox(displayIndex));

  state.tiles.push(tile);
  placeTile(tile, record);
  grid.appendChild(tile);
}

async function loadNextChunk() {
  if (state.loading || !state.chunkCount) return;
  if (state.displayList.length >= MAX_TILES) return;
  state.loading = true;
  try {
    const chunkIndex = state.nextChunk % state.chunkCount; // loop when exhausted
    const res = await fetch(`data/manifest-${String(chunkIndex).padStart(3, '0')}.json`);
    if (!res.ok) throw new Error(`chunk ${chunkIndex}: HTTP ${res.status}`);
    const records = await res.json();
    state.nextChunk++;
    for (const record of records) addTile(record);
    updateGridHeight();
    state.failedLoads = 0;
  } catch (err) {
    console.error('chunk load failed:', err);
    state.failedLoads = (state.failedLoads ?? 0) + 1;
    // One quiet retry; after that stop loading and leave the grid as-is.
    if (state.failedLoads > 1) observer.disconnect();
  } finally {
    state.loading = false;
  }
}

const observer = new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) loadNextChunk(); },
  { rootMargin: '1200px' },
);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 150);
});

async function fetchIndex() {
  const res = await fetch('data/index.json');
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  return res.json();
}

async function init() {
  const { count, columnWidth } = computeColumns();
  state.columnCount = count;
  state.columnWidth = columnWidth;
  state.columnHeights = new Array(count).fill(GUTTER);

  let index;
  try {
    index = await fetchIndex();
  } catch (err) {
    console.error('bootstrap: index.json failed, retrying once:', err);
    try {
      index = await fetchIndex();
    } catch (err2) {
      console.error('bootstrap: index.json retry failed, giving up:', err2);
      return;
    }
  }
  state.chunkCount = index.chunkCount;

  await loadNextChunk();
  // Adding the first chunk can introduce a vertical scrollbar that wasn't
  // present for the computeColumns() call above, narrowing the viewport;
  // relayout once against the settled width so tiles don't overflow
  // horizontally.
  relayout();
  observer.observe(sentinel);
}

init();

// ---------------------------------------------------------------- lightbox

const lightbox = document.getElementById('lightbox');
const lbImg = lightbox.querySelector('.lb-img');
const lbTitle = lightbox.querySelector('.lb-title');
const lbMeta = lightbox.querySelector('.lb-meta');
const lbSource = lightbox.querySelector('.lb-source');

let lbIndex = -1;
let lbOpener = null;
const LB_FOCUSABLE = ['.lb-close', '.lb-prev', '.lb-next', '.lb-source'];

function renderLightbox() {
  const record = state.displayList[lbIndex];
  lbImg.src = record.imageUrl;
  lbImg.alt = record.title;
  lbTitle.textContent = record.title;
  lbMeta.textContent = [record.date, record.creator, record.source].filter(Boolean).join(' · ');
  lbSource.href = record.sourceUrl;
}

function stepLightbox(delta) {
  const n = state.displayList.length;
  lbIndex = (lbIndex + delta + n) % n;
  renderLightbox();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.classList.remove('lightbox-open');
  lbImg.src = '';
  lbIndex = -1;
  if (lbOpener?.isConnected) lbOpener.focus();
  else grid.querySelector('.tile')?.focus();
  lbOpener = null;
}

openLightbox = function (displayIndex) {
  if (!state.displayList[displayIndex]) return;
  lbOpener = document.activeElement;
  lbIndex = displayIndex;
  renderLightbox();
  lightbox.hidden = false;
  document.body.classList.add('lightbox-open');
  lightbox.querySelector('.lb-close').focus();
};

lightbox.querySelector('.lb-close').addEventListener('click', closeLightbox);
lightbox.querySelector('.lb-prev').addEventListener('click', () => stepLightbox(-1));
lightbox.querySelector('.lb-next').addEventListener('click', () => stepLightbox(1));
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox(); // backdrop only
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
  else if (e.key === 'Tab') {
    // Driven explicitly (not left to native tab order) because the DOM
    // order of these controls (close, prev, figure > figcaption > source,
    // next) does not match this logical cycle — a boundary-only trap would
    // let native tabbing reach .lb-source before .lb-next and skip it.
    const els = LB_FOCUSABLE.map((sel) => lightbox.querySelector(sel));
    const idx = els.indexOf(document.activeElement);
    e.preventDefault();
    if (idx === -1) {
      els[e.shiftKey ? els.length - 1 : 0].focus();
    } else if (e.shiftKey) {
      els[(idx - 1 + els.length) % els.length].focus();
    } else {
      els[(idx + 1) % els.length].focus();
    }
  }
});

let touchStartX = null;
lightbox.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
lightbox.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 60) stepLightbox(dx > 0 ? -1 : 1);
  touchStartX = null;
}, { passive: true });

// ---------------------------------------------------------------- topbar

const topbar = document.getElementById('topbar');
let lastScrollY = window.scrollY;

window.addEventListener('scroll', () => {
  const y = window.scrollY;
  // Small hysteresis so the bar doesn't flicker on tiny scroll jitters.
  if (y > lastScrollY + 8 && y > 80) topbar.classList.add('hidden');
  else if (y < lastScrollY - 8) topbar.classList.remove('hidden');
  lastScrollY = y;
}, { passive: true });

// ---------------------------------------------------------------- about

const about = document.getElementById('about');
const ABOUT_FOCUSABLE = ['.about-close', '.about-panel a'];
let aboutOpener = null;

function openAbout() {
  aboutOpener = document.activeElement;
  about.hidden = false;
  document.body.classList.add('about-open-scroll-lock');
  about.querySelector('.about-close').focus();
}

function closeAbout() {
  about.hidden = true;
  document.body.classList.remove('about-open-scroll-lock');
  if (aboutOpener?.isConnected) aboutOpener.focus();
  aboutOpener = null;
}

document.querySelector('.about-open').addEventListener('click', openAbout);
about.querySelector('.about-close').addEventListener('click', closeAbout);
about.addEventListener('click', (e) => {
  if (e.target === about) closeAbout(); // backdrop only
});

document.addEventListener('keydown', (e) => {
  if (about.hidden) return;
  if (e.key === 'Escape') {
    closeAbout();
  } else if (e.key === 'Tab') {
    const els = ABOUT_FOCUSABLE.flatMap((sel) => [...about.querySelectorAll(sel)]);
    const idx = els.indexOf(document.activeElement);
    e.preventDefault();
    if (idx === -1) {
      els[e.shiftKey ? els.length - 1 : 0].focus();
    } else if (e.shiftKey) {
      els[(idx - 1 + els.length) % els.length].focus();
    } else {
      els[(idx + 1) % els.length].focus();
    }
  }
});
