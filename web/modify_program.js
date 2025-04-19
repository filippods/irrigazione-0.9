// modify_program.js - Script dedicato per la pagina di modifica programma

// Variabile globale per l'ID del programma in modifica
let programToModify = null;

// Inizializza la pagina di modifica programma
function initializeModifyProgramPage() {
    console.log("Inizializzazione pagina modifica programma");
    
    // Ottieni l'ID del programma da modificare
    const programId = localStorage.getItem('editProgramId');
    if (!programId) {
        if (typeof showToast === 'function') {
            showToast('Nessun programma selezionato per la modifica', 'error');
        } else {
            alert('Nessun programma selezionato per la modifica');
        }
        // Torna alla pagina dei programmi
        setTimeout(() => {
            loadPage('view_programs.html');
        }, 500);
        return;
    }
    
    programToModify = programId;
    console.log("Modifica programma con ID:", programId);
    
    // Carica i dati utente per ottenere le zone
    fetch('/data/user_settings.json')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento delle impostazioni utente');
            return response.json();
        })
        .then(userData => {
            // Genera la griglia dei mesi
            generateMonthsGrid();
            
            // Genera la griglia delle zone
            if (userData && userData.zones) {
                generateZonesGrid(userData.zones);
            } else {
                console.error("Nessuna zona trovata nelle impostazioni");
                showToast("Errore: nessuna zona configurata", "error");
            }
            
            // Carica i dati del programma da modificare
            loadProgramData(programId);
        })
        .catch(error => {
            console.error('Errore nel caricamento delle impostazioni:', error);
            if (typeof showToast === 'function') {
                showToast('Errore nel caricamento delle impostazioni', 'error');
            } else {
                alert('Errore nel caricamento delle impostazioni');
            }
        });
}

// Genera la griglia dei mesi
function generateMonthsGrid() {
    const monthsGrid = document.getElementById('months-list');
    if (!monthsGrid) {
        console.error("Elemento months-list non trovato");
        return;
    }
    
    monthsGrid.innerHTML = '';
    
    const months = [
        'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 
        'Maggio', 'Giugno', 'Luglio', 'Agosto', 
        'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
    ];
    
    months.forEach(month => {
        const monthItem = document.createElement('div');
        monthItem.className = 'month-item';
        monthItem.textContent = month;
        monthItem.dataset.month = month;
        
        monthItem.addEventListener('click', () => {
            monthItem.classList.toggle('selected');
        });
        
        monthsGrid.appendChild(monthItem);
    });
}

