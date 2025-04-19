// settings.js - Script per la pagina impostazioni

// Variabili globali
var isLoading = false;
var settingsStatusInterval = null;
var wifiNetworks = [];
var settingsModified = {
    wifi: false,
    zones: false,
    advanced: false
};

// Funzione per inizializzare la pagina delle impostazioni
function initializeSettingsPage(userData) {
    console.log("Inizializzazione pagina impostazioni con dati:", userData);
    
    if (userData && Object.keys(userData).length > 0) {
        loadSettingsWithData(userData);
    } else {
        // Se userData non è già disponibile, carica dal server
        fetch('/data/user_settings.json')
            .then(response => {
                if (!response.ok) throw new Error('Errore nel caricamento delle impostazioni utente');
                return response.json();
            })
            .then(data => {
                console.log("Dati impostazioni caricati dal server:", data);
                loadSettingsWithData(data);
            })
            .catch(error => {
                console.error('Errore:', error);
                showToast('Errore nel caricamento delle impostazioni', 'error');
            });
    }
    
    // Inizia il polling dello stato connessione
    startConnectionStatusPolling();
    
    // Ascoltatori per il cambio di pagina
    window.addEventListener('pagehide', cleanupSettingsPage);
    
    // Ascoltatori per rilevare modifiche ai campi
    addChangeListeners();
}

// Carica le impostazioni con i dati forniti
function loadSettingsWithData(data) {
    console.log("Caricamento impostazioni con dati:", data);
    window.userData = data || {};
    
    // Impostazioni WiFi
    document.getElementById('client-enabled').checked = data.client_enabled || false;
    toggleWifiClientSettings(data.client_enabled || false);
    
    if (data.wifi) {
        const wifiSsid = data.wifi.ssid || '';
        // Aggiungi l'opzione del SSID corrente alla lista WiFi se non vuota
        if (wifiSsid) {
            const wifiListSelect = document.getElementById('wifi-list');
            if (wifiListSelect) {
                wifiListSelect.innerHTML = `<option value="${wifiSsid}">${wifiSsid}</option>`;
            }
        }
        document.getElementById('wifi-password').value = data.wifi.password || '';
    }
    
    if (data.ap) {
        document.getElementById('ap-ssid').value = data.ap.ssid || 'IrrigationSystem';
        document.getElementById('ap-password').value = data.ap.password || '12345678';
    }
    
    // Impostazioni zone
    renderZonesSettings(data.zones || []);
    
    // Impostazioni avanzate
    document.getElementById('max-active-zones').value = data.max_active_zones || 3;
    document.getElementById('activation-delay').value = data.activation_delay || 0;
    document.getElementById('max-zone-duration').value = data.max_zone_duration || 180;
    
    // Imposta il valore del pin del relè di sicurezza
    const safetyRelayPin = data.safety_relay && data.safety_relay.pin !== undefined ? 
                        data.safety_relay.pin : 13;
    document.getElementById('safety-relay-pin').value = safetyRelayPin;
    
    document.getElementById('automatic-programs-enabled').checked = data.automatic_programs_enabled || false;
    
    // Resetta i flag delle modifiche
    settingsModified = {
        wifi: false,
        zones: false,
        advanced: false
    };
}

// Aggiungi listener per rilevare modifiche ai campi
function addChangeListeners() {
    // Wifi settings
    const wifiElements = [
        'client-enabled', 'wifi-list', 'wifi-password', 
        'ap-ssid', 'ap-password'
    ];
    
    wifiElements.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', () => {
                settingsModified.wifi = true;
            });
            
            if (element.type === 'text' || element.type === 'password') {
                element.addEventListener('input', () => {
                    settingsModified.wifi = true;
                });
            }
        }
    });
    
    // Advanced settings
    const advancedElements = [
        'max-active-zones', 'activation-delay', 'max-zone-duration',
        'safety-relay-pin', 'automatic-programs-enabled'
    ];
    
    advancedElements.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', () => {
                settingsModified.advanced = true;
            });
            
            if (element.type === 'number') {
                element.addEventListener('input', () => {
                    settingsModified.advanced = true;
                });
            }
        }
    });
}

