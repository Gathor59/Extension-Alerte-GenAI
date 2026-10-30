// ── i18n: module partagé i18n.js (chargé avant ce script) ───────────────────
const t = (key, vars) => NxI18n.t(key, vars);

function applyTranslations() {
    NxI18n.applyTranslations(document);
    document.title = t('admin.page_title');
    const current = NxI18n.getLanguage();
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === current);
    });
}

async function setLanguage(lang) {
    await NxI18n.setLanguage(lang);
    applyTranslations();
    if (window.refreshDynamicTexts) await window.refreshDynamicTexts();
}

// Génère un bouton par langue déclarée dans locales/index.json
async function buildLanguageSwitcher() {
    const container = document.getElementById('lang-switcher');
    if (!container) return;
    const languages = await NxI18n.getLanguages();
    container.replaceChildren();
    if (languages.length < 2) return;
    for (const lang of languages) {
        const btn = document.createElement('button');
        btn.className = 'lang-btn';
        btn.id = 'lang-' + lang.code;
        btn.dataset.lang = lang.code;
        btn.title = lang.name || lang.code;
        btn.textContent = lang.label || lang.code.toUpperCase();
        btn.addEventListener('click', () => setLanguage(lang.code));
        container.appendChild(btn);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    const listTypes = ['genai', 'bloom_en', 'redflag', 'amf', 'dgccrf', 'exceptions', 'idn_homograph'];
    const statusElement = document.getElementById('status');

    // Init langue (module partagé i18n.js)
    await NxI18n.init();
    await buildLanguageSwitcher();
    applyTranslations();

    // Load initial state of lists
    async function loadListStates() {
        try {
            const storageData = await browser.storage.local.get('enabledLists');
            const enabledLists = storageData.enabledLists || {
                'genai': true,
                'bloom_en': true,
                'redflag': true,
                'amf': true,
                'dgccrf': true,
                'exceptions': true,
                'idn_homograph': true
            };
            
            if (!storageData.enabledLists) {
                await browser.storage.local.set({ enabledLists });
            }
            
            listTypes.forEach(type => {
                const toggle = document.getElementById(`${type}-toggle`);
                if (toggle) {
                    toggle.checked = enabledLists[type] !== false;
                }
            });
        } catch (error) {
            showStatus(t('admin.list_load_error'), false);
        }
    }

    // Update list count display
    async function updateListCount(type) {
        try {
            const countElement = document.getElementById(`${type}-count`);
            const dateElement = document.getElementById(`${type}-date`);
            const metadataElement = document.getElementById(`${type}-metadata`);

            if (!countElement) {
                return;
            }

            const storageData = await browser.storage.local.get(null);
            let count = 0;
            let timestamp = null;
            let metadata = null;

            if (type === 'genai') {
                if (storageData.bloomFilter) {
                    try {
                        // Récupérer les métadonnées
                        metadata = storageData.bloomFilterMetadata;

                        // Afficher le nombre d'éléments depuis les métadonnées
                        if (metadata && metadata.numElements) {
                            count = metadata.numElements;
                        } else {
                            // Fallback sur la taille du fichier si pas de métadonnées
                            const jsonString = JSON.stringify(storageData.bloomFilter);
                            const fileSizeInBytes = new Blob([jsonString]).size;
                            const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
                            count = t('admin.list_size_no_metadata', { size: fileSizeInKo });
                        }
                    } catch (error) {
                        count = t('admin.list_count_error');
                    }
                }
                timestamp = storageData.bloomFilterTimestamp;
            } else if (type === 'bloom_en') {
                if (storageData.bloomFilterEn) {
                    try {
                        metadata = storageData.bloomFilterEnMetadata;

                        if (metadata && metadata.numElements) {
                            count = metadata.numElements;
                        } else {
                            const jsonString = JSON.stringify(storageData.bloomFilterEn);
                            const fileSizeInBytes = new Blob([jsonString]).size;
                            const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
                            count = t('admin.list_size_no_metadata', { size: fileSizeInKo });
                        }
                    } catch (error) {
                        count = t('admin.list_count_error');
                    }
                }
                timestamp = storageData.bloomFilterEnTimestamp;
            } else if (type === 'idn_homograph') {
                // Pour la détection IDN, afficher "Détection locale" et la date d'installation
                count = t('admin.lists.idn_homograph.count_local');
                timestamp = Date.now(); // Toujours actif
            } else {
                const listKey = `plainList_${type}`;
                if (storageData[listKey] && Array.isArray(storageData[listKey])) {
                    count = storageData[listKey].length;
                }
                timestamp = storageData[`plainList_${type}_timestamp`];
            }

            countElement.textContent = count;

            if (dateElement) {
                if (timestamp) {
                    const date = new Date(timestamp);
                    dateElement.textContent = date.toLocaleString();
                } else {
                    dateElement.textContent = t('admin.list_date_never');
                }
            }

            // Afficher les métadonnées si disponibles (sans le nombre d'éléments déjà affiché)
            if (metadataElement && metadata) {
                let metadataText = '';
                if (metadata.createdAt) {
                    const createdDate = new Date(metadata.createdAt);
                    metadataText += t('admin.list_created_on', { date: createdDate.toLocaleString() });
                }
                metadataElement.textContent = metadataText;
                metadataElement.style.display = metadataText ? 'block' : 'none';
            }

        } catch (error) {
            const countElement = document.getElementById(`${type}-count`);
            if (countElement) {
                countElement.textContent = t('admin.list_count_error');
            }
        }
    }

    // Display last global update time
    window.displayLastUpdateTime = async function() {
        try {
            const storageData = await browser.storage.local.get(['lastListUpdateFormatted', 'lastListUpdate']);
            const lastUpdateElement = document.getElementById('last-update-time');
            
            if (lastUpdateElement) {
                if (storageData.lastListUpdateFormatted) {
                    lastUpdateElement.textContent = t('admin.list_last_global_update', { date: storageData.lastListUpdateFormatted });
                } else if (storageData.lastListUpdate) {
                    const date = new Date(storageData.lastListUpdate);
                    lastUpdateElement.textContent = t('admin.list_last_global_update', { date: date.toLocaleString() });
                } else {
                    lastUpdateElement.textContent = t('admin.list_no_global_update');
                }
            }
        } catch (error) {
            // Silently fail - non-critical
        }
    }

    // Show status message
    function showStatus(message, isSuccess = true) {
        statusElement.textContent = message;
        statusElement.className = isSuccess ? 'status-success' : 'status-error';
        
        setTimeout(() => {
            statusElement.textContent = '';
            statusElement.className = '';
        }, 3000);
    }

    // Toggle list state
    async function toggleList(type, enabled) {
        try {
            const result = await browser.runtime.sendMessage({
                action: 'toggleList',
                type: type,
                enabled: enabled
            });

            if (result && result.success) {
                showStatus(t(enabled ? 'admin.list_enabled' : 'admin.list_disabled', { type }), true);
            } else {
                showStatus(t('admin.list_toggle_error', { type }), false);
            }
        } catch (error) {
            showStatus(t('admin.list_comm_error', { message: error.message }), false);
        }
    }

    // Add event listeners to toggles
    listTypes.forEach(type => {
        const toggle = document.getElementById(`${type}-toggle`);
        if (toggle) {
            toggle.addEventListener('change', (event) => {
                toggleList(type, event.target.checked);
            });
        }
    });

    // Manual update function
    window.updateLists = async function() {
        try {
            showStatus(t('admin.list_update_running'), true);

            const result = await browser.runtime.sendMessage({ action: 'updateAllLists' });

            // Wait for update completion
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Refresh counters
            for (const type of listTypes) {
                await updateListCount(type);
            }

            await window.displayLastUpdateTime();
            await checkAndDisplayUpdateErrors(); // Afficher les erreurs s'il y en a
            showStatus(t('admin.list_update_done'), true);

        } catch (error) {
            showStatus(t('admin.list_update_error'), false);
        }
    }

    // Add update button event listener
    const updateButton = document.getElementById('update-lists');
    if (updateButton) {
        updateButton.addEventListener('click', window.updateLists);
    }

    // Listen for real-time updates
    browser.runtime.onMessage.addListener(async (message) => {
        if (message.action === 'updateListCount') {
            await updateListCount(message.type);
        }
    });

    // Check and display update errors
    async function checkAndDisplayUpdateErrors() {
        try {
            const storage = await browser.storage.local.get(['updateErrors']);
            const alertDiv = document.getElementById('update-errors-alert');
            const errorsList = document.getElementById('update-errors-list');

            if (storage.updateErrors && Object.keys(storage.updateErrors).length > 0) {
                // Construit avec le DOM: le type et le message (venant du réseau) ne sont jamais analysés comme du HTML
                const ul = document.createElement('ul');
                ul.style.cssText = 'margin: 10px 0; padding-left: 20px;';
                for (const [type, error] of Object.entries(storage.updateErrors)) {
                    const li = document.createElement('li');
                    const strong = document.createElement('strong');
                    strong.textContent = type;
                    const errorDate = new Date(error.timestamp).toLocaleString();
                    li.append(strong, `: ${String(error.message).slice(0, 300)} (${errorDate})`);
                    ul.appendChild(li);
                }
                errorsList.replaceChildren(ul);
                alertDiv.style.display = 'block';
            } else {
                alertDiv.style.display = 'none';
            }
        } catch (error) {
            // Erreur lors de la vérification des erreurs de mise à jour
        }
    }

    // Retraduit les textes calculés en JavaScript (les [data-i18n] sont déjà gérés par applyTranslations)
    window.refreshDynamicTexts = async function() {
        for (const type of listTypes) {
            await updateListCount(type);
        }
        await window.displayLastUpdateTime();
        await checkAndDisplayUpdateErrors();
        await loadIgnoredSites();
    };

    // Initialize
    await loadListStates();

    for (const type of listTypes) {
        await updateListCount(type);
    }

    await window.displayLastUpdateTime();
    await updateAlertStats();
    await checkAndDisplayUpdateErrors();

    // Charger et afficher les sites ignorés
    await loadIgnoredSites();

    // Gérer le bouton d'effacement des sites ignorés
    const clearIgnoredBtn = document.getElementById('clear-ignored-btn');
    if (clearIgnoredBtn) {
        clearIgnoredBtn.addEventListener('click', async () => {
            if (confirm(t('admin.ignored_sites_confirm_clear'))) {
                await clearAllIgnoredSites();
            }
        });
    }

    // Gérer le bouton "Signaler mon problème"
    const showErrorReportBtn = document.getElementById('show-error-report-form');
    const errorReportForm = document.getElementById('error-report-form');
    const sendErrorReportBtn = document.getElementById('send-error-report');

    if (showErrorReportBtn) {
        showErrorReportBtn.addEventListener('click', () => {
            if (errorReportForm.style.display === 'none') {
                errorReportForm.style.display = 'block';
                showErrorReportBtn.textContent = t('admin.error_report_hide_button');
            } else {
                errorReportForm.style.display = 'none';
                showErrorReportBtn.textContent = t('admin.error_report_show_button');
            }
        });
    }

    if (sendErrorReportBtn) {
        sendErrorReportBtn.addEventListener('click', async () => {
            await handleErrorReport();
        });
    }
});


