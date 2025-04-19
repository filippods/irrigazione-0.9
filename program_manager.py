"""
Modulo per la gestione dei programmi di irrigazione.
Gestisce il caricamento, la creazione, l'aggiornamento e l'esecuzione dei programmi
con meccanismi di sicurezza e gestione degli errori.
"""
import ujson
import time
import uasyncio as asyncio
from zone_manager import start_zone, stop_zone, stop_all_zones, get_active_zones_count
from program_state import program_running, current_program_id, save_program_state, load_program_state
from settings_manager import load_user_settings
from log_manager import log_event

PROGRAM_STATE_FILE = '/data/program_state.json'
PROGRAM_FILE = '/data/program.json'

# Cache per i programmi - ottimizza le operazioni di lettura/scrittura
_programs_cache = None
_programs_cache_valid = False

def _ensure_programs_file_exists():
    """
    Assicura che il file dei programmi esista.
    """
    try:
        # Verifica se il file esiste
        try:
            with open(PROGRAM_FILE, 'r') as f:
                return
        except OSError:
            # Il file non esiste, crealo
            with open(PROGRAM_FILE, 'w') as f:
                ujson.dump({}, f)
            log_event("File programmi creato", "INFO")
    except Exception as e:
        log_event(f"Errore nella verifica/creazione del file programmi: {e}", "ERROR")

def load_programs(force_reload=False):
    """
    Carica i programmi dal file con supporto alla cache.
    
    Args:
        force_reload: Se True, ricarica dal disco anche se la cache è valida
        
    Returns:
        dict: Dizionario dei programmi
    """
    global _programs_cache, _programs_cache_valid
    
    # Se la cache è valida e non è richiesto un ricaricamento forzato, usa la cache
    if _programs_cache_valid and not force_reload and _programs_cache is not None:
        return _programs_cache.copy()  # Ritorna una copia per sicurezza
    
    try:
        _ensure_programs_file_exists()
        
        with open(PROGRAM_FILE, 'r') as f:
            programs = ujson.load(f)
            
            # Validazione del formato
            if not isinstance(programs, dict):
                log_event("Formato file programmi non valido, inizializzazione nuovo file", "WARNING")
                programs = {}
                save_programs(programs)
            
            # Assicura che tutti gli ID siano stringhe e ogni programma abbia il suo ID
            for prog_id in list(programs.keys()):
                if not isinstance(programs[prog_id], dict):
                    # Rimuovi programmi non validi
                    del programs[prog_id]
                    continue
                    
                # Assicura che l'ID sia salvato nel programma stesso
                programs[prog_id]['id'] = str(prog_id)
            
            # Aggiorna la cache
            _programs_cache = programs.copy()
            _programs_cache_valid = True
            
            return programs
    except OSError:
        log_event("File program.json non trovato, creazione file vuoto", "WARNING")
        empty_programs = {}
        save_programs(empty_programs)
        
        # Aggiorna la cache
        _programs_cache = empty_programs.copy()
        _programs_cache_valid = True
        
        return empty_programs
    except Exception as e:
        log_event(f"Errore caricamento programmi: {e}", "ERROR")
        # In caso di errore, ritorna un dizionario vuoto
        return {}

def save_programs(programs):
    """
    Salva i programmi su file in modo atomico.
    
    Args:
        programs: Dizionario dei programmi da salvare
        
    Returns:
        boolean: True se l'operazione è riuscita, False altrimenti
    """
    global _programs_cache, _programs_cache_valid
    
    if not isinstance(programs, dict):
        log_event("Errore: tentativo di salvare programmi non validi", "ERROR")
        return False
    
    try:
        # Assicura che la directory esista
        try:
            import uos
            try:
                uos.stat('/data')
            except OSError:
                uos.mkdir('/data')
        except:
            pass
        
        # Scrittura atomica tramite file temporaneo
        temp_file = PROGRAM_FILE + '.tmp'
        with open(temp_file, 'w') as f:
            ujson.dump(programs, f)
            f.flush()  # Flush esplicito per garantire la scrittura su disco
        
        # Rinomina il file temporaneo (operazione atomica su molti filesystem)
        import uos
        uos.rename(temp_file, PROGRAM_FILE)
        
        # Aggiorna la cache
        _programs_cache = programs.copy()
        _programs_cache_valid = True
        
        log_event("Programmi salvati con successo", "INFO")
        return True
    except Exception as e:
        log_event(f"Errore salvataggio programmi: {e}", "ERROR")
        # Invalida la cache in caso di errore
        _programs_cache_valid = False
        return False

