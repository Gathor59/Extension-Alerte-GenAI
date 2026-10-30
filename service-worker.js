// Service Worker/Background Script - Version corrigée
// Chargement du polyfill pour Chrome (requis dans service worker)
if (typeof browser === 'undefined') {
  try {
    importScripts('browser-polyfill.min.js');
  } catch (e) {
    // Fallback pour Firefox (browser natif)
    self.browser = self.browser || self.chrome;
  }
}

// Attendre que browser soit défini
if (typeof browser === 'undefined') {
  self.browser = self.chrome;
}

// Module de traduction partagé (importScripts: le service worker n'a pas de balise <script>).
// Les traductions ne doivent JAMAIS empêcher le service worker de démarrer: si i18n.js est absent
// ou illisible, un module de repli renvoie les clés telles quelles et les listes continuent de se charger.
if (typeof NxI18n === 'undefined') {
  try {
    importScripts('i18n.js');
  } catch (e) {
    self.NxI18n = {
      init: async () => 'fr',
      t: (key) => key,
      getLanguage: () => 'fr'
    };
  }
}

// Variables globales
let bloomFilter = null;
let bloomFilterEn = null;
let plainLists = {};
let isInitialized = false;
let initializationPromise = null;
let enabledLists = {
  'genai': true,
  'bloom_en': true,
  'redflag': true,
  'amf': true,
  'dgccrf': true,
  'exceptions': true,
  'idn_homograph': true
};
let exceptions = new Set();
let idnHomographChars = null;

// NOUVEAU: Cache pour éviter les doublons d'alertes
let alertedUrls = new Map(); // Map<url, Set<categories>>

// Configuration des listes
const LIST_CONFIGS = {
  'genai': {
    type: 'bloom',
    filename: 'bloom-filter.json',
    messageKey: 'alert_messages.genai',
    infoUrl: 'https://next.ink/173214/recap-nous-avons-decouvert-des-milliers-de-sites-dinfo-generes-par-ia-tous-nos-articles/',
    updateUrl: 'https://cdn.next.ink/genai/bloom-filter.json'
  },
  'bloom_en': {
    type: 'bloom_en',
    filename: 'bloom-filter-en.json',
    messageKey: 'alert_messages.bloom_en',
    infoUrl: 'https://next.ink/173214/recap-nous-avons-decouvert-des-milliers-de-sites-dinfo-generes-par-ia-tous-nos-articles/',
    updateUrl: 'https://cdn.next.ink/genai/bloom-filter-en.json'
  },
  'redflag': {
    type: 'plain',
    filename: 'test.txt',
    messageKey: 'alert_messages.redflag',
    infoUrl: 'https://red.flag.domains/',
    updateUrl: 'https://dl.red.flag.domains/red.flag.domains.txt'
  },
  'amf': {
    type: 'plain',
    filename: 'test2.txt',
    messageKey: 'alert_messages.amf',
    infoUrl: 'https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde',
    updateUrl: 'https://cdn.next.ink/genai/amf.txt'
  },
  'dgccrf': {
    type: 'plain',
    filename: 'dgccrf.txt',
    messageKey: 'alert_messages.dgccrf',
    infoUrl: 'https://www.economie.gouv.fr/dgccrf/laction-de-la-dgccrf/injonctions-et-sanctions',
    updateUrl: 'https://cdn.next.ink/genai/dgccrf.txt'
  },
  'exceptions': {
    type: 'plain',
    filename: 'exceptions.txt',
    message: "",
    infoUrl: '',
    updateUrl: 'https://cdn.next.ink/genai/exceptions.txt'
  },
  'idn_homograph': {
    type: 'idn_detection',
    filename: 'idn-homographes.json',
    messageKey: 'alert_messages.idn_homograph',
    infoUrl: 'https://fr.wikipedia.org/wiki/Attaque_homographe_IDN',
    updateUrl: 'https://cdn.next.ink/genai/idn-homographes.json'
  }
};

// Message d'alerte d'une liste, dans la langue active (voir locales/<langue>.json, section alert_messages)
async function getLocalizedMessage(config) {
  if (!config.messageKey) return config.message || '';
  await NxI18n.init();
  return NxI18n.t(config.messageKey);
}

// Classe BloomFilter
class BloomFilter {
  constructor(size, numHashes, bitArray) {
    this.size = size;
    this.numHashes = numHashes;
    this.bitArray = bitArray instanceof Uint8Array ? bitArray : new Uint8Array(bitArray);
  }

