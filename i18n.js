// Module de traduction partagé (popup, page d'options, content script, service worker).
//
// Fichiers de langue : locales/index.json (liste des langues) + locales/<code>.json.
// Pour ajouter une langue : créer locales/<code>.json (copie de fr.json traduite) puis
// ajouter une entrée dans locales/index.json. Aucun changement de code n'est nécessaire.
//
// Ordre de résolution de la langue :
//   1. choix de l'utilisateur (storage.local.uiLanguage)
//   2. langue du navigateur (ex. "de-CH" -> "de-CH", puis "de")
//   3. langue par défaut de locales/index.json
// Une clé absente d'une langue est lue dans la langue par défaut, puis dans la clé elle-même.
(function (root) {
  'use strict';

  const LOCALES_DIR = 'locales/';
  const FALLBACK_DEFAULT = 'en';

  const state = {
    index: null,        // contenu de locales/index.json
    lang: null,         // langue active
    bundles: {},        // { code: objet de traduction }
    ready: null         // promesse d'initialisation
  };

  async function fetchJson(path) {
    const res = await fetch(browser.runtime.getURL(path));
    if (!res.ok) throw new Error('HTTP ' + res.status + ' pour ' + path);
    return res.json();
  }

  async function loadIndex() {
    if (state.index) return state.index;
    try {
      state.index = await fetchJson(LOCALES_DIR + 'index.json');
    } catch (e) {
      state.index = { default: FALLBACK_DEFAULT, languages: [{ code: FALLBACK_DEFAULT, label: 'EN', name: 'English' }] };
    }
    return state.index;
  }

  function availableCodes() {
    return (state.index.languages || []).map(l => l.code);
  }

  // "de-CH" -> ["de-ch", "de"] ; "FR" -> ["fr"]
  function candidates(rawLang) {
    const lang = String(rawLang || '').toLowerCase().replace('_', '-');
    if (!lang) return [];
    const out = [lang];
    const base = lang.split('-')[0];
    if (base !== lang) out.push(base);
    return out;
  }

  // Associe une langue demandée à une langue disponible (insensible à la casse)
  function matchAvailable(rawLang) {
    const codes = availableCodes();
    for (const c of candidates(rawLang)) {
      const hit = codes.find(code => code.toLowerCase() === c);
      if (hit) return hit;
    }
    return null;
  }

  function browserLanguages() {
    const list = [];
    try { if (typeof navigator !== 'undefined') list.push(...(navigator.languages || []), navigator.language); } catch (e) { /* ignore */ }
    try { const ui = browser.i18n && browser.i18n.getUILanguage && browser.i18n.getUILanguage(); if (ui) list.push(ui); } catch (e) { /* ignore */ }
    return list.filter(Boolean);
  }

  async function resolveLanguage() {
    await loadIndex();
    let stored = null;
    try { stored = (await browser.storage.local.get('uiLanguage')).uiLanguage; } catch (e) { /* ignore */ }
    const fromUser = matchAvailable(stored);
    if (fromUser) return fromUser;
    for (const l of browserLanguages()) {
      const hit = matchAvailable(l);
      if (hit) return hit;
    }
    return matchAvailable(state.index.default) || availableCodes()[0] || FALLBACK_DEFAULT;
  }

  async function loadBundle(code) {
    if (state.bundles[code]) return state.bundles[code];
    try {
      state.bundles[code] = await fetchJson(LOCALES_DIR + code + '.json');
    } catch (e) {
      state.bundles[code] = {};
    }
    return state.bundles[code];
  }

  function lookup(bundle, key) {
    let val = bundle;
    for (const part of key.split('.')) val = val == null ? undefined : val[part];
    return val;
  }

  // Traduction d'une clé. Retourne la clé elle-même si introuvable. Les {variables} sont remplacées.
  function t(key, vars) {
    vars = vars || {};
    let val = lookup(state.bundles[state.lang], key);
    if (val === undefined) val = lookup(state.bundles[state.index && state.index.default], key);
    if (typeof val !== 'string') return key;
    return val.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? vars[k] : '{' + k + '}'));
  }

  // Initialise la langue et charge les fichiers nécessaires (langue active + langue par défaut)
  function init() {
    if (!state.ready) {
      state.ready = (async () => {
        state.lang = await resolveLanguage();
        await Promise.all([loadBundle(state.lang), loadBundle(state.index.default)]);
        return state.lang;
      })();
    }
    return state.ready;
  }

  // Un autre contexte (ex. page d'options) change la langue: les contextes longue durée
  // (service worker, content script) doivent la relire à leur prochain usage.
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.uiLanguage) state.ready = null;
    });
  } catch (e) { /* contexte sans storage.onChanged */ }

  // Change de langue (mémorisée pour tous les contextes de l'extension)
  async function setLanguage(code) {
    await loadIndex();
    const hit = matchAvailable(code);
    if (!hit) throw new Error('Langue non disponible : ' + code);
    await browser.storage.local.set({ uiLanguage: hit });
    state.lang = hit;
    state.ready = Promise.resolve(hit);
    await Promise.all([loadBundle(hit), loadBundle(state.index.default)]);
    return hit;
  }

  // Applique les traductions aux éléments [data-i18n] et [data-i18n-placeholder] d'un document
  function applyTranslations(doc) {
    doc = doc || document;
    doc.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val !== key) el.textContent = val;
    });
    doc.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = t(key);
      if (val !== key) el.placeholder = val;
    });
    if (doc.documentElement && state.lang) doc.documentElement.setAttribute('lang', state.lang);
  }

  const api = {
    init,
    t,
    setLanguage,
    applyTranslations,
    getLanguage: () => state.lang,
    getLanguages: async () => { await loadIndex(); return state.index.languages.slice(); },
    // Pour le service worker et les tests : fournit directement les données sans fetch
    _setBundlesForTest(index, bundles, lang) { state.index = index; state.bundles = bundles; state.lang = lang; state.ready = Promise.resolve(lang); }
  };

  root.NxI18n = api;
})(typeof self !== 'undefined' ? self : this);
