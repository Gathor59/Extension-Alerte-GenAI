let isSubmitting = false;

document.addEventListener('DOMContentLoaded', () => {
  // Get current URL
  browser.tabs.query({active: true, currentWindow: true})
    .then(tabs => {
      document.getElementById('siteUrl').value = tabs[0].url;
    })
    .catch(() => {
      // Silently fail - not critical
    });

  const form = document.getElementById('reportForm');
  const submitButton = document.querySelector('button[type="submit"]');

  form.addEventListener('submit', handleSubmit);
  
  // Touch feedback for mobile
  submitButton.addEventListener('touchstart', () => {
    submitButton.style.backgroundColor = '#3d8b40';
  });
  
  submitButton.addEventListener('touchend', () => {
    submitButton.style.backgroundColor = '';
  });

  // Prevent zoom on mobile inputs
  const inputs = document.querySelectorAll('input, select, textarea');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      input.style.fontSize = '16px';
    });
  });
});

// Fonction pour récupérer les informations du navigateur (simplifiées)
function getBrowserInfo() {
  const userAgent = navigator.userAgent;
  let browserName = 'Unknown';
  let browserVersion = 'Unknown';

  if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
    browserName = 'Chrome';
    const match = userAgent.match(/Chrome\/(\d+\.\d+)/);
    browserVersion = match ? match[1] : 'Unknown';
  } else if (userAgent.includes('Edg')) {
    browserName = 'Edge';
    const match = userAgent.match(/Edg\/(\d+\.\d+)/);
    browserVersion = match ? match[1] : 'Unknown';
  } else if (userAgent.includes('Firefox')) {
    browserName = 'Firefox';
    const match = userAgent.match(/Firefox\/(\d+\.\d+)/);
    browserVersion = match ? match[1] : 'Unknown';
  } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
    browserName = 'Safari';
    const match = userAgent.match(/Version\/(\d+\.\d+)/);
    browserVersion = match ? match[1] : 'Unknown';
  }

  // Retourner seulement nom et version
  return {
    name: browserName,
    version: browserVersion
  };
}

// Fonction pour récupérer les versions des listes depuis le storage
async function getListVersions() {
  try {
    const storage = await browser.storage.local.get([
      'bloomFilterTimestamp',
      'plainList_redflag_timestamp',
      'plainList_amf_timestamp',
      'plainList_exceptions_timestamp',
      'lastListUpdate'
    ]);

    return {
      bloomFilter: storage.bloomFilterTimestamp ? new Date(storage.bloomFilterTimestamp).toISOString() : null,
      redflag: storage.plainList_redflag_timestamp ? new Date(storage.plainList_redflag_timestamp).toISOString() : null,
      amf: storage.plainList_amf_timestamp ? new Date(storage.plainList_amf_timestamp).toISOString() : null,
      exceptions: storage.plainList_exceptions_timestamp ? new Date(storage.plainList_exceptions_timestamp).toISOString() : null,
      lastGlobalUpdate: storage.lastListUpdate ? new Date(storage.lastListUpdate).toISOString() : null
    };
  } catch (error) {
    console.error('Erreur récupération versions des listes:', error);
    return null;
  }
}

// Fonction pour récupérer les tailles des listes
async function getListSizes() {
  try {
    const storage = await browser.storage.local.get([
      'bloomFilter',
      'plainList_redflag',
      'plainList_amf',
      'plainList_exceptions'
    ]);

    const sizes = {};

    // Taille du bloom filter (en Ko)
    if (storage.bloomFilter) {
      try {
        const jsonString = JSON.stringify(storage.bloomFilter);
        const fileSizeInBytes = new Blob([jsonString]).size;
        sizes.bloomFilter = `${(fileSizeInBytes / 1024).toFixed(2)} Ko`;
      } catch (error) {
        sizes.bloomFilter = 'Erreur calcul';
      }
    } else {
      sizes.bloomFilter = 'Non chargé';
    }

    // Tailles des listes plain text (nombre d'éléments)
    sizes.redflag = storage.plainList_redflag ? `${storage.plainList_redflag.length} éléments` : '0 éléments';
    sizes.amf = storage.plainList_amf ? `${storage.plainList_amf.length} éléments` : '0 éléments';
    sizes.exceptions = storage.plainList_exceptions ? `${storage.plainList_exceptions.length} éléments` : '0 éléments';

    return sizes;
  } catch (error) {
    console.error('Erreur récupération tailles des listes:', error);
    return null;
  }
}