def invalidate_programs_cache():
    """
    Invalida la cache dei programmi, forzando una rilettura alla prossima richiesta.
    """
    global _programs_cache_valid
    _programs_cache_valid = False

def check_program_conflicts(program, programs, exclude_id=None):
    """
    Verifica se ci sono conflitti tra programmi negli stessi mesi e con lo stesso orario.
    
    Args:
        program: Programma da verificare
        programs: Dizionario di tutti i programmi
        exclude_id: ID del programma da escludere dalla verifica (per l'aggiornamento)
        
    Returns:
        tuple: (has_conflict, conflict_message)
    """
    # Validazione degli input
    if not isinstance(program, dict) or not isinstance(programs, dict):
        return False, ""
    
    # Estrai i mesi e l'orario dal programma
    program_months = set(program.get('months', []))
    if not program_months:
        return False, ""
    
    program_time = program.get('activation_time', '')
    if not program_time:
        return False, ""  # Senza orario non ci possono essere conflitti
    
    # Converti exclude_id a stringa se non è None
    if exclude_id is not None:
        exclude_id = str(exclude_id)
    
    # Verifica i conflitti con altri programmi
    for pid, existing_program in programs.items():
        # Salta il programma stesso durante la modifica
        if exclude_id and str(pid) == exclude_id:
            continue
            
        # Salta i programmi non validi
        if not isinstance(existing_program, dict):
            continue
            
        # Estrai mesi e orario dal programma esistente
        existing_months = set(existing_program.get('months', []))
        existing_time = existing_program.get('activation_time', '')
        
        # Verifica se c'è sovrapposizione nei mesi E lo stesso orario di attivazione
        if program_months.intersection(existing_months) and program_time == existing_time:
            # C'è una sovrapposizione nei mesi e lo stesso orario
            program_name = existing_program.get('name', f'Programma {pid}')
            return True, f"Conflitto con '{program_name}' nei mesi e orario selezionati"
    
    return False, ""

def update_program(program_id, updated_program):
    """
    Aggiorna un programma esistente.
    
    Args:
        program_id: ID del programma da aggiornare
        updated_program: Nuovo programma
        
    Returns:
        tuple: (success, error_message)
    """
    # Validazione degli input
    if not isinstance(updated_program, dict):
        return False, "Formato programma non valido"
    
    program_id = str(program_id)  # Assicura che l'ID sia una stringa
    programs = load_programs(force_reload=True)
    
    # Verifica conflitti (escludi il programma che stiamo aggiornando)
    has_conflict, conflict_message = check_program_conflicts(updated_program, programs, exclude_id=program_id)
    if has_conflict:
        log_event(f"Conflitto programma: {conflict_message}", "WARNING")
        return False, conflict_message
    
    if program_id in programs:
        # Se il programma è in esecuzione, fermalo prima di aggiornarlo
        load_program_state()  # Forza il caricamento dello stato più recente
        if program_running and current_program_id == program_id:
            stop_program()
            
        # Assicurati che l'ID del programma sia preservato
        updated_program['id'] = program_id
        programs[program_id] = updated_program
        
        if save_programs(programs):
            log_event(f"Programma {program_id} aggiornato con successo", "INFO")
            return True, ""
        else:
            error_msg = f"Errore durante il salvataggio del programma {program_id}"
            log_event(error_msg, "ERROR")
            return False, error_msg
    else:
        error_msg = f"Programma con ID {program_id} non trovato"
        log_event(error_msg, "ERROR")
        return False, error_msg

