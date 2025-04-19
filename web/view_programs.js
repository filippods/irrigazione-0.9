// view_programs.js - Script per la pagina di visualizzazione programmi

// =================== VARIABILI GLOBALI ===================
window.programStatusInterval = null;       // Intervallo per il polling dello stato
window.programsData = {};                  // Cache dei dati dei programmi
window.zoneNameMap = {};                   // Mappatura ID zona -> nome zona
window.lastKnownState = null;              // Ultimo stato conosciuto (per confronti)
window.pollingAccelerated = false;         // Flag per indicare se il polling è accelerato
window.retryInProgress = false;            // Flag per evitare richieste multiple contemporanee

// Costanti di configurazione
window.NORMAL_POLLING_INTERVAL = 5000;     // 5 secondi per il polling normale
window.FAST_POLLING_INTERVAL = 1000;       // 1 secondo per il polling accelerato
window.MAX_API_RETRIES = 3;                // Numero massimo di tentativi per le chiamate API

// =================== INIZIALIZZAZIONE ===================

/**
 * Inizializza la pagina di visualizzazione programmi
 */
function initializeViewProgramsPage() {
    console.log("Inizializzazione pagina visualizzazione programmi");
    
    // Aggiungi stili CSS per lo stato di loading
    addCssStyles();
    
    // Carica i dati e mostra i programmi
    loadUserSettingsAndPrograms();
    
    // Avvia il polling dello stato dei programmi
    startProgramStatusPolling();
    
    // Ascoltatori per la pulizia quando l'utente lascia la pagina
    window.addEventListener('pagehide', cleanupViewProgramsPage);
    
    // Esponi la funzione di aggiornamento stato programma globalmente
    window.fetchProgramState = fetchProgramState;
    
    // Aggiungi listener globale per il click per assicurarsi che i pulsanti STOP funzionino sempre
    document.addEventListener('click', function(e) {
        // Trova il pulsante di stop o un suo elemento figlio
        let target = e.target;
        let stopBtn = null;
        
        // Se l'utente ha cliccato su un elemento all'interno del pulsante (es. icona o testo)
        if (target.closest('.global-stop-btn')) {
            stopBtn = target.closest('.global-stop-btn');
        }
        // Se l'utente ha cliccato direttamente sul pulsante
        else if (target.classList && target.classList.contains('global-stop-btn')) {
            stopBtn = target;
        }
        
        // Se abbiamo trovato un pulsante stop attivo
        if (stopBtn) {
            console.log("Clic intercettato su pulsante STOP globale!");
            stopProgram();
            e.preventDefault();
            e.stopPropagation();
        }
    });
}

/**
 * Aggiunge stili CSS necessari per la pagina
 */