async function updateAlertStats() {
    try {
        const result = await browser.storage.local.get(['alertStats', 'todayBadgeCount']);
        const alertStats = result.alertStats || {};
        const todayBadgeCount = result.todayBadgeCount || 0;

        const today = new Date().toISOString().split('T')[0];
        const todayStats = alertStats[today] || { genai: 0, redflag: 0, amf: 0, dgccrf: 0, idn_homograph: 0 };

        // Calculer les stats pour la semaine
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        let weekTotal = 0;

        // Calculer les stats pour le mois
        const monthAgo = new Date();
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        let monthTotal = 0;

        // Calculer le total général
        let grandTotal = 0;

        for (const [date, stats] of Object.entries(alertStats)) {
            const alertDate = new Date(date);
            const dayTotal = (stats.genai || 0) + (stats.redflag || 0) + (stats.amf || 0) + (stats.dgccrf || 0) + (stats.idn_homograph || 0);

            if (alertDate >= weekAgo) {
                weekTotal += dayTotal;
            }
            if (alertDate >= monthAgo) {
                monthTotal += dayTotal;
            }
            grandTotal += dayTotal;
        }

        // Mettre à jour l'affichage
        document.getElementById('stats-today').textContent = todayBadgeCount;
        document.getElementById('stats-week').textContent = weekTotal;
        document.getElementById('stats-month').textContent = monthTotal;
        document.getElementById('stats-total').textContent = grandTotal;

        // Mettre à jour la répartition par catégorie
        document.getElementById('stats-genai-today').textContent = todayStats.genai || 0;
        document.getElementById('stats-redflag-today').textContent = todayStats.redflag || 0;
        document.getElementById('stats-amf-today').textContent = todayStats.amf || 0;
        document.getElementById('stats-dgccrf-today').textContent = todayStats.dgccrf || 0;
        document.getElementById('stats-idn_homograph-today').textContent = todayStats.idn_homograph || 0;

    } catch (error) {
        // Erreur lors de la mise à jour des statistiques
    }
}