def delete_program(program_id):
    """
    Elimina un programma.
    
    Args:
        program_id: ID del programma da eliminare
        
    Returns:
        boolean: True se l'operazione è riuscita, False altrimenti
    """
    program_id = str(program_id)  # Assicura che l'ID sia una stringa
    programs = load_programs(force_reload=True)
    
    if program_id in programs:
        # Se il programma è in esecuzione, fermalo prima di eliminarlo
        load_program_state()  # Forza il caricamento dello stato più recente
        if program_running and current_program_id == program_id:
            stop_program()
            
        # Rimuovi il programma
        del programs[program_id]
        
        if save_programs(programs):
            log_event(f"Programma {program_id} eliminato con successo", "INFO")
            return True
        else:
            log_event(f"Errore durante l'eliminazione del programma {program_id}", "ERROR")
            return False
    else:
        log_event(f"Errore: programma con ID {program_id} non trovato", "ERROR")
        return False

def is_program_active_in_current_month(program):
    """
    Controlla se il programma è attivo nel mese corrente.
    
    Args:
        program: Programma da verificare
        
    Returns:
        boolean: True se il programma è attivo nel mese corrente, False altrimenti
    """
    if not isinstance(program, dict):
        return False
        
    program_months = program.get('months', [])
    if not program_months:
        return False
        
    current_month = time.localtime()[1]
    
    # Mappa dei nomi dei mesi italiani ai numeri di mese
    months_map = {
        "Gennaio": 1, "Febbraio": 2, "Marzo": 3, "Aprile": 4,
        "Maggio": 5, "Giugno": 6, "Luglio": 7, "Agosto": 8,
        "Settembre": 9, "Ottobre": 10, "Novembre": 11, "Dicembre": 12
    }
    
    # Converti i nomi dei mesi in numeri
    program_month_numbers = [months_map.get(month, 0) for month in program_months]
    
    return current_month in program_month_numbers

def _day_of_year(year, month, day):
    """
    Calcola il giorno dell'anno da una data.
    
    Args:
        year: Anno
        month: Mese
        day: Giorno
        
    Returns:
        int: Giorno dell'anno (1-366)
    """
    days_in_month = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    
    # Gestione anno bisestile
    if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):
        days_in_month[2] = 29
    
    day_of_year = day
    for i in range(1, month):
        day_of_year += days_in_month[i]
    
    return day_of_year

def _is_leap_year(year):
    """
    Verifica se un anno è bisestile.
    
    Args:
        year: Anno da verificare
        
    Returns:
        boolean: True se l'anno è bisestile, False altrimenti
    """
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

def is_program_due_today(program):
    """
    Verifica se il programma è previsto per oggi in base alla cadenza.
    
    Args:
        program: Programma da verificare
        
    Returns:
        boolean: True se il programma è previsto per oggi, False altrimenti
    """
    if not isinstance(program, dict):
        return False
        
    # Ottieni la data corrente
    current_time = time.localtime()
    current_year = current_time[0]
    current_month = current_time[1]
    current_day = current_time[2]
    
    # Calcola il giorno dell'anno corrente
    current_day_of_year = _day_of_year(current_year, current_month, current_day)
    
    # Default: non eseguito mai (-1) o giorno diverso
    last_run_day = -1
    last_run_year = -1  # Aggiungiamo l'anno per gestire cambio anno

    # Estrai la data dell'ultima esecuzione
    if 'last_run_date' in program:
        try:
            last_run_date = program['last_run_date']
            date_parts = last_run_date.split('-')
            if len(date_parts) == 3:
                year, month, day = int(date_parts[0]), int(date_parts[1]), int(date_parts[2])
                last_run_day = _day_of_year(year, month, day)
                last_run_year = year
            else:
                log_event(f"Formato data non valido: {last_run_date}", "ERROR")
        except Exception as e:
            log_event(f"Errore nella conversione della data di esecuzione: {e}", "ERROR")

    # Log per debug
    program_name = program.get('name', 'Senza nome')
    log_event(f"Verifica esecuzione per '{program_name}': ultima esecuzione {last_run_year}-{last_run_day}, oggi {current_year}-{current_day_of_year}", "DEBUG")

    # Se non è mai stato eseguito, eseguilo oggi
    if last_run_day == -1:
        return True

    # Determina la cadenza del programma
    recurrence = program.get('recurrence', 'giornaliero')
    
    # Gestisci il cambio di anno
    days_since_last_run = 0
    if last_run_year == current_year:
        days_since_last_run = current_day_of_year - last_run_day
    else:
        # Se l'anno è diverso, calcola i giorni rimanenti nell'anno precedente
        # + i giorni trascorsi nell'anno corrente
        days_in_last_year = 366 if _is_leap_year(last_run_year) else 365
        days_since_last_run = (days_in_last_year - last_run_day) + current_day_of_year
    
    log_event(f"Giorni dall'ultima esecuzione di '{program_name}': {days_since_last_run}", "DEBUG")
    
    # Verifica basata sulla cadenza
    if recurrence == 'giornaliero':
        # Il programma è previsto ogni giorno, ma non più volte al giorno
        return days_since_last_run >= 1
    
    elif recurrence == 'giorni_alterni':
        # Il programma è previsto ogni 2 giorni
        return days_since_last_run >= 2
        
    elif recurrence == 'personalizzata':
        # Il programma è previsto ogni intervallo_giorni
        interval_days = program.get('interval_days', 1)
        # Assicura che l'intervallo sia almeno 1
        if interval_days <= 0:
            interval_days = 1
        return days_since_last_run >= interval_days
    
    # Per valori di recurrence sconosciuti, non eseguire
    return False

