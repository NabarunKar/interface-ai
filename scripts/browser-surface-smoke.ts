import { BrowserSurface } from '../src/surface/browser-surface.js';

const url = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'http://localhost:3100';
const headed = process.argv.includes('--headed');

const surface = await BrowserSurface.create({ headless: !headed });

try {
  await surface.navigate(url);
  const observation = await surface.observe();
  console.log(JSON.stringify({
    url: observation.url,
    title: observation.title,
    visibleText: observation.visibleText,
    elements: observation.elements,
  }, null, 2));
} finally {
  await surface.close();
}
