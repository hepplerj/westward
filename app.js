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

async function init() {
  const { count, columnWidth } = computeColumns();
  state.columnCount = count;
  state.columnWidth = columnWidth;
  state.columnHeights = new Array(count).fill(GUTTER);

  const res = await fetch('data/index.json');
  const index = await res.json();
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
