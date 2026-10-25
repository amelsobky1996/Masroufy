/* Masroufi service worker — offline cache + reminder notifications */
const VERSION = 'masroufi-v1.3.1';
const SHELL = [
  './', './index.html', './manifest.json',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './icons/favicon.png', './icons/logo-mark.png', './icons/logo-word.png', './icons/logo-tagline.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the sync API
  if (url.origin === location.origin && url.pathname.includes('/api/')) return;

  // App navigation: network first, fall back to cached shell (works offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin assets: cache first
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  // Fonts & CDN libraries: stale-while-revalidate
  if (/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host)) {
    e.respondWith(caches.open(VERSION).then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});

/* ---------- Reminders (shared with the page through IndexedDB) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('masroufi', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function kvGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return dstr(new Date(y, m - 1, d + n)); }

async function checkReminders() {
  const sched = (await kvGet('schedule')) || [];
  const notified = (await kvGet('notified')) || {};
  const today = dstr(new Date());
  let changed = false;
  for (const e of sched) {
    if (today < e.from || today > addDays(e.due, 7)) continue;
    const stage = today >= e.due ? 2 : 1;
    if ((notified[e.key] || 0) >= stage) continue;
    await self.registration.showNotification(e.title, {
      body: stage === 2 ? e.bodyDue : e.bodySoon,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: e.key, lang: e.lang, dir: e.lang === 'ar' ? 'rtl' : 'ltr',
      data: { url: './#reminders' }
    });
    notified[e.key] = stage; changed = true;
  }
  if (changed) await kvSet('notified', notified);
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'masroufi-reminders') e.waitUntil(checkReminders());
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'check-reminders') e.waitUntil(checkReminders());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
