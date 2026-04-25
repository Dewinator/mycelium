# Dashboard i18n

Vanilla, framework-free i18n for the mycelium dashboard.

## Files

- `i18n.js` — runtime helper (`t`, `setLocale`, `applyToDom`, `initI18n`)
- `de.json` — German strings
- `en.json` — English strings (used as fallback for missing keys)

## How it works

The helper walks the DOM and applies translations based on two attributes:

```html
<button data-i18n="nav.memory">gedächtnis</button>
<input data-i18n-attr="placeholder:search.placeholder">
<button data-i18n-attr="aria-label:header.burger.aria;title:header.burger.title"></button>
```

For DOM built dynamically by JavaScript, use `window.myceliumI18n.t('key')`.

Variables are written as `{name}` in the JSON value:

```json
{ "hello.user": "Hello {name}" }
```

```js
t('hello.user', { name: 'Reed' }) // "Hello Reed"
```

## Locale precedence

1. `localStorage['mycelium.locale']` — user override (set by clicking the
   language toggle in the header)
2. `navigator.language` — browser preference
3. `'en'` — default

## Adding a language

1. Drop a new `<code>.json` next to `de.json` / `en.json`. Key set must
   match `en.json` (the fallback dictionary).
2. Add the code to `AVAILABLE` in `i18n.js`.
3. Done. The header toggle cycles through `AVAILABLE_LOCALES`.

## Status

Phase 1 covers the dashboard chrome (sidebar tabs, header, brand subtitle).
Per-tab string extraction is tracked as a follow-up.
