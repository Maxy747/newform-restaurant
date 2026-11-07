// Build step: writes sw.js with the exact files each page needs, so the service worker can keep
// them for offline use. Vite names files by content hash, so the list changes with every build.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Rollup input name → service worker group. Static files from public/ that each page uses.
const ENTRIES = { main: 'site', admin: 'admin', invoice: 'invoice' };
const STATIC = {
  site: ['./', 'manifest.json', 'icons/icon-192.png'],
  admin: ['icons/favicon-64.png'],
  invoice: ['icons/favicon-64.png'],
};
const MARKER = '/*__NEWFORM_BUILD__*/null';

// Every file an entry chunk pulls in: its JS imports, their CSS and the assets they reference.
export function entryFiles(bundle, entryName) {
  const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
  const entry = chunks.find(chunk => chunk.isEntry && chunk.name === entryName);
  if (!entry) return [];
  const files = new Set();
  const visit = chunk => {
    if (!chunk || files.has(chunk.fileName)) return;
    files.add(chunk.fileName);
    for (const css of chunk.viteMetadata?.importedCss || []) files.add(css);
    for (const asset of chunk.viteMetadata?.importedAssets || []) files.add(asset);
    for (const name of [...chunk.imports, ...chunk.dynamicImports]) visit(bundle[name]);
  };
  visit(entry);
  return [...files];
}

// Images and styles the HTML page itself points at. Only built (hashed) files are kept: plain
// public/ photos stay on-demand, as pre-downloading them cost customers ~3.5 MB.
export function htmlAssets(source) {
  return [...String(source).matchAll(/(?:src|href)="(?:\.?\/)?(assets\/[^"?#]+)"/g)].map(match => match[1]);
}

export function buildGroups(bundle) {
  const groups = {};
  for (const [input, group] of Object.entries(ENTRIES)) {
    const html = input === 'main' ? 'index.html' : `${input}.html`;
    groups[group] = [...new Set([html, ...htmlAssets(bundle[html]?.source || '').filter(file => bundle[file]), ...entryFiles(bundle, input), ...STATIC[group]])].map(file => file.startsWith('./') ? file : './' + file);
  }
  return groups;
}

export function buildVersion(bundle) {
  const hash = createHash('sha256');
  for (const name of Object.keys(bundle).sort()) {
    const item = bundle[name];
    hash.update(name);
    hash.update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
  }
  return hash.digest('hex').slice(0, 12);
}

export function renderServiceWorker(template, build) {
  if (!template.includes(MARKER)) throw new Error('sw.js is missing the build marker');
  return template.replace(MARKER, JSON.stringify(build));
}

export function offlineManifest({ template = new URL('./sw.js', import.meta.url) } = {}) {
  return {
    name: 'newform-offline-manifest',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const build = { version: buildVersion(bundle), groups: buildGroups(bundle) };
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(readFileSync(template, 'utf8'), build) });
    },
  };
}
