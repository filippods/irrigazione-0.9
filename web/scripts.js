// scripts.js - Script principale dell'applicazione

// Variabili globali
let isLoadingPage = false;
let userData = {};
let connectionStatusInterval = null;
let programStatusInterval = null;
let currentPage = null;

// Polyfill per crypto.randomUUID per browser più vecchi
if (!crypto.randomUUID) {
    crypto.randomUUID = function() {
        // Verifica che la funzione getRandomValues sia disponibile
        if (crypto.getRandomValues) {
            return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, function(c) {
                return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
            });
        } else {
            // Fallback con timestamp + numeri random per browser molto vecchi
            let d = new Date().getTime();
            if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
                d += performance.now(); // use high-precision timer if available
            }
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                let r = (d + Math.random() * 16) % 16 | 0;
                d = Math.floor(d / 16);
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        }
    };
}

// Funzione per mostrare notifiche (toast)
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    // Rimuovi eventuali toast esistenti con lo stesso messaggio
    const existingToasts = container.querySelectorAll('.toast');
    existingToasts.forEach(toast => {
        if (toast.textContent === message) {
            toast.remove();
        }
    });
    
    // Crea un nuovo toast
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Aggiungi icona basata sul tipo
    let iconHtml = '';
    switch(type) {
        case 'success':
            iconHtml = '<i class="fas success-icon"></i>';
            break;
        case 'error':
            iconHtml = '<i class="fas error-icon"></i>';
            break;
        case 'warning':
            iconHtml = '<i class="fas warning-icon"></i>';
            break;
        default:
            iconHtml = '<i class="fas info-icon"></i>';
    }
    
    toast.innerHTML = `${iconHtml}<span>${message}</span>`;
    
    // Aggiungi al container
    container.appendChild(toast);
    
    // Renderizza e avvia l'animazione
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    // Rimuovi dopo la durata specificata
    const timerId = setTimeout(() => {
        toast.classList.remove('show');
        
        // Rimuovi l'elemento dopo che l'animazione è completata
        setTimeout(() => {
            if (container.contains(toast)) {
                container.removeChild(toast);
            }
        }, 300);
    }, duration);
    
    // Permetti di chiudere il toast cliccandolo
    toast.addEventListener('click', () => {
        clearTimeout(timerId);
        toast.classList.remove('show');
        
        setTimeout(() => {
            if (container.contains(toast)) {
                container.removeChild(toast);
            }
        }, 300);
    });
}

// Funzione per caricare i dati da user_settings.json una sola volta
function loadUserData(callback) {
    fetch('/data/user_settings.json')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dei dati di user_settings');
            return response.json();
        })
        .then(data => {
            userData = data;
            console.log("Dati utente caricati:", userData);
            if (callback) callback(userData);
        })
        .catch(error => {
            console.error('Errore nel caricamento dei dati di user_settings:', error);
            showToast('Errore nel caricamento delle impostazioni', 'error');
        });
}

