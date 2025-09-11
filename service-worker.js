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

// Variables globales
let bloomFilter = null;
let plainLists = {};
let isInitialized = false;
let initializationPromise = null;
let enabledLists = {
  'genai': true,
  'redflag': true,
  'amf': true,
  'exceptions': true
};
let exceptions = new Set();

// NOUVEAU: Cache pour éviter les doublons d'alertes
let alertedUrls = new Map(); // Map<url, Set<categories>>

// Configuration des listes
const LIST_CONFIGS = {
  'genai': {
    type: 'bloom',
    filename: 'bloom-filter.json',
    message: "Le règlement européen sur l'intelligence artificielle obligera à partir d'août 2026 les contenus « synthétiques » à être identifiables comme ayant été générés ou manipulés par une IA.<br><br>Or, d'après les constatations (humaines) de Next.ink, des articles de ce site semblent avoir été (en tout ou partie) générés par IA (il pourrait aussi s'agir d'un « faux positif », mais la probabilité est faible).<br><br>Pour en savoir plus, nous signaler d'autres sites GenAI, ou si votre site aurait été identifié à tort, cliquez sur le bouton de l'extension.<br>",
    infoUrl: 'https://next.ink/153613/enquete-plus-de-1-000-medias-en-francais-generes-par-ia-polluent-le-web-et-google/',
    updateUrl: 'https://next.ink/wp-content/uploads/2025/08/bloom-genai.json'
  },
  'redflag': {
    type: 'plain',
    filename: 'test.txt',
    message: "Attention : ce site est dans la base de données de Red Flag Domains, une initiative qui référence des noms de domaine potentiellement malveillants.",
    infoUrl: 'https://red.flag.domains/',
    updateUrl: 'https://dl.red.flag.domains/red.flag.domains.txt'
  },
  'amf': {
    type: 'plain',
    filename: 'test2.txt',
    message: "Attention : ce site est dans la liste noire des sociétés et sites non autorisés par l'Autorité des marchés financiers.",
    infoUrl: 'https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde',
    updateUrl: 'https://next.ink/wp-content/uploads/2025/05/amf.txt'
  },
  'exceptions': {
    type: 'plain',
    filename: 'exceptions.txt',
    message: "",
    infoUrl: '',
    updateUrl: 'https://next.ink/wp-content/uploads/2025/08/exceptions.txt'
  }
};

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
    return new BloomFilter(jsonData.size, jsonData.numHashes, jsonData.bitArray);
  }
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

    isInitialized = true;
    
  } catch (error) {
    console.error('Erreur lors de la réinitialisation des variables:', error);
  }
}

// Fonction fetch avec retry simple
async function fetchWithRetry(url, retryCount = 0) {
  const maxRetries = 3;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(url, {
      cache: 'no-cache',
      signal: controller.signal,
      headers: {
        'User-Agent': 'NextInk-Extension/2.2.0'
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

// Mise à jour d'une liste
async function updateList(type) {
  try {
    const listConfig = LIST_CONFIGS[type];
    if (!listConfig) {
      throw new Error(`Configuration non trouvée pour la liste ${type}`);
    }
    
    const response = await fetchWithRetry(listConfig.updateUrl);
    const currentTimestamp = Date.now();

    if (listConfig.type === 'bloom') {
      const filterData = await response.json();
      bloomFilter = BloomFilter.fromJSON(filterData);
      
      await browser.storage.local.set({ 
        bloomFilter: bloomFilter.toJSON(),
        bloomFilterTimestamp: currentTimestamp
      });
      
    } else {
      const text = await response.text();
      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
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
    console.error(`Échec de mise à jour de la liste ${type}:`, error.message);
    throw error;
  }
}

// Mise à jour de toutes les listes
async function updateAllLists() {
  const results = [];
  
  for (const type of Object.keys(LIST_CONFIGS)) {
    try {
      await updateList(type);
      results.push({ type, success: true });
    } catch (error) {
      results.push({ type, success: false, error: error.message });
    }
  }
  
  const updateTime = new Date().toLocaleString();
  await browser.storage.local.set({ 
    lastListUpdate: Date.now(),
    lastListUpdateFormatted: updateTime 
  });
  
  return results;
}

// Initialisation de l'extension
async function initializeExtension() {
  if (initializationPromise) {
    return initializationPromise;
  }
  
  initializationPromise = (async () => {
    try {
      await reinitializeVariables();

      const storage = await browser.storage.local.get(['lastListUpdate']);
      const now = Date.now();
      const needsUpdate = !storage.lastListUpdate || (now - storage.lastListUpdate > 12 * 60 * 60 * 1000);

      if (needsUpdate) {
        await updateAllLists();
      }
      
      // Ajouter ces lignes :
      await checkDayChange();
      const stats = await browser.storage.local.get('todayBadgeCount');
      await updateBadge(stats.todayBadgeCount || 0);
      
    } catch (error) {
      console.error('Erreur lors de l\'initialisation:', error);
      throw error;
    }
  })();
  
  return initializationPromise;
}

// Fonctions utilitaires
function getListCount(type) {
  if (LIST_CONFIGS[type].type === 'bloom') {
    if (bloomFilter) {
      try {
        const jsonString = JSON.stringify(bloomFilter.toJSON());
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
        matches.push({ category: type, config: listConfig });
      }
    }
  }

  // Vérification du filtre de Bloom
  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'bloom' && bloomFilter && currentEnabledLists[type] !== false) {
      if (bloomFilter.mightContain(cleanedUrl)) {
        matches.push({ category: type, config: listConfig });
      }
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

// Gestionnaire d'événements
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    if (!isInitialized) {
      await reinitializeVariables();
    }

    if (message.action === 'getListCount') {
      const count = getListCount(message.type);
      return { count };
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
    console.error('Erreur configuration alarme:', error);
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
    
    if (!storage.lastListUpdate || (now - storage.lastListUpdate > 24 * 60 * 60 * 1000)) {
      await updateAllLists();
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
    console.error('Erreur configuration alarme de nettoyage:', error);
  }
});

// Initialisation immédiate
initializeExtension().catch(error => {
  console.error('Erreur lors de l\'initialisation:', error);
});

// Fonction pour enregistrer une alerte - VERSION CORRIGÉE
async function recordAlert(matches, url) {
  const today = new Date().toISOString().split('T')[0];
  const stats = await browser.storage.local.get(['alertStats', 'todayBadgeCount']);
  
  // Initialiser si nécessaire
  const alertStats = stats.alertStats || {};
  if (!alertStats[today]) {
    alertStats[today] = { genai: 0, redflag: 0, amf: 0 };
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
  
  // Mettre à jour le badge
  await updateBadge(newBadgeCount);
}

// Fonction pour mettre à jour le badge
async function updateBadge(count) {
  // Détecter si on est sur Firefox ou Chrome
  const isFirefox = typeof browser !== 'undefined' && browser.browserAction;
  const actionAPI = isFirefox ? browser.browserAction : browser.action;
  
  if (count > 0) {
    await actionAPI.setBadgeText({ text: count.toString() });
    await actionAPI.setBadgeBackgroundColor({ color: '#FFFF00' });
  } else {
    await actionAPI.setBadgeText({ text: '' });
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
    await updateBadge(0);
    
    // NOUVEAU: Nettoyer le cache d'alertes pour le nouveau jour
    alertedUrls.clear();
  }
}