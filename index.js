const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
// Serve static files from 'public' directory
// Note: placed after API routes to avoid catching API calls
// app.use(express.static('public'));

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

// Session middleware
app.use(session({
  key: 'hvcm.sid',
  store: new MySQLStore({}, pool),
  secret: process.env.SESSION_SECRET || 'change_me_in_production',
  resave: false,
  saveUninitialized: false
}));

// Ping endpoint
app.get('/ping-db', async (req, res) => {
  try {
    
    const [rows] = await pool.query('SELECT NOW() AS time');
    res.json({ success: true, serverTime: rows[0].time });
  } catch (err) {
    console.error('DB connection failed:', err);
    res.status(500).json({ success: false, error: 'Database connection failed' });
  }
});

// Registration endpoint
app.post('/register', async (req, res) => {
  const { name, email, organisation_id, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, organisation_id, password_hash) VALUES (?, ?, ?, ?)',
      [name, email, organisation_id || null, hash]
    );
    res.sendStatus(201);
  } catch (err) {
    console.error('Registration failed:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT id, role, organisation_id, password_hash FROM users WHERE email = ?',
      [email]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Establish session
    req.session.user = {
      id: user.id,
      role: user.role,
      organisation_id: user.organisation_id
    };
    res.json({ success: true });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout endpoint
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('hvcm.sid');
    res.sendStatus(200);
  });
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

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (req.session.user && allowed.includes(req.session.user.role)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// Debug endpoint to test session and routing
app.get('/api/debug', requireAuth, (req, res) => {
  console.log('DEBUG /api/debug user:', req.session.user);
  res.json({ session: req.session.user });
});

// GET devices with latest location
app.get('/api/devices', requireAuth, requireRole('admin','account_manager','user'), async (req, res) => {
  const u = req.session.user;
  let sql = `SELECT g.device_id, g.latitude, g.longitude, g.altitude, g.timestamp
             FROM gps_data g
             JOIN (
               SELECT device_id, MAX(timestamp) AS ts
               FROM gps_data
               GROUP BY device_id
             ) AS latest ON g.device_id = latest.device_id AND g.timestamp = latest.ts`;
  const params = [];
  console.log('Executing SQL:', sql, 'Params:', params);
  if (u.role === 'account_manager') {
    sql = `SELECT g.device_id, g.latitude, g.longitude, g.altitude, g.timestamp
           FROM gps_data g
           JOIN (
             SELECT device_id, MAX(timestamp) AS ts FROM gps_data GROUP BY device_id
           ) AS latest ON g.device_id = latest.device_id AND g.timestamp = latest.ts
           WHERE g.device_id IN (
             SELECT device_id FROM user_devices WHERE user_id IN (
               SELECT id FROM users WHERE organisation_id = ?
             )
           )`;
    params.push(u.organisation_id);
  } else if (u.role === 'user') {
    sql = `SELECT g.device_id, g.latitude, g.longitude, g.altitude, g.timestamp
           FROM gps_data g
           JOIN (
             SELECT device_id, MAX(timestamp) AS ts FROM gps_data GROUP BY device_id
           ) AS latest ON g.device_id = latest.device_id AND g.timestamp = latest.ts
           WHERE g.device_id IN (
             SELECT device_id FROM user_devices WHERE user_id = ?
           )`;
    params.push(u.id);
  }
  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching devices:', err);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Serve frontend static files
app.use(express.static('public'));

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API running on port ${port}`);
});
