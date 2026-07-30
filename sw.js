const V='mes-v10-login-width-fix', CDN=[
  'https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/prop-types@15.8.1/prop-types.min.js',
  'https://cdn.jsdelivr.net/npm/recharts@2.8.0/umd/Recharts.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/firebase@10.7.0/firebase-app-compat.min.js',
  'https://cdn.jsdelivr.net/npm/firebase@10.7.0/firebase-firestore-compat.min.js',
  'https://cdn.jsdelivr.net/npm/firebase@10.7.0/firebase-auth-compat.min.js',
];
const APP=['./','./index.html','./app.js','./manifest.json'];

self.addEventListener('install',e=>e.waitUntil(
  caches.open(V).then(c=>Promise.allSettled([
    ...CDN.map(u=>c.add(u).catch(()=>{})),
    ...APP.map(u=>c.add(u).catch(()=>{})),
  ])).then(()=>self.skipWaiting())
));
self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k))))
  .then(()=>self.clients.claim())
));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.hostname.includes('googleapis.com')||u.pathname.includes('/listen/')){return;}
  if(e.request.method!=='GET'){return;}

  const update = fetch(e.request).then(r=>{
    if(r && r.ok){
      const copy = r.clone();
      caches.open(V).then(c=>c.put(e.request, copy)).catch(()=>{});
    }
    return r;
  }).catch(()=>null);

  e.respondWith(
    caches.match(e.request).then(cached=>
      cached || update.then(r=>r || new Response('',{status:503}))
    )
  );
  e.waitUntil(update.catch(()=>{}));
});
