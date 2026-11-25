const fs = require('node:fs');
const path = require('node:path');

const raw = process.env.BACKEND_URL;
if (!raw) throw new Error('Set BACKEND_URL to the deployed backend origin before building the frontend.');
const backend = new URL(raw);
if (backend.username || backend.password || backend.search || backend.hash || backend.pathname !== '/') {
  throw new Error('BACKEND_URL must be an origin, without a path, credentials, query string or fragment.');
}
if (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(backend.hostname))) {
  throw new Error('BACKEND_URL must use HTTPS, except for local testing.');
}

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const publicURL = JSON.stringify(backend.origin).replace(/</g, '\\u003c');
const html = source.replace('<head>', `<head>\n  <script>window.LYFTR_API_URL = ${publicURL};</script>`);
const output = path.join(root, 'dist', 'frontend');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
console.log('Built frontend in dist/frontend. API origin: ' + backend.origin);