// Fonction pour récupérer les informations du navigateur
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

    return {
        name: browserName,
        version: browserVersion
    };
}

// Fonction pour récupérer les versions des listes
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

        if (storage.bloomFilterMetadata && storage.bloomFilterMetadata.numElements) {
            sizes.bloomFilter = `${storage.bloomFilterMetadata.numElements} éléments`;
            sizes.bloomFilterMetadata = storage.bloomFilterMetadata;
        } else if (storage.bloomFilter) {
            sizes.bloomFilter = 'Métadonnées non disponibles';
            if (storage.bloomFilterMetadata) {
                sizes.bloomFilterMetadata = storage.bloomFilterMetadata;
            }
        } else {
            sizes.bloomFilter = 'Non chargé';
        }

        sizes.redflag = storage.plainList_redflag ? `${storage.plainList_redflag.length} éléments` : '0 éléments';
        sizes.amf = storage.plainList_amf ? `${storage.plainList_amf.length} éléments` : '0 éléments';
        sizes.dgccrf = storage.plainList_dgccrf ? `${storage.plainList_dgccrf.length} éléments` : '0 éléments';
        sizes.exceptions = storage.plainList_exceptions ? `${storage.plainList_exceptions.length} éléments` : '0 éléments';

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

// Fonction pour envoyer un rapport
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

