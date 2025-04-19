// manual.js - Sistema di controllo manuale delle zone di irrigazione

// ====================== VARIABILI GLOBALI ======================
let userSettings = {};            // Impostazioni utente
let maxZoneDuration = 180;        // Durata massima in minuti (default)
let maxActiveZones = 3;           // Numero massimo di zone attive (default)
let zoneStatusInterval = null;    // Intervallo di polling stato zone
let activeZones = {};             // Stato corrente delle zone attive con timer
let disabledManualMode = false;   // Flag per disabilitare la modalità manuale
const POLL_INTERVAL = 2000;       // Intervallo di polling in millisecondi (ridotto per maggiore reattività)

// ====================== INIZIALIZZAZIONE ======================
function initializeManualPage(userData) {
    console.log("Inizializzazione pagina controllo manuale");

    // Carica impostazioni utente
    if (userData && Object.keys(userData).length > 0) {
        userSettings = userData;
        maxActiveZones = userData.max_active_zones || 3;
        maxZoneDuration = userData.max_zone_duration || 180;
        renderZones(userData.zones || []);
    } else {
        // Carica impostazioni dal server
        fetch('/data/user_settings.json')
            .then(response => {
                if (!response.ok) throw new Error('Errore nel caricamento delle impostazioni utente');
                return response.json();
            })
            .then(data => {
                userSettings = data;
                maxActiveZones = data.max_active_zones || 3;
                maxZoneDuration = data.max_zone_duration || 180;
                renderZones(data.zones || []);
            })
            .catch(error => {
                console.error('Errore nel caricamento delle impostazioni:', error);
                showToast('Errore nel caricamento delle impostazioni', 'error');
            });
    }
    
    // Aggiungi stili CSS potenziati
    addManualStyles();
    
    // Avvia il polling dello stato
    startStatusPolling();
    
    // Controlla subito se c'è un programma in esecuzione
    fetchProgramState();
    
    // Pulizia quando si cambia pagina
    window.addEventListener('pagehide', cleanupManualPage);
}

// Aggiungi stili necessari migliorati
function addManualStyles() {
    if (!document.getElementById('manual-styles')) {
        const style = document.createElement('style');
        style.id = 'manual-styles';
        
        style.textContent = `
            .zone-card.disabled-mode {
                opacity: 0.6;
                pointer-events: none;
                position: relative;
                filter: grayscale(70%);
            }
            
            .manual-page-overlay {
                position: fixed;
                top: 60px;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(0, 0, 0, 0.8);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 9999 !important;
                animation: fadeIn 0.3s ease;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            
            .overlay-message {
                background-color: #fff;
                border-radius: 12px;
                padding: 25px;
                width: 80%;
                max-width: 500px;
                text-align: center;
                box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
                border-left: 5px solid #ff3333;
            }
            
            .overlay-message h3 {
                color: #ff3333;
                margin-top: 0;
                font-size: 20px;
            }
            
            .overlay-message p {
                margin-bottom: 0;
                font-size: 16px;
                line-height: 1.5;
                color: #555;
            }
            
            .zone-card input::placeholder {
                color: #999;
                opacity: 1;
            }
            
            .zone-card.active {
                border: 2px solid #00cc66;
                box-shadow: 0 0 15px rgba(0, 204, 102, 0.5);
            }
            
            .loading-indicator {
                position: relative;
                color: transparent !important;
                pointer-events: none;
            }
            
            .loading-indicator::after {
                content: "";
                position: absolute;
                width: 20px;
                height: 20px;
                top: 50%;
                left: 50%;
                margin-top: -10px;
                margin-left: -10px;
                border-radius: 50%;
                border: 3px solid rgba(0, 0, 0, 0.1);
                border-top-color: #00cc66;
                animation: spin 1s linear infinite;
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            .stop-program-button {
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background-color: #ff3333;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
                font-weight: bold;
                cursor: pointer;
                animation: pulse 2s infinite;
                z-index: 999;
                display: none;
                width: 85%;
                max-width: 320px;
                text-align: center;
                border: none;
                font-size: 16px;
            }
            
            .stop-program-button.visible {
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .stop-program-button i {
                margin-right: 10px;
                font-size: 20px;
            }
            
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(255, 51, 51, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(255, 51, 51, 0); }
                100% { box-shadow: 0 0 0 0 rgba(255, 51, 51, 0); }
            }
            
            .container {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                gap: 20px;
                padding: 20px;
                max-width: 1200px;
                margin: 0 auto;
            }
            
            .zone-card {
                background: #ffffff;
                border-radius: 12px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                padding: 20px;
                transition: all 0.3s ease;
                display: flex;
                flex-direction: column;
                position: relative;
                overflow: hidden;
            }
            
            @media (max-width: 768px) {
                .container {
                    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                    gap: 15px;
                }
                
                .zone-card {
                    padding: 15px;
                }
                
                .stop-program-button {
                    width: 95%;
                    padding: 10px 20px;
                }
            }
        `;
        
        document.head.appendChild(style);
        console.log("Stili per manual.js aggiunti con successo");
    }
}

