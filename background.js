let bloomFilter = null;
let plainLists = {};
let isInitialized = false;
let initializationPromise = null;
let enabledLists = {
  'genai': true,
  'redflag': true,
  'amf': true
};

const LIST_CONFIGS = {
  'genai': {
    type: 'bloom',
    filename: 'bloom-filter.json',
    message: "Le règlement européen sur l'intelligence artificielle obligera à partir d'août 2026 les contenus « synthétiques » à être identifiables comme ayant été générés ou manipulés par une IA.\n\nOr, d'après les constatations (humaines) de Next.ink, des articles de ce site semblent avoir été (en tout ou partie) générés par IA.\n\nPour en savoir plus, nous signaler d'autres sites GenAI, ou si votre site aurait été identifié à tort, cliquez sur le bouton de l'extension.",
    infoUrl: 'https://next.ink/153613/enquete-plus-de-1-000-medias-en-francais-generes-par-ia-polluent-le-web-et-google/',
    updateUrl: 'http://gavois.fr/bloom-filter.json'
  },
  'redflag': {
    type: 'plain',
    filename: 'test.txt',
    message: "Ce site est dans la base de données de Red Flag Domains, une initiative qui référence des noms de domaine potentiellement malveillants.",
    infoUrl: 'https://red.flag.domains/',
    updateUrl: 'https://dl.red.flag.domains/red.flag.domains.txt'
  },
  'amf': {
    type: 'plain',
    filename: 'test2.txt',
    message: "Ce site est dans la la liste noire  des sociétés et sites non autorisés par l'Autorité des marchés financiers.",
    infoUrl: 'https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde',
    updateUrl: 'https://next.ink/wp-content/uploads/2025/02/test2.txt'
  }
};

const exceptions = new Set([
  'web.archive.org',
  'wlp-acs.com',
  'matoo.net',
  'accountscenter.facebook.com',
  'univ-fcomte.fr',
  'iut-bm.univ-fcomte.fr',
  'atlassian.com',
  'atlassian.fr',
  'eligibilite-thd.fr',
  'la-pleiade.fr',
  'univ-lyon1.fr',
  'ccijp.net',
  'techouvot.com',
  'st.com',
  'mobilizon.org',
  'aisafety.dance',
  'esver.free.fr',
  'foundation.mozilla.org',
  'akeeba.com',
  'toobi.fr',
  'winehq.org/',
  'cedeo.fr',
  'streetpress.com',
  'centaure-marketing-ia.fr',
  'cloud.familleboisteau.fr',
  'blog.erreur503.xyz',
  'veepee.fr',
  'les-sans-hulotte.net',
  'grr.ensta-bretagne.fr',
  'rennes.maville.com',
  'gavois.fr',
  'next.ink',
  'dl.red.flag.domains',
  'onlinecreation.me'
]);

class BloomFilter {
  constructor(size, numHashes, bitArray) {
    this.size = size;
    this.numHashes = numHashes;
    this.bitArray = new Uint8Array(bitArray);
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

  static fromJSON(jsonData) {
    return new BloomFilter(jsonData.size, jsonData.numHashes, jsonData.bitArray);
  }
}

function getDomainFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace('www.', '');
  } catch (e) {
    return url;
  }
}

// Configuration des styles par type de notification
const NOTIFICATION_STYLES = {
  'genai': {
    backgroundColor: 'rgb(141, 141, 141)',
    buttonColor: 'rgb(248, 134, 68)'
  },
  'redflag': {
    backgroundColor: 'rgb(141, 141, 141)',
    buttonColor: 'rgb(248, 134, 68)'
  },
  'amf': {
    backgroundColor: 'rgb(141, 141, 141)',
    buttonColor: 'rgb(248, 134, 68)'
  }
};
/**
 * Initialize the extension
 * @returns {Promise<void>}
 */
