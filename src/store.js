// Armazenamento local do frontend para o que o backend ainda não guarda
// (conversas, destaques, preferências). IndexedDB primeiro, localStorage e
// memória como reserva — o app nunca deve quebrar por falta de armazenamento.

const DB_NAME = 'margem'
const STORE = 'kv'
const memory = new Map()
let dbPromise = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponível'))
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB bloqueado'))
    })
    dbPromise.catch(() => {})
  }
  return dbPromise
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(`margem:${key}`)
    return raw == null ? undefined : JSON.parse(raw)
  } catch {
    return memory.get(key)
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(`margem:${key}`, JSON.stringify(value))
  } catch {
    memory.set(key, value)
  }
}

export async function kvGet(key) {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return lsGet(key)
  }
}

export async function kvSet(key, value) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    lsSet(key, value)
  }
}

export async function kvDelete(key) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    try {
      localStorage.removeItem(`margem:${key}`)
    } catch {
      /* sem armazenamento */
    }
    memory.delete(key)
  }
}

/** Preferências pequenas e síncronas (tema, largura): localStorage direto. */
export function pref(key, fallback) {
  const value = lsGet(`pref:${key}`)
  return value === undefined ? fallback : value
}
export function setPref(key, value) {
  lsSet(`pref:${key}`, value)
}