// Genera la griglia delle zone
function generateZonesGrid(zones) {
    const zonesGrid = document.getElementById('zone-list');
    if (!zonesGrid) {
        console.error("Elemento zone-list non trovato");
        return;
    }
    
    zonesGrid.innerHTML = '';
    
    // Filtra solo le zone visibili
    const visibleZones = zones && Array.isArray(zones) ? 
                        zones.filter(zone => zone && zone.status === 'show') : [];
    
    if (visibleZones.length === 0) {
        zonesGrid.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:20px;">
                <p>Nessuna zona disponibile.</p>
                <button onclick="loadPage('settings.html')" class="button secondary-button">
                    Configura Zone
                </button>
            </div>
        `;
        return;
    }
    
    visibleZones.forEach(zone => {
        if (!zone || zone.id === undefined) return;
        
        const zoneItem = document.createElement('div');
        zoneItem.className = 'zone-item';
        zoneItem.dataset.zoneId = zone.id;
        
        zoneItem.innerHTML = `
            <div class="zone-header">
                <input type="checkbox" class="zone-checkbox" id="zone-${zone.id}" data-zone-id="${zone.id}">
                <label for="zone-${zone.id}" class="zone-name">${zone.name || `Zona ${zone.id + 1}`}</label>
            </div>
            <div>
                <input type="number" class="zone-duration" id="duration-${zone.id}" 
					min="1" max="180" placeholder="Durata (minuti)" 
					data-zone-id="${zone.id}" disabled>
            </div>
        `;
        
        zonesGrid.appendChild(zoneItem);
        
        // Aggiungi listener al checkbox
        const checkbox = zoneItem.querySelector('.zone-checkbox');
        const durationInput = zoneItem.querySelector('.zone-duration');
        
        checkbox.addEventListener('change', () => {
            // Abilita/disabilita l'input durata in base allo stato del checkbox
            durationInput.disabled = !checkbox.checked;
            
            // Aggiorna la classe selected della zona
            zoneItem.classList.toggle('selected', checkbox.checked);
            
            // Se il checkbox è selezionato, imposta il focus sull'input durata
            if (checkbox.checked) {
                durationInput.focus();
            }
        });
    });
}

// Mostra/nascondi l'input per i giorni personalizzati
function toggleDaysSelection() {
    const recurrenceSelect = document.getElementById('recurrence');
    const daysContainer = document.getElementById('days-container');
    if (recurrenceSelect && daysContainer) {
        daysContainer.style.display = (recurrenceSelect.value === 'personalizzata') ? 'block' : 'none';
    }
}

// Carica i dati di un programma esistente per la modifica
function loadProgramData(programId) {
    fetch('/data/program.json')
        .then(response => {
            if (!response.ok) throw new Error('Errore nel caricamento dei programmi');
            return response.json();
        })
        .then(programs => {
            if (!programs || typeof programs !== 'object') {
                throw new Error('Formato programmi non valido');
            }
            
            const program = programs[programId];
            if (!program) {
                throw new Error('Programma non trovato');
            }
            
            // Compila il form con i dati del programma
            document.getElementById('program-name').value = program.name || '';
            document.getElementById('start-time').value = program.activation_time || '';
            document.getElementById('recurrence').value = program.recurrence || 'giornaliero';
            
            // Se la ricorrenza è personalizzata, mostra e imposta l'intervallo
            if (program.recurrence === 'personalizzata') {
                toggleDaysSelection();
                document.getElementById('custom-days-interval').value = program.interval_days || 3;
            }
            
            // Seleziona i mesi
            if (program.months && program.months.length > 0) {
                const monthItems = document.querySelectorAll('.month-item');
                monthItems.forEach(item => {
                    if (program.months.includes(item.dataset.month)) {
                        item.classList.add('selected');
                    }
                });
            }
            
            // Seleziona le zone e imposta le durate
            if (program.steps && program.steps.length > 0) {
                program.steps.forEach(step => {
                    if (!step || step.zone_id === undefined) return;
                    
                    const checkbox = document.getElementById(`zone-${step.zone_id}`);
                    const durationInput = document.getElementById(`duration-${step.zone_id}`);
                    
                    if (checkbox && durationInput) {
                        checkbox.checked = true;
                        durationInput.disabled = false;
                        durationInput.value = step.duration || 10;
                        
                        // Seleziona anche la card della zona
                        const zoneItem = document.querySelector(`.zone-item[data-zone-id="${step.zone_id}"]`);
                        if (zoneItem) {
                            zoneItem.classList.add('selected');
                        }
                    }
                });
            }
        })
        .catch(error => {
            console.error('Errore nel caricamento del programma:', error);
            if (typeof showToast === 'function') {
                showToast(`Errore: ${error.message}`, 'error');
            } else {
                alert(`Errore: ${error.message}`);
            }
        });
}

// Salva le modifiche al programma
function saveProgram() {
    // Disabilita il pulsante durante il salvataggio
    const saveButton = document.querySelector('.save-btn');
    if (saveButton) {
        saveButton.classList.add('loading');
        saveButton.disabled = true;
    }
    
    // Raccogli i dati dal form
    const programName = document.getElementById('program-name').value.trim();
    const activationTime = document.getElementById('start-time').value;
    const recurrence = document.getElementById('recurrence').value;
    let intervalDays = null;
    
    if (recurrence === 'personalizzata') {
        intervalDays = parseInt(document.getElementById('custom-days-interval').value);
        if (isNaN(intervalDays) || intervalDays < 1) {
            if (typeof showToast === 'function') {
                showToast('Inserisci un intervallo di giorni valido', 'error');
            } else {
                alert('Inserisci un intervallo di giorni valido');
            }
            if (saveButton) {
                saveButton.classList.remove('loading');
                saveButton.disabled = false;
            }
            return;
        }
    }
    
    // Validazione dei dati
    if (!programName) {
        if (typeof showToast === 'function') {
            showToast('Inserisci un nome per il programma', 'error');
        } else {
            alert('Inserisci un nome per il programma');
        }
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    if (!activationTime) {
        if (typeof showToast === 'function') {
            showToast('Seleziona un orario di attivazione', 'error');
        } else {
            alert('Seleziona un orario di attivazione');
        }
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Raccogli i mesi selezionati
    const selectedMonths = [];
    document.querySelectorAll('.month-item.selected').forEach(item => {
        selectedMonths.push(item.dataset.month);
    });
    
    if (selectedMonths.length === 0) {
        if (typeof showToast === 'function') {
            showToast('Seleziona almeno un mese', 'error');
        } else {
            alert('Seleziona almeno un mese');
        }
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Raccogli le zone selezionate e le loro durate
    const steps = [];
    document.querySelectorAll('.zone-checkbox:checked').forEach(checkbox => {
        const zoneId = parseInt(checkbox.dataset.zoneId);
        const durationInput = document.getElementById(`duration-${zoneId}`);
        const duration = parseInt(durationInput.value);
        
        if (isNaN(duration) || duration < 1) {
            if (typeof showToast === 'function') {
                showToast(`Durata non valida per la zona ${zoneId}`, 'error');
            } else {
                alert(`Durata non valida per la zona ${zoneId}`);
            }
            if (saveButton) {
                saveButton.classList.remove('loading');
                saveButton.disabled = false;
            }
            return;
        }
        
        steps.push({
            zone_id: zoneId,
            duration: duration
        });
    });
    
    if (steps.length === 0) {
        if (typeof showToast === 'function') {
            showToast('Seleziona almeno una zona', 'error');
        } else {
            alert('Seleziona almeno una zona');
        }
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
        return;
    }
    
    // Crea l'oggetto programma aggiornato
    const program = {
        id: programToModify,  // Includi sempre l'ID del programma da modificare
        name: programName,
        activation_time: activationTime,
        recurrence: recurrence,
        months: selectedMonths,
        steps: steps
    };
    
    // Aggiungi l'intervallo dei giorni se la ricorrenza è personalizzata
    if (recurrence === 'personalizzata') {
        program.interval_days = intervalDays;
    }
    
    // Invia la richiesta al server per aggiornare il programma
    fetch('/update_program', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(program)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`Errore HTTP: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast('Programma aggiornato con successo', 'success');
            } else {
                alert('Programma aggiornato con successo');
            }
            
            // Pulizia
            localStorage.removeItem('editProgramId');
            
            // Torna alla pagina dei programmi dopo un breve ritardo
            setTimeout(() => {
                loadPage('view_programs.html');
            }, 1000);
        } else {
            throw new Error(data.error || 'Errore durante l\'aggiornamento');
        }
    })
    .catch(error => {
        console.error('Errore:', error);
        if (typeof showToast === 'function') {
            showToast(`Errore: ${error.message}`, 'error');
        } else {
            alert(`Errore: ${error.message}`);
        }
        
        // Riabilita il pulsante
        if (saveButton) {
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
        }
    });
}

// Annulla la modifica e torna alla pagina dei programmi
function cancelEdit() {
    if (confirm('Sei sicuro di voler annullare le modifiche?')) {
        localStorage.removeItem('editProgramId');
        loadPage('view_programs.html');
    }
}

// Inizializza la pagina quando il documento è caricato
document.addEventListener('DOMContentLoaded', initializeModifyProgramPage);