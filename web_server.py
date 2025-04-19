"""
Modulo per la gestione del server web.
Fornisce le API REST e serve i file statici con ottimizzazioni per dispositivi embedded.
"""
from microdot import Request, Microdot, Response, send_file
import uasyncio as asyncio
from log_manager import log_event
import ujson
import uos
import time
import gc
import machine

# Importazioni lazy per evitare dipendenze circolari e ottimizzare avvio
def _import_module(module_name):
    try:
        return __import__(module_name, None, None, [''], 0)
    except ImportError as e:
        log_event(f"Errore importazione {module_name}: {e}", "ERROR")
        return None

# Configurazione
HTML_BASE_PATH = '/web'
DATA_BASE_PATH = '/data'
WIFI_SCAN_FILE = '/data/wifi_scan.json'
FILE_CACHE_SIZE = 10  # Massimo numero file da cachecare
CACHE_TTL = 300       # Tempo di vita cache in secondi

# Migliore gestione delle richieste
Request.max_content_length = 32 * 1024  # 32KB per le richieste
Request.max_body_length = 16 * 1024     # 16KB per il corpo
Request.max_readline = 1024             # 1KB per riga di richiesta

# Inizializzazione app
app = Microdot()

# Cache per file statici
_file_cache = {}  # {path: (content, content_type, timestamp)}
_cache_usage = [] # Lista di path ordinati per ultimo accesso

# Cache per dati frequenti
_user_settings_cache = None
_user_settings_timestamp = 0
_user_settings_ttl = 10  # Secondi

# Metriche server
server_stats = {
    'requests_total': 0,
    'requests_error': 0,
    'last_request_time': 0,
    'cache_hits': 0,
    'cache_misses': 0,
    'gc_runs': 0
}

# Monitoraggio salute server
server_health = {
    'start_time': time.time(),
    'timeout_counter': 0,
    'last_restart': 0,
    'memory_warning': False
}

def json_response(data, status_code=200):
    """
    Helper per creare risposte JSON standardizzate.
    
    Args:
        data: Dati da convertire in JSON
        status_code: Codice di stato HTTP
        
    Returns:
        Response: Oggetto risposta Microdot
    """
    return Response(
        body=ujson.dumps(data),
        status_code=status_code,
        headers={'Content-Type': 'application/json'}
    )

def file_exists(path):
    """
    Verifica se un file esiste.
    
    Args:
        path: Percorso del file
        
    Returns:
        boolean: True se il file esiste, False altrimenti
    """
    try:
        uos.stat(path)
        return True
    except OSError:
        return False

def api_handler(f):
    """
    Decorator unificato per la gestione delle API con:
    - Ottimizzazione memoria
    - Gestione errori centralizzata
    - Monitoraggio metriche
    - Rate limiting leggero
    
    Args:
        f: Funzione da decorare
        
    Returns:
        function: Funzione decorata
    """
    async def wrapper(*args, **kwargs):
        global server_stats

        # Aggiorna metriche
        server_stats['requests_total'] += 1
        current_time = time.time()
        elapsed = current_time - server_stats['last_request_time'] if server_stats['last_request_time'] > 0 else 0
        server_stats['last_request_time'] = current_time
        
        # Rate limiting leggero
        if elapsed < 0.05:  # Più di 20 richieste/secondo potrebbe essere un problema
            server_health['timeout_counter'] += 1
            await asyncio.sleep(0.05)
        
        # Esegui GC preventivo se memoria bassa o periodicamente
        free_mem = gc.mem_free()
        if free_mem < 20000 or server_stats['requests_total'] % 50 == 0:
            gc.collect()
            server_stats['gc_runs'] += 1
        
        # Controlla salute memoria
        mem_percent = free_mem / (free_mem + gc.mem_alloc()) * 100
        if mem_percent < 15 and not server_health['memory_warning']:
            log_event(f"AVVISO: Memoria server bassa ({mem_percent:.1f}%)", "WARNING")
            server_health['memory_warning'] = True
        elif mem_percent > 30 and server_health['memory_warning']:
            server_health['memory_warning'] = False
        
        try:
            # Esecuzione handler effettivo
            result = f(*args, **kwargs)
            if hasattr(result, 'send') and hasattr(result, 'throw'):
                result = await result
                
            # GC dopo richieste onerose
            gc.collect()
            return result
        except Exception as e:
            # Gestione centralizzata errori
            server_stats['requests_error'] += 1
            func_name = getattr(f, '__name__', 'unknown')
            log_event(f"Errore in API '{func_name}': {e}", "ERROR")
            gc.collect()
            
            # Risposta generica ma utile
            error_message = str(e)
            if len(error_message) > 100:  # Limita lunghezza messaggi per risparmiare memoria
                error_message = error_message[:97] + "..."
                
            return json_response({
                'success': False, 
                'error': error_message
            }, 200)  # Usa 200 anche per errori per compatibilità client
    
    # Preserva metadati funzione originale in modo sicuro
    try:
        wrapper.__name__ = getattr(f, '__name__', 'api_handler')
    except (AttributeError, TypeError):
        # Se c'è un errore nell'assegnazione, ignora silenziosamente
        pass
        
    return wrapper

