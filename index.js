const express = require('express');
const bodyParser = require('body-parser');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Serve static files
app.use(express.static('public'));

// DB ping endpoint
app.get('/ping-db', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS time');
    res.json({ success: true, serverTime: rows[0].time });
  } catch (err) {
    console.error('DB connection failed:', err);
    res.status(500).json({ success: false, error: 'Database connection failed' });
  }
});

// Ingestion endpoint
app.post('/ingest', async (req, res) => {
  const data = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Insert/update device info
    await conn.query(
      `INSERT INTO devices (device_id, cpu_temp, uptime_sec, device_status)
       VALUES (?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE cpu_temp = VALUES(cpu_temp), uptime_sec = VALUES(uptime_sec)`,
      [data.device_id, data.cpu_temp, data.uptime_sec]
    );

    // Modem data
    await conn.query(
      `INSERT INTO modem_data (device_id, imei, iccid, operator, signal_strength, registration, cell_info)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.device_id, data.imei, data.iccid, data.operator, data.signal_strength, data.registration, data.cell_info]
    );

    // IMU data
    await conn.query(
      `INSERT INTO imu_data (device_id, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, mag_x, mag_y, mag_z, temperature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.device_id,
        ...data.imu.accel,
        ...data.imu.gyro,
        ...data.imu.mag,
        data.imu.temperature
      ]
    );

    // GPS data
    await conn.query(
      `INSERT INTO gps_data (device_id, latitude, longitude, altitude, speed, course, num_satellites, fix_type, utc_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.device_id,
        data.gps.lat,
        data.gps.lon,
        data.gps.altitude,
        data.gps.speed,
        data.gps.course,
        data.gps.num_satellites,
        data.gps.fix_type,
        `${data.gps.utc[0]}:${data.gps.utc[1]}:${data.gps.utc[2]}`
      ]
    );

    // Battery
    await conn.query(
      `INSERT INTO battery_data (device_id, voltage, status)
       VALUES (?, ?, ?)`,
      [data.device_id, data.battery.voltage, data.battery.status]
    );

    await conn.commit();
    res.status(200).json({ status: 'success' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to insert data' });
  } finally {
    conn.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
