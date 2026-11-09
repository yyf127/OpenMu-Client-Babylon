/**
 * Turns a full `vite build` into the single-player offline demo that GitHub
 * Pages can host.
 *
 * The two asset trees are both needed: `Data/` is the original MU data (read
 * through `resolveDataUrl`), `game-assets/` is the converted models/terrain
 * (read through `resolveUrlToDataFolder`). They cannot be merged into one
 * folder without rewriting every asset path in the client. What this script
 * does instead is consolidate them at the *build output* level:
 *
 *   - drop whole trees the demo never reads (optional texture packs, 0.97d),
 *   - keep one shared map whitelist applied to BOTH trees, so a map's original
 *     data and its converted assets are never half-present,
 *   - report the remaining same-path duplicates (a static host cannot hardlink
 *     them, and both resolvers still ask for their own root),
 *   - rebuild the pre-download index from the files that actually survived.
 *
 * It also makes the output work from a project page (`/<repo>/`) rather than
 * the domain root: a `<base>`, a 404.html SPA fallback, a `?offline` entry
 * redirect, and absolute static paths rewritten to relative ones.
 *
 * Usage: bun run tools/pagesOffline.ts --root dist --base /<repo>/
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ROOT = resolve(arg('--root', 'dist'));
const BASE = arg('--base', './');
const WORLDS = new Set(
  arg('--worlds', 'World1,World2,World3')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const LIMIT_MB = Number(arg('--limit', '900'));

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
const slash = (p: string): string => p.split(sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function sizeOf(dir: string): number {
  return walk(dir).reduce((n, p) => n + statSync(p).size, 0);
}

/** Top-level breakdown, so the CI log says exactly where the bytes went. */
function report(label: string): number {
  const rows: [string, number][] = [];
  let total = 0;
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    const p = join(ROOT, e.name);
    const size = e.isDirectory() ? sizeOf(p) : statSync(p).size;
    rows.push([e.name, size]);
    total += size;
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log(`\n${label}: ${mb(total)} in ${walk(ROOT).length} files`);
  for (const [name, size] of rows.slice(0, 14)) console.log(`  ${mb(size).padStart(10)}  ${name}`);
  return total;
}

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error(`pagesOffline: ${ROOT}/index.html not found - run vite build first`);
  process.exit(1);
}

report('before consolidation');

// ---------------------------------------------------------------- 1. whole trees
// `packs/` is the optional upscaled texture pack (the demo uses the originals),
// the two -v097d trees belong to the other game version (this build boots S6).
let dropped = 0;
for (const dir of ['packs', 'game-assets-v097d', 'Data-v097d']) {
  const p = join(ROOT, dir);
  if (existsSync(p)) {
    dropped += sizeOf(p);
    rmSync(p, { recursive: true, force: true });
    console.log(`  dropped ${dir}`);
  }
}

// ---------------------------------------------------------------- 2. map whitelist
// Applied to both trees together. `?map=` still works for the kept worlds;
// the rest would be dead weight in a Pages-sized trial build.
for (const tree of ['game-assets', 'Data']) {
  const base = join(ROOT, tree);
  if (!existsSync(base)) continue;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^World\d+$/i.test(e.name) || WORLDS.has(e.name)) continue;
    const p = join(base, e.name);
    dropped += sizeOf(p);
    rmSync(p, { recursive: true, force: true });
  }
}
console.log(`  kept worlds: ${[...WORLDS].join(', ')} (both trees)`);
console.log(`  dropped ${mb(dropped)}`);