def load_settings_cached():
    """
    Carica impostazioni utente con caching.
    
    Returns:
        dict: Impostazioni utente
    """
    global _user_settings_cache, _user_settings_timestamp
    
    current_time = time.time()
    if (_user_settings_cache is None or 
        current_time - _user_settings_timestamp > _user_settings_ttl):
        
        settings_manager = _import_module('settings_manager')
        if settings_manager:
            _user_settings_cache = settings_manager.load_user_settings()
            _user_settings_timestamp = current_time
    
    return _user_settings_cache

def get_cached_file(path, content_type=None):
    """
    Ottiene un file dalla cache o dal filesystem.
    
    Args:
        path: Percorso del file
        content_type: Tipo di contenuto opzionale
        
    Returns:
        Response o None: Risposta con il file o None se non esiste
    """
    global _file_cache, _cache_usage, server_stats
    current_time = time.time()
    
    # Verifica se il file è in cache
    if path in _file_cache:
        content, cached_content_type, timestamp = _file_cache[path]
        
        # Verifica validità cache
        if current_time - timestamp <= CACHE_TTL:
            # Aggiorna posizione in LRU cache
            _cache_usage.remove(path)
            _cache_usage.append(path)
            
            server_stats['cache_hits'] += 1
            return Response(content, headers={'Content-Type': cached_content_type})
    
    server_stats['cache_misses'] += 1
    
    # File non in cache o cache scaduta
    if not file_exists(path):
        return None
        
    try:
        # Determina tipo di contenuto
        if content_type is None:
            if path.endswith('.html'):
                content_type = 'text/html'
            elif path.endswith('.css'):
                content_type = 'text/css'
            elif path.endswith('.js'):
                content_type = 'application/javascript'
            elif path.endswith('.json'):
                content_type = 'application/json'
            elif path.endswith('.png'):
                content_type = 'image/png'
            elif path.endswith('.jpg') or path.endswith('.jpeg'):
                content_type = 'image/jpeg'
            elif path.endswith('.ico'):
                content_type = 'image/x-icon'
            elif path.endswith('.webp'):
                content_type = 'image/webp'
            else:
                content_type = 'text/plain'
        
        # Leggi file (solo per file di dimensioni ragionevoli)
        try:
            stat_info = uos.stat(path)
            file_size = stat_info[6]  # indice 6 è la dimensione file
            
            # Cache solo file under 32K per evitare problemi memoria
            if file_size < 32 * 1024:
                with open(path, 'rb') as f:
                    content = f.read()
                    
                # Gestisci cache LRU - rimuovi file meno recente se necessario
                if len(_file_cache) >= FILE_CACHE_SIZE and _cache_usage:
                    oldest = _cache_usage.pop(0)
                    if oldest in _file_cache:
                        del _file_cache[oldest]
                
                # Aggiungi file a cache
                _file_cache[path] = (content, content_type, current_time)
                _cache_usage.append(path)
                
                return Response(content, headers={'Content-Type': content_type})
            else:
                # File troppo grande per cache, usa send_file
                return send_file(path, content_type=content_type)
        except Exception as e:
            log_event(f"Errore nel caricamento file {path}: {e}", "ERROR")
            return None
    except Exception as e:
        log_event(f"Errore nel determinare il tipo di {path}: {e}", "ERROR")
        return None