// Avvia il polling dello stato
function startStatusPolling() {
    // Esegui subito la prima volta
    fetchZonesStatus();
    
    // Imposta l'intervallo di polling
    zoneStatusInterval = setInterval(fetchZonesStatus, POLL_INTERVAL);
    console.log("Polling stato zone avviato");
}

// Ferma il polling dello stato
function stopStatusPolling() {
    if (zoneStatusInterval) {
        clearInterval(zoneStatusInterval);
        zoneStatusInterval = null;
        console.log("Polling stato zone fermato");
    }
}

// Pulisce le risorse
function cleanupManualPage() {
    stopStatusPolling();
    
    // Rimuovi tutti i timer
    Object.keys(activeZones).forEach(zoneId => {
        if (activeZones[zoneId].timer) {
            clearInterval(activeZones[zoneId].timer);
        }
    });
    
    activeZones = {};

    // Rimuovi eventuali overlay
    const overlay = document.getElementById('manual-page-overlay');
    if (overlay) {
        overlay.remove();
    }
    
    // Rimuovi pulsante di arresto
    const stopButton = document.getElementById('manual-stop-button');
    if (stopButton) {
        stopButton.remove();
    }
}

// ====================== RENDERING INTERFACCIA ======================
// Renderizza le zone
function renderZones(zones) {
    console.log("Renderizzazione zone:", zones);
    
    const container = document.getElementById('zone-container');
    if (!container) return;
    
    // Filtra solo le zone visibili
    const visibleZones = Array.isArray(zones) ? zones.filter(zone => zone && zone.status === "show") : [];
    
    if (visibleZones.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>Nessuna zona configurata</h3>
                <p>Configura le zone nelle impostazioni per poterle controllare manualmente.</p>
                <button class="button primary" onclick="loadPage('settings.html')">
                    Vai alle impostazioni
                </button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = '';
    
    visibleZones.forEach(zone => {
        if (!zone || zone.id === undefined) return;
        
        const zoneCard = document.createElement('div');
        zoneCard.className = 'zone-card';
        zoneCard.id = `zone-${zone.id}`;
        
        const defaultDuration = 10; // Valore di default per l'input durata
        
        zoneCard.innerHTML = `
            <h3>${zone.name || `Zona ${zone.id + 1}`}</h3>
            <div class="input-container">
                <input type="number" id="duration-${zone.id}" placeholder="Durata (minuti)" 
                    min="1" max="${maxZoneDuration}" value="${defaultDuration}">
                <div class="toggle-switch">
                    <label class="switch">
                        <input type="checkbox" id="toggle-${zone.id}" class="zone-toggle" data-zone-id="${zone.id}">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="progress-container">
                <progress id="progress-${zone.id}" value="0" max="100" style="width: 100%;"></progress>
                <div class="timer-display" id="timer-${zone.id}">00:00</div>
            </div>
        `;
        
        container.appendChild(zoneCard);
    });
    
    // Aggiungi gestori eventi
    addZoneEventListeners();
    
    // Aggiorna immediatamente lo stato
    fetchZonesStatus();
    
    // Aggiungi pulsante di arresto programma se non esiste
    addStopProgramButton();
}

// Aggiungi pulsante per fermare qualsiasi programma in esecuzione
function addStopProgramButton() {
    // Rimuovi pulsante esistente se presente
    const existingButton = document.getElementById('manual-stop-button');
    if (existingButton) {
        existingButton.remove();
    }
    
    // Crea nuovo pulsante
    const stopButton = document.createElement('button');
    stopButton.id = 'manual-stop-button';
    stopButton.className = 'stop-program-button';
    stopButton.innerHTML = '<i>■</i> ARRESTA PROGRAMMA IN ESECUZIONE';
    stopButton.onclick = function() {
        window.stopProgram();
    };
    
    document.body.appendChild(stopButton);
}

// Aggiungi gestori eventi
function addZoneEventListeners() {
    document.querySelectorAll('.zone-toggle').forEach(toggle => {
        toggle.addEventListener('change', function(event) {
            // Se la pagina è disabilitata, non fare nulla
            if (disabledManualMode) {
                event.preventDefault();
                return false;
            }
            
            const zoneId = parseInt(event.target.getAttribute('data-zone-id'));
            const isActive = event.target.checked;
            
            if (isActive) {
                // Attiva la zona
                const durationInput = document.getElementById(`duration-${zoneId}`);
                const duration = durationInput ? parseInt(durationInput.value) : 0;
                
                if (!duration || isNaN(duration) || duration <= 0 || duration > maxZoneDuration) {
                    showToast(`Inserisci una durata valida tra 1 e ${maxZoneDuration} minuti`, 'warning');
                    event.target.checked = false;
                    return;
                }
                
                activateZone(zoneId, duration);
            } else {
                // Disattiva la zona
                deactivateZone(zoneId);
            }
        });
    });
}

// Attiva una zona
function activateZone(zoneId, duration) {
    console.log(`Attivazione zona ${zoneId} per ${duration} minuti`);
    
    // Imposta loading state
    const toggle = document.getElementById(`toggle-${zoneId}`);
    const zoneCard = document.getElementById(`zone-${zoneId}`);
    const durationInput = document.getElementById(`duration-${zoneId}`);
    
    if (toggle) toggle.disabled = true;
    if (zoneCard) zoneCard.classList.add('loading-indicator');
    if (durationInput) durationInput.disabled = true;
    
    fetch('/start_zone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone_id: zoneId, duration: duration })
    })
    .then(response => {
        if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);
        return response.json();
    })
    .then(data => {
        // Rimuovi loading state
        if (zoneCard) zoneCard.classList.remove('loading-indicator');
        
        if (data.success) {
            showToast(`Zona ${zoneId + 1} attivata per ${duration} minuti`, 'success');
            
            // Aggiorna lo stato locale
            const durationSeconds = duration * 60;
            
            // Inizializza monitoraggio locale della zona attivata
            startZoneTimer(zoneId, durationSeconds);
            
            // Aggiorna l'UI
            if (zoneCard) zoneCard.classList.add('active');
            if (durationInput) durationInput.disabled = true;
            if (toggle) toggle.disabled = false;
            
            fetchZonesStatus(); // Aggiorna lo stato dal server
        } else {
            showToast(`Errore: ${data.error || 'Attivazione zona fallita'}`, 'error');
            
            // Reset UI in caso di errore
            if (toggle) {
                toggle.checked = false;
                toggle.disabled = false;
            }
            if (durationInput) durationInput.disabled = false;
        }
    })
    .catch(error => {
        console.error('Errore durante l\'attivazione della zona:', error);
        showToast('Errore di rete durante l\'attivazione della zona', 'error');
        
        // Reset UI in caso di errore
        if (toggle) {
            toggle.checked = false;
            toggle.disabled = false;
        }
        if (zoneCard) zoneCard.classList.remove('loading-indicator');
        if (durationInput) durationInput.disabled = false;
    });
}

