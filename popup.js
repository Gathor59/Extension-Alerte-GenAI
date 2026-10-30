// ── i18n: module partagé i18n.js (chargé avant ce script) ───────────────────
const t = (key, vars) => NxI18n.t(key, vars);
const applyTranslations = () => NxI18n.applyTranslations(document);
// ─────────────────────────────────────────────────────────────────────────────

// Ne garde que domaine + chemin pour pré-remplir le signalement (http/https uniquement)
function stripUrlForReport(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.href;
  } catch (e) {
    return rawUrl;
  }
}

let isSubmitting = false;

// Adresse de contact utilisée quand l'envoi d'un signalement échoue (une seule définition pour tout le popup)
const REPORT_CONTACT_EMAIL = 'genai@next.ink';

// Construit le lien mailto: avec l'URL et le motif déjà saisis, bornés (certains clients tronquent les liens trop longs)
function buildContactMailto({ url, reason } = {}) {
  const clip = (s, n) => String(s || '').slice(0, n);
  const lines = [t('popup.report_form.mail_body_intro')];
  if (url) lines.push(t('popup.report_form.mail_body_url', { url: clip(url, 300) }));
  if (reason) lines.push(t('popup.report_form.mail_body_reason', { reason: clip(reason, 800) }));
  return 'mailto:' + REPORT_CONTACT_EMAIL +
    '?subject=' + encodeURIComponent(t('popup.report_form.mail_subject')) +
    '&body=' + encodeURIComponent(lines.join('\n\n'));
}

// Affiche l'encadré de contact À LA PLACE du formulaire (le popup est déjà à sa hauteur maximale: pas de place pour les deux)
function showContactFallback(details) {
  const box = document.getElementById('contactFallback');
  const fields = document.getElementById('reportFields');
  const link = document.getElementById('contactMailLink');
  if (!box || !link) return;
  link.href = buildContactMailto(details);
  link.textContent = REPORT_CONTACT_EMAIL;
  if (fields) fields.hidden = true;
  box.hidden = false;
}

// Remet le formulaire (avec ce que l'utilisateur a saisi) et masque l'encadré
function hideContactFallback() {
  const box = document.getElementById('contactFallback');
  const fields = document.getElementById('reportFields');
  if (box) box.hidden = true;
  if (fields) fields.hidden = false;
}

document.addEventListener('DOMContentLoaded', async () => {
  await NxI18n.init();
  applyTranslations();
  // Réinitialiser les flags de notification pour permettre de nouvelles notifications
  browser.storage.local.set({
    notificationAlreadySent: false,
    notificationOutdatedSent: false
  }).catch(() => {
    // Silently fail - not critical
  });

  // Get current URL (sans paramètres, fragment ni identifiants: ils peuvent contenir des jetons)
  browser.tabs.query({active: true, currentWindow: true})
    .then(tabs => {
      document.getElementById('siteUrl').value = stripUrlForReport(tabs[0].url);
    })
    .catch(() => {
      // Silently fail - not critical
    });

  // Load and display statistics
  loadStatistics();

  // Check for update errors and display alert
  checkUpdateErrors();

  // Le téléchargement des listes peut se terminer après l'ouverture du popup (première installation,
  // CDN lent): on réaffiche dès que les chiffres ou les erreurs changent, sinon "0 sites" resterait affiché.
  // Seules les clés utiles sont écoutées: le popup écrit lui-même dans le stockage à l'ouverture.
  const WATCHED = ['bloomFilterMetadata', 'bloomFilterEnMetadata', 'updateErrors'];
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !WATCHED.some(k => k in changes)) return;
    loadStatistics();
    checkUpdateErrors();
  });

  const form = document.getElementById('reportForm');
  const submitButton = document.querySelector('button[type="submit"]');

  form.addEventListener('submit', handleSubmit);

  // "Réessayer": on réaffiche le formulaire tel qu'il était (rien n'est vidé), l'utilisateur renvoie en un clic
  const retryButton = document.getElementById('contactRetry');
  if (retryButton) retryButton.addEventListener('click', hideContactFallback);

  // Open options page
  const openOptionsButton = document.getElementById('openOptionsButton');
  if (openOptionsButton) {
    openOptionsButton.addEventListener('click', (e) => {
      e.preventDefault();
      browser.runtime.openOptionsPage();
    });
  }

  // Open enquête link in new tab
  const enqueteLink = document.getElementById('enqueteLink');
  if (enqueteLink) {
    enqueteLink.addEventListener('click', (e) => {
      e.preventDefault();
      browser.tabs.create({ url: e.target.href });
    });
  }

  // Touch feedback for mobile - Submit button
  submitButton.addEventListener('touchstart', () => {
    submitButton.style.backgroundColor = '#3d8b40';
  });

  submitButton.addEventListener('touchend', () => {
    submitButton.style.backgroundColor = '';
  });

  // Touch feedback for mobile - Options button
  if (openOptionsButton) {
    openOptionsButton.addEventListener('touchstart', () => {
      openOptionsButton.style.backgroundColor = '#0b7dda';
    });

    openOptionsButton.addEventListener('touchend', () => {
      openOptionsButton.style.backgroundColor = '';
    });
  }

  // Prevent zoom on mobile inputs
  const inputs = document.querySelectorAll('input, select, textarea');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      input.style.fontSize = '16px';
    });
  });
});