def clear_file_cache():
    """Svuota la cache dei file."""
    global _file_cache, _cache_usage
    _file_cache = {}
    _cache_usage = []
    gc.collect()

# -------- API endpoints --------

@app.route('/data/system_log.json', methods=['GET'])
@api_handler
def get_system_logs(request):
    """API per ottenere i log di sistema."""
    log_manager = _import_module('log_manager')
    if not log_manager:
        return json_response({'error': 'Log manager non disponibile'}, 500)
        
    logs = log_manager.get_logs()
    return json_response(logs)

@app.route('/clear_logs', methods=['POST'])
@api_handler
def clear_system_logs(request):
    """API per cancellare i log di sistema."""
    log_manager = _import_module('log_manager')
    if not log_manager:
        return json_response({'success': False, 'error': 'Log manager non disponibile'}, 500)
        
    success = log_manager.clear_logs()
    if success:
        log_event("Log di sistema cancellati", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore cancellazione log'}, 500)

@app.route('/data/wifi_scan.json', methods=['GET'])
@api_handler
def get_wifi_scan_results(request):
    """API per ottenere i risultati della scansione WiFi."""
    if file_exists(WIFI_SCAN_FILE):
        return send_file(WIFI_SCAN_FILE, content_type='application/json')
    else:
        return Response('File not found', status_code=404)

@app.route('/scan_wifi', methods=['GET'])
@api_handler
def scan_wifi(request):
    """API per avviare una scansione WiFi."""
    log_event("Avvio scansione Wi-Fi", "INFO")
    
    # Importazioni lazy
    network_module = _import_module('network')
    wifi_manager = _import_module('wifi_manager')
    
    if not network_module or not wifi_manager:
        return json_response({'error': 'Moduli rete non disponibili'}, 500)
    
    # Cancella vecchi dati scansione
    wifi_manager.clear_wifi_scan_file()
    
    # Avvia scansione
    wlan = network_module.WLAN(network_module.STA_IF)
    wlan.active(True)
    networks = wlan.scan()
    network_list = []

    # Elabora risultati
    seen_ssids = set()
    for net in networks:
        ssid = net[0].decode('utf-8')
        rssi = net[3]
        
        # Evita duplicati
        if ssid in seen_ssids:
            continue
            
        seen_ssids.add(ssid)
        signal_quality = "Buono" if rssi > -60 else "Sufficiente" if rssi > -80 else "Scarso"
        network_list.append({"ssid": ssid, "signal": signal_quality})

    # Salva risultati
    wifi_manager.save_wifi_scan_results(network_list)
    log_event(f"Scansione Wi-Fi completata: {len(network_list)} reti", "INFO")

    return json_response(network_list)

@app.route('/clear_wifi_scan_file', methods=['POST'])
@api_handler
def clear_wifi_scan(request):
    """API per cancellare il file di scansione WiFi."""
    wifi_manager = _import_module('wifi_manager')
    if not wifi_manager:
        return json_response({'error': 'WiFi manager non disponibile'}, 500)
        
    wifi_manager.clear_wifi_scan_file()
    return json_response({'success': True})

@app.route('/get_zones_status', methods=['GET'])
@api_handler
async def get_zones_status_endpoint(request):
    """API per ottenere lo stato delle zone."""
    # Breve pausa per prevenire polling troppo frequenti
    await asyncio.sleep(0.05)
    
    zone_manager = _import_module('zone_manager')
    if not zone_manager:
        return json_response([], 200)  # Fallback sicuro
        
    zones_status = zone_manager.get_zones_status()
    return json_response(zones_status)

@app.route('/get_connection_status', methods=['GET'])
@api_handler
def get_connection_status(request):
    """API per ottenere lo stato della connessione WiFi."""
    network_module = _import_module('network')
    if not network_module:
        return json_response({'mode': 'unknown'}, 200)
    
    wlan_sta = network_module.WLAN(network_module.STA_IF)
    wlan_ap = network_module.WLAN(network_module.AP_IF)
    response_data = {}

    if wlan_sta.isconnected():
        ip = wlan_sta.ifconfig()[0]
        response_data = {
            'mode': 'client',
            'ip': ip,
            'ssid': wlan_sta.config('essid')
        }
    elif wlan_ap.active():
        ip = wlan_ap.ifconfig()[0]
        response_data = {
            'mode': 'AP',
            'ip': ip,
            'ssid': wlan_ap.config('essid')
        }
    else:
        response_data = {
            'mode': 'none',
            'ip': 'N/A',
            'ssid': 'N/A'
        }

    return json_response(response_data)

@app.route('/activate_ap', methods=['POST'])
@api_handler
def activate_ap(request):
    """API per attivare l'access point."""
    wifi_manager = _import_module('wifi_manager')
    if not wifi_manager:
        return json_response({'success': False, 'error': 'WiFi manager non disponibile'}, 500)
        
    wifi_manager.start_access_point()  # Attiva l'AP con le impostazioni salvate
    log_event("Access Point attivato", "INFO")
    return json_response({'success': True})

@app.route('/data/user_settings.json', methods=['GET'])
@api_handler
def get_user_settings(request):
    """API per ottenere le impostazioni utente."""
    settings = load_settings_cached()
    if not settings:
        return json_response({'error': 'Impossibile caricare impostazioni'}, 500)
        
    # Assicura campi essenziali
    if 'safety_relay' not in settings:
        settings['safety_relay'] = {'pin': 13}
    elif 'pin' not in settings['safety_relay']:
        settings['safety_relay']['pin'] = 13
            
    return json_response(settings)

@app.route('/data/program.json', methods=['GET'])
@api_handler
def get_programs(request):
    """API per ottenere i programmi."""
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({}, 200)  # Fallback sicuro
        
    programs = program_manager.load_programs()
    return json_response(programs)

@app.route('/toggle_automatic_programs', methods=['POST'])
@api_handler
def toggle_automatic_programs(request):
    """API per abilitare/disabilitare i programmi automatici."""
    # Importazioni lazy
    settings_manager = _import_module('settings_manager')
    if not settings_manager:
        return json_response({'success': False, 'error': 'Settings manager non disponibile'}, 500)
    
    # Estrai dati
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            data = {}
            
    enable = data.get('enable', False)
    
    # Aggiorna impostazioni
    settings = load_settings_cached()
    settings['automatic_programs_enabled'] = enable
    
    # Salva impostazioni
    if settings_manager.save_user_settings(settings):
        # Invalida cache impostazioni
        global _user_settings_cache, _user_settings_timestamp
        _user_settings_timestamp = 0
        
        log_event(f"Programmi automatici {'abilitati' if enable else 'disabilitati'}", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore salvataggio impostazioni'}, 500)

@app.route('/get_zones', methods=['GET'])
@api_handler
def get_zones(request):
    """API per ottenere la lista delle zone."""
    settings = load_settings_cached()
    if not settings:
        return json_response({'error': 'Impostazioni non disponibili'}, 500)
        
    zones = settings.get('zones', [])
    return json_response(zones)

@app.route('/start_zone', methods=['POST'])
@api_handler
def handle_start_zone(request):
    """API per avviare una zona."""
    # Importazioni lazy
    zone_manager = _import_module('zone_manager')
    program_state = _import_module('program_state')
    
    if not zone_manager or not program_state:
        return json_response({'error': 'Moduli sistema non disponibili', 'success': False}, 500)
    
    # Estrai e valida parametri
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'error': 'Dati JSON non validi', 'success': False}, 400)

    zone_id = data.get('zone_id')
    duration = data.get('duration')

    if zone_id is None or duration is None:
        return json_response({'error': 'Parametri mancanti', 'success': False}, 400)

    # Verifica se un programma è in esecuzione
    program_state.load_program_state()
    if program_state.program_running:
        return json_response({'error': 'Programma in esecuzione', 'success': False}, 400)

    # Avvia zona
    result = zone_manager.start_zone(zone_id, duration)
    if result:
        return json_response({"success": True})
    else:
        return json_response({'error': "Errore avvio zona", "success": False}, 500)