async function initializeExtension() {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {

    // Charger d'abord depuis le storage
    await loadListsFromStorage();

    // Vérifier quand était la dernière mise à jour
    const { lastListUpdate } = await browser.storage.local.get('lastListUpdate');
    const now = Date.now();
    const needsUpdate = !lastListUpdate || (now - lastListUpdate > 12 * 60 * 60 * 1000); // 12h

    if (needsUpdate) {
      await updateAllLists();
    }

    isInitialized = true;
  })();

  return initializationPromise;
}

/**
 * Get the size of the list
 * @param {string} type 
 * @returns {count: number | string}
 */
function getListCount(type) {
  if (LIST_CONFIGS[type].type === 'bloom') {
    if (bloomFilter) {
      try {
        const jsonString = JSON.stringify(bloomFilter);
        const fileSizeInBytes = new Blob([jsonString]).size;
        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
        return { count: `${fileSizeInKo} ko` };
      } catch (error) {
        return { count: 'Erreur de calcul' };
      }
    }
    return { count: 'Non chargé' };
  } else {
    return { count: plainLists[type] ? plainLists[type].size : 0 };
  }
}

/**
 * Check if the lists are up to date
 * @returns {Promise<void>}
 */
async function checkAndUpdateLists() {
  const lastUpdateKey = 'lastListUpdate';
  const now = Date.now();

  try {
    const { [lastUpdateKey]: lastUpdate } = await browser.storage.local.get(lastUpdateKey);

    if (!lastUpdate || (now - lastUpdate > 24 * 60 * 60 * 1000)) {
      await updateAllLists();
      await browser.storage.local.set({ [lastUpdateKey]: now });
    }
  } catch (error) {
  }
}

/**
 * Update the list
 * @param {string} type
 * @returns {Promise<void>}
 */
