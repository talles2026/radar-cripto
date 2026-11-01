// Radar Cripto: dados sempre da rede quando houver sinal; sem sinal, mostra a última versão salva.
const CACHE = "radar-cripto-v14";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "analise.js", "setups.js", "lightweight-charts.standalone.production.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// notificações no celular
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Radar Cripto", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Radar Cripto", {
    body: d.body || "", icon: "icon-192.png", badge: "badge-96.png", tag: d.tag || undefined, renotify: !!d.tag,
    // compra e venda ficam na tela até você tocar (não somem sozinhas)
    requireInteraction: /AGORA/.test(d.title || ""),
    vibrate: /AGORA/.test(d.title || "") ? [300, 120, 300, 120, 300] : [200, 100, 200], silent: false, timestamp: Date.now(), data: { url: d.url || "./" }
  }).then(() => self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null));
});

// O navegador às vezes renova a inscrição de push sozinho. Sem isso, os avisos parariam de chegar
// sem nenhum sinal; aqui a inscrição nova é criada e enviada ao servidor na hora.
const FN = "https://xgwdrrxbqopsfhjgkvdq.supabase.co/functions/v1/cripto";
const VAPID = "BFTclvnkE-ZTpvhl9-0SZFruOKbH8r6DvXHgNTbsqglo0coom_VvLiPFAj8ZINlZXRqClA5-VNKZsnUJF2hC168";
function b64(s){ const p = "=".repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g,"+").replace(/_/g,"/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); }
self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    const antigo = e.oldSubscription && e.oldSubscription.endpoint;
    const nova = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID) });
    if (antigo && nova) await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acao: "trocar", antigo, novo: nova.toJSON() }) }).catch(() => {});
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  if (self.navigator && self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {});
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ("focus" in w) { w.navigate && w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
