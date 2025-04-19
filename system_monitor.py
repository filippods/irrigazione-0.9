"""
Modulo di diagnostica per il sistema di irrigazione.
Monitora lo stato del sistema e dei servizi, risolvendo i problemi rilevati.
"""
import uasyncio as asyncio
import machine
import gc
import network
import time
from log_manager import log_event
from settings_manager import load_user_settings
from zone_manager import stop_all_zones, get_zones_status, stop_zone
from program_state import program_running, current_program_id, load_program_state
from wifi_manager import reset_wifi_module, initialize_network

# Configurazione del modulo
CHECK_INTERVAL = 60             # Intervallo controlli (secondi)
MEMORY_THRESHOLD = 20000        # Soglia memoria libera (bytes)
MAX_ZONE_ACTIVATION_TIME = 180  # Tempo massimo attivazione zona (minuti)
WEB_SERVER_TIMEOUT = 5          # Timeout controllo web server (secondi)
MAX_SERVER_RESTARTS = 3         # Massimo riavvii server consecutivi

# Stato del sistema
HEALTH_INDICATORS = {
    'web_server': True,
    'wifi_connection': True,
    'memory': True,
    'zones': True,
    'programs': True
}

CONSECUTIVE_FAILURES = {
    'web_server': 0,
    'wifi_connection': 0
}

# Contatori di sistema
server_restart_attempts = 0
last_server_restart = 0

# Metriche
system_metrics = {
    'uptime': 0,               # Tempo attività (secondi)
    'start_time': time.time(),
    'memory_free': 0,
    'memory_allocated': 0,
    'gc_runs': 0,
    'wifi_disconnects': 0,
    'server_restarts': 0,
    'zone_corrections': 0
}

# Monitoraggio salute server
server_health = {
    'start_time': time.time(),
    'timeout_counter': 0,
    'last_restart': 0,
    'memory_warning': False
}

async def check_web_server():
    """
    Verifica che il web server risponda correttamente.
    
    Returns:
        boolean: True se il server è attivo, False altrimenti
    """
    global server_restart_attempts, last_server_restart
    
    try:
        # Crea socket per verifica
        import socket
        s = socket.socket()
        s.settimeout(WEB_SERVER_TIMEOUT)
        
        try:
            s.connect(('127.0.0.1', 80))
            s.send(b'GET / HTTP/1.0\r\n\r\n')
            response = s.recv(100)
            s.close()
            
            if b'HTTP' in response:
                # Server OK
                HEALTH_INDICATORS['web_server'] = True
                CONSECUTIVE_FAILURES['web_server'] = 0
                server_restart_attempts = 0
                return True
        except Exception:
            # Server non risponde
            pass
    except Exception as e:
        log_event(f"Errore controllo web server: {e}", "ERROR")
    
    # Errore o timeout
    CONSECUTIVE_FAILURES['web_server'] += 1
    HEALTH_INDICATORS['web_server'] = False
    
    # Riavvio server se troppi errori consecutivi
    current_time = time.time()
    if CONSECUTIVE_FAILURES['web_server'] >= 3:
        # Evita riavvii troppo frequenti
        if current_time - last_server_restart > 120 and server_restart_attempts < MAX_SERVER_RESTARTS:
            log_event(f"Riavvio web server dopo {CONSECUTIVE_FAILURES['web_server']} fallimenti", "WARNING")
            server_restart_attempts += 1
            system_metrics['server_restarts'] += 1
            last_server_restart = current_time
            
            # Riavvia server
            try:
                await restart_web_server()
                log_event("Web server riavviato con successo", "INFO")
                CONSECUTIVE_FAILURES['web_server'] = 0
                return True
            except Exception as e:
                log_event(f"Errore riavvio web server: {e}", "ERROR")
        elif server_restart_attempts >= MAX_SERVER_RESTARTS:
            # Troppi tentativi, riavvia sistema
            if server_restart_attempts == MAX_SERVER_RESTARTS:
                log_event("Troppi tentativi falliti, riavvio sistema tra 10s", "ERROR")
                await _delayed_system_reset(10)
                server_restart_attempts += 1
    
    return False

async def _delayed_system_reset(seconds):
    """Riavvia il sistema dopo un ritardo."""
    await asyncio.sleep(seconds)
    machine.reset()

