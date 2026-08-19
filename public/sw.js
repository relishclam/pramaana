/**
 * Pramaana Service Worker — handles PWA share target for payment receipts.
 * Intercepts POST /share-receipt, saves file to IndexedDB, then redirects
 * to /receipts/inbox. The IDB-first approach means files survive cold SW
 * restarts — the RA "share and nothing happens" failure mode is prevented.
 *
 * On app load, the sync module reads pending items from IDB and uploads them.
 */

const IDB_NAME = 'pramaana-receipts'
const IDB_STORE = 'pending'
const IDB_VERSION = 1

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

async function savePendingReceipt(file) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const store = tx.objectStore(IDB_STORE)
    const reader = new FileReader()
    reader.onload = () => {
      const req = store.add({
        name:      file.name,
        type:      file.type,
        size:      file.size,
        data:      reader.result,   // ArrayBuffer
        savedAt:   Date.now(),
      })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

// ── Share target handler ──────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.pathname !== '/share-receipt') return

  event.respondWith((async () => {
    try {
      const form = await event.request.formData()
      const file = form.get('receipt')
      if (file && file instanceof File) {
        await savePendingReceipt(file)
      }
    } catch (err) {
      console.error('[sw] Failed to save receipt to IDB:', err)
    }
    return Response.redirect('/receipts/inbox?shared=1', 303)
  })())
})

// ── Install + activate (no caching strategy — Vercel handles CDN) ─────────────

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