// Fonction pour gérer l'envoi du rapport d'erreur
async function handleErrorReport() {
    const emailInput = document.getElementById('error-report-email');
    const sendButton = document.getElementById('send-error-report');
    const statusDiv = document.getElementById('error-report-status');

    try {
        // Désactiver le bouton pendant l'envoi
        sendButton.disabled = true;
        sendButton.textContent = t('admin.error_report_send_sending');
        statusDiv.style.display = 'none';

        // Récupérer les erreurs de mise à jour
        const storage = await browser.storage.local.get(['updateErrors']);
        const updateErrors = storage.updateErrors || {};

        // Construire la description avec les erreurs
        let description = 'Erreurs de mise à jour de l\'extension :\n\n';
        for (const [type, error] of Object.entries(updateErrors)) {
            const errorDate = new Date(error.timestamp).toLocaleString();
            description += `- ${type}: ${error.message} (${errorDate})\n`;
        }

        // Récupérer les métadonnées
        const [browserInfo, listVersions, listSizes] = await Promise.all([
            getBrowserInfo(),
            getListVersions(),
            getListSizes()
        ]);

        const extensionVersion = getExtensionVersion();

        // Construire le rapport
        const report = {
            url: 'Erreur Extension',
            email: emailInput.value.trim() || '',
            category: 'other',
            description: description,
            timestamp: new Date().toISOString(),
            status: 'pending',
            extension_version: extensionVersion,
            browser_info: JSON.stringify(browserInfo),
            list_versions: JSON.stringify(listVersions),
            list_sizes: JSON.stringify(listSizes)
        };

        // Envoyer le rapport
        await sendReport(report);

        // Afficher le succès
        statusDiv.textContent = t('admin.error_report_send_success');
        statusDiv.style.display = 'block';
        statusDiv.style.backgroundColor = '#d4edda';
        statusDiv.style.color = '#155724';
        statusDiv.style.border = '1px solid #c3e6cb';

        // Réinitialiser le formulaire
        emailInput.value = '';

        // Masquer le formulaire après 3 secondes
        setTimeout(() => {
            document.getElementById('error-report-form').style.display = 'none';
            document.getElementById('show-error-report-form').textContent = t('admin.error_report_show_button');
            statusDiv.style.display = 'none';
        }, 3000);

    } catch (error) {
        // Afficher l'erreur
        statusDiv.textContent = t('admin.error_report_send_error', { message: error.message });
        statusDiv.style.display = 'block';
        statusDiv.style.backgroundColor = '#f8d7da';
        statusDiv.style.color = '#721c24';
        statusDiv.style.border = '1px solid #f5c6cb';
    } finally {
        // Réactiver le bouton
        sendButton.disabled = false;
        sendButton.textContent = t('admin.error_report_send_button');
    }
}