  static fnv1a(string, seed = 0) {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < string.length; i++) {
      hash ^= string.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  getHashValues(string) {
    const hashes = new Array(this.numHashes);
    for (let i = 0; i < this.numHashes; i++) {
      hashes[i] = BloomFilter.fnv1a(string, i) % this.size;
    }
    return hashes;
  }

  mightContain(string) {
    const hashes = this.getHashValues(string);
    for (let i = 0; i < hashes.length; i++) {
      if (this.bitArray[hashes[i]] === 0) return false;
    }
    return true;
  }

  toJSON() {
    return {
      size: this.size,
      numHashes: this.numHashes,
      bitArray: Array.from(this.bitArray)
    };
  }

  static fromJSON(jsonData) {
    const filter = new BloomFilter(jsonData.size, jsonData.numHashes, jsonData.bitArray);
    filter.metadata = jsonData.metadata || null;
    return filter;
  }
}

// Fonction pour charger les caractères homographes IDN
async function loadIdnHomographChars() {
  try {
    // D'abord essayer de charger depuis le storage (données à jour du CDN)
    const result = await browser.storage.local.get(['idnHomographData']);
    if (result.idnHomographData) {
      idnHomographChars = result.idnHomographData;
      return true;
    }

    // Si pas dans le storage, charger depuis le fichier local (première installation)
    const response = await fetch(browser.runtime.getURL('idn-homographes.json'));
    const data = await response.json();
    idnHomographChars = data.homographs;

    // Stocker dans le storage pour les prochaines fois
    await browser.storage.local.set({
      idnHomographData: data.homographs,
      idnHomographData_timestamp: Date.now()
    });

    return true;
  } catch (error) {
    return false;
  }
}

// Fonction pour décoder Punycode (RFC 3492)
function decodePunycode(input) {
  try {
    if (!input.startsWith('xn--')) {
      return input;
    }

    const encoded = input.substring(4);
    const base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700;
    const initialBias = 72, initialN = 0x80;

    let n = initialN;
    let i = 0;
    let bias = initialBias;
    let output = [];

    let basic = encoded.lastIndexOf('-');
    if (basic < 0) basic = 0;

    for (let j = 0; j < basic; ++j) {
      output.push(encoded.charCodeAt(j));
    }

    for (let index = basic > 0 ? basic + 1 : 0; index < encoded.length; ) {
      let oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (index >= encoded.length) break;

        let c = encoded.charCodeAt(index++);
        let digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;

        i += digit * w;
        let t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
        if (digit < t) break;
        w *= base - t;
      }

      let out = output.length + 1;
      bias = ((i - oldi) / (oldi == 0 ? damp : 2)) >> 0;
      bias /= out;
      let k = 0;
      while (bias > ((base - tmin) * tmax) >> 1) {
        bias /= base - tmin;
        k += base;
      }
      bias = ((k + (base - tmin + 1) * bias / (bias + skew)) >> 0);

      n += (i / out) >> 0;
      i %= out;
      output.splice(i++, 0, n);
    }

    return String.fromCodePoint(...output);
  } catch (error) {
    return input;
  }
}

// Fonction pour détecter les caractères homographes dans une URL
function detectIdnHomograph(url) {
  if (!idnHomographChars || !url) {
    return { detected: false, suspiciousChars: [], isPunycode: false };
  }

  let domainToCheck = url;
  let isPunycode = false;

  try {
    // Extraire le domaine de l'URL
    const urlObj = new URL(url.startsWith('http') ? url : 'http://' + url);
    let hostname = urlObj.hostname;

    // Vérifier si c'est un domaine Punycode
    if (hostname.includes('xn--')) {
      isPunycode = true;

      // Décoder chaque partie du domaine
      const parts = hostname.split('.');
      const decodedParts = parts.map(part => {
        if (part.startsWith('xn--')) {
          return decodePunycode(part);
        }
        return part;
      });

      domainToCheck = decodedParts.join('.');
    } else {
      domainToCheck = hostname;
    }
  } catch (e) {
    // Si le parsing échoue, utiliser l'URL telle quelle
  }

  const suspiciousChars = [];

  // Parcourir chaque caractère du domaine
  for (let i = 0; i < domainToCheck.length; i++) {
    const char = domainToCheck[i];

    // Ignorer les chiffres (0-9) qui sont trop courants et génèrent des fausses alertes
    if (/[0-9]/.test(char)) {
      continue;
    }

    // Vérifier chaque lettre latine et ses homographes
    for (const [latinChar, homographData] of Object.entries(idnHomographChars)) {
      if (homographData.confusables) {
        for (const confusable of homographData.confusables) {
          if (char === confusable.char) {
            suspiciousChars.push({
              char: char,
              position: i,
              latinEquivalent: latinChar,
              script: confusable.script,
              unicode: confusable.unicode
            });
          }
        }
      }
    }
  }

  return {
    detected: suspiciousChars.length > 0 || isPunycode,
    suspiciousChars: suspiciousChars,
    isPunycode: isPunycode,
    decodedDomain: domainToCheck
  };
}

// Réinitialisation des variables depuis le storage
async function reinitializeVariables() {
  try {
    const res = await browser.storage.local.get(null);

    if (res.enabledLists) {
      enabledLists = res.enabledLists;
    }

    if (res.bloomFilter) {
      bloomFilter = BloomFilter.fromJSON(res.bloomFilter);
    }

    if (res.bloomFilterEn) {
      bloomFilterEn = BloomFilter.fromJSON(res.bloomFilterEn);
    }

    plainLists = {};
    for (const key in res) {
      if (key.startsWith('plainList_') && !key.includes('timestamp')) {
        const listName = key.slice('plainList_'.length);
        plainLists[listName] = new Set(res[key]);

        if (listName === 'exceptions') {
          exceptions = plainLists[listName];
        }
      }
    }

    if (res.idnHomographData) {
      idnHomographChars = res.idnHomographData;
    }

    isInitialized = true;
    
  } catch (error) {
    // Erreur lors de la réinitialisation des variables
  }
}

