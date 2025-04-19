"""
Modulo per la gestione delle impostazioni utente.
Gestisce il caricamento, il salvataggio e il reset delle impostazioni con meccanismi
di protezione contro la corruzione dei dati e problemi di I/O.
"""
import ujson
import uos as os
import gc

# Percorsi dei file
USER_SETTINGS_FILE = '/data/user_settings.json'
FACTORY_SETTINGS_FILE = '/data/factory_settings.json'
PROGRAM_FILE = '/data/program.json'

# Cache delle impostazioni per ridurre le letture su disco
_settings_cache = None
_last_load_time = 0
_CACHE_VALIDITY = 60  # secondi di validità della cache

# Funzione per il logging che evita importazioni circolari
def _log_event(message, level="INFO"):
    """
    Registra un messaggio nel log senza causare importazioni circolari.
    
    Args:
        message: Messaggio da loggare
        level: Livello del log (INFO, WARNING, ERROR)
    """
    try:
        # Importazione locale per evitare dipendenze circolari
        from log_manager import log_event
        log_event(message, level)
    except ImportError:
        # Fallback di logging se l'importazione fallisce
        print(f"[{level}] {message}")

def ensure_directory_exists(path):
    """
    Assicura che una directory esista, creandola se necessario.
    Implementazione robusta con supporto a percorsi annidati.
    
    Args:
        path: Percorso della directory
        
    Returns:
        boolean: True se la directory esiste o è stata creata, False altrimenti
    """
    if not path or path == '/':
        return True
    
    try:
        # Rimuovi eventuali slash di terminazione
        if path.endswith('/'):
            path = path[:-1]
            
        # Verifica se la directory esiste già
        try:
            os.stat(path)
            return True
        except OSError:
            # La directory non esiste, crea le directory necessarie
            components = path.split('/')
            current_path = ''
            
            for component in components:
                if component:
                    current_path += '/' + component
                    try:
                        os.stat(current_path)
                    except OSError:
                        try:
                            os.mkdir(current_path)
                        except OSError as e:
                            _log_event(f"Errore creazione directory {current_path}: {e}", "ERROR")
                            return False
            return True
    except Exception as e:
        _log_event(f"Errore verifica/creazione directory {path}: {e}", "ERROR")
        return False

def create_default_settings():
    """
    Crea impostazioni predefinite con valori sicuri e ben documentati.
    
    Returns:
        dict: Dizionario delle impostazioni predefinite
    """
    return {
        'safety_relay': {
            'pin': 13  # Pin per il relè di sicurezza principale
        },
        'zones': [
            {'id': 0, 'status': 'show', 'pin': 14, 'name': 'Giardino'},
            {'id': 1, 'status': 'show', 'pin': 15, 'name': 'Terrazzo'},
            {'id': 2, 'status': 'show', 'pin': 16, 'name': 'Cancelletto'},
            {'id': 3, 'status': 'show', 'pin': 17, 'name': 'Zona 4'},
            {'id': 4, 'status': 'show', 'pin': 18, 'name': 'Zona 5'},
            {'id': 5, 'status': 'show', 'pin': 19, 'name': 'Zona 6'},
            {'id': 6, 'status': 'show', 'pin': 20, 'name': 'Zona 7'},
            {'id': 7, 'status': 'show', 'pin': 21, 'name': 'Zona 8'}
        ],
        'automatic_programs_enabled': True,  # Abilita l'esecuzione automatica dei programmi
        'max_active_zones': 3,  # Numero massimo di zone attive contemporaneamente
        'wifi': {
            'ssid': '',  # SSID della rete WiFi a cui connettersi
            'password': ''  # Password della rete WiFi
        },
        'activation_delay': 5,  # Ritardo in minuti tra l'attivazione di zone successive
        'client_enabled': False,  # Abilita la modalità client WiFi
        'ap': {
            'ssid': 'IrrigationSystem',  # SSID dell'access point
            'password': '12345678'  # Password dell'access point (min 8 caratteri)
        },
        'max_zone_duration': 180  # Durata massima di attivazione di una zona in minuti
    }