// Disattiva una zona
function deactivateZone(zoneId) {
    console.log(`Disattivazione zona ${zoneId}`);
    
    // Imposta loading state
    const toggle = document.getElementById(`toggle-${zoneId}`);
    const zoneCard = document.getElementById(`zone-${zoneId}`);
    
    if (toggle) toggle.disabled = true;
    if (zoneCard) zoneCard.classList.add('loading-indicator');
    
    // Effettua un massimo di 3 tentativi in caso di errore
    let retryCount = 0;
    const maxRetries = 3;
    
    function attemptDeactivation() {
        fetch('/stop_zone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zone_id: zoneId })
        })
        .then(response => {
            if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);
            return response.json();
        })
        .then(data => {
            // Rimuovi loading state
            if (zoneCard) zoneCard.classList.remove('loading-indicator');
            
            if (data.success) {
                showToast(`Zona ${zoneId + 1} disattivata`, 'info');
                
                // Ferma il timer locale
                stopZoneTimer(zoneId);
                
                // Aggiorna l'UI
                if (zoneCard) zoneCard.classList.remove('active');
                const durationInput = document.getElementById(`duration-${zoneId}`);
                if (durationInput) durationInput.disabled = false;
                
                // Reset barra di progresso
                resetProgressBar(zoneId);
                
                if (toggle) {
                    toggle.checked = false; // Assicurati che il toggle sia disattivato
                    toggle.disabled = false;
                }
                
                fetchZonesStatus(); // Aggiorna lo stato dal server
            } else {
                console.error(`Errore nella disattivazione della zona: ${data.error || 'Errore sconosciuto'}`);
                
                // Riprova se non abbiamo raggiunto il numero massimo di tentativi
                if (retryCount < maxRetries) {
                    retryCount++;
                    console.log(`Tentativo ${retryCount}/${maxRetries} di disattivare la zona ${zoneId}`);
                    setTimeout(attemptDeactivation, 500);
                } else {
                    // Dopo tutti i tentativi falliti, mostra un messaggio di errore
                    showToast(`Errore: ${data.error || 'Disattivazione zona fallita'}`, 'error');
                    
                    // Reset UI in caso di errore
                    if (toggle) {
                        toggle.checked = true; // Mantieni checked perché la zona è ancora attiva
                        toggle.disabled = false;
                    }
                    
                    if (zoneCard) zoneCard.classList.remove('loading-indicator');
                    fetchZonesStatus(); // Ricarica lo stato dal server
                }
            }
        })
        .catch(error => {
            console.error('Errore durante la disattivazione della zona:', error);
            
            // Riprova se non abbiamo raggiunto il numero massimo di tentativi
            if (retryCount < maxRetries) {
                retryCount++;
                console.log(`Tentativo ${retryCount}/${maxRetries} di disattivare la zona ${zoneId}`);
                setTimeout(attemptDeactivation, 500 * retryCount);
            } else {
                // Dopo tutti i tentativi falliti, mostra un messaggio di errore
                showToast('Errore di rete durante la disattivazione della zona', 'error');
                
                // Reset UI in caso di errore
                if (toggle) {
                    toggle.checked = true; // Mantieni checked perché la zona è ancora attiva
                    toggle.disabled = false;
                }
                
                if (zoneCard) zoneCard.classList.remove('loading-indicator');
                fetchZonesStatus(); // Ricarica lo stato dal server
            }
        });
    }
    
    // Avvia il primo tentativo
    attemptDeactivation();
}