// Fonction fetch avec retry simple
async function fetchWithRetry(url, retryCount = 0) {
  const maxRetries = 3;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // Récupérer la version dynamiquement
    const manifest = browser.runtime.getManifest();
    const version = manifest.version;

    const response = await fetch(url, {
      cache: 'no-cache',
      signal: controller.signal,
      headers: {
        'User-Agent': `NextInk-Extension/${version}`
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  } catch (error) {
    if (retryCount < maxRetries && error.name !== 'AbortError') {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return fetchWithRetry(url, retryCount + 1);
    }
    throw error;
  }
}

// Limites de validation des fichiers distants (la liste de production est bien en dessous)
const BLOOM_MAX_BITS = 200_000_000;
const BLOOM_MAX_HASHES = 64;

// Un filtre de Bloom distant doit avoir une forme exacte avant d'être activé
function isValidBloomData(data) {
  if (!data || typeof data !== 'object') return false;
  const { size, numHashes, bitArray } = data;
  if (!Number.isInteger(size) || size < 1 || size > BLOOM_MAX_BITS) return false;
  if (!Number.isInteger(numHashes) || numHashes < 1 || numHashes > BLOOM_MAX_HASHES) return false;
  if (!Array.isArray(bitArray) || bitArray.length !== size) return false;
  for (let i = 0; i < bitArray.length; i++) {
    if (bitArray[i] !== 0 && bitArray[i] !== 1) return false;
  }
  return true;
}

// Métadonnées sûres: numElements est toujours un nombre (jamais du texte venant du CDN)
function buildBloomMetadata(filterData) {
  const raw = filterData.metadata && typeof filterData.metadata === 'object' ? filterData.metadata : {};
  const metadata = {};
  if (typeof raw.createdAt === 'string') metadata.createdAt = raw.createdAt.slice(0, 40);
  if (typeof raw.generatedBy === 'string') metadata.generatedBy = raw.generatedBy.slice(0, 40);
  if (Number.isFinite(raw.numElements) && raw.numElements >= 0) {
    metadata.numElements = raw.numElements;
  } else {
    let setBits = 0;
    for (let i = 0; i < filterData.bitArray.length; i++) {
      if (filterData.bitArray[i] === 1) setBits++;
    }
    metadata.numElements = Math.round(setBits / filterData.numHashes);
    metadata.estimated = true;
  }
  return metadata;
}

// Le fichier d'homographes doit être un objet {lettre: {confusables: [{char, unicode, script}]}}
function isValidIdnData(data) {
  if (!data || typeof data !== 'object' || !data.homographs || typeof data.homographs !== 'object') return false;
  const entries = Object.entries(data.homographs);
  if (entries.length === 0 || entries.length > 500) return false;
  for (const [letter, entry] of entries) {
    if (typeof letter !== 'string' || letter.length > 4) return false;
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.confusables) || entry.confusables.length > 500) return false;
    for (const c of entry.confusables) {
      if (!c || typeof c.char !== 'string' || c.char.length < 1 || c.char.length > 4) return false;
      if (typeof c.script !== 'string' || c.script.length > 80) return false;
      if (typeof c.unicode !== 'string' || !/^U\+[0-9A-F]{4,6}$/i.test(c.unicode)) return false;
    }
  }
  return true;
}