async def execute_program(program, manual=False):
    """
    Esegue un programma di irrigazione con gestione robusta degli errori e
    protezione contro stati inconsistenti.
    
    Args:
        program: Programma da eseguire
        manual: Flag che indica se l'esecuzione è manuale
        
    Returns:
        boolean: True se l'esecuzione è completata con successo, False altrimenti
    """
    if not isinstance(program, dict):
        log_event("Tentativo di eseguire un programma non valido", "ERROR")
        return False
    
    # Ricarica lo stato per assicurarsi di avere dati aggiornati
    load_program_state()
    
    # Riferimento esplicito alle variabili globali
    global program_running, current_program_id
    
    if program_running:
        log_event(f"Impossibile eseguire il programma: altro programma già in esecuzione ({current_program_id})", "WARNING")
        return False

    # Se è un programma automatico, prima arresta tutte le zone manuali
    # I programmi automatici hanno priorità
    active_count = get_active_zones_count()
    if active_count > 0:
        log_event(f"Arresto zone attive per dare priorità al programma {'manuale' if manual else 'automatico'}", "INFO")
        try:
            stop_all_zones()
            await asyncio.sleep(1)  # Piccolo ritardo per sicurezza
        except Exception as e:
            log_event(f"Errore durante l'arresto delle zone attive: {e}", "ERROR")

    # Arresta tutte le zone prima di avviare un nuovo programma
    try:
        if not stop_all_zones():
            log_event("Errore durante l'arresto delle zone", "ERROR")
            return False
    except Exception as e:
        log_event(f"Eccezione durante l'arresto delle zone: {e}", "ERROR")
        return False

    # Ottieni l'ID del programma
    program_id = str(program.get('id', '0'))
    
    # FASE 1: Imposta lo stato del programma
    program_running = True
    current_program_id = program_id
    
    # Salva lo stato aggiornato su file
    save_program_state()
    
    # FASE 2: Verifica che lo stato sia stato salvato correttamente
    # Effettua più tentativi per garantire che lo stato sia persistente
    state_persisted = False
    for retry in range(3):  # Massimo 3 tentativi
        # Verifica lo stato salvato
        load_program_state()
        
        if program_running and current_program_id == program_id:
            state_persisted = True
            break
        
        # Se lo stato non è corretto, lo reimpostiamo e risalviamo
        log_event(f"Stato programma non persistito, tentativo {retry + 1}/3", "WARNING")
        program_running = True
        current_program_id = program_id
        save_program_state()
        
        await asyncio.sleep(0.2)  # Breve pausa tra i tentativi
    
    if not state_persisted:
        log_event("IMPORTANTE: Impossibile persistere lo stato del programma", "ERROR")
    
    # FASE 3: Esecuzione del programma
    program_name = program.get('name', 'Senza nome')
    log_event(f"Avvio programma: {program_name} (ID: {program_id})", "INFO")

    # Carica le impostazioni utente per il ritardo di attivazione
    settings = load_user_settings()
    activation_delay = settings.get('activation_delay', 0)
    
    # Flag per tracciare il successo dell'esecuzione
    successful_execution = False
    
    try:
        # Esegui i passaggi del programma
        steps = program.get('steps', [])
        
        # Validation: verifica che gli steps siano in formato valido
        if not isinstance(steps, list):
            log_event(f"Formato steps non valido nel programma {program_id}", "ERROR")
            raise ValueError("Formato steps non valido")
        
        for i, step in enumerate(steps):
            # Verifica periodicamente se il programma è stato interrotto
            load_program_state()
            
            if not program_running:
                log_event("Programma interrotto dall'utente", "INFO")
                break

            # Verifica che lo step sia valido
            if not isinstance(step, dict):
                log_event(f"Step {i+1} non valido, ignorato", "WARNING")
                continue
                
            zone_id = step.get('zone_id')
            duration = step.get('duration', 1)
            
            if zone_id is None:
                log_event(f"Errore nel passo {i+1}: zone_id mancante", "ERROR")
                continue
                
            log_event(f"Attivazione zona {zone_id} per {duration} minuti", "INFO")
            
            # FASE 3.1: Attiva la zona
            result = start_zone(zone_id, duration)
            if not result:
                log_event(f"Errore nell'attivazione della zona {zone_id}", "ERROR")
                continue
                
            # FASE 3.2: Attendi per la durata specificata
            # Suddividi l'attesa in intervalli più brevi per verificare interruzioni
            remaining_seconds = duration * 60
            check_interval = 10  # Verifica ogni 10 secondi
            
            while remaining_seconds > 0 and program_running:
                # Determina il tempo di attesa per questo ciclo
                wait_time = min(check_interval, remaining_seconds)
                
                # Attendi
                await asyncio.sleep(wait_time)
                remaining_seconds -= wait_time
                
                # Verifica lo stato del programma
                load_program_state()
                
                if not program_running:
                    log_event("Programma interrotto durante l'esecuzione di uno step", "INFO")
                    break
            
            # Se il programma è stato interrotto, esci dal ciclo degli step
            if not program_running:
                break
                
            # FASE 3.3: Ferma la zona
            if not stop_zone(zone_id):
                log_event(f"Errore nell'arresto della zona {zone_id}", "WARNING")
                
            log_event(f"Zona {zone_id} completata", "INFO")

            # Gestione del ritardo tra zone
            if activation_delay > 0 and i < len(steps) - 1:
                # Converti il ritardo in secondi se necessario (potrebbe già essere in secondi)
                delay_in_seconds = activation_delay
                # Aggiorna il messaggio per chiarezza
                log_event(f"Attesa {delay_in_seconds} secondi prima della prossima zona", "INFO")

                # Suddividi il ritardo in intervalli più brevi per controllo interruzioni
                remaining_delay = delay_in_seconds
                while remaining_delay > 0 and program_running:
                    wait_time = min(check_interval, remaining_delay)
                    await asyncio.sleep(wait_time)
                    remaining_delay -= wait_time

                    # Verifica lo stato del programma (potrebbe essere stato interrotto)
                    load_program_state()

                    if not program_running:
                        log_event("Ritardo interrotto: programma fermato", "INFO")
                        break
        
        # FASE 4: Verifica se l'esecuzione è stata completata con successo
        # Se siamo arrivati qui e il programma è ancora in esecuzione, 
        # significa che tutti gli step sono stati completati
        if program_running:
            successful_execution = True
            update_last_run_date(program_id)
            log_event(f"Programma {program_name} completato con successo", "INFO")
        
        return successful_execution
    
    except Exception as e:
        log_event(f"Errore durante l'esecuzione del programma {program_name}: {e}", "ERROR")
        return False
    finally:
        # FASE 5: Pulizia finale - questi passaggi vengono eseguiti sempre
        try:
            # Aggiorna lo stato del programma
            program_running = False
            current_program_id = None
            save_program_state()
            
            # Assicurati che tutte le zone siano disattivate
            stop_all_zones()
        except Exception as final_e:
            log_event(f"Errore durante la pulizia finale: {final_e}", "ERROR")

