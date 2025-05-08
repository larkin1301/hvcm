const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
require('dotenv').config();

const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');

// use an environment variable, or fall back to a safe default
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me_in_production';

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Create DB connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(session({
  key: 'hvcm.sid',
  store: new MySQLStore({}, pool),
  secret: SESSION_SECRET, //secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

// Ping endpoint to confirm app & DB are alive
app.get('/ping-db', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS time');
    res.json({ success: true, serverTime: rows[0].time });
  } catch (err) {
    console.error('❌ DB ERROR:', err.message);
    res.status(500).json({ success: false, error: 'Database connection failed' });
  }
});

// Ingestion endpoint
app.post('/ingest', async (req, res) => {
  const data = req.body;
  console.log('Incoming payload:', JSON.stringify(data));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Device info
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
      'INSERT INTO `gps_data` (`device_id`, `latitude`, `longitude`, `altitude`, `speed`, `course`, `num_satellites`, `fix_type`, `utc_time`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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

    // Battery data
    await conn.query(
      `INSERT INTO battery_data (device_id, voltage, status)
       VALUES (?, ?, ?)`,
      [data.device_id, data.battery.voltage, data.battery.status]
    );

    await conn.commit();
    res.status(200).json({ status: 'success' });
  } catch (err) {
    await conn.rollback();
    console.error('Insert failed for payload:', JSON.stringify(data));
    console.error(err);
    res.status(500).json({ error: 'Failed to insert data', details: err.message });
  } finally {
    conn.release();
  }
});

// Registration endpoint
app.post('/register', async (req, res) => {
  const { name, email, organisation_id, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (name,email,organisation_id,password_hash) VALUES (?,?,?,?)',
    [name, email, organisation_id, hash]
  );
  res.sendStatus(201);
});

// Login endpoint
app.post('/login', async (req,res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
  if (!rows.length || !await bcrypt.compare(password, rows[0].password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = { id: rows[0].id, role: rows[0].role, org: rows[0].organisation_id };
  res.json({ success: true });
});

// Auth middleware
function requireRole(...allowed) {
  return (req,res,next) => {
    if (req.session.user && allowed.includes(req.session.user.role)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

// Example protected route
app.get('/api/devices', requireRole('admin','account_manager','user'), async (req,res) => {
  const u = req.session.user;
  let sql = 'SELECT * FROM devices d';
  let params = [];
  if (u.role === 'account_manager') {
    sql += ' WHERE d.device_id IN (SELECT device_id FROM user_devices WHERE user_id IN (SELECT id FROM users WHERE organisation_id=?))';
    params.push(u.org);
  } else if (u.role === 'user') {
    sql += ' WHERE d.device_id IN (SELECT device_id FROM user_devices WHERE user_id=?)';
    params.push(u.id);
  }
  const [devs] = await pool.query(sql, params);
  res.json(devs);
});

// Start app (Passenger will inject PORT)
const port = process.env.PORT;
if (!port) {
  console.error('❌ PORT not defined. Set it in Plesk.');
  process.exit(1);
}
app.listen(port, () => {
  console.log(`✅ API listening on port ${port}`);
});