// Mise à jour d'une liste
async function updateList(type) {
  const listConfig = LIST_CONFIGS[type];
  if (!listConfig) {
    throw new Error(`Configuration non trouvée pour la liste ${type}`);
  }

  try {
    const response = await fetchWithRetry(listConfig.updateUrl);
    const currentTimestamp = Date.now();

    if (listConfig.type === 'bloom') {
      const filterData = await response.json();

      if (!isValidBloomData(filterData)) {
        throw new Error('Format de Bloom Filter invalide');
      }

      const newFilter = BloomFilter.fromJSON(filterData);
      const metadata = buildBloomMetadata(filterData);

      await browser.storage.local.set({
        bloomFilter: newFilter.toJSON(),
        bloomFilterTimestamp: currentTimestamp,
        bloomFilterMetadata: metadata
      });
      bloomFilter = newFilter;

    } else if (listConfig.type === 'bloom_en') {
      const filterData = await response.json();

      if (!isValidBloomData(filterData)) {
        throw new Error('Format de Bloom Filter anglais invalide');
      }

      const newFilter = BloomFilter.fromJSON(filterData);
      const metadata = buildBloomMetadata(filterData);

      await browser.storage.local.set({
        bloomFilterEn: newFilter.toJSON(),
        bloomFilterEnTimestamp: currentTimestamp,
        bloomFilterEnMetadata: metadata
      });
      bloomFilterEn = newFilter;

    } else if (listConfig.type === 'idn_detection') {
      const data = await response.json();

      if (!isValidIdnData(data)) {
        throw new Error('Format de fichier IDN invalide');
      }

      await browser.storage.local.set({
        idnHomographData: data.homographs,
        idnHomographData_timestamp: currentTimestamp
      });
      idnHomographChars = data.homographs;

    } else {
      const text = await response.text();

      // Validation basique du format texte
      if (typeof text !== 'string') {
        throw new Error('Format de liste texte invalide : le contenu n\'est pas du texte');
      }

      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      // Validation : vérifier qu'il y a au moins quelques entrées (éviter les listes vides accidentelles)
      if (type !== 'exceptions' && urls.length < 10) {
        // Attention : la liste contient peu d'entrées
      }

      plainLists[type] = new Set(urls);

      if (type === 'exceptions') {
        exceptions = plainLists[type];
      }

      await browser.storage.local.set({
        [`plainList_${type}`]: Array.from(plainLists[type]),
        [`plainList_${type}_timestamp`]: currentTimestamp
      });
    }

    // Notifier l'interface admin
    try {
      await browser.runtime.sendMessage({
        action: 'updateListCount',
        type: type,
        count: plainLists[type] ? plainLists[type].size : 0,
        timestamp: currentTimestamp
      });
    } catch (error) {
      // Interface admin non ouverte
    }

  } catch (error) {
    // Stocker l'erreur pour affichage dans l'interface admin
    try {
      const storage = await browser.storage.local.get(['updateErrors']);
      const updateErrors = storage.updateErrors || {};
      updateErrors[type] = {
        message: error.message,
        timestamp: Date.now(),
        url: listConfig.updateUrl
      };
      await browser.storage.local.set({ updateErrors });
    } catch (storageError) {
      // Impossible de stocker l'erreur
    }

    throw error;
  }
}

// Mise à jour de toutes les listes
async function updateAllLists() {
  const results = [];
  let hasErrors = false;

  for (const type of Object.keys(LIST_CONFIGS)) {
    try {
      await updateList(type);
      results.push({ type, success: true });

      // Effacer l'erreur si la mise à jour réussit
      try {
        const storage = await browser.storage.local.get(['updateErrors']);
        const updateErrors = storage.updateErrors || {};
        if (updateErrors[type]) {
          delete updateErrors[type];
          await browser.storage.local.set({ updateErrors });
        }
      } catch (e) {
        // Ignorer
      }
    } catch (error) {
      hasErrors = true;
      results.push({ type, success: false, error: error.message });
      // L'erreur est déjà stockée dans updateErrors par updateList()
    }
  }

  const updateTime = new Date().toLocaleString();
  await browser.storage.local.set({
    lastListUpdate: Date.now(),
    lastListUpdateFormatted: updateTime,
    lastUpdateResults: results
  });

  // Revérifier les filtres après la mise à jour
  await reinitializeVariables();
  const filterCheck = await checkAllFiltersLoaded();
  if (!filterCheck.allLoaded) {
    await notifyMissingFilters(filterCheck.missingFilters);
  } else {
    // Effacer l'alerte si tout est OK
    await browser.storage.local.set({
      filtersNotLoaded: false,
      missingFiltersList: [],
      notificationAlreadySent: false,
      notificationOutdatedSent: false
    });
    // Effacer les erreurs précédentes
    await browser.storage.local.remove('updateErrors');
    // Fermer les notifications si elles existent
    try {
      await browser.notifications.clear('missing-filters-alert');
      await browser.notifications.clear('outdated-lists-alert');
    } catch (e) {
      // Ignorer si les notifications n'existent pas
    }
  }

  // Mettre à jour le badge pour refléter l'état des erreurs
  await updateBadgeWithErrorCheck();

  return results;
}

// Vérification que tous les filtres critiques sont chargés
async function checkAllFiltersLoaded() {
  await NxI18n.init();
  const missingFilters = [];

  // Vérifier les erreurs de mise à jour récentes
  const storage = await browser.storage.local.get(['updateErrors', 'lastListUpdate']);
  const updateErrors = storage.updateErrors || {};

  // Vérifier le bloom filter
  if (!bloomFilter) {
    missingFilters.push(NxI18n.t('service_worker.missing_filter_genai'));
  } else if (updateErrors['genai']) {
    // Bloom filter existe mais mise à jour a échoué
    missingFilters.push(NxI18n.t('service_worker.missing_filter_genai_error'));
  }

  // Vérifier les listes plain text critiques
  if (!plainLists['redflag'] || plainLists['redflag'].size === 0) {
    missingFilters.push(NxI18n.t('service_worker.missing_filter_redflag'));
  } else if (updateErrors['redflag']) {
    missingFilters.push(NxI18n.t('service_worker.missing_filter_redflag_error'));
  }

  if (!plainLists['amf'] || plainLists['amf'].size === 0) {
    missingFilters.push(NxI18n.t('service_worker.missing_filter_amf'));
  } else if (updateErrors['amf']) {
    missingFilters.push(NxI18n.t('service_worker.missing_filter_amf_error'));
  }

  // Vérifier si les listes sont trop anciennes (plus de 7 jours)
  if (storage.lastListUpdate) {
    const lastUpdate = storage.lastListUpdate;
    const now = Date.now();
    const sevenDaysAgo = 7 * 24 * 60 * 60 * 1000;

    if (now - lastUpdate > sevenDaysAgo) {
      missingFilters.push(NxI18n.t('service_worker.missing_filter_obsolete'));
    }
  }

  return {
    allLoaded: missingFilters.length === 0,
    missingFilters: missingFilters
  };
}

