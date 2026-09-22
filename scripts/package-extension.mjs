import { cp, mkdir, readFile, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('../.build/extension/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Only package the extension's public assets; dev dependencies and build scripts never end up in the extension.
for (const name of ['manifest.json', 'config.json', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', 'icons', '_locales']) {
  await cp(new URL(name, root), new URL(name, output), { recursive: true });
}
const config = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));
console.log(`Extension built to .build/extension, API: ${config.apiBase}`);