// ====================== GESTIONE TIMER E PROGRESS BAR ======================
// Avvia il timer per una zona
function startZoneTimer(zoneId, totalSeconds) {
    const zoneId_str = zoneId.toString();
    
    // Ferma il timer esistente se presente
    if (activeZones[zoneId_str] && activeZones[zoneId_str].timer) {
        clearInterval(activeZones[zoneId_str].timer);
    }
    
    // Memorizza i dati della zona
    activeZones[zoneId_str] = {
        totalDuration: totalSeconds,
        remainingTime: totalSeconds,
        startTime: Date.now(),
        timer: null
    };
    
    // Aggiorna subito la barra di progresso
    updateProgressBar(zoneId_str, 0, totalSeconds);
    
    // Avvia il timer
    activeZones[zoneId_str].timer = setInterval(() => {
        // Calcola tempo trascorso
        const now = Date.now();
        const elapsed = Math.floor((now - activeZones[zoneId_str].startTime) / 1000);
        const remaining = Math.max(0, totalSeconds - elapsed);
        
        // Aggiorna tempo rimanente
        activeZones[zoneId_str].remainingTime = remaining;
        
        // Aggiorna la barra di progresso
        updateProgressBar(zoneId_str, elapsed, totalSeconds);
        
        // Se il timer è scaduto, ferma la zona
        if (remaining <= 0) {
            stopZoneTimer(zoneId);
            
            // Reset UI
            const toggle = document.getElementById(`toggle-${zoneId}`);
            const zoneCard = document.getElementById(`zone-${zoneId}`);
            const durationInput = document.getElementById(`duration-${zoneId}`);
            
            if (toggle) {
                toggle.checked = false;
                toggle.disabled = false;
            }
            if (zoneCard) zoneCard.classList.remove('active');
            if (durationInput) durationInput.disabled = false;
            
            // La zona sarà disattivata sul server al prossimo polling
        }
    }, 1000);
}