// Afficher une notification d'alerte si des filtres manquent
async function notifyMissingFilters(missingFilters) {
  try {
    await NxI18n.init();

    // Stocker l'état d'alerte EN PREMIER: le badge et le bandeau du popup en dépendent, et ils doivent
    // fonctionner même quand les notifications système sont indisponibles (Safari) ou refusées.
    await browser.storage.local.set({
      filtersNotLoaded: true,
      missingFiltersList: missingFilters,
      lastFilterCheckTimestamp: Date.now()
    });

    // Vérifier si une notification a déjà été envoyée
    const storage = await browser.storage.local.get(['notificationAlreadySent']);

    // Ne notifier que si aucune notification n'a été envoyée pour cette erreur
    if (!storage.notificationAlreadySent && browser.notifications) {
      try {
        // Créer une notification système (API absente dans Safari)
        await browser.notifications.create('missing-filters-alert', {
          type: 'basic',
          iconUrl: 'icone-app_ia128.png',
          title: NxI18n.t('service_worker.notification_title_missing_filters'),
          message: NxI18n.t('service_worker.missing_filters_notification', { count: missingFilters.length, lists: missingFilters.join(', ') }),
          priority: 2
        });

        // Marquer qu'une notification a été envoyée
        await browser.storage.local.set({
          notificationAlreadySent: true
        });
      } catch (notificationError) {
        // Notification refusée ou indisponible: l'état d'alerte est déjà enregistré
      }
    }

  } catch (error) {
    // Erreur lors de la notification des filtres manquants
  }
}

// Afficher une notification si les listes sont obsolètes (> 7 jours)
async function notifyOutdatedLists() {
  try {
    await NxI18n.init();
    // Vérifier si une notification a déjà été envoyée
    const storage = await browser.storage.local.get(['notificationOutdatedSent']);

    // Ne notifier que si aucune notification n'a été envoyée
    if (!storage.notificationOutdatedSent && browser.notifications) {
      // Créer une notification système
      await browser.notifications.create('outdated-lists-alert', {
        type: 'basic',
        iconUrl: 'icone-app_ia128.png',
        title: NxI18n.t('service_worker.notification_title_outdated'),
        message: NxI18n.t('service_worker.outdated_lists_notification'),
        priority: 2
      });

      // Marquer qu'une notification a été envoyée
      await browser.storage.local.set({
        notificationOutdatedSent: true
      });
    }

  } catch (error) {
    // Erreur lors de la notification des listes obsolètes
  }
}

// Initialisation de l'extension
async function initializeExtension() {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      await reinitializeVariables();

      // Charger les caractères homographes IDN
      await loadIdnHomographChars();

      const storage = await browser.storage.local.get(['lastListUpdate', 'updateErrors']);
      const now = Date.now();
      const needsUpdate = !storage.lastListUpdate || (now - storage.lastListUpdate > 12 * 60 * 60 * 1000);
      const hasUpdateErrors = storage.updateErrors && Object.keys(storage.updateErrors).length > 0;

      // Mettre à jour si nécessaire OU si la dernière tentative a échoué
      if (needsUpdate || hasUpdateErrors) {
        await updateAllLists();
      }

      await checkDayChange();
      await updateBadgeWithErrorCheck();

      // Vérifier que tous les filtres sont chargés
      const filterCheck = await checkAllFiltersLoaded();
      if (!filterCheck.allLoaded) {
        await notifyMissingFilters(filterCheck.missingFilters);
        // Mettre à jour le badge pour afficher l'erreur
        await updateBadgeWithErrorCheck();
      } else {
        // Effacer l'état d'alerte si tout est OK
        await browser.storage.local.set({
          filtersNotLoaded: false,
          missingFiltersList: [],
          notificationAlreadySent: false,
          notificationOutdatedSent: false
        });
        // Fermer les notifications si elles existent
        try {
          await browser.notifications.clear('missing-filters-alert');
          await browser.notifications.clear('outdated-lists-alert');
        } catch (e) {
          // Ignorer si les notifications n'existent pas
        }
      }

    } catch (error) {
      // Erreur lors de l'initialisation
      throw error;
    }
  })();

  return initializationPromise;
}