function addCssStyles() {
    // Se non esiste già uno stile per la classe loading, aggiungilo
    if (!document.getElementById('loading-button-style')) {
        const style = document.createElement('style');
        style.id = 'loading-button-style';
        style.innerHTML = `
            .btn.loading {
                position: relative;
                color: transparent !important;
                pointer-events: none;
            }
            
            .btn.loading::after {
                content: "";
                position: absolute;
                width: 20px;
                height: 20px;
                top: 50%;
                left: 50%;
                margin-top: -10px;
                margin-left: -10px;
                border-radius: 50%;
                border: 2px solid rgba(255, 255, 255, 0.3);
                border-top-color: white;
                animation: button-spin 1s linear infinite;
            }
            
            @keyframes button-spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }
}

/**
 * Pulisce le risorse quando l'utente lascia la pagina
 */
function cleanupViewProgramsPage() {
    stopProgramStatusPolling();
}

// =================== GESTIONE POLLING ===================

/**
 * Avvia il polling dello stato dei programmi
 */
function startProgramStatusPolling() {
    // Esegui subito
    fetchProgramState();
    
    // Imposta l'intervallo per il polling e adatta in base allo stato
    let pollingInterval = NORMAL_POLLING_INTERVAL;
    
    // Adatta l'intervallo di polling in base allo stato del programma
    if (lastKnownState && lastKnownState.program_running) {
        pollingInterval = FAST_POLLING_INTERVAL;
    }
    
    window.programStatusInterval = setInterval(fetchProgramState, pollingInterval);
    console.log("Polling dello stato dei programmi avviato");
    
    // Aggiungi listener per visibilità pagina se necessario
    document.addEventListener('visibilitychange', function() {
        if (document.hidden && window.programStatusInterval) {
            // Se la pagina non è visibile, polling più lento
            clearInterval(window.programStatusInterval);
            window.programStatusInterval = setInterval(fetchProgramState, NORMAL_POLLING_INTERVAL * 2);
        } else if (!document.hidden && window.programStatusInterval) {
            // Quando la pagina diventa visibile, ripristina polling normale
            clearInterval(window.programStatusInterval);
            
            // Adatta l'intervallo in base allo stato
            let newInterval = lastKnownState && lastKnownState.program_running ? 
                FAST_POLLING_INTERVAL : NORMAL_POLLING_INTERVAL;
                
            window.programStatusInterval = setInterval(fetchProgramState, newInterval);
        }
    });
}

/**
 * Ferma il polling dello stato dei programmi
 */
function stopProgramStatusPolling() {
    if (window.programStatusInterval) {
        clearInterval(window.programStatusInterval);
        window.programStatusInterval = null;
        console.log("Polling dello stato dei programmi fermato");
    }
}

/**
 * Ottiene lo stato del programma corrente con gestione degli errori migliorata
 */
function fetchProgramState() {
    // Evita richieste sovrapposte se una è in corso e in retry
    if (retryInProgress) return;
    
    fetch('/get_program_state')
        .then(response => {
            if (!response.ok) throw new Error(`Errore HTTP: ${response.status}`);
            return response.json();
        })
        .then(state => {
            if (state && typeof state === 'object') {
                // Salva l'ultimo stato conosciuto per confronti
                const previousState = lastKnownState;
                lastKnownState = state;
                
                console.log("Stato programma ricevuto:", state);
                
                // Aggiorna l'UI con il nuovo stato
                updateProgramsUI(state);
                
                // Se c'è un programma in esecuzione, aggiorna l'UI con maggiori dettagli
                if (state.program_running && state.current_program_id) {
                    updateRunningProgramStatus(state);
                    
                    // Se siamo passati da non in esecuzione a in esecuzione, accelera il polling
                    if (previousState && !previousState.program_running && !pollingAccelerated) {
                        acceleratePolling();
                    }
                    
                    // Mostra il pulsante globale di arresto
                    showGlobalStopButton(state);
                } else {
                    // Rimuovi eventuali indicatori di stato se non c'è un programma in esecuzione
                    hideRunningStatus();
                    
                    // Nascondi il pulsante globale di arresto
                    hideGlobalStopButton();
                    
                    // Se siamo passati da in esecuzione a non in esecuzione, ripristina polling normale
                    if (previousState && previousState.program_running && pollingAccelerated) {
                        restoreNormalPolling();
                    }
                }
            } else {
                console.error("Formato di risposta non valido per lo stato del programma");
            }
        })
        .catch(error => {
            console.error('Errore nel recupero dello stato del programma:', error);
            // Non aggiorniamo l'UI in caso di errore per evitare visualizzazioni errate
        });
}

/**
 * Accelera temporaneamente il polling durante l'esecuzione iniziale di un programma
 */
function acceleratePolling() {
    if (pollingAccelerated) return;
    
    console.log("Accelerazione polling per monitoraggio stato");
    pollingAccelerated = true;
    
    // Ferma il polling normale
    stopProgramStatusPolling();
    
    // Imposta un intervallo più frequente
    window.programStatusInterval = setInterval(fetchProgramState, FAST_POLLING_INTERVAL);
    
    // Dopo 15 secondi, ripristina l'intervallo normale
    setTimeout(restoreNormalPolling, 15000);
}

/**
 * Ripristina il polling normale
 */
function restoreNormalPolling() {
    if (!pollingAccelerated) return;
    
    console.log("Ripristino polling normale");
    pollingAccelerated = false;
    
    // Ferma il polling accelerato
    stopProgramStatusPolling();
    
    // Ripristina l'intervallo normale
    window.programStatusInterval = setInterval(fetchProgramState, NORMAL_POLLING_INTERVAL);
}

// =================== CARICAMENTO DATI ===================

/**
 * Carica le impostazioni utente e i programmi
 */
function loadUserSettingsAndPrograms() {
    // Mostra l'indicatore di caricamento
    const programsContainer = document.getElementById('programs-container');
    if (programsContainer) {
        programsContainer.innerHTML = '<div class="loading">Caricamento programmi...</div>';
    }
    
    // Uso Promise.all per fare richieste parallele
    Promise.all([
        // Carica le impostazioni utente per ottenere i nomi delle zone
        fetch('/data/user_settings.json').then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento delle impostazioni utente');
            return response.json();
        }),
        // Carica i programmi
        fetch('/data/program.json').then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dei programmi');
            return response.json();
        }),
        // Carica lo stato corrente
        fetch('/get_program_state').then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dello stato del programma');
            return response.json();
        })
    ])
    .then(([settings, programs, state]) => {
        // Salva l'ultimo stato conosciuto
        lastKnownState = state;
        
        // Crea una mappa di ID zona -> nome zona
        zoneNameMap = {};
        if (settings.zones && Array.isArray(settings.zones)) {
            settings.zones.forEach(zone => {
                if (zone && zone.id !== undefined) {
                    zoneNameMap[zone.id] = zone.name || `Zona ${zone.id + 1}`;
                }
            });
        }
        
        // Salva i programmi per riferimento futuro
        window.programsData = programs || {};
        
        // Ora che abbiamo tutti i dati necessari, possiamo renderizzare i programmi
        renderProgramCards(window.programsData, state);
    })
    .catch(error => {
        console.error('Errore nel caricamento dei dati:', error);
        
        if (typeof showToast === 'function') {
            showToast('Errore nel caricamento dei dati', 'error');
        }
        
        // Mostra un messaggio di errore con pulsante di riprova
        const programsContainer = document.getElementById('programs-container');
        if (programsContainer) {
            programsContainer.innerHTML = `
                <div class="empty-state">
                    <h3>Errore nel caricamento dei programmi</h3>
                    <p>${error.message}</p>
                    <button class="btn" onclick="loadUserSettingsAndPrograms()">Riprova</button>
                </div>
            `;
        }
    });
}

// =================== RENDERING UI ===================

/**
 * Renderizza le card dei programmi
 * @param {Object} programs - Oggetto contenente i programmi
 * @param {Object} state - Oggetto contenente lo stato corrente
 */
function renderProgramCards(programs, state) {
    const container = document.getElementById('programs-container');
    if (!container) return;
    
    const programIds = programs ? Object.keys(programs) : [];
    
    if (!programs || programIds.length === 0) {
        // Nessun programma trovato
        container.innerHTML = `
            <div class="empty-state">
                <h3>Nessun programma configurato</h3>
                <p>Crea il tuo primo programma di irrigazione per iniziare a usare il sistema.</p>
                <button class="btn" onclick="loadPage('create_program.html')">Crea Programma</button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = '';
    
    // Per ogni programma, crea una card
    programIds.forEach(programId => {
        const program = programs[programId];
        if (!program) return; // Salta se il programma è nullo
        
        // Assicurati che l'ID del programma sia disponibile nell'oggetto
        if (program.id === undefined) {
            program.id = programId;
        }
        
        const isActive = state.program_running && state.current_program_id === String(programId);
        
        // Costruisci la visualizzazione dei mesi
        const monthsHtml = buildMonthsGrid(program.months || []);
        
        // Costruisci la visualizzazione delle zone
        const zonesHtml = buildZonesGrid(program.steps || []);
        
        // Get the automatic status (default to true for backward compatibility)
        const isAutomatic = program.automatic_enabled !== false;
        
        // Prepara i pulsanti con stati corretti
        const startButtonHtml = isActive 
            ? `<button class="btn btn-start disabled" disabled title="Programma in esecuzione" style="width: 100%;">
                <span class="btn-icon">▶</span> Programma in esecuzione
               </button>`
            : `<button class="btn btn-start" onclick="startProgram('${programId}')" title="Avvia programma" style="width: 100%;">
                <span class="btn-icon">▶</span> Avvio Manuale
               </button>`;
        
        // Card del programma
        const programCard = document.createElement('div');
        programCard.className = `program-card ${isActive ? 'active-program' : ''}`;
        programCard.setAttribute('data-program-id', programId);
        
        programCard.innerHTML = `
            <div class="program-header">
                <h3>${program.name || 'Programma senza nome'}</h3>
                ${isActive ? '<div class="active-indicator">In esecuzione</div>' : ''}
            </div>
            <div class="program-content">
                <div class="info-row">
                    <div class="info-label">Orario:</div>
                    <div class="info-value">${program.activation_time || 'Non impostato'}</div>
                </div>
                <div class="info-row">
                    <div class="info-label">Cadenza:</div>
                    <div class="info-value">${formatRecurrence(program.recurrence, program.interval_days)}</div>
                </div>
                <div class="info-row">
                    <div class="info-label">Ultima esecuzione:</div>
                    <div class="info-value">${program.last_run_date || 'Mai eseguito'}</div>
                </div>
                <div class="info-row">
                    <div class="info-label">Mesi attivi:</div>
                    <div class="info-value">
                        <div class="months-grid">
                            ${monthsHtml}
                        </div>
                    </div>
                </div>
                <div class="info-row">
                    <div class="info-label">Zone:</div>
                    <div class="info-value">
                        <div class="zones-grid">
                            ${zonesHtml}
                        </div>
                    </div>
                </div>
                <!-- Row for automatic execution toggle -->
                <div class="info-row auto-execution-row">
                    <div class="info-value" style="display: flex; align-items: center; justify-content: space-between;">
                        <div id="auto-icon-${programId}" class="auto-status ${isAutomatic ? 'on' : 'off'}">
                            <i></i>
                            <span>Attivazione automatica: ${isAutomatic ? 'ON' : 'OFF'}</span>
                        </div>
                        <label class="toggle-switch">
                            <input type="checkbox" id="auto-switch-${programId}" 
                                   class="auto-program-toggle" 
                                   data-program-id="${programId}" 
                                   ${isAutomatic ? 'checked' : ''}
                                   onchange="toggleProgramAutomatic('${programId}', this.checked)">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </div>
            <div class="program-actions">
                <!-- Solo pulsante Avvio Manuale, senza OFF -->
                <div class="action-row" style="grid-template-columns: 1fr;">
                    ${startButtonHtml}
                </div>
                <div class="action-row">
                    <button class="btn btn-edit" onclick="editProgram('${programId}')">
                        <span class="btn-icon">✎</span> Modifica
                    </button>
                    <button class="btn btn-delete" onclick="deleteProgram('${programId}')">
                        <span class="btn-icon">🗑</span> Elimina
                    </button>
                </div>
            </div>
        `;
        
        container.appendChild(programCard);
    });
    
    // Mostra/Nascondi pulsante globale di arresto in base allo stato
    if (state.program_running && state.current_program_id) {
        showGlobalStopButton(state);
    } else {
        hideGlobalStopButton();
    }
}

/**
 * Aggiorna l'interfaccia in base allo stato corrente
 */
function updateProgramsUI(state) {
    const currentProgramId = state.current_program_id;
    const programRunning = state.program_running;
    
    console.log(`Aggiornamento UI programmi - In esecuzione: ${programRunning}, ID: ${currentProgramId}`);
    
    // Aggiorna tutte le card dei programmi
    document.querySelectorAll('.program-card').forEach(card => {
        const cardProgramId = card.getAttribute('data-program-id');
        // Assicuriamo il confronto tra stringhe per evitare problemi di tipo
        const isActive = programRunning && String(cardProgramId) === String(currentProgramId);
        
        // Aggiorna classe attiva
        if (isActive) {
            card.classList.add('active-program');
            
            // Aggiungi indicatore se non esiste
            if (!card.querySelector('.active-indicator')) {
                const programHeader = card.querySelector('.program-header');
                if (programHeader) {
                    const indicator = document.createElement('div');
                    indicator.className = 'active-indicator';
                    indicator.textContent = 'In esecuzione';
                    programHeader.appendChild(indicator);
                }
            }
        } else {
            card.classList.remove('active-program');
            
            // Rimuovi indicatore se esiste
            const indicator = card.querySelector('.active-indicator');
            if (indicator) {
                indicator.remove();
            }
        }
        
        // Aggiorna pulsanti
        const startBtn = card.querySelector('.btn-start');

        if (startBtn) {
            if (isActive) {
                // Disabilita il pulsante START (programma già in esecuzione)
                startBtn.classList.add('disabled');
                startBtn.disabled = true;
                startBtn.innerHTML = '<span class="btn-icon">▶</span> Programma in esecuzione';
            } else if (programRunning) {
                // Un altro programma è attivo
                startBtn.classList.add('disabled');
                startBtn.disabled = true;
                startBtn.innerHTML = '<span class="btn-icon">▶</span> Altro programma in esecuzione';
            } else {
                // Nessun programma è attivo
                startBtn.classList.remove('disabled');
                startBtn.disabled = false;
                startBtn.innerHTML = '<span class="btn-icon">▶</span> Avvio Manuale';
            }
        }
    });
    
    // Mostra/nascondi il pulsante globale di stop
    if (programRunning && currentProgramId) {
        showGlobalStopButton(state);
    } else {
        hideGlobalStopButton();
    }
}

/**
 * Aggiorna le informazioni dettagliate sul programma in esecuzione
 * @param {Object} state - Stato del programma
 */
function updateRunningProgramStatus(state) {
    // Ottieni il div per il programma attivo, se esiste
    const activeCard = document.querySelector(`.program-card[data-program-id="${state.current_program_id}"]`);
    
    if (!activeCard) return;
    
    // Se abbiamo informazioni sulla zona attiva, mostrale
    if (state.active_zone) {
        // Crea o aggiorna la sezione di stato di esecuzione
        let statusSection = activeCard.querySelector('.running-status-section');
        
        if (!statusSection) {
            // Crea la sezione se non esiste già
            statusSection = document.createElement('div');
            statusSection.className = 'running-status-section';
            
            // Inseriscila prima delle azioni
            const programActions = activeCard.querySelector('.program-actions');
            if (programActions) {
                activeCard.insertBefore(statusSection, programActions);
            }
        }
        
        // Calcola il tempo rimanente in formato leggibile
        const remainingSeconds = state.active_zone.remaining_time || 0;
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        // Determina l'avanzamento della zona attiva
        let progressPercentage = 0;
        const steps = window.programsData[state.current_program_id]?.steps || [];
        const currentStep = steps.find(step => parseInt(step.zone_id) === parseInt(state.active_zone.id));
        
        if (currentStep) {
            const totalSeconds = currentStep.duration * 60;
            const elapsedSeconds = totalSeconds - remainingSeconds;
            progressPercentage = Math.min(Math.max((elapsedSeconds / totalSeconds) * 100, 0), 100);
        } else {
            // Fallback
            progressPercentage = calculateProgressPercentage(remainingSeconds);
        }
        
        // Aggiorna il contenuto dello status section
        statusSection.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 5px;">Stato di Esecuzione:</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span>Zona Attiva:</span>
                <span>${state.active_zone.name || `Zona ${state.active_zone.id + 1}`}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span>Tempo Rimanente:</span>
                <span>${formattedTime}</span>
            </div>
            <div class="progress-bar-container">
                <div class="progress-bar" style="width: ${progressPercentage}%;"></div>
            </div>
        `;
    }
}

/**
 * Nasconde gli elementi di stato quando un programma non è in esecuzione
 */
function hideRunningStatus() {
    const statusSections = document.querySelectorAll('.running-status-section');
    statusSections.forEach(section => {
        section.remove();
    });
}

/**
 * Mostra il pulsante globale di arresto
 */
function showGlobalStopButton(state) {
    const stopButton = document.getElementById('global-stop-button');
    if (!stopButton) return;

    // Aggiorna il testo con il nome del programma in esecuzione
    const programNameElem = document.getElementById('active-program-name');
    
    if (programNameElem && state.current_program_id) {
        // Ottieni informazioni sul programma
        const program = window.programsData[state.current_program_id];
        const programName = program ? program.name : 'Programma in esecuzione';
        programNameElem.textContent = programName;
    }
    
    // Mostra il pulsante
    stopButton.style.display = 'block';
}

/**
 * Nasconde il pulsante globale di arresto
 */
function hideGlobalStopButton() {
    const stopButton = document.getElementById('global-stop-button');
    if (stopButton) {
        stopButton.style.display = 'none';
    }
}

/**
 * Costruisce la griglia dei mesi
 * @param {Array} activeMonths - Array di mesi attivi
 * @returns {string} HTML per la griglia dei mesi
 */
function buildMonthsGrid(activeMonths) {
    const months = [
        'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 
        'Maggio', 'Giugno', 'Luglio', 'Agosto', 
        'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
    ];
    
    // Crea un Set per controlli di appartenenza più efficienti
    const activeMonthsSet = new Set(activeMonths || []);
    
    return months.map(month => {
        const isActive = activeMonthsSet.has(month);
        return `
            <div class="month-tag ${isActive ? 'active' : 'inactive'}">
                ${month.substring(0, 3)}
            </div>
        `;
    }).join('');
}

/**
 * Costruisce la griglia delle zone
 * @param {Array} steps - Array di passi del programma
 * @returns {string} HTML per la griglia delle zone
 */
function buildZonesGrid(steps) {
    if (!steps || steps.length === 0) {
        return '<div class="zone-tag" style="grid-column: 1/-1; text-align: center;">Nessuna zona configurata</div>';
    }
    
    return steps.map(step => {
        if (!step || step.zone_id === undefined) return '';
        
        const zoneName = zoneNameMap[step.zone_id] || `Zona ${step.zone_id + 1}`;
        return `
            <div class="zone-tag">
                ${zoneName}
                <span class="duration">${step.duration || 0} min</span>
            </div>
        `;
    }).join('');
}

/**
 * Calcola la percentuale di avanzamento per la barra di progresso
 * @param {number} remainingSeconds - Secondi rimanenti 
 * @returns {number} Percentuale di avanzamento
 */
function calculateProgressPercentage(remainingSeconds) {
    // Questa è un'approssimazione, in quanto non conosciamo la durata totale della zona
    // quindi assumiamo che la maggior parte delle zone durano circa 10 minuti
    const estimatedTotalSeconds = 10 * 60;
    const elapsedSeconds = estimatedTotalSeconds - remainingSeconds;
    const elapsedPercentage = (elapsedSeconds / estimatedTotalSeconds * 100);
    
    // Limita il valore tra 0 e 100
    return Math.min(Math.max(elapsedPercentage, 0), 100);
}

/**
 * Formatta la cadenza per la visualizzazione
 * @param {string} recurrence - Tipo di ricorrenza
 * @param {number} interval_days - Intervallo giorni per ricorrenza personalizzata
 * @returns {string} Descrizione formattata della ricorrenza
 */
function formatRecurrence(recurrence, interval_days) {
    if (!recurrence) return 'Non impostata';
    
    switch (recurrence) {
        case 'giornaliero':
            return 'Ogni giorno';
        case 'giorni_alterni':
            return 'Giorni alterni';
        case 'personalizzata':
            return `Ogni ${interval_days || 1} giorn${interval_days === 1 ? 'o' : 'i'}`;
        default:
            return recurrence;
    }
}

// =================== AZIONI PROGRAMMI ===================

/**
 * Avvia un programma
 * @param {string} programId - ID del programma da avviare
 */
function startProgram(programId) {
    // Previeni clic multipli
    if (retryInProgress) return;
    retryInProgress = true;
    
    const startBtn = document.querySelector(`.program-card[data-program-id="${programId}"] .btn-start`);
    if (startBtn) {
        startBtn.classList.add('loading');
        startBtn.disabled = true;
    }
    
    // Mostra un toast per feedback immediato
    if (typeof showToast === 'function') {
        showToast('Avvio del programma in corso...', 'info');
    }
    
    // Tenta più volte la richiesta in caso di errore di rete
    let retryCount = 0;
    
    function attemptStartProgram() {
        fetch('/start_program', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ program_id: programId })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Errore HTTP: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            retryInProgress = false;
            
            if (startBtn) {
                startBtn.classList.remove('loading');
            }
            
            if (data.success) {
                if (typeof showToast === 'function') {
                    showToast('Programma avviato con successo', 'success');
                }
                // Aggiorna immediatamente l'interfaccia e accelera il polling
                fetchProgramState();
                acceleratePolling();
            } else {
                if (typeof showToast === 'function') {
                    showToast(`Errore nell'avvio del programma: ${data.error || 'Errore sconosciuto'}`, 'error');
                }
                
                // Riabilita il pulsante in caso di errore
                if (startBtn) {
                    startBtn.classList.remove('disabled');
                    startBtn.disabled = false;
                }
            }
        })
        .catch(error => {
            console.error("Errore durante l'avvio del programma:", error);
            
            // Tenta nuovamente se non abbiamo raggiunto il numero massimo di tentativi
            if (retryCount < MAX_API_RETRIES) {
                retryCount++;
                console.log(`Tentativo di avviare il programma ${retryCount}/${MAX_API_RETRIES}`);
                
                // Ritenta dopo un breve ritardo
                setTimeout(attemptStartProgram, 500 * retryCount);
            } else {
                retryInProgress = false;
                
                if (startBtn) {
                    startBtn.classList.remove('loading');
                    startBtn.disabled = false;
                }
                
                if (typeof showToast === 'function') {
                    showToast("Errore di rete durante l'avvio del programma", 'error');
                }
            }
        });
    }
    
    // Avvia il primo tentativo
    attemptStartProgram();
}