async function updateList(type) {
  try {
    const listConfig = LIST_CONFIGS[type];
    const response = await fetch(listConfig.updateUrl);

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status} lors du téléchargement de ${listConfig.updateUrl}`);
    }

    // Timestamp actuel pour cette liste
    const currentTimestamp = Date.now();

    if (listConfig.type === 'bloom') {
      const filterData = await response.json();
      bloomFilter = BloomFilter.fromJSON(filterData);
      await browser.storage.local.set({
        bloomFilter,
        bloomFilterTimestamp: currentTimestamp  // Ajouter le timestamp
      });
    } else {
      const text = await response.text();
      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      plainLists[type] = new Set(urls);

      await browser.storage.local.set({
        [`plainList_${type}`]: Array.from(plainLists[type]),
        [`plainList_${type}_timestamp`]: currentTimestamp  // Ajouter le timestamp
      });
    }

    await browser.runtime.sendMessage({
      action: 'updateListCount',
      type: type,
      count: plainLists[type] ? plainLists[type].size : 0,
      timestamp: currentTimestamp
    });

  } catch (error) {
  }
}

/**
 * Update all lists
 * @returns {Promise<void>}
 */
async function updateAllLists() {
  try {
    const updatePromises = Object.keys(LIST_CONFIGS).map(type => updateList(type));
    await Promise.allSettled(updatePromises);

    const updateTime = new Date().toLocaleString();
    await browser.storage.local.set({
      lastListUpdate: Date.now(),
      lastListUpdateFormatted: updateTime
    });
  } catch (error) {
  }
}

/**
 * Initialize list storage
 * @returns {Promise<void>}
 */
async function loadListsFromStorage() {
  try {
    const res = await browser.storage.local.get(null);

    if (!res.enabledLists) {
      const defaultLists = {
        'genai': true,
        'redflag': true,
        'amf': true
      };
      await browser.storage.local.set({ enabledLists: defaultLists });
      enabledLists = defaultLists;
    } else {
      enabledLists = res.enabledLists;
    }

    if (res.bloomFilter) {
      bloomFilter = BloomFilter.fromJSON(res.bloomFilter);
    }

    for (const key in res) {
      if (key.startsWith('plainList_') && !key.includes('timestamp')) {
        const listName = key.slice('plainList_'.length);
        plainLists[listName] = new Set(res[key]);
      }
    }

    isInitialized = true;

  } catch (error) {
  }
}

/**
 * Get the domain from a URL, excluging whitelists
 * @param {string} url 
 * @returns string|null
 */
function cleanUrl(url) {
  try {
    if (!url) return null;

    let cleaned = url.toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/$/, '')
      .split(/[/?#]/)[0];

    if (exceptions.has(cleaned)) {
      return null;
    }

    return cleaned;

  } catch (error) {
    return null;
  }
}

/**
 * Check if a URL is malicious
 * @param {string} url 
 * @returns {Promise<{matches: {category: string, config: object}[]}|undefined>}
 */
async function checkMalicious(url) {

  await initializeExtension();
  const cleanedUrl = cleanUrl(url);
  if (!cleanedUrl) {
    return resolve(undefined);
  }

  const listsHaveData = Object.values(plainLists).some(list => list && list.size > 0);
  if (!listsHaveData) {
    await updateAllLists();
  }

  const config = await browser.storage.local.get('enabledLists');
  const enabledLists = config.enabledLists || {
    genai: true,
    redflag: true,
    amf: true
  };

  let matches = [];

  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'plain' && enabledLists[type] !== false) {
      if (plainLists[type] && plainLists[type].has(cleanedUrl)) {
        matches.push({ category: type, config: listConfig });
      }
    }
  }

  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'bloom' && bloomFilter && enabledLists[type] !== false) {
      if (bloomFilter.mightContain(cleanedUrl)) {
        matches.push({ category: type, config: listConfig });
      }
    }
  }


  return matches.length > 0 ? { matches } : undefined;
}

/**
 * Handle the before request event
 * @param {object} details
 * @returns {Promise<{redirectUrl: string}>}
 */
async function beforeRequestListener(details) {
  const currentUrl = details.url;
  const cleanedUrl = cleanUrl(currentUrl);
  if (!cleanedUrl || !cleanedUrl.length || cleanedUrl.length < 2) {
    return {};
  }
  const domain = getDomainFromUrl(currentUrl);
  if (!domain || !domain.length || domain.length < 2) {
    return {};
  }
  const storageKey = 'tmp_ignore_' + domain;
  const response = await checkMalicious(currentUrl)
  if (response && response.matches && response.matches.length > 0) {
    const tmpIgnore = await browser.storage.local.get(storageKey);
    if (tmpIgnore && tmpIgnore[storageKey] && (new Date().getTime() - tmpIgnore[storageKey]) < 43200000) {
      return {};
    }
    let ignored = false;
    for await (const match of response.matches) {
      const category = match.category;
      const storageKey = `ignoredDomains_${category}`;
      const result = await browser.storage.local.get(storageKey)
      const ignoredDomains = result[storageKey] || [];
      if (ignoredDomains.includes(domain)) {
        ignored = true;
        break;
      }
    }
    if (ignored) {
      return {};
    }
    const match = response.matches[0];
    const redirectUrl = browser.runtime.getURL("alert.html") +
      `#m=${encodeURIComponent(match.config.message)}` +
      `&i=${encodeURIComponent(match.config.infoUrl)}` +
      `&c=${encodeURIComponent(match.category)}` +
      `&u=${encodeURIComponent(currentUrl)}`;
    return { 'redirectUrl': redirectUrl };
  }
  return {};
}

browser.runtime.onStartup.addListener(initializeExtension);
browser.runtime.onInstalled.addListener(async (details) => {
  await initializeExtension();

  await browser.alarms.create('listUpdateAlarm', {
    periodInMinutes: 60
  });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'listUpdateAlarm') {
    await checkAndUpdateLists();
  }
});

initializeExtension();

browser.webRequest.onBeforeRequest.addListener(
  beforeRequestListener,
  { urls: ["<all_urls>"] },
  ["blocking"]
);