@app.route('/stop_zone', methods=['POST'])
@api_handler
def handle_stop_zone(request):
    """API per fermare una zona."""
    zone_manager = _import_module('zone_manager')
    if not zone_manager:
        return json_response({'error': 'Zone manager non disponibile', 'success': False}, 500)
    
    # Estrai e valida parametri
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'error': 'Dati JSON non validi', 'success': False}, 400)

    zone_id = data.get('zone_id')
    if zone_id is None:
        return json_response({'error': 'Parametro zone_id mancante', 'success': False}, 400)

    # Ferma zona
    result = zone_manager.stop_zone(zone_id)
    if result:
        return json_response({"success": True})
    else:
        return json_response({'error': "Errore arresto zona", "success": False}, 500)

@app.route('/stop_program', methods=['POST'])
@api_handler
def stop_program_route(request):
    """API per fermare il programma corrente."""
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({'success': False, 'error': 'Program manager non disponibile'}, 500)
    
    log_event("Interruzione programma richiesta", "INFO")
    
    # GC preventivo
    gc.collect()
    
    # Ferma programma
    success = program_manager.stop_program()
    
    # GC post-operazione
    gc.collect()
    
    return json_response({'success': success, 'message': 'Programma interrotto'})

@app.route('/save_program', methods=['POST'])
@api_handler
def save_program_route(request):
    """API per salvare un nuovo programma."""
    # Importazioni lazy
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({'success': False, 'error': 'Program manager non disponibile'}, 500)
    
    # Estrai e valida dati
    program_data = request.json
    if program_data is None:
        try:
            program_data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)

    # Validazione programma
    if len(program_data.get('name', '')) > 16:
        return json_response({'success': False, 'error': 'Nome troppo lungo (max 16 caratteri)'}, 400)

    if not program_data.get('months'):
        return json_response({'success': False, 'error': 'Seleziona almeno un mese'}, 400)
            
    if not program_data.get('steps'):
        return json_response({'success': False, 'error': 'Seleziona almeno una zona'}, 400)

    # Carica programmi esistenti
    programs = program_manager.load_programs()

    # Verifica se esiste un programma con lo stesso nome
    for existing_program in programs.values():
        if existing_program['name'] == program_data['name']:
            return json_response({'success': False, 'error': 'Nome programma già esistente'}, 400)

    # Verifica conflitti
    has_conflict, conflict_message = program_manager.check_program_conflicts(program_data, programs)
    if has_conflict:
        return json_response({'success': False, 'error': conflict_message}, 400)

    # Genera nuovo ID
    new_id = '1'
    if programs:
        new_id = str(max([int(pid) for pid in programs.keys()]) + 1)
    program_data['id'] = new_id

    # Salva programma
    programs[new_id] = program_data
    if program_manager.save_programs(programs):
        log_event(f"Nuovo programma '{program_data['name']}' creato con ID {new_id}", "INFO")
        return json_response({'success': True, 'program_id': new_id})
    else:
        return json_response({'success': False, 'error': 'Errore salvataggio programma'}, 500)

