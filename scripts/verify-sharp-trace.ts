import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const manifestPath = resolve(
  '.next/server/app/api/events/[id]/[filename]/route.js.nft.json',
);
if (!existsSync(manifestPath)) {
  throw new Error('Poster route trace manifest is missing after the production build');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: unknown };
if (!Array.isArray(manifest.files) || manifest.files.some(file => typeof file !== 'string')) {
  throw new Error('Poster route trace manifest has an invalid files list');
}

const tracedFiles = manifest.files as string[];
const sharpFiles = tracedFiles.filter(file => (
  file.includes('/node_modules/sharp/')
  || file.includes('/node_modules/@img/sharp-')
));
if (sharpFiles.length === 0 || !sharpFiles.some(file => file.endsWith('.node'))) {
  throw new Error('Poster route did not trace Sharp and its native runtime');
}

const missing = sharpFiles.filter(file => !existsSync(resolve(dirname(manifestPath), file)));
if (missing.length > 0) {
  throw new Error(`Poster route traced missing Sharp files: ${missing.slice(0, 3).join(', ')}`);
}

const compiledText = tracedFiles
  .filter(file => file.endsWith('.js') && existsSync(resolve(dirname(manifestPath), file)))
  .map(file => readFileSync(resolve(dirname(manifestPath), file), 'utf8'))
  .join('\n');
if (compiledText.includes('Cannot find module as expression is too dynamic')) {
  throw new Error('Poster route compiled Sharp into a permanent MODULE_NOT_FOUND throw');
}

console.log(`✓ Poster route traced ${sharpFiles.length} Sharp runtime files.`);