// Ferma il timer per una zona
function stopZoneTimer(zoneId) {
    const zoneId_str = zoneId.toString();
    
    if (activeZones[zoneId_str] && activeZones[zoneId_str].timer) {
        clearInterval(activeZones[zoneId_str].timer);
        delete activeZones[zoneId_str];
    }
    
    // Resetta la barra di progresso
    resetProgressBar(zoneId);
}

// Aggiorna la barra di progresso
function updateProgressBar(zoneId, elapsed, total) {
    const progressBar = document.getElementById(`progress-${zoneId}`);
    const timerDisplay = document.getElementById(`timer-${zoneId}`);
    
    if (!progressBar || !timerDisplay) return;
    
    // Calcola il valore percentuale
    const percentComplete = Math.min(100, Math.floor((elapsed / total) * 100));
    progressBar.value = percentComplete;
    
    // Aggiorna il display del timer
    const remaining = Math.max(0, total - elapsed);
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Resetta la barra di progresso
function resetProgressBar(zoneId) {
    const progressBar = document.getElementById(`progress-${zoneId}`);
    const timerDisplay = document.getElementById(`timer-${zoneId}`);
    
    if (progressBar) progressBar.value = 0;
    if (timerDisplay) timerDisplay.textContent = '00:00';
}

// ====================== GESTIONE STATO SERVER ======================
// Ottiene lo stato delle zone dal server
function fetchZonesStatus() {
    console.log("Recupero stato zone...");
    fetch('/get_zones_status')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dello stato delle zone');
            return response.json();
        })
        .then(zonesStatus => {
            console.log("Stato zone ricevuto:", zonesStatus);
            
            // Aggiorna l'UI delle zone
            updateZonesUI(zonesStatus);
        })
        .catch(error => {
            console.error('Errore nel recupero dello stato delle zone:', error);
        });
}