// Fonction pour récupérer la version de l'extension
function getExtensionVersion() {
  try {
    const manifest = browser.runtime.getManifest();
    return manifest.version;
  } catch (error) {
    console.error('Erreur récupération version extension:', error);
    return 'Unknown';
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  e.stopPropagation();

  if (isSubmitting) {
    return false;
  }

  const submitButton = document.querySelector('button[type="submit"]');
  const successMessage = document.getElementById('successMessage');
  
  try {
    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Envoi en cours...';

    // Récupération des valeurs du formulaire
    const siteUrlElement = document.getElementById('siteUrl');
    const emailElement = document.getElementById('email');
    const categoryElement = document.getElementById('category');
    const descriptionElement = document.getElementById('description');

    if (!siteUrlElement || !emailElement || !categoryElement || !descriptionElement) {
      throw new Error('Éléments du formulaire non trouvés');
    }

    const siteUrl = siteUrlElement.value.trim();
    const email = emailElement.value.trim();
    const category = categoryElement.value;
    const description = descriptionElement.value.trim();

    // Récupération des métadonnées
    console.log('Récupération des métadonnées...');
    const [browserInfo, listVersions, listSizes] = await Promise.all([
      getBrowserInfo(),
      getListVersions(),
      getListSizes()
    ]);

    const extensionVersion = getExtensionVersion();

    console.log('Métadonnées récupérées:', {
      extensionVersion,
      browserInfo,
      listVersions,
      listSizes
    });

    const report = {
      url: siteUrl,
      email: email,
      category: category,
      description: description,
      timestamp: new Date().toISOString(),
      status: 'pending',
      // Nouvelles métadonnées
      extension_version: extensionVersion,
      browser_info: JSON.stringify(browserInfo),
      list_versions: JSON.stringify(listVersions),
      list_sizes: JSON.stringify(listSizes)
    };

    console.log('Objet report final:', report);

    if (!navigator.onLine) {
      throw new Error('Pas de connexion Internet');
    }

    await sendReport(report);
    
    // Show success and close popup
    successMessage.style.display = 'block';
    successMessage.textContent = 'Site signalé avec succès !';
    document.getElementById('reportForm').reset();

    // Close popup after brief delay
    setTimeout(() => {
      successMessage.style.opacity = '0';
      successMessage.style.transition = 'opacity 0.5s ease';
      setTimeout(() => window.close(), 500);
    }, 2000);

  } catch (error) {
    console.error('Erreur lors de la soumission:', error);
    showError(getErrorMessage(error));
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Signaler ce site';
  }

  return false;
}

function getErrorMessage(error) {
  if (!navigator.onLine) {
    return 'Une erreur est survenue. Vérifiez votre connexion Internet.';
  }
  
  if (error.name === 'TypeError') {
    return 'Une erreur est survenue. Impossible de contacter le serveur.';
  }
  
  return `Une erreur est survenue. ${error.message}`;
}

function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = `
    color: red;
    padding: 10px;
    margin-top: 10px;
    border-radius: 4px;
    background-color: #ffebee;
  `;
  errorDiv.textContent = message;
  
  document.getElementById('reportForm').appendChild(errorDiv);
  
  setTimeout(() => errorDiv.remove(), 5000);
}

async function sendReport(report) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    console.log('Envoi de la requête avec le payload:', report);
    
    const response = await fetch('https://genai.gavois.fr:42001/api/reports', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(report),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    console.log('Réponse du serveur - Status:', response.status);

    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    const result = await response.json();
    console.log('Réponse JSON du serveur:', result);
    
    return result;

  } catch (error) {
    clearTimeout(timeoutId);
    
    console.error('Erreur lors de l\'envoi:', error);
    
    if (error.name === 'AbortError') {
      throw new Error('La requête a pris trop de temps');
    }
    
    throw error;
  }
}