/**
 * Arresta il programma in esecuzione
 * IMPORTANTE: Questa funzione è esposta globalmente
 */
function stopProgram() {
    // Previeni clic multipli
    if (retryInProgress) {
        console.log("Operazione già in corso, ignorata");
        return;
    }
    
    console.log("Tentativo di arrestare il programma");
    retryInProgress = true;
    
    // Nascondi il pulsante globale di stop (feedback immediato)
    const globalStopButton = document.getElementById('global-stop-button');
    if (globalStopButton) {
        globalStopButton.style.display = 'none';
    }
    
    // Mostra un toast per feedback immediato
    if (typeof showToast === 'function') {
        showToast('Arresto del programma in corso...', 'info');
    }
    
    // Tenta più volte la richiesta in caso di errore di rete
    let retryCount = 0;
    
    function attemptStopProgram() {
        console.log(`Tentativo ${retryCount + 1} di arrestare il programma`);
        
        fetch('/stop_program', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Errore HTTP: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            retryInProgress = false;
            
            if (data.success) {
                console.log("Programma arrestato con successo");
                if (typeof showToast === 'function') {
                    showToast('Programma arrestato con successo', 'success');
                }
                // Aggiorna immediatamente l'interfaccia
                fetchProgramState();
                
                // Aggiorna il banner di stato se esiste
                if (typeof updateProgramStatusBanner === 'function') {
                    updateProgramStatusBanner({ program_running: false });
                }
            } else {
                console.error(`Errore nell'arresto del programma: ${data.error || 'Errore sconosciuto'}`);
                if (typeof showToast === 'function') {
                    showToast(`Errore nell'arresto del programma: ${data.error || 'Errore sconosciuto'}`, 'error');
                }
                
                // Rimostra il pulsante globale in caso di errore
                if (globalStopButton && lastKnownState && lastKnownState.program_running) {
                    globalStopButton.style.display = 'block';
                }
            }
        })
        .catch(error => {
            console.error("Errore durante l'arresto del programma:", error);
            
            // Tenta nuovamente se non abbiamo raggiunto il numero massimo di tentativi
            if (retryCount < MAX_API_RETRIES) {
                retryCount++;
                console.log(`Nuovo tentativo di arrestare il programma ${retryCount}/${MAX_API_RETRIES}`);
                
                // Ritenta dopo un breve ritardo (con aumenti progressivi)
                setTimeout(attemptStopProgram, 500 * retryCount);
            } else {
                retryInProgress = false;
                
                if (typeof showToast === 'function') {
                    showToast("Errore di rete durante l'arresto del programma", 'error');
                }
                
                // Rimostra il pulsante globale in caso di errore
                if (globalStopButton && lastKnownState && lastKnownState.program_running) {
                    globalStopButton.style.display = 'block';
                }
            }
        });
    }
    
    // Avvia il primo tentativo
    attemptStopProgram();
}