@app.route('/update_program', methods=['PUT'])
@api_handler
def update_program_route(request):
    """API per aggiornare un programma esistente."""
    # Importazioni lazy
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({'success': False, 'error': 'Program manager non disponibile'}, 500)
    
    # Estrai e valida dati
    updated_program_data = request.json
    if updated_program_data is None:
        try:
            updated_program_data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)
            
    program_id = updated_program_data.get('id')
    if program_id is None:
        return json_response({'success': False, 'error': 'ID programma mancante'}, 400)

    # Validazione nome
    if len(updated_program_data.get('name', '')) > 16:
        return json_response({'success': False, 'error': 'Nome troppo lungo (max 16 caratteri)'}, 400)

    # Aggiorna programma
    success, error_msg = program_manager.update_program(program_id, updated_program_data)
    if success:
        log_event(f"Programma {program_id} aggiornato", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': error_msg}, 400)

@app.route('/toggle_program_automatic', methods=['POST'])
@api_handler
def toggle_program_automatic(request):
    """API per abilitare/disabilitare l'automazione di un singolo programma."""
    # Importazioni lazy
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({'success': False, 'error': 'Program manager non disponibile'}, 500)
    
    # Estrai e valida dati
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)
            
    program_id = data.get('program_id')
    enable = data.get('enable', True)
    
    if not program_id:
        return json_response({'success': False, 'error': 'ID programma mancante'}, 400)
            
    # Carica programmi
    programs = program_manager.load_programs()
    
    if program_id not in programs:
        return json_response({'success': False, 'error': 'Programma non trovato'}, 404)
            
    # Aggiorna stato
    programs[program_id]['automatic_enabled'] = enable
    
    # Salva programmi
    if program_manager.save_programs(programs):
        log_event(f"Automazione programma {program_id} {'abilitata' if enable else 'disabilitata'}", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore salvataggio'}, 500)
        
@app.route('/delete_program', methods=['POST'])
@api_handler
def delete_program_route(request):
    """API per eliminare un programma."""
    # Importazioni lazy
    program_manager = _import_module('program_manager')
    if not program_manager:
        return json_response({'success': False, 'error': 'Program manager non disponibile'}, 500)
    
    # Estrai e valida dati
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)
            
    program_id = data.get('id')
    if program_id is None:
        return json_response({'success': False, 'error': 'ID programma mancante'}, 400)

    # Elimina programma
    success = program_manager.delete_program(program_id)
    if success:
        log_event(f"Programma {program_id} eliminato", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Programma non trovato'}, 404)

@app.route('/restart_system', methods=['POST'])
@api_handler
def restart_system_route(request):
    """API per riavviare il sistema."""
    # Importazioni lazy
    zone_manager = _import_module('zone_manager')
    if zone_manager:
        # Ferma tutte le zone per sicurezza
        zone_manager.stop_all_zones()
    
    log_event("Riavvio sistema richiesto", "INFO")
    
    # Ritardo per consentire l'invio della risposta
    asyncio.create_task(_delayed_reset(2))
    return json_response({'success': True, 'message': 'Sistema in riavvio'})

async def _delayed_reset(delay_seconds):
    """Esegue un reset del sistema dopo un ritardo specificato."""
    await asyncio.sleep(delay_seconds)
    machine.reset()

@app.route('/reset_settings', methods=['POST'])
@api_handler
def reset_settings_route(request):
    """API per ripristinare le impostazioni predefinite."""
    # Importazioni lazy
    settings_manager = _import_module('settings_manager')
    if not settings_manager:
        return json_response({'success': False, 'error': 'Settings manager non disponibile'}, 500)
    
    success = settings_manager.reset_user_settings()
    
    # Invalida cache
    global _user_settings_cache, _user_settings_timestamp
    _user_settings_timestamp = 0
    
    if success:
        log_event("Impostazioni resettate", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore reset impostazioni'}, 500)

@app.route('/reset_factory_data', methods=['POST'])
@api_handler
def reset_factory_data_route(request):
    """API per ripristinare le impostazioni e i dati di fabbrica."""
    # Importazioni lazy
    settings_manager = _import_module('settings_manager')
    if not settings_manager:
        return json_response({'success': False, 'error': 'Settings manager non disponibile'}, 500)
    
    success = settings_manager.reset_factory_data()
    
    # Invalida tutte le cache
    global _user_settings_cache, _user_settings_timestamp
    _user_settings_timestamp = 0
    clear_file_cache()
    
    if success:
        log_event("Reset dati di fabbrica completato", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore reset dati'}, 500)

@app.route('/get_program_state', methods=['GET'])
@api_handler
async def get_program_state(request):
    """API per ottenere lo stato del programma corrente."""
    # Breve pausa per prevenire polling troppo frequenti
    await asyncio.sleep(0.05)
    
    # Importazioni lazy
    program_state = _import_module('program_state')
    if not program_state:
        return json_response({'program_running': False, 'current_program_id': None})
    
    # Ricarica stato
    try:
        program_state.load_program_state()
        
        # Ottieni stato zone attive
        zone_manager = _import_module('zone_manager')
        active_zone = None
        
        if zone_manager and program_state.program_running:
            zones = zone_manager.get_zones_status()
            for zone in zones:
                if zone['active']:
                    active_zone = zone
                    break
                    
        # Costruisci risposta
        state = {
            'program_running': program_state.program_running,
            'current_program_id': program_state.current_program_id
        }
        
        if active_zone:
            state['active_zone'] = active_zone
            
        return json_response(state)
    except Exception as e:
        log_event(f"Errore caricamento stato programma: {e}", "ERROR")
        return json_response({'program_running': False, 'current_program_id': None})

@app.route('/start_program', methods=['POST'])
@api_handler
async def start_program_route(request):
    """API per avviare manualmente un programma."""
    # Importazioni lazy
    program_manager = _import_module('program_manager')
    program_state = _import_module('program_state')
    
    if not program_manager or not program_state:
        return json_response({'success': False, 'error': 'Moduli programma non disponibili'}, 500)
    
    # Estrai e valida dati
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)
            
    program_id = str(data.get('program_id', ''))
    if not program_id:
        return json_response({'success': False, 'error': 'ID programma mancante'}, 400)

    # Carica programma
    programs = program_manager.load_programs()
    program = programs.get(program_id)
    if not program:
        return json_response({'success': False, 'error': 'Programma non trovato'}, 404)

    # Verifica se già in esecuzione
    program_state.load_program_state()
    if program_state.program_running:
        return json_response({'success': False, 'error': 'Altro programma in esecuzione'}, 400)

    # Avvia programma
    success = await program_manager.execute_program(program, manual=True)
    
    if success:
        log_event(f"Programma {program.get('name', '')} avviato manualmente", "INFO")
        return json_response({'success': True})
    else:
        return json_response({'success': False, 'error': 'Errore avvio programma'}, 500)

@app.route('/connect_wifi', methods=['POST'])
@api_handler
def connect_wifi_route(request):
    """API per connettersi a una rete WiFi."""
    # Importazioni lazy
    network_module = _import_module('network')
    settings_manager = _import_module('settings_manager')
    
    if not network_module or not settings_manager:
        return json_response({'success': False, 'error': 'Moduli rete non disponibili'}, 500)
    
    # Estrai e valida dati
    data = request.json
    if data is None:
        try:
            data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)

    ssid = data.get('ssid')
    password = data.get('password')

    if not ssid or not password:
        return json_response({'success': False, 'error': 'SSID e password richiesti'}, 400)

    log_event(f"Tentativo connessione a {ssid}", "INFO")
    
    # Connetti a WiFi
    wlan = network_module.WLAN(network_module.STA_IF)
    wlan.active(True)
    wlan.connect(ssid, password)

    # Attesa max 15 secondi
    connected = False
    for _ in range(15):
        if wlan.isconnected():
            connected = True
            break
        time.sleep(1)

    if connected:
        ip = wlan.ifconfig()[0]
        log_event(f"Connesso a {ssid} con IP: {ip}", "INFO")

        # Aggiorna impostazioni
        settings = settings_manager.load_user_settings()
        settings['wifi'] = {'ssid': ssid, 'password': password}
        settings['client_enabled'] = True
        settings_manager.save_user_settings(settings)
        
        # Invalida cache
        global _user_settings_cache, _user_settings_timestamp
        _user_settings_timestamp = 0

        return json_response({'success': True, 'ip': ip, 'mode': 'client'})
    else:
        log_event("Connessione WiFi fallita", "ERROR")
        return json_response({'success': False, 'error': 'Connessione fallita'}, 500)

@app.route('/save_user_settings', methods=['POST'])
@api_handler
def save_user_settings_route(request):
    """API per salvare le impostazioni utente."""
    # Importazioni lazy
    settings_manager = _import_module('settings_manager')
    if not settings_manager:
        return json_response({'success': False, 'error': 'Settings manager non disponibile'}, 500)
    
    # Estrai e valida dati
    settings_data = request.json
    if settings_data is None:
        try:
            settings_data = ujson.loads(request.body.decode('utf-8'))
        except:
            return json_response({'success': False, 'error': 'Dati JSON non validi'}, 400)

    if not isinstance(settings_data, dict):
        return json_response({'success': False, 'error': 'Formato impostazioni non valido'}, 400)

    # Carica impostazioni attuali
    existing_settings = settings_manager.load_user_settings()
    if not isinstance(existing_settings, dict):
        existing_settings = {}

    # Aggiorna impostazioni con merge intelligente
    for key, value in settings_data.items():
        if isinstance(value, dict) and key in existing_settings and isinstance(existing_settings[key], dict):
            existing_settings[key].update(value)
        else:
            existing_settings[key] = value

    # Salva impostazioni
    success = settings_manager.save_user_settings(existing_settings)
    
    # Invalida cache
    global _user_settings_cache, _user_settings_timestamp
    _user_settings_timestamp = 0
    
    # Gestione WiFi
    if 'client_enabled' in settings_data:
        client_enabled = settings_data['client_enabled']
        network_module = _import_module('network')
        
        if network_module:
            wlan_sta = network_module.WLAN(network_module.STA_IF)
            if not client_enabled and wlan_sta.active():
                wlan_sta.active(False)
                log_event("Modalità client disattivata", "INFO")
    
    # Pulizia memoria
    gc.collect()
    
    return json_response({'success': success})

@app.route('/disconnect_wifi', methods=['POST'])
@api_handler
def disconnect_wifi(request):
    """API per disconnettere il client WiFi."""
    network_module = _import_module('network')
    if not network_module:
        return json_response({'success': False, 'error': 'Network module non disponibile'}, 500)
    
    wlan_sta = network_module.WLAN(network_module.STA_IF)
    if wlan_sta.isconnected():
        wlan_sta.disconnect()
        wlan_sta.active(False)
        log_event("WiFi client disconnesso", "INFO")
    
    return json_response({'success': True})

@app.route('/', methods=['GET'])
@api_handler
def index(request):
    """Route per servire la pagina principale."""
    response = get_cached_file('/web/main.html', 'text/html')
    if response:
        return response
    else:
        return Response('Errore caricamento pagina', status_code=500)

@app.route('/<path:path>', methods=['GET'])
@api_handler
def static_files(request, path):
    """Route per servire i file statici."""
    # Evita accesso a directory data
    if path.startswith('data/'):
        return Response('Not Found', status_code=404)

    file_path = f'/web/{path}'
    response = get_cached_file(file_path)
    
    if response:
        return response
    elif file_exists(file_path):
        # Determina il tipo di contenuto
        if file_path.endswith('.html'):
            content_type = 'text/html'
        elif file_path.endswith('.css'):
            content_type = 'text/css'
        elif file_path.endswith('.js'):
            content_type = 'application/javascript'
        elif file_path.endswith('.json'):
            content_type = 'application/json'
        elif file_path.endswith('.png'):
            content_type = 'image/png'
        elif file_path.endswith('.jpg') or file_path.endswith('.jpeg'):
            content_type = 'image/jpeg'
        elif file_path.endswith('.ico'):
            content_type = 'image/x-icon'
        elif file_path.endswith('.webp'):
            content_type = 'image/webp'
        else:
            content_type = 'text/plain'
            
        return send_file(file_path, content_type=content_type)
    else:
        return Response('File non trovato', status_code=404)

@app.route('/server_stats', methods=['GET'])
@api_handler
def get_server_stats(request):
    """API diagnostica per statistiche server."""
    global server_stats, server_health
    
    # Aggiorna metriche memoria
    current_time = time.time()
    uptime = current_time - server_health['start_time']
    mem_free = gc.mem_free()
    mem_alloc = gc.mem_alloc()
    
    stats = {
        'uptime': uptime,
        'uptime_human': f"{int(uptime // 3600)}h {int((uptime % 3600) // 60)}m",
        'requests_total': server_stats['requests_total'],
        'requests_error': server_stats['requests_error'],
        'cache_hits': server_stats['cache_hits'],
        'cache_misses': server_stats['cache_misses'],
        'gc_runs': server_stats['gc_runs'],
        'cached_files': len(_file_cache),
        'memory': {
            'free': mem_free,
            'allocated': mem_alloc,
            'total': mem_free + mem_alloc,
            'percent_free': (mem_free / (mem_free + mem_alloc)) * 100
        }
    }
    
    return json_response(stats)

async def start_web_server():
    """
    Avvia il server web con inizializzazione robusta.
    """
    global server_health
    
    try:
        log_event("Avvio server web", "INFO")
        
        # Crea directory data se non esiste
        try:
            if not file_exists('/data'):
                uos.mkdir('/data')
        except Exception as e:
            log_event(f"Errore creazione directory data: {e}", "WARNING")
        
        # Libera memoria prima di avviare
        gc.collect()
        
        # Reset stato server
        server_health['start_time'] = time.time()
        server_health['timeout_counter'] = 0
        server_health['last_restart'] = 0
        server_health['memory_warning'] = False
        
        # Avvia server
        await app.start_server(host='0.0.0.0', port=80)
    except Exception as e:
        log_event(f"Errore avvio server web: {e}", "ERROR")
        
        # Ritenta dopo breve pausa
        await asyncio.sleep(5)
        asyncio.create_task(start_web_server())