def stop_program():
    """
    Ferma il programma attualmente in esecuzione con protezioni 
    contro stati inconsistenti.
    
    Returns:
        boolean: True se l'operazione è riuscita, False altrimenti
    """
    global program_running, current_program_id
    
    # Salva i valori originali per la verifica
    original_running = program_running
    original_id = current_program_id
    
    # Ricarica lo stato per assicurarsi di avere dati aggiornati
    load_program_state()
    
    # Verifica di coerenza: se non era in esecuzione prima ma ora lo è,
    # considera lo stato originale più attendibile
    # Questo gestisce i casi di race condition nei caricamenti da file
    if not program_running and original_running:
        log_event(f"Stato incoerente durante arresto: era {original_running}, ora {program_running}", "WARNING")
        program_running = True
        current_program_id = original_id
    
    # Se non c'è nessun programma in esecuzione, non fare nulla
    if not program_running:
        log_event("Nessun programma in esecuzione da interrompere", "INFO")
        return False
        
    # FASE 1: Log dell'operazione
    prog_id = current_program_id or "sconosciuto"
    log_event(f"Interruzione programma {prog_id} in corso", "INFO")
    
    # FASE 2: Arresta tutte le zone prima di aggiornare lo stato
    # Questo evita che il programma venga marcato come interrotto ma le zone rimangano attive
    try:
        if not stop_all_zones():
            log_event("Errore nell'arresto delle zone durante l'interruzione", "ERROR")
        else:
            log_event("Tutte le zone arrestate correttamente", "INFO")
    except Exception as e:
        log_event(f"Eccezione durante l'arresto delle zone: {e}", "ERROR")
    
    # FASE 3: Aggiorna lo stato del programma
    program_running = False
    current_program_id = None
    
    # FASE 4: Salva lo stato e verifica
    save_program_state()
    
    # Esegui più tentativi per garantire che lo stato sia persistito
    state_saved = False
    for retry in range(3):
        # Verifica lo stato salvato
        original_running = program_running
        original_id = current_program_id
        
        # Ricarica lo stato
        load_program_state()
        
        # Verifica che lo stato sia stato salvato correttamente
        if program_running == original_running and current_program_id == original_id:
            state_saved = True
            break
        
        # Se lo stato non è stato salvato correttamente, risalva
        log_event(f"Stato non persistito durante arresto, tentativo {retry + 1}/3", "WARNING")
        program_running = original_running
        current_program_id = original_id
        save_program_state()
        
        time.sleep(0.2)  # Breve pausa tra i tentativi
    
    if not state_saved:
        log_event("IMPORTANTE: Impossibile persistere stato del programma dopo arresto", "ERROR")
        
    return True