// Fonction pour charger et afficher les sites ignorés
async function loadIgnoredSites() {
    try {
        const container = document.getElementById('ignored-sites-container');
        if (!container) return;

        const categories = [
            { key: 'genai', name: t('admin.ignored_categories.genai'), color: '#8d8d8d' },
            { key: 'redflag', name: t('admin.ignored_categories.redflag'), color: '#dc3545' },
            { key: 'amf', name: t('admin.ignored_categories.amf'), color: '#ffc107' },
            { key: 'idn_homograph', name: t('admin.ignored_categories.idn_homograph'), color: '#17a2b8' }
        ];

        let allIgnoredSites = {};
        let totalSites = 0;

        // Charger tous les sites ignorés
        for (const category of categories) {
            const storageKey = `ignoredDomains_${category.key}`;
            const result = await browser.storage.local.get(storageKey);
            const domains = result[storageKey] || [];
            if (domains.length > 0) {
                allIgnoredSites[category.key] = {
                    name: category.name,
                    color: category.color,
                    domains: domains
                };
                totalSites += domains.length;
            }
        }

        // Si aucun site ignoré
        if (totalSites === 0) {
            const empty = document.createElement('p');
            empty.className = 'ignored-empty';
            empty.textContent = t('admin.ignored_sites_empty');
            container.replaceChildren(empty);
            return;
        }

        // Une pastille "domaine  ✕" par site ignoré. Tout est créé via le DOM (textContent / dataset):
        // un nom de domaine n'est jamais interprété comme du HTML.
        const displayLimit = 10;
        const makeChip = (categoryKey, domain) => {
            const chip = document.createElement('span');
            chip.className = 'domain-chip';
            const name = document.createElement('span');
            name.className = 'domain-name';
            name.textContent = domain;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'remove-domain-btn';
            btn.dataset.category = categoryKey;
            btn.dataset.domain = domain;
            btn.title = t('admin.ignored_sites_remove');
            btn.setAttribute('aria-label', t('admin.ignored_sites_remove') + ' ' + domain);
            btn.textContent = '✕';
            btn.addEventListener('click', () => removeDomainFromIgnored(categoryKey, domain));
            chip.append(name, btn);
            return chip;
        };

        const sections = [];
        for (const [categoryKey, categoryData] of Object.entries(allIgnoredSites)) {
            const section = document.createElement('div');
            section.className = 'category-section';
            section.style.setProperty('--cat', categoryData.color);

            const title = document.createElement('h3');
            title.append(categoryData.name + ' ');
            const count = document.createElement('span');
            count.className = 'category-count';
            count.textContent = String(categoryData.domains.length);
            title.append(count);

            const list = document.createElement('div');
            list.className = 'domains-list';
            categoryData.domains.slice(0, displayLimit).forEach(d => list.append(makeChip(categoryKey, d)));
            section.append(title, list);

            if (categoryData.domains.length > displayLimit) {
                const more = document.createElement('div');
                more.className = 'domains-list all-domains';
                more.hidden = true;
                categoryData.domains.slice(displayLimit).forEach(d => more.append(makeChip(categoryKey, d)));

                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'show-all-btn';
                const arrow = document.createElement('span');
                arrow.textContent = '▼';
                const label = document.createElement('span');
                label.textContent = t('admin.ignored_sites_show_all', { count: categoryData.domains.length });
                toggle.append(arrow, label);
                toggle.addEventListener('click', () => {
                    more.hidden = !more.hidden;
                    arrow.textContent = more.hidden ? '▼' : '▲';
                });
                section.append(toggle, more);
            }
            sections.push(section);
        }

        container.replaceChildren(...sections);

    } catch (error) {
        console.error('Erreur lors du chargement des sites ignorés:', error);
    }
}

// Fonction pour supprimer un domaine de la liste des ignorés
async function removeDomainFromIgnored(category, domain) {
    try {
        const storageKey = `ignoredDomains_${category}`;
        const result = await browser.storage.local.get(storageKey);
        const domains = result[storageKey] || [];

        const updatedDomains = domains.filter(d => d !== domain);
        await browser.storage.local.set({ [storageKey]: updatedDomains });

        // Recharger l'affichage
        await loadIgnoredSites();
    } catch (error) {
        console.error('Erreur lors de la suppression du domaine:', error);
    }
}

// Fonction pour effacer tous les sites ignorés
async function clearAllIgnoredSites() {
    try {
        const categories = ['genai', 'redflag', 'amf', 'idn_homograph'];
        const keysToRemove = categories.map(cat => `ignoredDomains_${cat}`);

        await browser.storage.local.remove(keysToRemove);

        // Recharger l'affichage
        await loadIgnoredSites();
    } catch (error) {
        console.error('Erreur lors de l\'effacement des sites ignorés:', error);
    }
}