// Ottiene lo stato del programma dal server
function fetchProgramState() {
    console.log("Recupero stato programma...");
    fetch('/get_program_state')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dello stato del programma');
            return response.json();
        })
        .then(programState => {
            console.log("Stato programma ricevuto:", programState);
            
            // Gestisci lo stato del programma
            handleProgramState(programState);
        })
        .catch(error => {
            console.error('Errore nel recupero dello stato del programma:', error);
        });
}

// Gestisce lo stato del programma
function handleProgramState(programState) {
    console.log("Gestione stato programma:", programState);
    const programRunning = programState && programState.program_running;
    
    // Aggiorna UI in base allo stato del programma
    if (programRunning) {
        disableManualPage(programState);
        
        // Mostra il pulsante di stop
        const stopButton = document.getElementById('manual-stop-button');
        if (stopButton) {
            stopButton.classList.add('visible');
            
            // Ottieni nome programma se disponibile
            if (programState.current_program_id) {
                fetch('/data/program.json')
                    .then(response => response.json())
                    .then(programs => {
                        if (programs && programs[programState.current_program_id]) {
                            const programName = programs[programState.current_program_id].name || 'Programma';
                            stopButton.innerHTML = `<i>■</i> ARRESTA "${programName}"`;
                        }
                    })
                    .catch(err => console.error('Errore caricamento dettagli programma:', err));
            }
        }
    } else {
        enableManualPage();
        
        // Nascondi il pulsante di stop
        const stopButton = document.getElementById('manual-stop-button');
        if (stopButton) {
            stopButton.classList.remove('visible');
        }
    }
}