def _save_settings_atomic(settings, file_path):
    """
    Salva le impostazioni in modo atomico usando un file temporaneo.
    
    Args:
        settings: Impostazioni da salvare
        file_path: Percorso del file di destinazione
        
    Returns:
        boolean: True se il salvataggio è riuscito, False altrimenti
    """
    try:
        # Assicurati che la directory esista
        if not ensure_directory_exists(os.path.dirname(file_path)):
            return False
        
        # Usa un file temporaneo per garantire scritture atomiche
        temp_file = file_path + '.tmp'
        
        # Scrivi su file temporaneo
        with open(temp_file, 'w') as f:
            ujson.dump(settings, f)
            f.flush()  # Forza il flush dei dati sul disco
            
        # Rinomina il file temporaneo (operazione atomica su molti filesystem)
        os.rename(temp_file, file_path)
        
        # Aggiorna la cache
        global _settings_cache, _last_load_time
        _settings_cache = settings.copy()
        _last_load_time = time.time() if 'time' in globals() else 0
        
        return True
    except Exception as e:
        _log_event(f"Errore salvataggio {file_path}: {e}", "ERROR")
        return False

def load_user_settings(force_reload=False):
    """
    Carica le impostazioni utente dal file JSON con supporto alla cache.
    Se il file non esiste o è corrotto, viene creato con valori predefiniti.
    
    Args:
        force_reload: Se True, ignora la cache e forza la rilettura dal disco
        
    Returns:
        dict: Dizionario delle impostazioni
    """
    global _settings_cache, _last_load_time
    
    # Controlla se possiamo usare la cache
    current_time = time.time() if 'time' in globals() else 0
    if (not force_reload and 
        _settings_cache is not None and 
        current_time - _last_load_time < _CACHE_VALIDITY):
        return _settings_cache.copy()  # Ritorna una copia per evitare modifiche indesiderate
    
    try:
        try:
            # Tenta di aprire il file delle impostazioni
            with open(USER_SETTINGS_FILE, 'r') as f:
                settings = ujson.load(f)
                
                if not isinstance(settings, dict):
                    raise ValueError("Formato impostazioni non valido")
                
                # Aggiorna la cache
                _settings_cache = settings.copy()
                _last_load_time = current_time
                
                return settings
        except OSError:
            # Il file non esiste, crea impostazioni predefinite
            default_settings = create_default_settings()
            save_user_settings(default_settings)
            
            # Aggiorna la cache
            _settings_cache = default_settings.copy()
            _last_load_time = current_time
            
            return default_settings
        except ValueError as e:
            # Il file esiste ma non è un JSON valido
            _log_event(f"File {USER_SETTINGS_FILE} danneggiato: {e}, ripristino impostazioni", "WARNING")
            default_settings = create_default_settings()
            save_user_settings(default_settings)
            
            # Aggiorna la cache
            _settings_cache = default_settings.copy()
            _last_load_time = current_time
            
            return default_settings
    except Exception as e:
        _log_event(f"Errore critico caricamento impostazioni: {e}", "ERROR")
        try:
            # Tenta un ultimo sforzo per fornire impostazioni valide
            default_settings = create_default_settings()
            # Non salvare qui per evitare loop di errori
            return default_settings
        except:
            # In caso di errore critico, restituisci un dizionario vuoto
            return {}