/**
 * Vai alla pagina di modifica del programma
 * @param {string} programId - ID del programma da modificare
 */
function editProgram(programId) {
    // Salva l'ID del programma in localStorage per recuperarlo nella pagina di modifica
    localStorage.setItem('editProgramId', programId);
    
    // Vai alla pagina dedicata alla modifica
    loadPage('modify_program.html');
}

/**
 * Elimina un programma
 * @param {string} programId - ID del programma da eliminare
 */
function deleteProgram(programId) {
    if (!confirm('Sei sicuro di voler eliminare questo programma? Questa operazione non può essere annullata.')) {
        return;
    }
    
    // Mostra un toast per feedback immediato
    if (typeof showToast === 'function') {
        showToast('Eliminazione del programma in corso...', 'info');
    }
    
    // Mostra un indicatore di caricamento sulla card
    const programCard = document.querySelector(`.program-card[data-program-id="${programId}"]`);
    if (programCard) {
        // Aggiunge un overlay di caricamento
        const loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'loading-overlay';
        loadingOverlay.style.cssText = `
            position: absolute; 
            top: 0; 
            left: 0; 
            width: 100%; 
            height: 100%; 
            background-color: rgba(255,255,255,0.7); 
            display: flex; 
            justify-content: center; 
            align-items: center;
            z-index: 100;
            border-radius: 12px;
        `;
        loadingOverlay.innerHTML = '<div class="loading" style="position: static; transform: scale(0.6);"></div>';
        programCard.style.position = 'relative';
        programCard.appendChild(loadingOverlay);
    }
    
    // Disabilita pulsanti di azione
    const actionButtons = programCard ? programCard.querySelectorAll('.btn') : [];
    actionButtons.forEach(btn => {
        btn.disabled = true;
    });
    
    fetch('/delete_program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: programId })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast('Programma eliminato con successo', 'success');
            }
            // Effetto di dissolvenza prima di rimuovere la card
            if (programCard) {
                programCard.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                programCard.style.opacity = '0';
                programCard.style.transform = 'scale(0.9)';
                
                // Rimuovi la card dopo l'animazione
                setTimeout(() => {
                    programCard.remove();
                    
                    // Se era l'unico programma, mostra il messaggio "nessun programma"
                    const container = document.getElementById('programs-container');
                    if (container && !container.querySelector('.program-card')) {
                        container.innerHTML = `
                            <div class="empty-state">
                                <h3>Nessun programma configurato</h3>
                                <p>Crea il tuo primo programma di irrigazione per iniziare a usare il sistema.</p>
                                <button class="btn" onclick="loadPage('create_program.html')">Crea Programma</button>
                            </div>
                        `;
                    }
                }, 500);
            } else {
                // Ricarica i programmi se non troviamo la card
                loadUserSettingsAndPrograms();
            }
        } else {
            // Rimuovi l'overlay di caricamento
            if (programCard) {
                const loadingOverlay = programCard.querySelector('.loading-overlay');
                if (loadingOverlay) {
                    loadingOverlay.remove();
                }
            }
            
            // Riabilita i pulsanti
            actionButtons.forEach(btn => {
                btn.disabled = false;
            });
            
            if (typeof showToast === 'function') {
                showToast(`Errore nell'eliminazione del programma: ${data.error || 'Errore sconosciuto'}`, 'error');
            }
        }
    })
    .catch(error => {
        console.error("Errore durante l'eliminazione del programma:", error);
        
        // Rimuovi l'overlay di caricamento
        if (programCard) {
            const loadingOverlay = programCard.querySelector('.loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.remove();
            }
        }
        
        // Riabilita i pulsanti
        actionButtons.forEach(btn => {
            btn.disabled = false;
        });
        
        if (typeof showToast === 'function') {
            showToast("Errore di rete durante l'eliminazione del programma", 'error');
        }
    });
}

