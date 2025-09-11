document.addEventListener('DOMContentLoaded', async () => {
    const listTypes = ['genai', 'redflag', 'amf', 'exceptions'];
    const statusElement = document.getElementById('status');

    // Load initial state of lists
    async function loadListStates() {
        try {
            const storageData = await browser.storage.local.get('enabledLists');
            const enabledLists = storageData.enabledLists || {
                'genai': true,
                'redflag': true,
                'amf': true,
                'exceptions': true
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
            showStatus('Erreur de chargement des états', false);
        }
    }

    // Update list count display
    async function updateListCount(type) {
        try {
            const countElement = document.getElementById(`${type}-count`);
            const dateElement = document.getElementById(`${type}-date`);
            
            if (!countElement) {
                return;
            }
            
            const storageData = await browser.storage.local.get(null);
            let count = 0;
            let timestamp = null;
            
            if (type === 'genai') {
                if (storageData.bloomFilter) {
                    try {
                        const jsonString = JSON.stringify(storageData.bloomFilter);
                        const fileSizeInBytes = new Blob([jsonString]).size;
                        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
                        count = `${fileSizeInKo} ko`;
                    } catch (error) {
                        count = 'Erreur de calcul';
                    }
                }
                timestamp = storageData.bloomFilterTimestamp;
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
                    dateElement.textContent = 'Jamais mise à jour';
                }
            }
            
        } catch (error) {
            const countElement = document.getElementById(`${type}-count`);
            if (countElement) {
                countElement.textContent = 'Erreur';
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
                    lastUpdateElement.textContent = `Dernière mise à jour globale : ${storageData.lastListUpdateFormatted}`;
                } else if (storageData.lastListUpdate) {
                    const date = new Date(storageData.lastListUpdate);
                    lastUpdateElement.textContent = `Dernière mise à jour globale : ${date.toLocaleString()}`;
                } else {
                    lastUpdateElement.textContent = 'Aucune mise à jour globale effectuée';
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
                showStatus(`Liste ${type} ${enabled ? 'activée' : 'désactivée'}`, true);
            } else {
                showStatus(`Erreur lors de la modification de la liste ${type}`, false);
            }
        } catch (error) {
            showStatus(`Erreur de communication: ${error.message}`, false);
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
            showStatus('Mise à jour des listes en cours...', true);
            
            const result = await browser.runtime.sendMessage({ action: 'updateAllLists' });
            
            // Wait for update completion
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Refresh counters
            for (const type of listTypes) {
                await updateListCount(type);
            }
            
            await window.displayLastUpdateTime();
            showStatus('Mise à jour des listes terminée', true);
            
        } catch (error) {
            showStatus('Erreur lors de la mise à jour des listes', false);
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

    // Initialize
    await loadListStates();
    
    for (const type of listTypes) {
        await updateListCount(type);
    }
    
    await window.displayLastUpdateTime();
    await updateAlertStats();
});


async function updateAlertStats() {
    try {
        const result = await browser.storage.local.get(['alertStats', 'todayBadgeCount']);
        const alertStats = result.alertStats || {};
        const todayBadgeCount = result.todayBadgeCount || 0;
        
        const today = new Date().toISOString().split('T')[0];
        const todayStats = alertStats[today] || { genai: 0, redflag: 0, amf: 0 };
        
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
            const dayTotal = stats.genai + stats.redflag + stats.amf;
            
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
        document.getElementById('stats-genai-today').textContent = todayStats.genai;
        document.getElementById('stats-redflag-today').textContent = todayStats.redflag;
        document.getElementById('stats-amf-today').textContent = todayStats.amf;
        
    } catch (error) {
        console.error('Erreur lors de la mise à jour des statistiques:', error);
    }
}