// Funzione per caricare e visualizzare una pagina
function loadPage(pageName, callback) {
    if (isLoadingPage) return;
    isLoadingPage = true;
    closeMenu();
	
    if (pageName === 'create_program.html') {
        // Rimuovi sempre l'ID quando vai alla pagina di creazione
        localStorage.removeItem('editProgramId');
        sessionStorage.removeItem('editing_intent');
    } else if (pageName !== 'modify_program.html') {
        // Se stiamo andando a una pagina che non è né creazione né modifica,
        // possiamo pulire l'ID (a meno che non stiamo salvando un form)
        if (!pageName.includes('save') && !pageName.includes('update')) {
            localStorage.removeItem('editProgramId');
            sessionStorage.removeItem('editing_intent');
        }
    }
    
    // Segna la pagina corrente nel menu
    updateActiveMenuItem(pageName);
    
    // Memorizza la pagina corrente
    currentPage = pageName;
    
    // Chiudi il menu dopo la selezione (su dispositivi mobili)
    closeMenu();
    
    // Mostra un indicatore di caricamento
    const contentElement = document.getElementById('content');
    if (contentElement) {
        contentElement.innerHTML = '<div class="loading-indicator" style="text-align:center;padding:50px;">Caricamento...</div>';
    }

    fetch(pageName)
        .then(response => {
            if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);
            return response.text();
        })
        .then(html => {
            if (contentElement) {
                contentElement.innerHTML = html;

                // Ferma il polling prima di caricare qualsiasi altra pagina
                stopConnectionStatusPolling();

                // Carica gli script associati alla pagina
                const scriptSrc = pageName.replace('.html', '.js');
                
                // Rimuovi eventuali script precedenti della stessa pagina
                const oldScripts = document.querySelectorAll(`script[src="${scriptSrc}"]`);
                oldScripts.forEach(script => script.remove());
                
                // Carica il nuovo script
                loadScript(scriptSrc, () => {
                    // Inizializza la pagina basandosi sul nome del file
                    switch (pageName) {
                        case 'manual.html':
                            if (typeof initializeManualPage === 'function') {
                                initializeManualPage(userData);
                            }
                            break;
                        case 'create_program.html':
                            if (typeof initializeCreateProgramPage === 'function') {
                                initializeCreateProgramPage();
                            }
                            break;
                        case 'modify_program.html':
                            if (typeof initializeModifyProgramPage === 'function') {
                                initializeModifyProgramPage();
                            }
                            break;
                        case 'settings.html':
                            if (typeof initializeSettingsPage === 'function') {
                                initializeSettingsPage(userData);
                            }
                            // Avvia il polling dello stato della connessione solo se sei nella pagina Impostazioni
                            startConnectionStatusPolling();
                            break;
                        case 'view_programs.html':
                            if (typeof initializeViewProgramsPage === 'function') {
                                initializeViewProgramsPage();
                            }
                            break;
                        case 'logs.html':
                            if (typeof initializeLogsPage === 'function') {
                                initializeLogsPage();
                            }
                            break;
                    }

                    if (callback && typeof callback === 'function') {
                        callback();
                    }
                });
            }
        })
        .catch(error => {
            console.error('Errore nel caricamento della pagina:', error);
            if (contentElement) {
                contentElement.innerHTML = `
                    <div style="text-align:center;padding:30px;color:#ff3333;">
                        <div style="font-size:48px;margin-bottom:20px;">⚠️</div>
                        <h2>Errore di caricamento</h2>
                        <p>Impossibile caricare la pagina ${pageName}</p>
                        <button onclick="window.location.reload()" class="button primary" style="margin-top:20px;">
                            Ricarica pagina
                        </button>
                    </div>
                `;
            }
            showToast(`Errore nel caricamento di ${pageName}`, 'error');
        })
        .finally(() => {
            isLoadingPage = false;
        });
}

// Funzione per caricare uno script
function loadScript(url, callback) {
    // Prima rimuovi qualsiasi script esistente con lo stesso URL
    const existingScripts = document.querySelectorAll(`script[src="${url}"]`);
    existingScripts.forEach(script => script.remove());
    
    // Ora crea un nuovo script
    const script = document.createElement('script');
    script.src = url;
    script.onload = callback;
    script.onerror = () => {
        console.error(`Errore nel caricamento dello script: ${url}`);
        callback();  // Chiamiamo comunque il callback per non bloccare
    };
    document.head.appendChild(script);
}