// Disabilita la pagina manual
function disableManualPage(programState) {
    console.log("Disabilitazione controllo manuale - Programma in esecuzione", programState);
    
    // Imposta flag globale
    disabledManualMode = true;
    
    // Disabilita tutte le card
    document.querySelectorAll('.zone-card').forEach(card => {
        card.classList.add('disabled-mode');
    });
    
    // Disabilita tutti gli input e toggle
    document.querySelectorAll('.zone-toggle, [id^="duration-"]').forEach(el => {
        el.disabled = true;
    });
    
    // Rimuovi overlay precedente se esiste
    const existingOverlay = document.getElementById('manual-page-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }
    
    // Crea e aggiunge l'overlay con nome programma
    let programName = "Programma in esecuzione";
    if (programState && programState.current_program_id) {
        fetch('/data/program.json')
            .then(response => response.json())
            .then(programs => {
                if (programs && programs[programState.current_program_id]) {
                    programName = programs[programState.current_program_id].name || 'Programma';
                }
                createOverlay(programName, programState);
            })
            .catch(err => {
                console.error('Errore caricamento dettagli programma:', err);
                createOverlay(programName, programState);
            });
    } else {
        createOverlay(programName, programState);
    }
}

// Crea l'overlay
function createOverlay(programName, programState) {
    const overlay = document.createElement('div');
    overlay.id = 'manual-page-overlay';
    overlay.className = 'manual-page-overlay';
    
    let zoneInfo = '';
    if (programState && programState.active_zone) {
        zoneInfo = `<p>Zona attualmente attiva: <strong>${programState.active_zone.name || 'Zona ' + (programState.active_zone.id + 1)}</strong></p>`;
    }
    
    overlay.innerHTML = `
        <div class="overlay-message">
            <h3>Controllo Manuale Disabilitato</h3>
            <p>"${programName}" è attualmente in esecuzione.</p>
            ${zoneInfo}
            <p>Il controllo manuale sarà disponibile al termine del programma.</p>
            <button onclick="window.stopProgram()" style="margin-top: 20px; background-color: #ff3333; color: white; border: none; padding: 12px 25px; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 2px 10px rgba(0,0,0,0.2);">
                ARRESTA PROGRAMMA
            </button>
        </div>
    `;
    
    document.body.appendChild(overlay);
    console.log("Overlay aggiunto al DOM");
}

// Riabilita la pagina manual
function enableManualPage() {
    console.log("Riabilitazione controllo manuale - Nessun programma in esecuzione");
    
    // Resetta flag globale
    disabledManualMode = false;
    
    // Riabilita tutte le card
    document.querySelectorAll('.zone-card').forEach(card => {
        card.classList.remove('disabled-mode');
    });
    
    // Riabilita tutti gli input e toggle (tranne per le zone attive)
    document.querySelectorAll('.zone-toggle:not(:checked), [id^="duration-"]').forEach(el => {
        const zoneId = el.id.split('-')[1];
        const toggle = document.getElementById(`toggle-${zoneId}`);
        
        // Non riabilitare input per zone attive
        if (!toggle || !toggle.checked) {
            el.disabled = false;
        }
    });
    
    // Rimuovi overlay se esiste
    const overlay = document.getElementById('manual-page-overlay');
    if (overlay) {
        overlay.remove();
    }
}

// Aggiorna l'UI delle zone
function updateZonesUI(zonesStatus) {
    if (!Array.isArray(zonesStatus)) return;
    
    // Aggiorna ogni zona
    zonesStatus.forEach(zone => {
        if (!zone || zone.id === undefined) return;
        
        const zoneId = zone.id;
        const toggle = document.getElementById(`toggle-${zoneId}`);
        const zoneCard = document.getElementById(`zone-${zoneId}`);
        const durationInput = document.getElementById(`duration-${zoneId}`);
        
        if (!toggle || !zoneCard) return;
        
        // Aggiorna stato toggle senza triggerare eventi
        if (toggle.checked !== zone.active) {
            // Rimuovi handler temporaneamente
            const originalOnChange = toggle.onchange;
            toggle.onchange = null;
            
            // Cambia stato
            toggle.checked = zone.active;
            
            // Ripristina handler
            setTimeout(() => {
                toggle.onchange = originalOnChange;
            }, 0);
        }
        
        // Aggiorna stato visivo
        if (zone.active) {
            zoneCard.classList.add('active');
            
            // Disabilita l'input durata
            if (durationInput) durationInput.disabled = true;
            
            // Se non c'è un timer locale per questa zona, crealo
            const zoneId_str = zoneId.toString();
            if (!activeZones[zoneId_str] || !activeZones[zoneId_str].timer) {
                // Determina durata totale
                let totalDuration = 0;
                
                // Da input utente
                if (durationInput && durationInput.value) {
                    totalDuration = parseInt(durationInput.value) * 60;
                } else {
                    // Stima dalla zona attiva
                    totalDuration = zone.remaining_time * 1.2; // Stima (rimanente + 20%)
                }
                
                // Imposta timer locale
                startZoneTimer(zoneId, totalDuration);
                
                // Aggiorna con il tempo rimanente dal server
                activeZones[zoneId_str].remainingTime = zone.remaining_time;
                
                // Calcola tempo trascorso
                const elapsed = activeZones[zoneId_str].totalDuration - zone.remaining_time;
                
                // Aggiusta startTime
                activeZones[zoneId_str].startTime = Date.now() - (elapsed * 1000);
            }
        } else {
            zoneCard.classList.remove('active');
            
            // Riabilita l'input durata se non è in modalità disabilitata
            if (durationInput && !disabledManualMode) {
                durationInput.disabled = false;
            }
            
            // Se c'è un timer locale per questa zona, fermalo
            stopZoneTimer(zoneId);
        }
    });
}

// ====================== ESPOSIZIONE FUNZIONI GLOBALI ======================
window.handleProgramState = handleProgramState;
window.enableManualPage = enableManualPage;
window.disableManualPage = disableManualPage;
window.fetchZonesStatus = fetchZonesStatus;
window.fetchProgramState = fetchProgramState;

// ====================== INIZIALIZZAZIONE ======================
// Inizializzazione a caricamento documento
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM caricato - Inizializzazione manual.js");
    
    if (window.userData && Object.keys(window.userData).length > 0) {
        initializeManualPage(window.userData);
    }
});