def reset_program_state():
    """
    Resetta lo stato del programma.
    """
    global program_running, current_program_id
    
    # Ferma eventuali zone attive
    try:
        stop_all_zones()
    except Exception as e:
        log_event(f"Errore durante l'arresto delle zone nel reset: {e}", "ERROR")
    
    # Resetta le variabili di stato
    program_running = False
    current_program_id = None
    
    # Salva lo stato su file
    save_program_state()
    log_event("Stato del programma resettato", "INFO")

def _get_formatted_date():
    """
    Formatta la data corrente come YYYY-MM-DD senza dipendenze da strftime.
    
    Returns:
        str: Data formattata
    """
    t = time.localtime()
    return f"{t[0]}-{t[1]:02d}-{t[2]:02d}"

def update_last_run_date(program_id):
    """
    Aggiorna la data dell'ultima esecuzione del programma.
    
    Args:
        program_id: ID del programma
    """
    program_id = str(program_id)  # Assicura che l'ID sia una stringa
    current_date = _get_formatted_date()
    
    try:
        programs = load_programs(force_reload=True)
        
        if program_id in programs:
            programs[program_id]['last_run_date'] = current_date
            save_programs(programs)
            log_event(f"Data ultima esecuzione aggiornata: programma {program_id}, data {current_date}", "INFO")
        else:
            log_event(f"Impossibile aggiornare data: programma {program_id} non trovato", "WARNING")
    except Exception as e:
        log_event(f"Errore nell'aggiornamento della data di esecuzione: {e}", "ERROR")