// Funzione per aggiornare l'elemento del menu attivo
function updateActiveMenuItem(pageName) {
    const menuItems = document.querySelectorAll('.menu li');
    menuItems.forEach(item => {
        const itemPage = item.getAttribute('data-page');
        if (itemPage === pageName) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

// Funzioni per aprire e chiudere il menu
function toggleMenu() {
    const menu = document.getElementById('menu');
    const overlay = document.getElementById('menu-overlay');
    
    if (!menu || !overlay) return;
    
    menu.classList.toggle('active');
    overlay.classList.toggle('active');
}

function closeMenu() {
    const menu = document.getElementById('menu');
    const overlay = document.getElementById('menu-overlay');
    
    if (!menu || !overlay) return;
    
    menu.classList.remove('active');
    overlay.classList.remove('active');
}

// Funzione per aggiornare data e ora
function updateDateTime() {
    const dateElement = document.getElementById('date');
    const timeElement = document.getElementById('time');

    if (!dateElement || !timeElement) return;

    const now = new Date();
    
    // Formatta la data come "giorno mese anno"
    const options = { day: 'numeric', month: 'long', year: 'numeric' };
    const formattedDate = now.toLocaleDateString('it-IT', options);
    
    // Formatta l'ora come "ore:minuti:secondi"
    const formattedTime = now.toLocaleTimeString('it-IT', { 
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
    });

    dateElement.textContent = formattedDate;
    timeElement.textContent = formattedTime;
}

// Funzione corretta per controllare lo stato del programma
function checkProgramStatus() {
    console.log("Controllo stato programma...");
    fetch('/get_program_state')
        .then(response => {
            if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);
            return response.json();
        })
        .then(state => {
            console.log("Stato programma ricevuto:", state);
            
            // Salva lo stato per riferimento futuro
            window.lastProgramState = state;
            
            // Aggiorna il banner di stato
            updateProgramStatusBanner(state);
            
            // Se ci troviamo nella pagina manual, aggiorna anche quella interfaccia
            if (currentPage === 'manual.html' && window.handleProgramState) {
                window.handleProgramState(state);
            }
        })
        .catch(error => {
            console.error('Errore nel controllo stato programma:', error);
        });
}

// Funzione corretta per aggiornare il banner
function updateProgramStatusBanner(state) {
    const banner = document.getElementById('program-status-banner');
    const mainContent = document.getElementById('content');
    
    if (!banner) {
        console.error("Banner elemento non trovato!");
        return;
    }
    
    console.log("Aggiornamento banner con stato:", state);
    
    if (state && state.program_running && state.current_program_id) {
        console.log("Programma in esecuzione, mostrando banner");
        
        // Programma in esecuzione, mostra il banner
        banner.style.display = 'block';
        
        // Aggiungi classe al contenuto principale per lo spazio
        if (mainContent) {
            mainContent.classList.add('with-banner');
        }
        
        // Aggiorna informazioni sul programma
        fetch('/data/program.json')
            .then(response => response.json())
            .then(programs => {
                const program = programs[state.current_program_id];
                if (program) {
                    // Aggiorna nome programma
                    const nameElement = document.getElementById('banner-program-name');
                    if (nameElement) {
                        nameElement.textContent = program.name || 'Programma in esecuzione';
                    }
                }
                
                // Aggiorna informazioni sulla zona attiva
                updateActiveZoneInfo(state);
            })
            .catch(err => {
                console.error('Errore caricamento dettagli programma:', err);
                // Comunque aggiorna le informazioni sulla zona attiva
                updateActiveZoneInfo(state);
            });
    } else {
        console.log("Nessun programma in esecuzione, nascondendo banner");
        
        // Nessun programma in esecuzione, nascondi il banner
        banner.style.display = 'none';
        
        // Rimuovi classe dal contenuto principale
        if (mainContent) {
            mainContent.classList.remove('with-banner');
        }
    }
}

// Funzione per aggiornare le informazioni sulla zona attiva
function updateActiveZoneInfo(state) {
    if (!state) return;
    
    const zoneElement = document.getElementById('banner-active-zone');
    if (!zoneElement) return;
    
    if (state.active_zone) {
        zoneElement.textContent = `Zona attiva: ${state.active_zone.name || 'Zona ' + (state.active_zone.id + 1)}`;
    } else {
        zoneElement.textContent = 'Inizializzazione...';
    }
}

// Funzione per fermare tutti i programmi in esecuzione
function stopAllPrograms() {
    // Aggiungi classe loading al pulsante
    const stopBtn = document.querySelector('.stop-all-button');
    if (stopBtn) {
        stopBtn.classList.add('loading');
    }
    
    // Mostra toast di caricamento
    showToast('Arresto del programma in corso...', 'info');
    
    fetch('/stop_program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        if (stopBtn) {
            stopBtn.classList.remove('loading');
        }
        
        if (data.success) {
            showToast('Arresto totale eseguito con successo', 'success');
            
            // Aggiorna immediatamente lo stato del programma
            checkProgramStatus();
            
            // Se siamo nella pagina di visualizzazione programmi, aggiorniamola
            if (currentPage === 'view_programs.html' && typeof fetchProgramState === 'function') {
                fetchProgramState();
            }
            
            // Se siamo nella pagina manuale, aggiorniamola
            if (currentPage === 'manual.html' && typeof fetchZonesStatus === 'function') {
                fetchZonesStatus();
            }
        } else {
            showToast(`Errore durante l'arresto totale: ${data.error || 'Errore sconosciuto'}`, 'error');
        }
    })
    .catch(error => {
        if (stopBtn) {
            stopBtn.classList.remove('loading');
        }
        console.error('Errore di rete durante l\'arresto totale:', error);
        showToast('Errore di rete durante l\'arresto totale', 'error');
    });
}

