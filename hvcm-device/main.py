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

def read_imu():
    try:
        accel = imu_sensor.acceleration
        gyro = imu_sensor.gyro
        mag = imu_sensor.magnetic
        temp = imu_sensor.temperature
        return {
            "accel": [accel[0], accel[1], accel[2]],
            "gyro": [gyro[0], gyro[1], gyro[2]],
            "mag": [mag[0], mag[1], mag[2]],
            "temperature": temp
        }
    except Exception as e:
        print("IMU read error:")
        print(e)
        return {
            "accel": [0, 0, 0],
            "gyro": [0, 0, 0],
            "mag": [0, 0, 0],
            "temperature": 0
        }

def read_gps():
    gps_data = {
        "lat": 0.0,
        "lon": 0.0,
        "altitude": 0,
        "speed": 0,
        "course": 0,
        "num_satellites": 0,
        "fix_type": 0,
        "utc": [0, 0, 0]
    }
    try:
        timeout = time.time() + 5  # Read GPS data for 5 seconds
        while time.time() < timeout:
            if gps_uart.any():
                char = gps_uart.read(1)
                if char:
                    gps.update(char.decode('utf-8', 'ignore'))

        if gps.latitude and gps.longitude:
            gps_data["lat"] = gps.latitude[0] * (-1 if gps.latitude[1] == 'S' else 1)
            gps_data["lon"] = gps.longitude[0] * (-1 if gps.longitude[1] == 'W' else 1)
            gps_data["altitude"] = gps.altitude
            gps_data["speed"] = gps.speed[2]  # km/h
            gps_data["course"] = gps.course
            gps_data["num_satellites"] = gps.satellites_in_use
            gps_data["utc"] = [gps.timestamp[0], gps.timestamp[1], gps.timestamp[2]]
            gps_data["fix_type"] = gps.fix_stat
    except Exception as e:
        print("GPS read error:")
        print(e)
    return gps_data

def estimate_battery():
    uptime = int(time.time())
    percent = max(0, min(100, 100 - int((uptime / ESTIMATED_MAX_RUNTIME_SEC) * 100)))
    return percent, "OK" if percent > 20 else "LOW"

def create_payload():
    mac = get_mac()
    cpu_temp = 42.5
    uptime = int(time.time())

    imei, iccid, operator, signal, reg, cell_info = "", "", "", "", "", ""
    imu = read_imu()
    gps = read_gps()
    battery_percent, battery_status = estimate_battery()

    return json.dumps({
        "device_id": mac,
        "cpu_temp": cpu_temp,
        "uptime_sec": uptime,
        "imei": imei,
        "iccid": iccid,
        "operator": operator,
        "signal_strength": signal,
        "registration": reg,
        "cell_info": cell_info,
        "imu": imu,
        "gps": gps,
        "battery": {
            "voltage": battery_percent,
            "status": battery_status
        }
    })

def at(cmd):
    try:
        modem_uart.write((cmd + '\r\n').encode())
        time.sleep(2)
        response = b""
        while modem_uart.any():
            response += modem_uart.read()
        decoded = response.decode('utf-8')
        print("Response: " + decoded)
        return decoded.strip()
    except Exception as err:
        print("AT command failed: " + cmd)
        print("Error: " + str(err))
        return "ERROR"

def send_payload(payload):
    print("Starting HTTP POST over SIM7028...")
    at('AT+SAPBR=3,1,"CONTYPE","GPRS"')
    at('AT+SAPBR=3,1,"APN","wap.vodafone.co.uk"')
    at("AT+SAPBR=1,1")
    at("AT+SAPBR=2,1")
    at("AT+HTTPINIT")
    at('AT+HTTPPARA="URL","' + API_URL + '"')
    at('AT+HTTPPARA="CONTENT","application/json"')
    at('AT+HTTPDATA=' + str(len(payload)) + ',10000')
    time.sleep(1)
    modem_uart.write(payload.encode())
    time.sleep(1)
    at("AT+HTTPACTION=1")
    at("AT+HTTPREAD")
    at("AT+HTTPTERM")
    at("AT+SAPBR=0,1")

# === MAIN EXECUTION ===
payload = create_payload()
send_payload(payload)
print("Done. Sleeping for 60s...")
time.sleep(60)

