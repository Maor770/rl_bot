'use strict';

// In-memory cache with TTL — replaces Google Apps Script's CacheService
// Keys: VIDEO_INDEX, KNOWLEDGE, SETTINGS, HOLIDAYS
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlSeconds = 21600) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function remove(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

module.exports = { get, set, remove, clear };