// Fonctions utilitaires
async function getListCount(type) {
  if (LIST_CONFIGS[type].type === 'bloom') {
    if (bloomFilter) {
      try {
        const jsonString = JSON.stringify(bloomFilter.toJSON());
        const fileSizeInBytes = new Blob([jsonString]).size;
        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);

        // Récupérer les métadonnées depuis le storage
        const storage = await browser.storage.local.get('bloomFilterMetadata');
        const metadata = storage.bloomFilterMetadata || bloomFilter.metadata;

        return {
          count: `${fileSizeInKo} ko`,
          metadata: metadata
        };
      } catch (error) {
        return { count: 'Erreur de calcul', metadata: null };
      }
    }
    return { count: 'Non chargé', metadata: null };
  } else if (LIST_CONFIGS[type].type === 'bloom_en') {
    if (bloomFilterEn) {
      try {
        const jsonString = JSON.stringify(bloomFilterEn.toJSON());
        const fileSizeInBytes = new Blob([jsonString]).size;
        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);

        const storage = await browser.storage.local.get('bloomFilterEnMetadata');
        const metadata = storage.bloomFilterEnMetadata || bloomFilterEn.metadata;

        return {
          count: `${fileSizeInKo} ko`,
          metadata: metadata
        };
      } catch (error) {
        return { count: 'Erreur de calcul', metadata: null };
      }
    }
    return { count: 'Non chargé', metadata: null };
  } else {
    return { count: plainLists[type] ? plainLists[type].size : 0, metadata: null };
  }
}

function cleanUrl(url) {
  try {
    if (!url) return null;

    // Hôte seul via le parseur d'URL: retire identifiant (user@), port et chemin
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'http://' + url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const cleaned = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');

    if (!cleaned || exceptions.has(cleaned)) {
      return null;
    }

    return cleaned;

  } catch (error) {
    return null;
  }
}

// NOUVEAU: Fonction pour vérifier si une alerte a déjà été affichée
function hasAlreadyAlerted(url, categories) {
  if (!alertedUrls.has(url)) {
    return false;
  }
  
  const alertedCategories = alertedUrls.get(url);
  return categories.every(category => alertedCategories.has(category));
}

// NOUVEAU: Fonction pour marquer une URL comme ayant été alertée
function markAsAlerted(url, categories) {
  if (!alertedUrls.has(url)) {
    alertedUrls.set(url, new Set());
  }
  
  const alertedCategories = alertedUrls.get(url);
  categories.forEach(category => alertedCategories.add(category));
}

// Vérification d'URL et envoi de notifications - VERSION CORRIGÉE
async function checkUrl(tabId, url) {
  if (!isInitialized) {
    await reinitializeVariables();
  }
  
  if (!url) return;

  const cleanedUrl = cleanUrl(url);
  if (!cleanedUrl) return;

  // Vérifier que l'onglet peut recevoir des messages
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab || tab.status !== 'complete') return;
    
    if (tab.url.startsWith('chrome://') || 
        tab.url.startsWith('edge://') || 
        tab.url.startsWith('about:') || 
        tab.url.startsWith('moz-extension://') || 
        tab.url.startsWith('chrome-extension://')) {
      return;
    }
  } catch (error) {
    return;
  }

  const listsHaveData = Object.values(plainLists).some(list => list && list.size > 0);
  if (!listsHaveData && !bloomFilter) {
    await updateAllLists();
  }

  const config = await browser.storage.local.get(['enabledLists']);
  const currentEnabledLists = config.enabledLists || enabledLists;

  let matches = [];

  // Vérification des listes plain text
  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'plain' && currentEnabledLists[type] !== false && type !== 'exceptions') {
      if (plainLists[type] && plainLists[type].has(cleanedUrl)) {
        matches.push({ category: type, config: { ...listConfig, message: await getLocalizedMessage(listConfig) } });
      }
    }
  }

  // Vérification du filtre de Bloom (FR)
  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'bloom' && bloomFilter && currentEnabledLists[type] !== false) {
      try {
        if (bloomFilter.mightContain(cleanedUrl)) {
          matches.push({ category: type, config: { ...listConfig, message: await getLocalizedMessage(listConfig) } });
        }
      } catch (error) {
        // Filtre inutilisable: les autres listes restent actives
      }
    }
  }

  // Vérification du filtre de Bloom (EN)
  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'bloom_en' && bloomFilterEn && currentEnabledLists[type] !== false) {
      try {
        if (bloomFilterEn.mightContain(cleanedUrl)) {
          matches.push({ category: type, config: { ...listConfig, message: await getLocalizedMessage(listConfig) } });
        }
      } catch (error) {
        // Filtre inutilisable: les autres listes restent actives
      }
    }
  }

  // Vérification des homographes IDN
  if (currentEnabledLists['idn_homograph'] !== false && idnHomographChars) {
    try {
      const idnResult = detectIdnHomograph(url);
      if (idnResult.detected) {
        matches.push({
          category: 'idn_homograph',
          config: { ...LIST_CONFIGS['idn_homograph'], message: await getLocalizedMessage(LIST_CONFIGS['idn_homograph']) },
          homographData: idnResult.suspiciousChars,
          decodedDomain: idnResult.decodedDomain
        });
      }
    } catch (error) {
      // Données IDN inutilisables: les autres listes restent actives
    }
  }

  if (matches.length > 0) {
    // NOUVEAU: Vérifier si on a déjà alerté pour ces catégories
    const categories = matches.map(m => m.category);
    if (hasAlreadyAlerted(url, categories)) {
      return; // Ne pas alerter à nouveau
    }

    try {
      // D'abord envoyer la notification
      await browser.tabs.sendMessage(tabId, {
        action: "showNotification",
        matches: matches
      });
      
      // NOUVEAU: Marquer comme alerté et enregistrer l'alerte seulement si la notification est envoyée avec succès
      markAsAlerted(url, categories);
      await recordAlert(matches, url);
      
    } catch (error) {
      // Content script non disponible, retry après délai
      setTimeout(async () => {
        try {
          await browser.tabs.sendMessage(tabId, {
            action: "showNotification",
            matches: matches
          });
          
          // NOUVEAU: Marquer comme alerté et enregistrer l'alerte seulement après envoi réussi
          markAsAlerted(url, categories);
          await recordAlert(matches, url);
          
        } catch (retryError) {
          // Ignorer si l'onglet n'est plus disponible
        }
      }, 1000);
    }
  }
}