// Funzione per arrestare un programma in esecuzione
function stopProgram() {
    // Mostra toast di caricamento
    showToast('Arresto del programma in corso...', 'info');
    
    // Nascondi subito il banner per feedback immediato
    const banner = document.getElementById('program-status-banner');
    if (banner) {
        banner.style.display = 'none';
    }
    
    // Mostra indicatore di caricamento
    const stopButtons = document.querySelectorAll('.banner-stop-btn, .global-stop-btn, .stop-program-button');
    stopButtons.forEach(btn => {
        if (btn) btn.classList.add('loading');
    });
    
    fetch('/stop_program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(response => response.json())
    .then(data => {
        // Rimuovi indicatori di caricamento
        stopButtons.forEach(btn => {
            if (btn) btn.classList.remove('loading');
        });
        
        if (data.success) {
            showToast('Programma arrestato con successo', 'success');
            
            // Aggiorna immediatamente lo stato del programma
            checkProgramStatus();
            
            // Se siamo nella pagina di visualizzazione programmi, aggiorniamola
            if (currentPage === 'view_programs.html' && typeof fetchProgramState === 'function') {
                fetchProgramState();
            }
            
            // Se siamo nella pagina manuale, aggiorniamola
            if (currentPage === 'manual.html' && typeof fetchZonesStatus === 'function') {
                fetchZonesStatus();
            }
            
            // Per la pagina manual, riattiva l'interfaccia
            if (currentPage === 'manual.html' && typeof enableManualPage === 'function') {
                enableManualPage();
            }
        } else {
            // Rimostra il banner in caso di errore
            if (banner) {
                banner.style.display = 'block';
            }
            
            showToast(`Errore durante l'arresto del programma: ${data.error || 'Errore sconosciuto'}`, 'error');
        }
    })
    .catch(error => {
        // Rimuovi indicatori di caricamento
        stopButtons.forEach(btn => {
            if (btn) btn.classList.remove('loading');
        });
        
        console.error('Errore di rete durante l\'arresto del programma:', error);
        showToast('Errore di rete durante l\'arresto del programma', 'error');
        
        // Rimostra il banner in caso di errore
        if (banner) {
            banner.style.display = 'block';
        }
    });
}

// Avvia polling per il controllo dei programmi con frequenza più alta
function startProgramStatusPolling() {
    console.log("Avvio polling stato programma");
    
    // Ferma eventuali polling precedenti
    stopProgramStatusPolling();
    
    // Esegui subito
    checkProgramStatus();
    
    // Poi ogni 2 secondi (più frequente per reattività migliore)
    programStatusInterval = setInterval(checkProgramStatus, 2000);
    console.log("Polling dello stato del programma avviato");
}

// Ferma polling dello stato programma
function stopProgramStatusPolling() {
    if (programStatusInterval) {
        clearInterval(programStatusInterval);
        programStatusInterval = null;
        console.log("Polling dello stato del programma fermato");
    }
}

// Funzioni per il polling dello stato della connessione
function startConnectionStatusPolling() {
    if (connectionStatusInterval) {
        clearInterval(connectionStatusInterval);
    }
    
    // Esegui subito
    fetchConnectionStatus();
    
    // Poi esegui ogni 30 secondi
    connectionStatusInterval = setInterval(fetchConnectionStatus, 30000);
    console.log("Polling dello stato della connessione avviato");
}

function stopConnectionStatusPolling() {
    if (connectionStatusInterval) {
        clearInterval(connectionStatusInterval);
        connectionStatusInterval = null;
        console.log("Polling dello stato della connessione fermato");
    }
}

function fetchConnectionStatus() {
    fetch('/get_connection_status')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dello stato della connessione');
            return response.json();
        })
        .then(data => {
            const statusElement = document.getElementById('connection-status');
            if (statusElement) {
                let statusHtml = '';
                
                if (data.mode === 'client') {
                    statusHtml = `
                        <div style="background-color:#e6f7ff;border-radius:8px;padding:15px;margin-top:15px;border:1px solid #91d5ff;">
                            <h3 style="margin:0 0 10px 0;color:#0099ff;">Connesso alla rete WiFi</h3>
                            <p><strong>SSID:</strong> ${data.ssid}</p>
                            <p><strong>IP:</strong> ${data.ip}</p>
                        </div>
                    `;
                } else if (data.mode === 'AP') {
                    statusHtml = `
                        <div style="background-color:#fff7e6;border-radius:8px;padding:15px;margin-top:15px;border:1px solid #ffd591;">
                            <h3 style="margin:0 0 10px 0;color:#fa8c16;">Access Point attivo</h3>
                            <p><strong>SSID:</strong> ${data.ssid}</p>
                            <p><strong>IP:</strong> ${data.ip}</p>
                        </div>
                    `;
                } else {
                    statusHtml = `
                        <div style="background-color:#fff1f0;border-radius:8px;padding:15px;margin-top:15px;border:1px solid #ffa39e;">
                            <h3 style="margin:0 0 10px 0;color:#f5222d;">Nessuna connessione attiva</h3>
                        </div>
                    `;
                }
                
                statusElement.innerHTML = statusHtml;
                statusElement.style.display = 'block';
            }
        })
        .catch(error => {
            console.error('Errore nel caricamento dello stato della connessione:', error);
            // Non mostrare toast per evitare troppi popup
        });
}