/**
 * Attiva o disattiva l'automatizzazione di un programma
 * @param {string} programId - ID del programma
 * @param {boolean} enable - true per attivare, false per disattivare
 */
function toggleProgramAutomatic(programId, enable) {
    // Previeni manipolazioni durante il processo
    const toggle = document.getElementById(`auto-switch-${programId}`);
    if (toggle) toggle.disabled = true;
    
    fetch('/toggle_program_automatic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program_id: programId, enable: enable })
    })
    .then(response => response.json())
    .then(data => {
        if (toggle) toggle.disabled = false;
        
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast(`Automazione del programma ${enable ? 'attivata' : 'disattivata'} con successo`, 'success');
            }
            
            // Update the UI to reflect the new state
            const autoSwitch = document.getElementById(`auto-switch-${programId}`);
            if (autoSwitch) {
                autoSwitch.checked = enable;
            }
            
            // Aggiorna l'icona nella card
            const autoIcon = document.getElementById(`auto-icon-${programId}`);
            if (autoIcon) {
                autoIcon.className = enable ? 'auto-status on' : 'auto-status off';
                autoIcon.querySelector('span').textContent = `Attivazione automatica: ${enable ? 'ON' : 'OFF'}`;
            }
            
            // Aggiorna i dati salvati localmente
            if (window.programsData[programId]) {
                window.programsData[programId].automatic_enabled = enable;
            }
        } else {
            if (typeof showToast === 'function') {
                showToast(`Errore: ${data.error || 'Errore sconosciuto'}`, 'error');
            }
            
            // Ripristina lo stato dell'interruttore in caso di errore
            const autoSwitch = document.getElementById(`auto-switch-${programId}`);
            if (autoSwitch) {
                autoSwitch.checked = !enable; // Inverti lo stato
            }
        }
    })
    .catch(error => {
        if (toggle) toggle.disabled = false;
        
        console.error('Errore di rete:', error);
        if (typeof showToast === 'function') {
            showToast('Errore di rete', 'error');
        }
        
        // Ripristina lo stato dell'interruttore in caso di errore
        const autoSwitch = document.getElementById(`auto-switch-${programId}`);
        if (autoSwitch) {
            autoSwitch.checked = !enable; // Inverti lo stato
        }
    });
}

// Esponi funzione stopProgram globalmente
window.stopProgram = stopProgram;

// Inizializzazione al caricamento del documento
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOMContentLoaded: Avvio inizializzazione view_programs");
    initializeViewProgramsPage();
});