async def restart_web_server():
    """Riavvia il web server."""
    # Importa qui per evitare import circolari
    from web_server import app
    
    try:
        # Libera memoria
        gc.collect()
        
        # Ferma server attuale
        if hasattr(app, 'server') and app.server:
            try:
                app.server.close()
                await asyncio.sleep(1)
            except Exception as e:
                log_event(f"Errore chiusura server: {e}", "WARNING")
        
        # Avvia nuovo server
        asyncio.create_task(app.start_server(host='0.0.0.0', port=80))
        
        # Attesa per avvio
        await asyncio.sleep(2)
        log_event("Server web riavviato", "INFO")
    except Exception as e:
        log_event(f"Errore riavvio server web: {e}", "ERROR")
        raise

async def check_wifi_connection():
    """
    Verifica connessione WiFi.
    
    Returns:
        boolean: True se connessione OK, False altrimenti
    """
    try:
        settings = load_user_settings()
        client_enabled = settings.get('client_enabled', False)
        wlan_sta = network.WLAN(network.STA_IF)
        wlan_ap = network.WLAN(network.AP_IF)
        
        if client_enabled:
            # Verifica client attivo
            if not wlan_sta.isconnected():
                log_event("Connessione WiFi client persa", "WARNING")
                CONSECUTIVE_FAILURES['wifi_connection'] += 1
                HEALTH_INDICATORS['wifi_connection'] = False
                
                # Reset dopo troppi errori
                if CONSECUTIVE_FAILURES['wifi_connection'] >= 3:
                    log_event("Riavvio completo modulo WiFi", "WARNING")
                    system_metrics['wifi_disconnects'] += 1
                    reset_wifi_module()
                    await asyncio.sleep(1)
                    initialize_network()
                    CONSECUTIVE_FAILURES['wifi_connection'] = 0
                
                return False
            else:
                HEALTH_INDICATORS['wifi_connection'] = True
                CONSECUTIVE_FAILURES['wifi_connection'] = 0
                return True
        else:
            # Client disabilitato, verifica AP
            if not wlan_ap.active():
                log_event("Access Point non attivo", "WARNING")
                HEALTH_INDICATORS['wifi_connection'] = False
                
                # Riavvia AP
                from wifi_manager import start_access_point
                ap_ssid = settings.get('ap', {}).get('ssid', 'IrrigationSystem')
                ap_password = settings.get('ap', {}).get('password', '12345678')
                start_access_point(ap_ssid, ap_password)
                
                return False
            else:
                HEALTH_INDICATORS['wifi_connection'] = True
                return True
    
    except Exception as e:
        log_event(f"Errore controllo connessione WiFi: {e}", "ERROR")
        HEALTH_INDICATORS['wifi_connection'] = False
        return False

async def check_memory_usage():
    """
    Controlla memoria disponibile.
    
    Returns:
        boolean: True se memoria OK, False se poca memoria
    """
    try:
        # Raccogli dati memoria
        free_mem = gc.mem_free()
        allocated_mem = gc.mem_alloc()
        total_mem = free_mem + allocated_mem
        percent_free = (free_mem / total_mem) * 100
        
        # Aggiorna metriche
        system_metrics['memory_free'] = free_mem
        system_metrics['memory_allocated'] = allocated_mem
        
        # Verifica memoria bassa
        if free_mem < MEMORY_THRESHOLD or percent_free < 10:
            log_event(f"Memoria bassa: {free_mem} bytes ({percent_free:.1f}%), GC forzato", "WARNING")
            gc.collect()
            system_metrics['gc_runs'] += 1
            
            # Verifica dopo GC
            new_free_mem = gc.mem_free()
            new_percent_free = (new_free_mem / total_mem) * 100
            
            log_event(f"Post GC: {new_free_mem} bytes ({new_percent_free:.1f}%)", "INFO")
            
            if new_free_mem < MEMORY_THRESHOLD:
                HEALTH_INDICATORS['memory'] = False
                return False
        
        HEALTH_INDICATORS['memory'] = True
        return True
    
    except Exception as e:
        log_event(f"Errore controllo memoria: {e}", "ERROR")
        HEALTH_INDICATORS['memory'] = False
        return False