// Teste une liste de noms de domaine contre les bases GenAI (FR + EN).
// Renvoie ceux qui y figurent. Point d'entrée réservé aux content scripts qui veulent tester des domaines
// trouvés dans une page (message "checkDomains"); sans effet tant qu'aucun script ne l'envoie.
// Les domaines viennent d'une page web (non fiable): types et tailles sont bornés.
const CHECK_DOMAINS_MAX = 500;
const CHECK_DOMAIN_MAX_LENGTH = 253;
async function checkDomainsAgainstGenAI(domains) {
  if (!Array.isArray(domains)) return [];
  const stored = await browser.storage.local.get(['enabledLists']);
  const enabled = stored.enabledLists || enabledLists;
  const flagged = [];
  for (const raw of domains.slice(0, CHECK_DOMAINS_MAX)) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > CHECK_DOMAIN_MAX_LENGTH) continue;
    const host = cleanUrl(raw); // même normalisation que l'alerte (sans www., exceptions respectées)
    if (!host) continue;
    let hit = false;
    try {
      if (bloomFilter && enabled['genai'] !== false && bloomFilter.mightContain(host)) hit = true;
      if (!hit && bloomFilterEn && enabled['bloom_en'] !== false && bloomFilterEn.mightContain(host)) hit = true;
    } catch (error) {
      // Filtre inutilisable: ce domaine n'est pas signalé
    }
    if (hit) flagged.push(raw);
  }
  return flagged;
}

// Gestionnaire d'événements
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    if (!isInitialized) {
      await reinitializeVariables();
    }

    if (message.action === 'getListCount') {
      const result = await getListCount(message.type);
      return result;
    }
    else if (message.action === 'toggleList') {
      try {
        enabledLists[message.type] = message.enabled;
        await browser.storage.local.set({ enabledLists });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    else if (message.action === 'updateAllLists') {
      const results = await updateAllLists();
      return { success: true, results };
    }
    else if (message.action === "contentScriptReady" && sender.tab) {
      setTimeout(() => checkUrl(sender.tab.id, sender.tab.url), 100);
      return { received: true };
    }
    else if (message.action === "pageRevisited" && sender.tab) {
      setTimeout(() => checkUrl(sender.tab.id, sender.tab.url), 100);
      return { received: true };
    }
    else if (message.action === "checkDomains" && sender.tab) {
      return { flagged: await checkDomainsAgainstGenAI(message.domains) };
    }
    else if (message.action === "checkReady") {
      return { status: "ready" };
    }
    
    return undefined;
  };

  handleMessage()
    .then(sendResponse)
    .catch(error => {
      sendResponse({error: error.message});
    });
  
  return true;
});

// Listeners d'événements
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && 
      !tab.url.startsWith('about:') && 
      !tab.url.startsWith('chrome://') && 
      !tab.url.startsWith('edge://') && 
      !tab.url.startsWith('moz-extension://') && 
      !tab.url.startsWith('chrome-extension://')) {
    
    if (!isInitialized) {
      await reinitializeVariables();
    }
    
    setTimeout(() => checkUrl(tabId, tab.url), 500);
  }
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    
    if (tab.url && 
        !tab.url.startsWith('about:') && 
        !tab.url.startsWith('chrome://') && 
        !tab.url.startsWith('edge://') && 
        !tab.url.startsWith('moz-extension://') && 
        !tab.url.startsWith('chrome-extension://')) {
      
      if (!isInitialized) {
        await reinitializeVariables();
      }
      
      setTimeout(() => checkUrl(activeInfo.tabId, tab.url), 200);
    }
  } catch (error) {
    // Onglet non disponible
  }
});

// Initialisation au démarrage
browser.runtime.onStartup.addListener(async () => {
  await initializeExtension();
});

browser.runtime.onInstalled.addListener(async (details) => {
  await initializeExtension();
  
  try {
    await browser.alarms.create('listUpdateAlarm', {
      periodInMinutes: 60
    });
  } catch (error) {
    // Erreur configuration alarme
  }
});

