// logs.js - Script per la pagina di visualizzazione dei log

// Variabili globali
var isLoadingLogs = false;
var autoRefreshInterval = null;

// Inizializza la pagina dei log
function initializeLogsPage() {
    console.log("Inizializzazione pagina log");
    
    // Carica i log
    loadLogs();
    
    // Imposta l'aggiornamento automatico ogni 30 secondi
    startAutoRefresh();
    
    // Ascoltatori per la pulizia quando l'utente lascia la pagina
    window.addEventListener('pagehide', cleanupLogsPage);
}

// Avvia l'aggiornamento automatico
function startAutoRefresh() {
    // Ferma eventuali timer precedenti
    stopAutoRefresh();
    
    // Aggiorna ogni 30 secondi
    autoRefreshInterval = setInterval(loadLogs, 30000);
    console.log("Aggiornamento automatico dei log avviato");
}

// Ferma l'aggiornamento automatico
function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        console.log("Aggiornamento automatico dei log fermato");
    }
}

// Pulizia quando si cambia pagina
function cleanupLogsPage() {
    stopAutoRefresh();
}

// Carica i log dal server
function loadLogs() {
    if (isLoadingLogs) return;
    isLoadingLogs = true;
    
    const logsBody = document.getElementById('logs-tbody');
    if (!logsBody) {
        isLoadingLogs = false;
        return;
    }
    
    // Mostra l'indicatore di caricamento
    logsBody.innerHTML = `<tr><td colspan="4" class="loading">Caricamento log...</td></tr>`;
    
    fetch('/data/system_log.json')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dei log');
            return response.json();
        })
        .then(logs => {
            displayLogs(logs);
        })
        .catch(error => {
            console.error('Errore:', error);
            showToast('Errore nel caricamento dei log', 'error');
            
            if (logsBody) {
                logsBody.innerHTML = `
                    <tr>
                        <td colspan="4" class="empty-logs">
                            Errore nel caricamento dei log: ${error.message}
                        </td>
                    </tr>
                `;
            }
        })
        .finally(() => {
            isLoadingLogs = false;
        });
}

// Visualizza i log nell'interfaccia
function displayLogs(logs) {
    const logsBody = document.getElementById('logs-tbody');
    if (!logsBody) return;
    
    if (!logs || logs.length === 0) {
        logsBody.innerHTML = `
            <tr>
                <td colspan="4" class="empty-logs">
                    Nessun log disponibile
                </td>
            </tr>
        `;
        return;
    }
    
    // Ordina i log per data e ora (dal più recente al più vecchio)
    logs.sort((a, b) => {
        const dateA = a.date + ' ' + a.time;
        const dateB = b.date + ' ' + b.time;
        return dateB.localeCompare(dateA);
    });
    
    // Crea le righe della tabella
    logsBody.innerHTML = logs.map(log => {
        const level = log.level || 'INFO';
        const levelClass = level.toLowerCase();
        
        return `
            <tr>
                <td>${log.date || 'N/A'}</td>
                <td>${log.time || 'N/A'}</td>
                <td>
                    <span class="log-level ${levelClass}">${level}</span>
                </td>
                <td>${log.message || 'Nessun messaggio'}</td>
            </tr>
        `;
    }).join('');
}

// Aggiorna i log (chiamato dal pulsante Aggiorna)
function refreshLogs() {
    const refreshButton = document.getElementById('refresh-logs-btn');
    if (refreshButton) {
        refreshButton.classList.add('loading');
        refreshButton.disabled = true;
    }
    
    loadLogs();
    
    // Riabilita il pulsante dopo 1 secondo
    setTimeout(() => {
        if (refreshButton) {
            refreshButton.classList.remove('loading');
            refreshButton.disabled = false;
        }
    }, 1000);
}

// Mostra la finestra di conferma per la cancellazione dei log
function confirmClearLogs() {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay) {
        overlay.classList.add('active');
    }
}

// Chiude la finestra di conferma
function closeConfirmDialog() {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

// Cancella tutti i log
function clearLogs() {
    const clearButton = document.getElementById('clear-logs-btn');
    if (clearButton) {
        clearButton.classList.add('loading');
        clearButton.disabled = true;
    }
    
    // Chiudi la finestra di conferma
    closeConfirmDialog();
    
    fetch('/clear_logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast('Log cancellati con successo', 'success');
            loadLogs();
        } else {
            showToast(`Errore: ${data.error || 'Cancellazione fallita'}`, 'error');
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante la cancellazione dei log', 'error');
    })
    .finally(() => {
        if (clearButton) {
            clearButton.classList.remove('loading');
            clearButton.disabled = false;
        }
    });
}

// Inizializzazione quando il documento è caricato
document.addEventListener('DOMContentLoaded', initializeLogsPage);