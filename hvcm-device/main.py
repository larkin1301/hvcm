# High Voltage Cable Monitor - Device Script (Cellular Only)
# Compatible with RPi Pico W, SIM7028, ICM-20948, NEO-6M GPS

import time
import json
import machine
import ubinascii

from imu_icm20948 import ICM20948
from micropyGPS import MicropyGPS

# === CONFIG ===
API_URL = "https://31051221.benlarkin.co.uk/ingest"
ESTIMATED_MAX_RUNTIME_SEC = 86400  # Estimate full discharge in 24h
MOVEMENT_THRESHOLD = 1.5  # m/s² deviation for alarm

# UART setup for SIM7028 modem
modem_uart = machine.UART(1, baudrate=9600, tx=machine.Pin(4), rx=machine.Pin(5))
# UART setup for GPS (NEO-6M)
gps_uart = machine.UART(0, baudrate=9600, tx=machine.Pin(0), rx=machine.Pin(1))
gps = MicropyGPS(location_formatting='dd')

# I2C for IMU (ICM-20948)
i2c = machine.I2C(0, scl=machine.Pin(17), sda=machine.Pin(16))
imu_sensor = ICM20948(i2c)

# === FUNCTIONS ===

def get_mac():
    mac = ubinascii.hexlify(machine.unique_id()).decode()
    return ':'.join(mac[i:i+2] for i in range(0, len(mac), 2))


def at(cmd):
    # Send AT command and read response, handling line endings and decoding errors
    modem_uart.write((cmd + '').encode())
    time.sleep(1)
    resp = b""
    while modem_uart.any():
        resp += modem_uart.read()
    # Decode safely, ignoring undecodable bytes
    try:
        decoded = resp.decode('utf-8', 'ignore')
    except Exception:
        decoded = ''.join(chr(b) for b in resp)
    return decoded.strip()


def get_modem_info():
    imei = at('AT+GSN')
    iccid = at('AT+CCID')
    operator = at('AT+COPS?')
    signal = at('AT+CSQ')
    registration = at('AT+CREG?')
    cell_info = at('AT+CENG?')
    return imei, iccid, operator, signal, registration, cell_info


def read_imu():
    try:
        accel = imu_sensor.acceleration  # list of x,y,z in m/s²
        gyro = imu_sensor.gyro  # list of x,y,z in °/s
        mag = imu_sensor.magnetic  # list of x,y,z in µT
        temp = imu_sensor.temperature
        return {
            'accel': accel,
            'gyro': gyro,
            'mag': mag,
            'temperature': temp
        }
    except:
        return {'accel':[0,0,0],'gyro':[0,0,0],'mag':[0,0,0],'temperature':0}


def read_gps():
    data = {'lat':0.0,'lon':0.0,'altitude':0,'speed':0,'course':0,'num_satellites':0,'fix_type':0,'utc':[0,0,0]}
    timeout = time.time() + 5
    while time.time() < timeout:
        if gps_uart.any():
            char = gps_uart.read(1)
            if char:
                gps.update(char.decode('utf-8','ignore'))
    if gps.latitude and gps.longitude:
        data['lat'] = gps.latitude[0] * (-1 if gps.latitude[1]=='S' else 1)
        data['lon'] = gps.longitude[0] * (-1 if gps.longitude[1]=='W' else 1)
        data['altitude'] = gps.altitude
        data['speed'] = gps.speed[2]
        data['course'] = gps.course
        data['num_satellites'] = gps.satellites_in_use
        data['fix_type'] = gps.fix_stat
        data['utc'] = [gps.timestamp[0],gps.timestamp[1],gps.timestamp[2]]
    return data


def estimate_battery():
    uptime = int(time.time())
    percent = max(0, min(100, 100 - int((uptime/ESTIMATED_MAX_RUNTIME_SEC)*100)))
    status = 'OK' if percent>20 else 'LOW'
    return percent, status


def detect_movement(accel):
    # accel is list [x, y, z], compare magnitude against gravity
    g = 9.8
    dx = accel[0]
    dy = accel[1]
    dz = accel[2] - g
    magnitude = (dx*dx + dy*dy + dz*dz)**0.5
    return magnitude > MOVEMENT_THRESHOLD


def create_payload():
    mac = get_mac()
    imei, iccid, operator, signal, reg, cell_info = get_modem_info()
    imu = read_imu()
    gpsd = read_gps()
    batt_pct, batt_stat = estimate_battery()
    movement = detect_movement(imu['accel'])
    alarm_state = 1 if movement else 0
    return json.dumps({
        'device_id': mac,
        'cpu_temp': machine.temperature() if hasattr(machine,'temperature') else 0,
        'uptime_sec': int(time.time()),
        'imei': imei,
        'iccid': iccid,
        'operator': operator,
        'signal_strength': signal,
        'registration': reg,
        'cell_info': cell_info,
        'imu': imu,
        'gps': gpsd,
        'battery': {'voltage': batt_pct, 'status': batt_stat},
        'alarm_state': alarm_state
    })


def send_payload(payload):
    at('AT+SAPBR=3,1,"CONTYPE","GPRS"')
    at('AT+SAPBR=3,1,"APN","wap.vodafone.co.uk"')
    at('AT+SAPBR=1,1')
    at('AT+SAPBR=2,1')
    at('AT+HTTPINIT')
    at(f'AT+HTTPPARA="URL","{API_URL}"')
    at('AT+HTTPPARA="CONTENT","application/json"')
    at(f'AT+HTTPDATA={len(payload)},10000')
    time.sleep(1)
    modem_uart.write(payload.encode())
    time.sleep(1)
    at('AT+HTTPACTION=1')
    at('AT+HTTPREAD')
    at('AT+HTTPTERM')
    at('AT+SAPBR=0,1')


# === MAIN EXECUTION ===
payload = create_payload()
print('Payload:', payload)
send_payload(payload)
print('Sleeping for 60s...')
time.sleep(60)