// Genera la griglia delle zone con i dati forniti
function renderZonesSettings(zones) {
    console.log("Rendering zone settings con:", zones);
    const zonesGrid = document.getElementById('zones-grid');
    if (!zonesGrid) {
        console.error("Elemento zones-grid non trovato");
        return;
    }
    
    zonesGrid.innerHTML = '';
    
    if (!zones || !Array.isArray(zones) || zones.length === 0) {
        zonesGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Nessuna zona configurata</p>';
        return;
    }
    
    // Assicurati che tutte le zone abbiano i campi necessari
    const defaultZones = [];
    for (let i = 0; i < 8; i++) {
        defaultZones.push({
            id: i,
            status: 'show',
            pin: 14 + i,
            name: `Zona ${i + 1}`
        });
    }
    
    // Combina le zone esistenti con quelle di default
    let combinedZones = [...defaultZones];
    zones.forEach(zone => {
        if (zone && zone.id !== undefined) {
            const index = combinedZones.findIndex(z => z.id === zone.id);
            if (index !== -1) {
                combinedZones[index] = {...combinedZones[index], ...zone};
            }
        }
    });
    
    // Debug delle zone
    console.log("Zone combinate:", combinedZones);
    
    combinedZones.forEach(zone => {
        if (!zone || zone.id === undefined) return;
        
        const zoneCard = document.createElement('div');
        zoneCard.className = 'zone-card';
        zoneCard.dataset.zoneId = zone.id;
        
        zoneCard.innerHTML = `
            <h4>Zona ${zone.id + 1}</h4>
            <div class="input-group">
                <label for="zone-name-${zone.id}">Nome:</label>
                <input type="text" id="zone-name-${zone.id}" class="input-control zone-name-input" 
                       value="${zone.name || `Zona ${zone.id + 1}`}" maxlength="16" 
                       placeholder="Nome zona" data-zone-id="${zone.id}">
            </div>
            <div class="input-group">
                <label for="zone-pin-${zone.id}">PIN:</label>
                <input type="number" id="zone-pin-${zone.id}" class="input-control zone-pin-input" 
                       value="${zone.pin !== undefined ? zone.pin : (14 + zone.id)}" min="0" max="40" 
                       placeholder="Numero pin" data-zone-id="${zone.id}">
            </div>
            <div class="input-group">
                <div class="input-row" style="justify-content: space-between;">
                    <label for="zone-status-${zone.id}">Visibile:</label>
                    <label class="toggle-switch">
                        <input type="checkbox" id="zone-status-${zone.id}" class="zone-status-toggle" 
                               ${zone.status === 'show' ? 'checked' : ''} data-zone-id="${zone.id}">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
        
        zonesGrid.appendChild(zoneCard);
        
        // Aggiungi listener per le modifiche
        const nameInput = zoneCard.querySelector('.zone-name-input');
        const pinInput = zoneCard.querySelector('.zone-pin-input');
        const statusToggle = zoneCard.querySelector('.zone-status-toggle');
        
        if (nameInput) {
            nameInput.addEventListener('input', () => {
                settingsModified.zones = true;
            });
        }
        
        if (pinInput) {
            pinInput.addEventListener('input', () => {
                settingsModified.zones = true;
            });
        }
        
        if (statusToggle) {
            statusToggle.addEventListener('change', () => {
                settingsModified.zones = true;
            });
        }
    });
}


// Mostra/nascondi le impostazioni WiFi client
function toggleWifiClientSettings(enable) {
    const wifiClientSettings = document.getElementById('wifi-client-settings');
    if (wifiClientSettings) {
        wifiClientSettings.style.display = enable ? 'block' : 'none';
    }
}

// Funzioni per la connessione WiFi
function scanWifiNetworks() {
    const scanButton = document.getElementById('scan-wifi-button');
    if (scanButton) {
        scanButton.classList.add('loading');
        scanButton.disabled = true;
    }
    
    fetch('/scan_wifi')
        .then(response => {
            if (!response.ok) throw new Error('Errore durante la scansione WiFi');
            return response.json();
        })
        .then(networks => {
            console.log('Reti WiFi trovate:', networks);
            wifiNetworks = networks;
            displayWifiNetworks(networks);
        })
        .catch(error => {
            console.error('Errore durante la scansione WiFi:', error);
            showToast('Errore durante la scansione delle reti WiFi', 'error');
        })
        .finally(() => {
            if (scanButton) {
                scanButton.classList.remove('loading');
                scanButton.disabled = false;
            }
        });
}

// Visualizza le reti WiFi trovate
function displayWifiNetworks(networks) {
    const wifiList = document.getElementById('wifi-list');
    const networksContainer = document.getElementById('wifi-networks-container');
    
    if (!wifiList || !networksContainer) return;
    
    // Aggiorna la select
    wifiList.innerHTML = '';
    
    if (!networks || !Array.isArray(networks) || networks.length === 0) {
        wifiList.innerHTML = '<option value="">Nessuna rete trovata</option>';
        networksContainer.style.display = 'none';
        return;
    }
    
    // Popola la select
    networks.forEach(network => {
        if (!network || !network.ssid) return;
        
        const option = document.createElement('option');
        option.value = network.ssid;
        option.textContent = `${network.ssid} (${network.signal || 'Segnale sconosciuto'})`;
        wifiList.appendChild(option);
    });
    
    // Popola il container con le reti come lista cliccabile
    networksContainer.innerHTML = '';
    networks.forEach(network => {
        if (!network || !network.ssid) return;
        
        const networkElement = document.createElement('div');
        networkElement.className = 'wifi-network';
        networkElement.innerHTML = `
            <span class="wifi-name">${network.ssid}</span>
            <span class="wifi-signal">${network.signal || 'Segnale sconosciuto'}</span>
        `;
        
        // Click sulla rete seleziona la stessa nella select
        networkElement.addEventListener('click', () => {
            wifiList.value = network.ssid;
            
            // Aggiorna la classe selected
            document.querySelectorAll('.wifi-network').forEach(el => {
                el.classList.remove('selected');
            });
            networkElement.classList.add('selected');
            
            // Focus sul campo password
            document.getElementById('wifi-password').focus();
            
            // Segnala modifica
            settingsModified.wifi = true;
        });
        
        networksContainer.appendChild(networkElement);
    });
    
    networksContainer.style.display = 'block';
}

// Connetti alla rete WiFi selezionata
function connectToWifi() {
    const ssid = document.getElementById('wifi-list').value;
    const password = document.getElementById('wifi-password').value;
    
    if (!ssid) {
        showToast('Seleziona una rete WiFi', 'warning');
        return;
    }
    
    if (!password) {
        showToast('Inserisci la password', 'warning');
        return;
    }
    
    const connectButton = document.getElementById('connect-wifi-button');
    if (connectButton) {
        connectButton.classList.add('loading');
        connectButton.disabled = true;
    }
    
    fetch('/connect_wifi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid, password })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast(`Connesso a ${ssid} con successo`, 'success');
            
            // Aggiorna le impostazioni
            window.userData.client_enabled = true;
            window.userData.wifi = { ssid, password };
            
            // Aggiorna l'interfaccia
            document.getElementById('client-enabled').checked = true;
            
            // Aggiorna lo stato della connessione
            setTimeout(fetchConnectionStatus, 2000);
        } else {
            showToast(`Errore: ${data.error || 'Connessione fallita'}`, 'error');
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante la connessione', 'error');
    })
    .finally(() => {
        if (connectButton) {
            connectButton.classList.remove('loading');
            connectButton.disabled = false;
        }
    });
}

// Salva le impostazioni WiFi
function saveWifiSettings() {
    if (!settingsModified.wifi) {
        showToast('Nessuna modifica da salvare', 'info');
        return;
    }
    
    const saveButton = document.getElementById('save-wifi-button');
    if (saveButton) {
        saveButton.classList.add('loading');
        saveButton.disabled = true;
    }
    
    // Raccogli i dati dai campi
    const clientEnabled = document.getElementById('client-enabled').checked;
    const wifiSsid = document.getElementById('wifi-list').value;
    const wifiPassword = document.getElementById('wifi-password').value;
    const apSsid = document.getElementById('ap-ssid').value;
    const apPassword = document.getElementById('ap-password').value;
    
    // Validazione
    if (!apSsid) {
        showToast('Il nome (SSID) dell\'access point non può essere vuoto', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    if (apPassword && apPassword.length < 8) {
        showToast('La password dell\'access point deve essere di almeno 8 caratteri', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Se client è abilitato, verifica che ci siano SSID e password
    if (clientEnabled && (!wifiSsid || !wifiPassword)) {
        showToast('Inserisci SSID e password per la modalità client', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Prepara i dati da inviare
    const wifiSettings = {
        client_enabled: clientEnabled,
        wifi: {
            ssid: wifiSsid,
            password: wifiPassword
        },
        ap: {
            ssid: apSsid,
            password: apPassword
        }
    };
    
    // Invia la richiesta
    saveSettings(wifiSettings, () => {
        settingsModified.wifi = false;
        
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        
        showToast('Impostazioni WiFi salvate con successo', 'success');
        
        // Aggiorna lo stato della connessione
        setTimeout(fetchConnectionStatus, 2000);
    }, () => {
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
    });
}

// Funzione per salvare le impostazioni delle zone
function saveZonesSettings() {
    if (!settingsModified.zones) {
        showToast('Nessuna modifica da salvare', 'info');
        return;
    }
    
    const saveButton = document.getElementById('save-zones-button');
    if (saveButton) {
        saveButton.classList.add('loading');
        saveButton.disabled = true;
    }
    
    // Raccogli i dati dalle zone
    const zones = [];
    const zoneCards = document.querySelectorAll('.zone-card');
    
    zoneCards.forEach(card => {
        const zoneId = parseInt(card.dataset.zoneId);
        const nameInput = card.querySelector('.zone-name-input');
        const pinInput = card.querySelector('.zone-pin-input');
        const statusToggle = card.querySelector('.zone-status-toggle');
        
        if (nameInput && pinInput && statusToggle) {
            const name = nameInput.value.trim();
            const pin = parseInt(pinInput.value);
            const status = statusToggle.checked ? 'show' : 'hide';
            
            // Validazione
            if (isNaN(pin) || pin < 0) {
                showToast(`Il PIN della zona ${zoneId + 1} deve essere un numero valido`, 'error');
                if (saveButton) {
                    saveButton.classList.remove('loading');
                    saveButton.disabled = false;
                }
                return;
            }
            
            zones.push({
                id: zoneId,
                name: name,
                pin: pin,
                status: status
            });
        }
    });
    
    if (zones.length === 0) {
        showToast('Errore nel salvataggio delle zone', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Prepara i dati da inviare
    const zonesSettings = {
        zones: zones
    };
    
    // Invia la richiesta
    saveSettings(zonesSettings, () => {
        settingsModified.zones = false;
        
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        
        showToast('Impostazioni zone salvate con successo', 'success');
    }, () => {
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
    });
}

// Salva le impostazioni avanzate
function saveAdvancedSettings() {
    if (!settingsModified.advanced) {
        showToast('Nessuna modifica da salvare', 'info');
        return;
    }
    
    const saveButton = document.getElementById('save-advanced-button');
    if (saveButton) {
        saveButton.classList.add('loading');
        saveButton.disabled = true;
    }
    
    // Raccogli i dati dai campi
    const maxActiveZones = parseInt(document.getElementById('max-active-zones').value);
    const activationDelay = parseInt(document.getElementById('activation-delay').value);
    const maxZoneDuration = parseInt(document.getElementById('max-zone-duration').value);
    const safetyRelayPin = parseInt(document.getElementById('safety-relay-pin').value);
    const automaticProgramsEnabled = document.getElementById('automatic-programs-enabled').checked;
    
    // Validazione
    if (isNaN(maxActiveZones) || maxActiveZones < 1 || maxActiveZones > 8) {
        showToast('Il numero massimo di zone deve essere tra 1 e 8', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    if (isNaN(activationDelay) || activationDelay < 0) {
        showToast('Il ritardo di attivazione deve essere un numero positivo', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    if (isNaN(maxZoneDuration) || maxZoneDuration < 1) {
        showToast('La durata massima deve essere almeno 1 minuto', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    if (isNaN(safetyRelayPin) || safetyRelayPin < 0) {
        showToast('Il pin del relè di sicurezza deve essere un numero valido', 'error');
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Prepara i dati da inviare
    const advancedSettings = {
        max_active_zones: maxActiveZones,
        activation_delay: activationDelay,
        max_zone_duration: maxZoneDuration,
        safety_relay: {
            pin: safetyRelayPin
        },
        automatic_programs_enabled: automaticProgramsEnabled
    };
    
    // Invia la richiesta
    saveSettings(advancedSettings, () => {
        settingsModified.advanced = false;
        
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        
        showToast('Impostazioni avanzate salvate con successo', 'success');
    }, () => {
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
    });
}

// Funzione generica per il salvataggio delle impostazioni
function saveSettings(settings, onSuccess, onError) {
    fetch('/save_user_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Aggiorna le impostazioni locali
            Object.assign(window.userData, settings);
            
            // Callback di successo
            if (onSuccess) onSuccess();
        } else {
            showToast(`Errore: ${data.error || 'Salvataggio fallito'}`, 'error');
            
            // Callback di errore
            if (onError) onError();
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante il salvataggio', 'error');
        
        // Callback di errore
        if (onError) onError();
    });
}

// Funzioni per il polling dello stato della connessione
function startConnectionStatusPolling() {
    // Ferma eventuali polling precedenti
    stopConnectionStatusPolling();
    
    // Esegui subito
    fetchConnectionStatus();
    
    // Poi ogni 10 secondi
    settingsStatusInterval = setInterval(fetchConnectionStatus, 10000);
    console.log("Polling dello stato della connessione avviato");
}

function stopConnectionStatusPolling() {
    if (settingsStatusInterval) {
        clearInterval(settingsStatusInterval);
        settingsStatusInterval = null;
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
            updateConnectionStatus(data);
        })
        .catch(error => {
            console.error('Errore:', error);
            const statusElement = document.getElementById('connection-status');
            if (statusElement) {
                statusElement.innerHTML = `
                    <div style="padding:10px;background-color:#ffebee;border-radius:6px;text-align:center;">
                        <p style="color:#c62828;margin:0;">Errore nel recupero dello stato della connessione</p>
                    </div>
                `;
            }
        });
}

function updateConnectionStatus(data) {
    const statusElement = document.getElementById('connection-status');
    if (!statusElement) return;
    
    let statusHTML = '';
    
    if (data.mode === 'client') {
        statusHTML = `
            <div style="padding:15px;background-color:#e8f5e9;border-radius:8px;border:1px solid #c8e6c9;">
                <h4 style="margin:0 0 10px 0;color:#2e7d32;font-size:16px;">Connesso come Client Wi-Fi</h4>
                <p style="margin:5px 0;"><strong>SSID:</strong> ${data.ssid}</p>
                <p style="margin:5px 0;"><strong>Indirizzo IP:</strong> ${data.ip}</p>
            </div>
        `;
    } else if (data.mode === 'AP') {
        statusHTML = `
            <div style="padding:15px;background-color:#fff8e1;border-radius:8px;border:1px solid #ffecb3;">
                <h4 style="margin:0 0 10px 0;color:#ff8f00;font-size:16px;">Modalità Access Point attiva</h4>
                <p style="margin:5px 0;"><strong>SSID:</strong> ${data.ssid}</p>
                <p style="margin:5px 0;"><strong>Indirizzo IP:</strong> ${data.ip}</p>
                <p style="margin:5px 0;font-size:13px;color:#666;">I dispositivi possono connettersi a questa rete per accedere al sistema.</p>
            </div>
        `;
    } else {
        statusHTML = `
            <div style="padding:15px;background-color:#ffebee;border-radius:8px;border:1px solid #ffcdd2;">
                <h4 style="margin:0 0 10px 0;color:#c62828;font-size:16px;">Nessuna connessione attiva</h4>
                <p style="margin:5px 0;font-size:13px;">Configura le impostazioni Wi-Fi per connettere il dispositivo.</p>
            </div>
        `;
    }
    
    statusElement.innerHTML = statusHTML;
}

// Pulizia quando si cambia pagina
function cleanupSettingsPage() {
    stopConnectionStatusPolling();
    
    // Chiedi conferma se ci sono modifiche non salvate
    const hasUnsavedChanges = settingsModified.wifi || settingsModified.zones || settingsModified.advanced;
    if (hasUnsavedChanges) {
        if (confirm('Ci sono modifiche non salvate. Vuoi lasciare comunque la pagina?')) {
            // L'utente ha confermato, non fare nulla
        } else {
            // L'utente ha annullato, rimani nella pagina
            // Ma questa funzione viene chiamata quando la pagina sta per essere scaricata,
            // quindi non possiamo impedire all'utente di lasciare la pagina in questo modo.
            // La conferma dovrebbe essere implementata negli event listener dei link di navigazione.
        }
    }
}

// Funzioni di conferma per le azioni di sistema
function confirmRestartSystem() {
    if (confirm('Sei sicuro di voler riavviare il sistema? Tutte le connessioni attive verranno chiuse.')) {
        restartSystem();
    }
}

function confirmResetSettings() {
    if (confirm('Sei sicuro di voler resettare tutte le impostazioni? Questa operazione non può essere annullata.')) {
        resetSettings();
    }
}

function confirmFactoryReset() {
    if (confirm('ATTENZIONE: Questa operazione cancellerà tutti i programmi e resetterà tutte le impostazioni. Continuare?')) {
        factoryReset();
    }
}

// Funzioni per le azioni di sistema
function restartSystem() {
    const restartButton = document.getElementById('restart-button');
    if (restartButton) {
        restartButton.classList.add('loading');
        restartButton.disabled = true;
    }
    
    fetch('/restart_system', {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast('Sistema in riavvio. La pagina si ricaricherà automaticamente tra 30 secondi.', 'info');
            
            // Mostra un countdown e ricarica la pagina dopo 30 secondi
            let countDown = 30;
            const countdownInterval = setInterval(() => {
                countDown--;
                if (countDown <= 0) {
                    clearInterval(countdownInterval);
                    window.location.reload();
                } else {
                    showToast(`Sistema in riavvio. Ricaricamento in ${countDown} secondi...`, 'info');
                }
            }, 1000);
        } else {
            showToast(`Errore: ${data.error || 'Riavvio fallito'}`, 'error');
            
            if (restartButton) {
                restartButton.classList.remove('loading');
                restartButton.disabled = false;
            }
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante il riavvio', 'error');
        
        if (restartButton) {
            restartButton.classList.remove('loading');
            restartButton.disabled = false;
        }
    });
}

function resetSettings() {
    const resetButton = document.getElementById('reset-settings-button');
    if (resetButton) {
        resetButton.classList.add('loading');
        resetButton.disabled = true;
    }
    
    fetch('/reset_settings', {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast('Impostazioni resettate con successo. La pagina si ricaricherà.', 'success');
            
            // Ricarica la pagina dopo 2 secondi
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            showToast(`Errore: ${data.error || 'Reset fallito'}`, 'error');
            
            if (resetButton) {
                resetButton.classList.remove('loading');
                resetButton.disabled = false;
            }
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante il reset', 'error');
        
        if (resetButton) {
            resetButton.classList.remove('loading');
            resetButton.disabled = false;
        }
    });
}

function factoryReset() {
    const factoryResetButton = document.getElementById('factory-reset-button');
    if (factoryResetButton) {
        factoryResetButton.classList.add('loading');
        factoryResetButton.disabled = true;
    }
    
    fetch('/reset_factory_data', {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast('Reset di fabbrica completato. La pagina si ricaricherà.', 'success');
            
            // Ricarica la pagina dopo 2 secondi
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            showToast(`Errore: ${data.error || 'Reset fallito'}`, 'error');
            
            if (factoryResetButton) {
                factoryResetButton.classList.remove('loading');
                factoryResetButton.disabled = false;
            }
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        showToast('Errore di rete durante il reset', 'error');
        
        if (factoryResetButton) {
            factoryResetButton.classList.remove('loading');
            factoryResetButton.disabled = false;
        }
    });
}

// Azzera il file wifi_scan.json
function clearWifiScanFile() {
    fetch('/clear_wifi_scan_file', { method: 'POST' })
        .then(response => console.log('File wifi_scan.json azzerato'))
        .catch(error => console.error('Errore durante l\'azzeramento del file wifi_scan.json:', error));
}

// Inizializzazione quando il documento è caricato
document.addEventListener('DOMContentLoaded', () => {
    // Se userData è già disponibile, inizializza la pagina
    if (window.userData && Object.keys(window.userData).length > 0) {
        initializeSettingsPage(window.userData);
    }
});