// Gestion des alarmes
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'listUpdateAlarm') {
    await reinitializeVariables();

    // Vérifier le changement de jour
    await checkDayChange();

    const storage = await browser.storage.local.get(['lastListUpdate']);
    const now = Date.now();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const oneWeekInMs = 7 * oneDayInMs;

    // Vérifier si les listes n'ont pas été mises à jour depuis plus d'une semaine
    if (storage.lastListUpdate && (now - storage.lastListUpdate > oneWeekInMs)) {
      await notifyOutdatedLists();
    }

    // Tenter une mise à jour si dernière MAJ > 24h
    if (!storage.lastListUpdate || (now - storage.lastListUpdate > oneDayInMs)) {
      await updateAllLists();
    }

    // Vérifier l'état des filtres même si on ne met pas à jour
    const filterCheck = await checkAllFiltersLoaded();
    if (!filterCheck.allLoaded) {
      await notifyMissingFilters(filterCheck.missingFilters);
      // Mettre à jour le badge pour afficher l'erreur
      await updateBadgeWithErrorCheck();
    }
  }
});

// NOUVEAU: Nettoyer le cache d'alertes périodiquement (toutes les heures)
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cleanAlertCache') {
    // Garder seulement les 100 dernières URLs alertées
    if (alertedUrls.size > 100) {
      const entries = Array.from(alertedUrls.entries());
      alertedUrls.clear();
      // Garder les 50 plus récentes
      entries.slice(-50).forEach(([url, categories]) => {
        alertedUrls.set(url, categories);
      });
    }
  }
});

// Créer l'alarme de nettoyage
browser.runtime.onInstalled.addListener(async () => {
  try {
    await browser.alarms.create('cleanAlertCache', {
      periodInMinutes: 60
    });
  } catch (error) {
    // Erreur configuration alarme de nettoyage
  }
});

// Initialisation immédiate
initializeExtension().catch(error => {
  // Erreur lors de l'initialisation
});

// Fonction pour enregistrer une alerte - VERSION CORRIGÉE
async function recordAlert(matches, url) {
  const today = new Date().toISOString().split('T')[0];
  const stats = await browser.storage.local.get(['alertStats', 'todayBadgeCount']);

  // Initialiser si nécessaire
  const alertStats = stats.alertStats || {};
  if (!alertStats[today]) {
    alertStats[today] = { genai: 0, redflag: 0, amf: 0, dgccrf: 0, idn_homograph: 0 };
  }

  // NOUVEAU: Compter une seule alerte par popup (même si plusieurs catégories)
  // au lieu de compter chaque catégorie séparément
  let hasNewAlert = false;

  matches.forEach(match => {
    if (alertStats[today][match.category] !== undefined) {
      alertStats[today][match.category]++;
      hasNewAlert = true;
    }
  });

  // NOUVEAU: Incrémenter le badge seulement d'une unité par popup
  const newBadgeCount = (stats.todayBadgeCount || 0) + (hasNewAlert ? 1 : 0);

  // Sauvegarder
  await browser.storage.local.set({
    alertStats,
    todayBadgeCount: newBadgeCount
  });

  // Mettre à jour le badge (vérifie aussi les erreurs)
  await updateBadgeWithErrorCheck();
}

// Fonction pour mettre à jour le badge
async function updateBadge(count, hasErrors = false) {
  // MV3: la clé du manifeste est "action", donc l'API est browser.action dans Chrome, Edge ET Firefox.
  // browserAction n'existe que pour les extensions MV2; on le garde en repli, sans deviner le navigateur.
  const actionAPI = browser.action || browser.browserAction;
  if (!actionAPI) return;

  if (hasErrors) {
    // Mode erreur : badge rouge avec "!"
    await actionAPI.setBadgeText({ text: '!' });
    await actionAPI.setBadgeBackgroundColor({ color: '#FF0000' });
  } else if (count > 0) {
    // Mode normal : badge jaune avec le compteur
    await actionAPI.setBadgeText({ text: count.toString() });
    await actionAPI.setBadgeBackgroundColor({ color: '#FFFF00' });
  } else {
    // Pas de badge
    await actionAPI.setBadgeText({ text: '' });
  }
}

// Fonction pour mettre à jour le badge en vérifiant l'état des erreurs
async function updateBadgeWithErrorCheck() {
  try {
    const storage = await browser.storage.local.get(['todayBadgeCount', 'updateErrors']);
    const count = storage.todayBadgeCount || 0;
    const hasErrors = storage.updateErrors && Object.keys(storage.updateErrors).length > 0;

    await updateBadge(count, hasErrors);
  } catch (error) {
    // Erreur lors de la mise à jour du badge
  }
}

async function checkDayChange() {
  const today = new Date().toISOString().split('T')[0];
  const lastDay = await browser.storage.local.get('lastAlertDay');

  if (!lastDay.lastAlertDay || lastDay.lastAlertDay !== today) {
    // Nouveau jour - reset du badge et du cache d'alertes
    await browser.storage.local.set({
      lastAlertDay: today,
      todayBadgeCount: 0
    });
    await updateBadgeWithErrorCheck();

    // NOUVEAU: Nettoyer le cache d'alertes pour le nouveau jour
    alertedUrls.clear();
  }
}