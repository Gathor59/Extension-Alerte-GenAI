// Assurer la compatibilité avec Chrome si le polyfill n'est pas chargé
if (typeof browser === 'undefined') {
  var browser = chrome;
}

// Variables globales avec persistance pour Chrome
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

// Variable pour stocker les exceptions
let exceptions = new Set();

// Configuration des listes
const LIST_CONFIGS = {
  'genai': {
    type: 'bloom',
    filename: 'bloom-filter.json',
    message: "Le règlement européen sur l'intelligence artificielle obligera à partir d'août 2026 les contenus « synthétiques » à être identifiables comme ayant été générés ou manipulés par une IA.<br><br>Or, d'après les constatations (humaines) de Next.ink, des articles de ce site semblent avoir été (en tout ou partie) générés par IA (il pourrait aussi s'agir d'un « faux positif », mais la probabilité est faible).<br><br>Pour en savoir plus, nous signaler d'autres sites GenAI, ou si votre site aurait été identifié à tort, cliquez sur le bouton de l'extension.<br>",
    infoUrl: 'https://next.ink/153613/enquete-plus-de-1-000-medias-en-francais-generes-par-ia-polluent-le-web-et-google/',
    updateUrl: 'https://next.ink/bloom-genai/'
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
    message: "Attention : ce site est dans la la liste noire des sociétés et sites non autorisés par l'Autorité des marchés financiers.",
    infoUrl: 'https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde',
    updateUrl: 'https://next.ink/amf/'
  },
  'exceptions': {
    type: 'plain',
    filename: 'exceptions.txt',
    message: "",
    infoUrl: '',
    updateUrl: 'https://next.ink/exceptions/'
  }
};

// Classe BloomFilter
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

// CORRECTION 1: Fonction de réinitialisation des variables à chaque réveil du service worker
async function reinitializeVariables() {
  console.log('🔄 Réinitialisation des variables depuis le storage pour Chrome');
  
  try {
    const res = await browser.storage.local.get(null);
    console.log('Données récupérées du storage:', Object.keys(res));

    // Réinitialiser enabledLists
    if (res.enabledLists) {
      enabledLists = res.enabledLists;
    }

    // Réinitialiser bloomFilter
    if (res.bloomFilter) {
      bloomFilter = BloomFilter.fromJSON(res.bloomFilter);
      console.log('BloomFilter réinitialisé');
    }

    // Réinitialiser plainLists
    plainLists = {};
    for (const key in res) {
      if (key.startsWith('plainList_') && !key.includes('timestamp')) {
        const listName = key.slice('plainList_'.length);
        plainLists[listName] = new Set(res[key]);
        
        if (listName === 'exceptions') {
          exceptions = plainLists[listName];
        }
        
        console.log(`Liste ${listName} réinitialisée avec ${plainLists[listName].size} éléments`);
      }
    }

    isInitialized = true;
    console.log('Variables réinitialisées avec succès');
    
  } catch (error) {
    console.error('Erreur lors de la réinitialisation des variables:', error);
  }
}

// CORRECTION 2: Initialisation améliorée pour Chrome
async function initializeExtension() {
  console.log('🚀 Démarrage de l\'initialisation Chrome');
  
  if (initializationPromise) {
    console.log('Initialisation déjà en cours, attente...');
    return initializationPromise;
  }
  
  initializationPromise = (async () => {
    // Toujours réinitialiser les variables depuis le storage
    await reinitializeVariables();

    // Vérifier la dernière mise à jour
    const { lastListUpdate } = await browser.storage.local.get('lastListUpdate');
    const now = Date.now();
    const needsUpdate = !lastListUpdate || (now - lastListUpdate > 12 * 60 * 60 * 1000); // 12h

    if (needsUpdate) {
      console.log('⬇️ Mise à jour nécessaire (> 12h ou jamais faite)');
      await updateAllLists();
    } else {
      console.log('✅ Pas besoin de mise à jour (dernière mise à jour < 12h)');
    }
    
    console.log('✅ Initialisation terminée');
  })();
  
  return initializationPromise;
}