// Fonction pour charger et afficher les statistiques
async function loadStatistics() {
  const statsElement = document.getElementById('statsInfo');

  try {
    const storage = await browser.storage.local.get([
      'bloomFilterMetadata',
      'bloomFilterEnMetadata'
    ]);

    // Total des sites de la liste GenAI = liste francophone + liste anglophone
    const count = (meta) => (Number.isFinite(meta?.numElements) ? meta.numElements : 0);
    const frCount = count(storage.bloomFilterMetadata);
    const genaiTotal = frCount + count(storage.bloomFilterEnMetadata);

    // Formater avec séparateurs de milliers (espace insécable)
    const formatNumber = (num) => num.toLocaleString('fr-FR');

    // Sans liste française chargée, "dont 0 en français" serait faux: on garde la phrase simple
    const key = frCount > 0 ? 'popup.stats_text' : 'popup.stats_text_total_only';
    statsElement.textContent = t(key, { genai: formatNumber(genaiTotal), fr: formatNumber(frCount) });
  } catch (error) {
    statsElement.textContent = t('popup.stats_loading_error');
  }
}

// Fonction pour vérifier et afficher les erreurs de mise à jour
async function checkUpdateErrors() {
  try {
    const storage = await browser.storage.local.get(['updateErrors']);
    const alertDiv = document.getElementById('errorAlert');
    const errorsList = document.getElementById('errorList');

    if (storage.updateErrors && Object.keys(storage.updateErrors).length > 0) {
      errorsList.replaceChildren();

      for (const [type, error] of Object.entries(storage.updateErrors)) {
        const li = document.createElement('li');
        let listName = '';

        switch(type) {
          case 'genai':
            listName = t('popup.list_names.genai');
            break;
          case 'redflag':
            listName = t('popup.list_names.redflag');
            break;
          case 'amf':
            listName = t('popup.list_names.amf');
            break;
          case 'dgccrf':
            listName = t('popup.list_names.dgccrf');
            break;
          case 'exceptions':
            listName = t('popup.list_names.exceptions');
            break;
          default:
            listName = type;
        }

        li.textContent = listName;
        errorsList.appendChild(li);
      }

      alertDiv.style.display = 'block';
    } else {
      alertDiv.style.display = 'none';
    }
  } catch (error) {
    // Silently fail - non-critical
  }
}

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
      'plainList_dgccrf_timestamp',
      'plainList_exceptions_timestamp',
      'lastListUpdate'
    ]);

    return {
      bloomFilter: storage.bloomFilterTimestamp ? new Date(storage.bloomFilterTimestamp).toISOString() : null,
      redflag: storage.plainList_redflag_timestamp ? new Date(storage.plainList_redflag_timestamp).toISOString() : null,
      amf: storage.plainList_amf_timestamp ? new Date(storage.plainList_amf_timestamp).toISOString() : null,
      dgccrf: storage.plainList_dgccrf_timestamp ? new Date(storage.plainList_dgccrf_timestamp).toISOString() : null,
      exceptions: storage.plainList_exceptions_timestamp ? new Date(storage.plainList_exceptions_timestamp).toISOString() : null,
      lastGlobalUpdate: storage.lastListUpdate ? new Date(storage.lastListUpdate).toISOString() : null
    };
  } catch (error) {
    return null;
  }
}