async def check_programs():
    """
    Controlla se ci sono programmi da eseguire automaticamente.
    Implementa controlli di sicurezza e robustezza.
    """
    try:
        # Verifica le impostazioni globali
        settings = load_user_settings()
        automatic_programs_enabled = settings.get('automatic_programs_enabled', False)
        
        # Log per debug
        log_event(f"Controllo programmi automatici - Abilitati globalmente: {automatic_programs_enabled}", "DEBUG")
        
        # Se i programmi automatici sono disabilitati globalmente, non fare nulla
        if not automatic_programs_enabled:
            return
        
        # Carica i programmi
        programs = load_programs()
        if not programs:
            return
        
        # Ottieni l'ora corrente nel formato HH:MM
        t = time.localtime()
        current_time_str = f"{t[3]:02d}:{t[4]:02d}"
        current_hour = t[3]
        current_minute = t[4]
        
        log_event(f"Orario controllo programmi: {current_time_str}", "DEBUG")

        # Verifica ogni programma
        for program_id, program in programs.items():
            # Skip programmi non validi
            if not isinstance(program, dict):
                continue
                
            # Verifica se questo programma specifico ha l'automazione abilitata
            # Default a True per compatibilità con versioni precedenti
            program_auto_enabled = program.get('automatic_enabled', True)
            if not program_auto_enabled:
                continue
                
            program_name = program.get('name', f'Programma {program_id}')
            activation_time = program.get('activation_time', '')
            if not activation_time:
                continue
            
            log_event(f"Verifica programma '{program_name}' con orario {activation_time}", "DEBUG")
            
            # Parse del tempo di attivazione
            activation_parts = activation_time.split(':')
            if len(activation_parts) != 2:
                continue
                
            try:
                activation_hour = int(activation_parts[0])
                activation_minute = int(activation_parts[1])
                
                # Verifica se il tempo corrente è uguale al tempo di attivazione
                # Per maggiore robustezza, controlliamo anche il minuto prima/dopo
                time_match = False
                
                # Corrispondenza esatta
                if current_hour == activation_hour and current_minute == activation_minute:
                    log_event(f"Corrispondenza orario esatta per '{program_name}'", "INFO")
                    time_match = True
                # Minuto prima (per evitare di perdere l'attivazione)
                elif current_hour == activation_hour and current_minute == activation_minute - 1:
                    log_event(f"Corrispondenza orario (minuto precedente) per '{program_name}'", "DEBUG")
                    time_match = True
                # Gestisci il caso di cambio ora (es. 08:59 vs 09:00)
                elif activation_minute == 0 and current_minute == 59 and current_hour == activation_hour - 1:
                    log_event(f"Corrispondenza orario (cambio ora) per '{program_name}'", "DEBUG")
                    time_match = True
                
                # Verifica se il programma deve essere eseguito oggi
                if time_match:
                    active_in_month = is_program_active_in_current_month(program)
                    due_today = is_program_due_today(program)
                    
                    log_event(f"Programma '{program_name}': attivo nel mese corrente: {active_in_month}, previsto oggi: {due_today}", "INFO")
                    
                    if active_in_month and due_today:
                        log_event(f"*** AVVIO programma pianificato: {program_name} ***", "INFO")
                        
                        # Verifica se c'è già un programma in esecuzione
                        load_program_state()  # Assicurati di avere lo stato aggiornato
                        if program_running:
                            log_event(f"Programma in esecuzione, verrà interrotto per avviare '{program_name}'", "WARNING")
                            # Interrompi il programma in corso prima di avviare il nuovo
                            stop_program()  # Questa funzione ferma il programma attivo e tutte le zone
                            # Breve pausa per assicurarsi che tutto sia fermato
                            await asyncio.sleep(2)
                            # Ricarica lo stato per assicurarsi che sia aggiornato
                            load_program_state()
                            
                        # Avvia il programma con gestione degli errori
                        try:
                            success = await execute_program(program)
                            if success:
                                log_event(f"Programma '{program_name}' avviato con successo", "INFO")
                            else:
                                log_event(f"Errore nell'esecuzione del programma '{program_name}'", "ERROR")
                        except Exception as e:
                            log_event(f"Eccezione durante esecuzione programma '{program_name}': {e}", "ERROR")
            except ValueError as e:
                # Errore nel parsing dei tempi, salta questo programma
                log_event(f"Formato tempo non valido nel programma {program_id}: {activation_time}: {e}", "WARNING")
                continue
    except Exception as e:
        log_event(f"Errore critico in check_programs: {e}", "ERROR")