// CORRECTION 3: Fonction de mise à jour avec retry et meilleure gestion d'erreurs
async function updateList(type, retryCount = 0) {
  const maxRetries = 3;
  
  try {
    console.log(`📥 Mise à jour de la liste ${type} (tentative ${retryCount + 1})`);
    
    const listConfig = LIST_CONFIGS[type];
    
    // Ajouter un timeout et retry
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    const response = await fetch(listConfig.updateUrl, {
      cache: 'no-cache',
      signal: controller.signal,
      headers: {
        'User-Agent': 'NextInk-Extension/2.1.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status} pour ${listConfig.updateUrl}`);
    }

    console.log(`✅ Liste ${type} téléchargée avec succès`);
    
    const currentTimestamp = Date.now();

    if (listConfig.type === 'bloom') {
      const filterData = await response.json();
      bloomFilter = BloomFilter.fromJSON(filterData);
      await browser.storage.local.set({ 
        bloomFilter,
        bloomFilterTimestamp: currentTimestamp
      });
      console.log(`🌸 BloomFilter mis à jour et sauvegardé`);
      
    } else {
      const text = await response.text();
      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      plainLists[type] = new Set(urls);
      
      if (type === 'exceptions') {
        exceptions = plainLists[type];
        console.log(`🚫 Liste d'exceptions mise à jour avec ${exceptions.size} éléments`);
      }
      
      await browser.storage.local.set({ 
        [`plainList_${type}`]: Array.from(plainLists[type]),
        [`plainList_${type}_timestamp`]: currentTimestamp
      });
      
      console.log(`📋 Liste ${type} mise à jour avec ${urls.length} éléments`);
    }

    // Notifier l'interface admin si elle est ouverte
    try {
      await browser.runtime.sendMessage({
        action: 'updateListCount',
        type: type,
        count: plainLists[type] ? plainLists[type].size : 0,
        timestamp: currentTimestamp
      });
    } catch (error) {
      // Ignorer les erreurs de message (interface admin pas ouverte)
    }

  } catch (error) {
    console.error(`❌ Échec de mise à jour de la liste ${type}:`, error.message);
    
    // Retry logic
    if (retryCount < maxRetries && error.name !== 'AbortError') {
      console.log(`🔄 Tentative de retry pour ${type} dans 5 secondes...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return updateList(type, retryCount + 1);
    } else {
      console.error(`💀 Abandon de la mise à jour pour ${type} après ${retryCount + 1} tentatives`);
    }
  }
}

// CORRECTION 4: Mise à jour de toutes les listes avec gestion d'erreurs améliorée
async function updateAllLists() {
  console.log('🔄 Début mise à jour de toutes les listes...');
  
  const updatePromises = Object.keys(LIST_CONFIGS).map(async (type) => {
    try {
      await updateList(type);
      return { type, success: true };
    } catch (error) {
      console.error(`Erreur lors de la mise à jour de ${type}:`, error);
      return { type, success: false, error: error.message };
    }
  });
  
  const results = await Promise.allSettled(updatePromises);
  
  // Log des résultats
  results.forEach((result, index) => {
    const type = Object.keys(LIST_CONFIGS)[index];
    if (result.status === 'fulfilled' && result.value.success) {
      console.log(`✅ ${type}: succès`);
    } else {
      console.log(`❌ ${type}: échec`);
    }
  });
  
  // Sauvegarder le timestamp même si certaines listes ont échoué
  const updateTime = new Date().toLocaleString();
  await browser.storage.local.set({ 
    lastListUpdate: Date.now(),
    lastListUpdateFormatted: updateTime 
  });
  
  console.log('📊 État final des listes:');
  Object.entries(plainLists).forEach(([type, list]) => {
    console.log(`- ${type}: ${list ? list.size : 'non initialisé'} éléments`);
  });
}

// CORRECTION 5: Gestionnaire d'événements amélioré avec réinitialisation
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 Message reçu:', message.action);
  
  // Toujours réinitialiser les variables au début
  const handleMessage = async () => {
    // S'assurer que les variables sont initialisées
    if (!isInitialized) {
      console.log('🔄 Variables non initialisées, réinitialisation...');
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
        console.error('Erreur lors de la mise à jour de la liste:', error);
        return { success: false, error: error.message };
      }
    }
    else if (message.action === 'updateAllLists') {
      console.log('🔄 Demande de mise à jour manuelle des listes');
      await updateAllLists();
      return { success: true };
    }
    else if (message.action === "contentScriptReady" && sender.tab) {
      console.log('✅ Content script prêt dans:', sender.tab.url);
      setTimeout(() => checkUrl(sender.tab.id, sender.tab.url), 100);
      return { received: true };
    }
    else if (message.action === "pageRevisited" && sender.tab) {
      console.log('🔄 Page revisitée signalée:', sender.tab.url);
      setTimeout(() => checkUrl(sender.tab.id, sender.tab.url), 100);
      return { received: true };
    }
    
    return undefined;
  };

  // Exécuter de manière asynchrone et retourner une promesse
  handleMessage()
    .then(sendResponse)
    .catch(error => {
      console.error("Erreur dans le traitement du message:", error);
      sendResponse({error: error.message});
    });
  
  return true; // Indique que la réponse sera envoyée de manière asynchrone
});

// CORRECTION 6: Amélioration des listeners d'événements
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && 
      !tab.url.startsWith('about:') && 
      !tab.url.startsWith('moz-extension://') && 
      !tab.url.startsWith('chrome-extension://')) {
    
    console.log('🔄 Onglet mis à jour vers:', tab.url);
    
    // S'assurer que les variables sont initialisées
    if (!isInitialized) {
      await reinitializeVariables();
    }
    
    setTimeout(() => checkUrl(tabId, tab.url), 200);
  }
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    console.log('🔄 Onglet activé:', tab.url);
    
    if (tab.url && 
        !tab.url.startsWith('about:') && 
        !tab.url.startsWith('moz-extension://') && 
        !tab.url.startsWith('chrome-extension://')) {
      
      // S'assurer que les variables sont initialisées
      if (!isInitialized) {
        await reinitializeVariables();
      }
      
      setTimeout(() => checkUrl(activeInfo.tabId, tab.url), 200);
    }
  } catch (error) {
    console.error('Erreur lors de la gestion d\'activation d\'onglet:', error);
  }
});

// CORRECTION 7: Initialisation au démarrage et réveil du service worker
browser.runtime.onStartup.addListener(async () => {
  console.log('🚀 Extension démarrée');
  await initializeExtension();
});

browser.runtime.onInstalled.addListener(async (details) => {
  console.log('🔧 Extension installée/mise à jour:', details.reason);
  await initializeExtension();
  
  // Configurer l'alarme
  await browser.alarms.create('listUpdateAlarm', {
    periodInMinutes: 60
  });
});

// CORRECTION 8: Gestion améliorée des alarmes
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'listUpdateAlarm') {
    console.log('⏰ Alarme de mise à jour déclenchée');
    
    // Réinitialiser les variables avant la vérification
    await reinitializeVariables();
    
    const { lastListUpdate } = await browser.storage.local.get('lastListUpdate');
    const now = Date.now();
    
    if (!lastListUpdate || (now - lastListUpdate > 24 * 60 * 60 * 1000)) {
      console.log('⬇️ Mise à jour automatique déclenchée par l\'alarme');
      await updateAllLists();
    } else {
      console.log('⏭️ Pas de mise à jour nécessaire (< 24h)');
    }
  }
});

// Fonctions restantes (getListCount, cleanUrl, checkUrl) restent identiques
function getListCount(type) {
  if (LIST_CONFIGS[type].type === 'bloom') {
    if (bloomFilter) {
      try {
        const jsonString = JSON.stringify(bloomFilter);
        const fileSizeInBytes = new Blob([jsonString]).size;
        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
        return { count: `${fileSizeInKo} ko` };
      } catch (error) {
        console.error('Erreur lors du calcul de la taille:', error);
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
    console.error('Error cleaning URL:', error);
    return null;
  }
}

async function checkUrl(tabId, url, retry = 0) {
  // S'assurer que les variables sont initialisées
  if (!isInitialized) {
    console.log('🔄 Variables non initialisées, réinitialisation avant vérification URL...');
    await reinitializeVariables();
  }
  
  if (!url) {
    console.log('❌ Pas d\'URL fournie');
    return;
  }

  const cleanedUrl = cleanUrl(url);
  if (!cleanedUrl) {
    console.log('❌ URL nettoyée invalide:', url);
    return;
  }

  console.log('🔍 Vérification URL:', cleanedUrl);

  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status !== 'complete') {
      if (retry < 3) {
        console.log(`⏳ Tab non prêt (${tab.status}), tentative ${retry + 1}/3`);
        setTimeout(() => checkUrl(tabId, url, retry + 1), 500);
        return;
      }
    }
  } catch (error) {
    console.error('❌ Erreur lors de la vérification de l\'état de l\'onglet:', error);
    return;
  }

  // Vérifier si les listes ont des données
  const listsHaveData = Object.values(plainLists).some(list => list && list.size > 0);
  if (!listsHaveData && !bloomFilter) {
    console.log('📥 Listes vides détectées, forçage mise à jour...');
    await updateAllLists();
  }

  const config = await browser.storage.local.get('enabledLists');
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
    try {
      await browser.tabs.sendMessage(tabId, {
        action: "showNotification",
        matches: matches
      });
    } catch (error) {
      console.warn('⚠️ Erreur lors de l\'envoi de la notification:', error);
      setTimeout(async () => {
        try {
          await browser.tabs.sendMessage(tabId, {
            action: "showNotification",
            matches: matches
          });
        } catch (retryError) {
          console.error('❌ Échec de l\'envoi de notification après retry:', retryError);
        }
      }, 1000);
    }
  }
}

// Initialisation immédiate
initializeExtension();