def save_user_settings(settings):
    """
    Salva le impostazioni utente in un file JSON in modo atomico.
    
    Args:
        settings: Dizionario delle impostazioni da salvare
        
    Returns:
        boolean: True se il salvataggio è riuscito, False altrimenti
    """
    if not isinstance(settings, dict):
        _log_event("Tentativo di salvare impostazioni non valide", "ERROR")
        return False
        
    # Assicurati che ci siano almeno le chiavi principali
    # Questo previene la perdita di impostazioni critiche
    current_settings = load_user_settings(force_reload=True)
    
    # Se current_settings è un dizionario vuoto (errore di caricamento)
    # usa le impostazioni predefinite come base
    if not current_settings:
        current_settings = create_default_settings()
    
    # Unisci le impostazioni ricevute con quelle esistenti
    for key, value in settings.items():
        if isinstance(value, dict) and key in current_settings and isinstance(current_settings[key], dict):
            # Per i dizionari nested, unisci anziché sovrascrivere
            # Questo preserva le chiavi che non vengono aggiornate
            current_settings[key].update(value)
        else:
            # Per i valori semplici o i dizionari non esistenti, sovrascrivere
            current_settings[key] = value
    
    # Salva usando la funzione atomica
    result = _save_settings_atomic(current_settings, USER_SETTINGS_FILE)
    
    # Forza la garbage collection dopo operazioni su file
    gc.collect()
    
    return result

def reset_user_settings():
    """
    Resetta le impostazioni utente ai valori predefiniti.
    
    Returns:
        boolean: True se il reset è riuscito, False altrimenti
    """
    try:
        default_settings = create_default_settings()
        success = save_user_settings(default_settings)
        
        if success:
            _log_event("Impostazioni utente resettate ai valori predefiniti", "INFO")
        
        return success
    except Exception as e:
        _log_event(f"Errore reset impostazioni utente: {e}", "ERROR")
        return False

def reset_factory_data():
    """
    Resetta tutti i dati ai valori di fabbrica.
    Resetta impostazioni utente, programmi e stato del programma.
    
    Returns:
        boolean: True se il reset è riuscito, False altrimenti
    """
    try:
        # Utilizziamo una lista di operazioni da eseguire per migliorare la leggibilità
        # e facilitare l'aggiunta di future operazioni di reset
        operations = [
            # Reset impostazioni utente
            {'name': 'Impostazioni utente', 'func': reset_user_settings},
            
            # Reset programmi
            {'name': 'Programmi', 'func': lambda: _save_settings_atomic({}, PROGRAM_FILE)},
            
            # Resetta lo stato del programma
            {'name': 'Stato programma', 'func': lambda: _save_settings_atomic(
                {'program_running': False, 'current_program_id': None}, 
                '/data/program_state.json'
            )}
        ]
        
        # Esegui tutte le operazioni e traccia i risultati
        results = []
        for op in operations:
            try:
                success = op['func']()
                results.append((op['name'], success))
                if success:
                    _log_event(f"Reset {op['name']} completato", "INFO")
                else:
                    _log_event(f"Reset {op['name']} fallito", "WARNING")
            except Exception as e:
                _log_event(f"Errore durante reset {op['name']}: {e}", "ERROR")
                results.append((op['name'], False))
        
        # Considera il reset riuscito se almeno il 50% delle operazioni ha avuto successo
        success_count = sum(1 for _, success in results if success)
        overall_success = success_count >= len(operations) / 2
        
        # Log riassuntivo
        if overall_success:
            if success_count == len(operations):
                _log_event("Reset completo dati di fabbrica completato con successo", "INFO")
            else:
                _log_event(f"Reset dati di fabbrica parziale: {success_count}/{len(operations)} operazioni completate", "WARNING")
        else:
            _log_event(f"Reset dati di fabbrica fallito: solo {success_count}/{len(operations)} operazioni completate", "ERROR")
        
        # Forza la garbage collection
        gc.collect()
        
        return overall_success
    except Exception as e:
        _log_event(f"Errore catastrofico durante reset dati di fabbrica: {e}", "ERROR")
        return False

def invalidate_cache():
    """
    Invalida la cache delle impostazioni, forzando la rilettura dal disco.
    Utile dopo operazioni esterne che potrebbero aver modificato le impostazioni.
    """
    global _settings_cache, _last_load_time
    _settings_cache = None
    _last_load_time = 0

# Inizializzazione: importa il modulo time se disponibile
try:
    import time
except ImportError:
    # Il modulo time non è disponibile, useremo 0 come timestamp
    pass