// Funzione initializePage migliorata
function initializePage() {
    console.log("Inizializzazione pagina principale");
    
    // Aggiorna data e ora
    updateDateTime();
    setInterval(updateDateTime, 1000);

    // Avvia polling per lo stato del programma immediatamente
    startProgramStatusPolling();

    // Carica i dati utente e dopo carica la pagina predefinita
    loadUserData(() => {
        // Carica la pagina predefinita (controllo manuale)
        loadPage('manual.html');
    });
    
    // Esponi funzioni globali
    window.showToast = showToast;
    window.stopProgram = stopProgram;
    window.stopAllPrograms = stopAllPrograms;
}

// Inizializzazione quando il DOM è completamente caricato
document.addEventListener('DOMContentLoaded', () => {
    // Inizializza la pagina principale
    initializePage();

    // Gestisci i click sui link di navigazione
    document.querySelectorAll('.menu li').forEach(item => {
        item.addEventListener('click', (event) => {
            const targetPage = event.currentTarget.getAttribute('data-page');
            if (targetPage) {
                loadPage(targetPage);
            }
        });
    });

    // Previeni il trascinamento delle immagini
    document.addEventListener('dragstart', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
        }
    });
});

// Gestione errori globali
window.addEventListener('error', (event) => {
    console.error('Errore JavaScript:', event.error);
    showToast('Si è verificato un errore. Controlla la console del browser.', 'error');
});