// ---------------------------------------------------------------- 3. duplicate report
// The 4 MB minimap OZT ships once per root because the two resolvers each ask
// their own root. A static host cannot hardlink them; the map whitelist above
// is what actually keeps this number small.
const gameAssetPaths = new Map<string, number>();
for (const p of walk(join(ROOT, 'game-assets'))) {
  gameAssetPaths.set(slash(relative(join(ROOT, 'game-assets'), p)).toLowerCase(), statSync(p).size);
}
let dupFiles = 0;
let dupBytes = 0;
for (const p of walk(join(ROOT, 'Data'))) {
  const key = slash(relative(join(ROOT, 'Data'), p)).toLowerCase();
  const other = gameAssetPaths.get(key);
  if (other !== undefined && other === statSync(p).size) {
    dupFiles++;
    dupBytes += statSync(p).size;
  }
}
console.log(`  remaining same-path duplicates: ${dupFiles} files / ${mb(dupBytes)} (one copy per resolver root)`);

// ---------------------------------------------------------------- 4. no pre-download
// `assets-index*.json` drives the first-run "download every asset group"
// screen (AutoDownload / preloadAll): ~474 MB on this build. The client
// streams what the world actually needs, and `loadAssetsIndex()` treats a
// missing index as "no download screen" (see assetDownload.ts), which is what
// a trial build wants. Removing it also drops a dependency on files the
// consolidation removed.
for (const f of ['assets-index.json', 'assets-index-v097d.json']) {
  rmSync(join(ROOT, f), { force: true });
}
console.log('  removed pre-download indexes (no first-run bulk download)');

// ---------------------------------------------------------------- 5. project-page HTML
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// Some assets are referenced from an absolute site root (`/fonts/...`,
// `/backdrops/...`). Relative works both at the domain root and under /<repo>/.
const staticRoots = 'fonts|backdrops|icons|ui|skyline|js|items|Data|game-assets';
const absoluteAsset = new RegExp(`(["'\`])\\/(${staticRoots})\\/`, 'g');
const fixPaths = (s: string): string => s.replace(absoluteAsset, '$1./$2/');
html = fixPaths(html);

// A project page serves the app from /<repo>/. The base tag also makes the
// 404.html fallback below resolve `./assets/...` correctly from any deep path.
if (!/<base\s/i.test(html)) {
  html = html.replace(/<head>/i, `<head>\n  <base href="${BASE}">`);
}

// Landing on the site root should go straight into the single-player demo.
// `Session.isOffline` is `location.href.includes('offline')`, so the query is
// all it takes - no server, no login, no deep route to 404.
const entry = `<script>if(!/[?&]offline\\b/.test(location.search))location.replace('?offline');</script>`;
if (!html.includes("location.replace('?offline')")) {
  html = html.replace(/<\/head>/i, `  ${entry}\n</head>`);
}
writeFileSync(join(ROOT, 'index.html'), html);
// GitHub Pages serves 404.html for any unknown path: `/offline` (the URL the
// README mentions) then still boots the client, with `offline` in the URL.
writeFileSync(join(ROOT, '404.html'), html);

// The /move window rewrites the address bar to a root-relative
// `/offline?map=...`. Under /<repo>/ that points at the domain root, where a
// refresh would 404, so keep the current path (same fix as playOffline()).
const offlineQueryJump = /"\/offline\?"\s*\+\s*/g;
const fixRoutes = (s: string): string => s.replace(offlineQueryJump, 'location.pathname+"?"+');

// The same absolute paths can appear inside bundled JS/CSS.
let routeFixes = 0;
for (const p of walk(ROOT).filter(p => /\.(js|css)$/.test(p))) {
  const src = readFileSync(p, 'utf8');
  routeFixes += (src.match(offlineQueryJump) ?? []).length;
  const out = fixRoutes(fixPaths(src));
  if (out !== src) writeFileSync(p, out);
}
console.log(`  project-page fixes: ${routeFixes} root-relative /offline? jump(s)`);

// ---------------------------------------------------------------- 6. size gate
const after = report('after consolidation');
console.log(`\nGitHub Pages limit is 1 GB (recommended < 1 GB); this build: ${mb(after)}`);
if (after > LIMIT_MB * 1048576) {
  console.error(`pagesOffline: ${mb(after)} exceeds the ${LIMIT_MB} MB guard - widen the whitelist or prune more`);
  process.exit(1);
}