// Fonction pour récupérer les tailles des listes
async function getListSizes() {
  try {
    const storage = await browser.storage.local.get([
      'bloomFilter',
      'bloomFilterMetadata',
      'plainList_redflag',
      'plainList_amf',
      'plainList_dgccrf',
      'plainList_exceptions'
    ]);

    const sizes = {};

    // Nombre d'éléments du bloom filter depuis les métadonnées
    if (storage.bloomFilterMetadata && storage.bloomFilterMetadata.expectedElements) {
      sizes.bloomFilter = t('popup.sizes.elements', { count: storage.bloomFilterMetadata.expectedElements });
      sizes.bloomFilterMetadata = storage.bloomFilterMetadata;
    } else if (storage.bloomFilter) {
      sizes.bloomFilter = t('popup.sizes.metadata_unavailable');
      if (storage.bloomFilterMetadata) {
        sizes.bloomFilterMetadata = storage.bloomFilterMetadata;
      }
    } else {
      sizes.bloomFilter = t('popup.sizes.not_loaded');
    }

    // Tailles des listes plain text (nombre d'éléments)
    sizes.redflag = storage.plainList_redflag ? t('popup.sizes.elements', { count: storage.plainList_redflag.length }) : t('popup.sizes.elements', { count: 0 });
    sizes.amf = storage.plainList_amf ? t('popup.sizes.elements', { count: storage.plainList_amf.length }) : t('popup.sizes.elements', { count: 0 });
    sizes.dgccrf = storage.plainList_dgccrf ? t('popup.sizes.elements', { count: storage.plainList_dgccrf.length }) : t('popup.sizes.elements', { count: 0 });
    sizes.exceptions = storage.plainList_exceptions ? t('popup.sizes.elements', { count: storage.plainList_exceptions.length }) : t('popup.sizes.elements', { count: 0 });

    return sizes;
  } catch (error) {
    return null;
  }
}

// Fonction pour récupérer la version de l'extension
function getExtensionVersion() {
  try {
    const manifest = browser.runtime.getManifest();
    return manifest.version;
  } catch (error) {
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
  
  let sendFailed = false;
  let lastReport = null;
  try {
    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = t('popup.report_form.submit_sending');

    // Récupération des valeurs du formulaire
    const siteUrlElement = document.getElementById('siteUrl');
    const emailElement = document.getElementById('email');
    const descriptionElement = document.getElementById('description');

    if (!siteUrlElement || !emailElement || !descriptionElement) {
      throw new Error(t('errors.form_elements_missing'));
    }

    const siteUrl = siteUrlElement.value.trim();
    const email = emailElement.value.trim();
    const description = descriptionElement.value.trim();

    if (!description) {
      showError(t('popup.report_form.error_reason_required'));
      return false;
    }

    // Récupération des métadonnées
    const [browserInfo, listVersions, listSizes] = await Promise.all([
      getBrowserInfo(),
      getListVersions(),
      getListSizes()
    ]);

    const extensionVersion = getExtensionVersion();

    const report = {
      url: siteUrl,
      email: email,
      description: description,
      timestamp: new Date().toISOString(),
      status: 'pending',
      // Nouvelles métadonnées
      extension_version: extensionVersion,
      browser_info: JSON.stringify(browserInfo),
      list_versions: JSON.stringify(listVersions),
      list_sizes: JSON.stringify(listSizes)
    };

    lastReport = report;
    sendFailed = false;

    // Hors ligne: le rapport est prêt mais l'envoi est impossible, donc c'est un échec d'envoi (encadré e-mail affiché)
    if (!navigator.onLine) {
      sendFailed = true;
      throw new Error(t('errors.offline'));
    }

    try {
      await sendReport(report);
    } catch (sendError) {
      sendFailed = true;
      throw sendError;
    }
    hideContactFallback();
    
    // Show success and close popup
    successMessage.style.display = 'block';
    successMessage.textContent = t('popup.report_form.submit_success');
    document.getElementById('reportForm').reset();

    // Close popup after brief delay
    setTimeout(() => {
      successMessage.style.opacity = '0';
      successMessage.style.transition = 'opacity 0.5s ease';
      setTimeout(() => window.close(), 500);
    }, 2000);

  } catch (error) {
    // Un échec d'ENVOI (réseau, serveur, certificat, délai, code HTTP) affiche l'encadré persistant avec l'adresse e-mail.
    // Les autres erreurs (formulaire introuvable...) restent un simple message temporaire.
    if (sendFailed) {
      showContactFallback({ url: lastReport && lastReport.url, reason: lastReport && lastReport.description });
    } else {
      showError(getErrorMessage(error));
    }
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = t('popup.report_form.submit_button');
  }

  return false;
}

function getErrorMessage(error) {
  if (!navigator.onLine) {
    return t('popup.report_form.error_network');
  }
  if (error.name === 'TypeError') {
    return t('popup.report_form.error_server');
  }
  return t('popup.report_form.error_generic', { message: error.message });
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
    const response = await fetch('https://genai.gavois.fr:42001/api/reports', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(report),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(t('errors.http_error', { status: response.status }));
    }

    const result = await response.json();

    return result;

  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error(t('popup.error_timeout'));
    }
    
    throw error;
  }
}