async def check_zones_state():
    """
    Verifica stato zone e disattiva quelle attive da troppo tempo.
    
    Returns:
        boolean: True se zone OK, False altrimenti
    """
    try:
        zones_status = get_zones_status()
        current_time = time.time()
        
        # Verifica ogni zona attiva
        active_zones_found = False
        for zone in zones_status:
            if zone['active']:
                active_zones_found = True
                
                # Controlla tempo attivazione
                remaining_time = zone.get('remaining_time', 0)
                
                if remaining_time == 0:
                    # Zona bloccata
                    log_event(f"Zona {zone['id']} bloccata, disattivazione forzata", "WARNING")
                    stop_zone(zone['id'])
                    system_metrics['zone_corrections'] += 1
                elif remaining_time > MAX_ZONE_ACTIVATION_TIME * 60:
                    # Zona attiva da troppo tempo
                    log_event(f"Zona {zone['id']} attiva da troppo tempo, disattivazione", "WARNING")
                    stop_zone(zone['id'])
                    system_metrics['zone_corrections'] += 1
        
        # Verifica coerenza programma
        load_program_state()
        if program_running:
            if not active_zones_found:
                log_event("Programma in esecuzione ma nessuna zona attiva", "WARNING")
                from program_manager import stop_program
                stop_program()
                system_metrics['zone_corrections'] += 1
                HEALTH_INDICATORS['zones'] = False
                return False
        
        HEALTH_INDICATORS['zones'] = True
        return True
    
    except Exception as e:
        log_event(f"Errore controllo stato zone: {e}", "ERROR")
        HEALTH_INDICATORS['zones'] = False
        return False

async def check_programs_state():
    """
    Verifica coerenza programmi.
    
    Returns:
        boolean: True se programmi OK, False altrimenti
    """
    try:
        from program_state import program_running, current_program_id
        from program_manager import load_programs
        
        # Ricarica stato per dati aggiornati
        load_program_state()
        
        # Verifica esistenza programma in esecuzione
        if program_running and current_program_id:
            programs = load_programs()
            
            if current_program_id not in programs:
                log_event(f"Programma {current_program_id} in esecuzione non trovato", "WARNING")
                from program_manager import stop_program
                stop_program()
                HEALTH_INDICATORS['programs'] = False
                return False
        
        HEALTH_INDICATORS['programs'] = True
        return True
    
    except Exception as e:
        log_event(f"Errore controllo stato programmi: {e}", "ERROR")
        HEALTH_INDICATORS['programs'] = False
        return False

async def check_system_health():
    """
    Controllo completo stato sistema.
    """
    try:
        # Aggiorna uptime
        system_metrics['uptime'] = time.time() - system_metrics['start_time']
        
        # Esegui tutti i controlli
        web_server_ok = await check_web_server()
        wifi_ok = await check_wifi_connection()
        memory_ok = await check_memory_usage()
        zones_ok = await check_zones_state()
        programs_ok = await check_programs_state()
        
        # Logga stato completo solo periodicamente o se ci sono problemi
        all_ok = web_server_ok and wifi_ok and memory_ok and zones_ok and programs_ok
        
        if all_ok:
            # Log stato OK ogni 10 iterazioni (circa 10 minuti)
            if int(system_metrics['uptime']) % (CHECK_INTERVAL * 10) < CHECK_INTERVAL:
                free_mem = gc.mem_free()
                allocated_mem = gc.mem_alloc()
                total_mem = free_mem + allocated_mem
                percent_free = (free_mem / total_mem) * 100
                
                log_event(f"Sistema in salute. Uptime: {int(system_metrics['uptime']//3600)}h {int((system_metrics['uptime']%3600)//60)}m. "
                         f"Memoria: {free_mem} bytes liberi ({percent_free:.1f}%)", "INFO")
        else:
            # Log ogni iterazione in caso di problemi
            log_event(f"Problemi rilevati. Stato: "
                     f"WebServer={HEALTH_INDICATORS['web_server']}, "
                     f"WiFi={HEALTH_INDICATORS['wifi_connection']}, "
                     f"Memoria={HEALTH_INDICATORS['memory']}, "
                     f"Zone={HEALTH_INDICATORS['zones']}, "
                     f"Programmi={HEALTH_INDICATORS['programs']}", "WARNING")
    
    except Exception as e:
        log_event(f"Errore controllo salute sistema: {e}", "ERROR")

async def diagnostic_loop():
    """
    Loop principale diagnostica. Questo è il task che deve rimanere attivo.
    """
    log_event("Sistema diagnostica avviato", "INFO")
    
    # Attendi prima del primo controllo
    await asyncio.sleep(30)
    
    while True:
        try:
            await check_system_health()
        except Exception as e:
            log_event(f"Errore grave diagnostica: {e}", "ERROR")
        
        # Controllo più frequente se ci sono problemi noti
        if any(not status for status in HEALTH_INDICATORS.values()):
            await asyncio.sleep(CHECK_INTERVAL // 2)
        else:
            await asyncio.sleep(CHECK_INTERVAL)

async def start_diagnostics():
    """
    Avvia sistema diagnostica.
    Questo è il corretto punto di ingresso che DEVE ritornare il task di diagnostica
    invece di avviarlo direttamente, per evitare che il supervised_task lo riavvii.
    """
    log_event("Sistema diagnostica inizializzato", "INFO")
    return diagnostic_loop()  # Ritorna la coroutine, non creare il task