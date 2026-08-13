/** Does an unchanged asset revalidate, and does a changed one break the cache? */
const url = process.argv[2] || 'http://127.0.0.1:4331/app.js';

const head = await fetch(url);
const etag = head.headers.get('etag');
console.log('etag         :', etag);
console.log('cache-control:', head.headers.get('cache-control'));

const same = await fetch(url, { headers: { 'If-None-Match': etag } });
console.log('matching tag ->', same.status, 'body bytes', (await same.text()).length);

const stale = await fetch(url, { headers: { 'If-None-Match': 'W/"stale"' } });
console.log('stale tag    ->', stale.status, 'body bytes', (await stale.text()).length);
