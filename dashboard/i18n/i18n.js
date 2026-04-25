// Vanilla i18n helper for the mycelium dashboard.
// No framework, no build step. Two responsibilities:
//   1) provide t(key) for JS-built DOM
//   2) walk the DOM and apply data-i18n / data-i18n-attr attributes
//
// Markup conventions:
//   <button data-i18n="nav.memory">gedächtnis</button>
//   <input data-i18n-attr="placeholder:search.placeholder">
//   <button data-i18n-attr="aria-label:header.burger.aria"></button>
//   (multiple attrs: "placeholder:foo;title:bar")
//
// Variables: t('hello.name', { name: 'Reed' }) → "Hello Reed"
//   placeholders are written as {name} in the JSON value.
//
// Locale precedence: localStorage('mycelium.locale') > navigator.language > 'en'
// Adding a language: drop a new <code>.json into this folder, add to AVAILABLE.

const AVAILABLE = ['de', 'en'];
const STORAGE_KEY = 'mycelium.locale';
const DEFAULT_LOCALE = 'en';

let currentLocale = DEFAULT_LOCALE;
const dictionaries = {};
const listeners = new Set();

function detectInitialLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && AVAILABLE.includes(stored)) return stored;
  } catch (_) { /* localStorage may be unavailable */ }
  const nav = (navigator.language || '').toLowerCase().split('-')[0];
  if (AVAILABLE.includes(nav)) return nav;
  return DEFAULT_LOCALE;
}

async function loadDictionary(locale) {
  if (dictionaries[locale]) return dictionaries[locale];
  const res = await fetch(`/i18n/${locale}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`i18n: failed to load ${locale}.json (${res.status})`);
  dictionaries[locale] = await res.json();
  return dictionaries[locale];
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function t(key, vars) {
  const dict = dictionaries[currentLocale] || {};
  const fallback = dictionaries[DEFAULT_LOCALE] || {};
  const raw = key in dict ? dict[key] : (key in fallback ? fallback[key] : key);
  return interpolate(raw, vars);
}

export function getLocale() {
  return currentLocale;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function setLocale(locale) {
  if (!AVAILABLE.includes(locale)) throw new Error(`i18n: unknown locale ${locale}`);
  await loadDictionary(locale);
  currentLocale = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch (_) {}
  document.documentElement.setAttribute('lang', locale);
  applyToDom(document);
  listeners.forEach(fn => { try { fn(locale); } catch (_) {} });
}

export function applyToDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    const spec = el.getAttribute('data-i18n-attr');
    spec.split(';').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s && s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

export async function initI18n() {
  const initial = detectInitialLocale();
  // Always preload the default locale too so t() can fall back on missing keys.
  await Promise.all([
    loadDictionary(DEFAULT_LOCALE),
    initial === DEFAULT_LOCALE ? Promise.resolve() : loadDictionary(initial),
  ]);
  currentLocale = initial;
  document.documentElement.setAttribute('lang', initial);
  applyToDom(document);
  return initial;
}

export const AVAILABLE_LOCALES = AVAILABLE;
