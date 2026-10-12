```js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_COOKIE_NAME = 'rent-spec.sid';

app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return {
    requests: [],
    messages: [],
    equipment: [],
    settings: {}
  };
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2));
}

function readDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    return {
      ...raw,
      requests: Array.isArray(raw.requests) ? raw.requests : [],
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      equipment: Array.isArray(raw.equipment) ? raw.equipment : [],
      settings: raw.settings && typeof raw.settings === 'object'
        ? raw.settings
        : {}
    };
  } catch (error) {
    console.error('Database read error:', error.message);
    throw error;
  }
}

function writeDb(db) {
  const tempFile = DB_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DB_FILE);
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function safeRequest(r) {
  return {
    id: r.id,
    name: r.name || r.customer || '',
    customer: r.customer || r.name || '',
    phone: r.phone || '',
    equipment: r.equipment || '',
    equipment_id: r.equipment_id || null,
    duration: r.duration || r.rental_duration || '',
    rental_duration: r.rental_duration || r.duration || '',
    address: r.address || r.delivery_address || '',
    delivery_address: r.delivery_address || r.address || '',
    arrival: r.arrival || '',
    arrival_type: r.arrival_type || '',
    arrival_date: r.arrival_date || '',
    wishes: r.wishes || r.message || '',
    message: r.message || r.wishes || '',
    status: r.status || 'Новая',
    createdAt: r.createdAt || r.created_at || '',
    public_token: r.public_token || ''
  };
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(session({
  name: SESSION_COOKIE_NAME,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: process.env.NODE_ENV === 'production',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  }
}));

// Защита файлов сервера и базы данных.
app.use((req, res, next) => {
  let requestedPath;

  try {
    requestedPath = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    return res.sendStatus(400);
  }

  const blocked = [
    'server.js',
    'package.json',
    'package-lock.json',
    '.env',
    'data',
    'node_modules',
    '.git'
  ].some(name =>
    requestedPath === name ||
    requestedPath.startsWith(name + '/') ||
    (name === '.env' && requestedPath.startsWith('.env.'))
  );

  if (blocked) {
    return res.sendStatus(404);
  }

  next();
});

// Статические файлы: HTML, CSS, JavaScript и изображения.
app.use(express.static(ROOT, { index: false }));

// HTML-страницы.
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

app.get('/status.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'status.html'));
});

function adminOnly(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({
      ok: false,
      error: 'Требуется вход администратора.'
    });
  }

  next();
}

// Публичная информация.
app.get('/api/public', (req, res) => {
  const db = readDb();

  res.json({
    siteName: db.settings.siteName || 'Оренда спецтехніки',
    city: db.settings.city || 'Україна',
    equipment: db.equipment.filter(
      item => String(item.status || '').toLowerCase() !== 'hidden'
    )
  });
});

// Создание заявки с главной страницы.
app.post('/api/requests', (req, res) => {
  const body = req.body || {};

  const name = String(body.name || body.customer || '').trim();
  const phone = String(body.phone || '').trim();
  const equipment = String(body.equipment || '').trim();
  const duration = String(body.duration || body.rental_duration || '').trim();
  const address = String(body.address || body.delivery_address || '').trim();

  if (!name || !phone || (!equipment && !body.equipment_id)) {
    return res.status(400).json({
      ok: false,
      error: 'Заповніть ім’я, телефон і виберіть техніку.'
    });
  }

  const db = readDb();

  const request = {
    id: makeId(),
    name,
    customer: name,
    phone,
    equipment,
    equipment_id: body.equipment_id || null,
    duration,
    rental_duration: duration,
    address,
    delivery_address: address,
    arrival: String(body.arrival || ''),
    arrival_type: String(body.arrival_type || ''),
    arrival_date: String(body.arrival_date || ''),
    wishes: String(body.wishes || body.message || ''),
    message: String(body.message || body.wishes || ''),
    status: 'Новая',
    createdAt: new Date().toISOString(),
    public_token: crypto.randomBytes(24).toString('hex')
  };

  db.requests.unshift(request);
  writeDb(db);

  const base = (
    process.env.SITE_URL || req.protocol + '://' + req.get('host')
  ).replace(/\/+$/, '');

  const statusUrl =
    base + '/status.html?token=' + encodeURIComponent(request.public_token);

  res.status(201).json({
    ok: true,
    request: safeRequest(request),
    statusUrl
  });
});

// Получение статуса и сообщений клиента.
app.get('/api/requests/status/:token', (req, res) => {
  const db = readDb();

  const request = db.requests.find(
    item => item.public_token === req.params.token
  );

  if (!request) {
    return res.status(404).json({
      ok: false,
      error: 'Заявка не найдена.'
    });
  }

  const messages = db.messages
    .filter(item => String(item.requestId) === String(request.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  res.json({
    ok: true,
    request: { ...safeRequest(request), messages },
    messages,
    statusLabel: request.status || 'Новая'
  });
});

// Сообщение клиента.
app.post('/api/requests/status/:token/messages', (req, res) => {
  const db = readDb();

  const request = db.requests.find(
    item => item.public_token === req.params.token
  );

  if (!request) {
    return res.status(404).json({
      ok: false,
      error: 'Заявка не найдена.'
    });
  }

  const text = String(req.body?.text || req.body?.message || '').trim();

  if (!text || text.length > 5000) {
    return res.status(400).json({
      ok: false,
      error: 'Введіть повідомлення довжиною до 5000 символів.'
    });
  }

  const message = {
    id: makeId(),
    requestId: request.id,
    from: 'client',
    text,
    createdAt: new Date().toISOString()
  };

  db.messages.push(message);
  writeDb(db);

  res.status(201).json({ ok: true, message });
});

// Вход администратора.
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  const expectedUser =
    process.env.ADMIN_USERNAME || process.env.ADMIN_USER || 'owner';

  const expectedPass =
    process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS;

  if (!expectedPass) {
    return res.status(500).json({
      ok: false,
      error: 'Не задан ADMIN_PASSWORD в Environment.'
    });
  }

  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).json({
      ok: false,
      error: 'Невірний логін або пароль.'
    });
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'Помилка створення сесії.'
      });
    }

    req.session.isAdmin = true;
    req.session.username = username;

    req.session.save(saveError => {
      if (saveError) {
        return res.status(500).json({
          ok: false,
          error: 'Помилка збереження сесії.'
        });
      }

      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, username });
    });
  });
});

// Проверка входа администратора.
app.get('/api/admin/me', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!req.session?.isAdmin) {
    return res.status(401).json({
      ok: false,
      error: 'Не виконано вхід.'
    });
  }

  res.json({ ok: true, username: req.session.username });
});

// Выход администратора.
app.post('/api/admin/logout', (req, res) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'Не вдалося завершити сесію.'
      });
    }

    res.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    res.json({ ok: true });
  });
});

// Данные админ-панели.
app.get('/api/admin/data', adminOnly, (req, res) => {
  const db = readDb();

  const messages = db.messages.slice().sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  const requests = db.requests.map(request => ({
    ...safeRequest(request),
    messages: messages.filter(
      message => String(message.requestId) === String(request.id)
    )
  }));

  res.json({
    ok: true,
    requests,
    messages,
    equipment: db.equipment,
    settings: db.settings
  });
});

// Ответ администратора.
app.post('/api/admin/requests/:id/reply', adminOnly, (req, res) => {
  const db = readDb();

  const request = db.requests.find(
    item => String(item.id) === String(req.params.id)
  );

  if (!request) {
    return res.status(404).json({
      ok: false,
      error: 'Заявка не найдена.'
    });
  }

  const text = String(req.body?.text || req.body?.message || '').trim();

  if (!text || text.length > 5000) {
    return res.status(400).json({
      ok: false,
      error: 'Введіть повідомлення довжиною до 5000 символів.'
    });
  }

  const message = {
    id: makeId(),
    requestId: request.id,
    from: 'admin',
    text,
    createdAt: new Date().toISOString()
  };

  db.messages.push(message);
  writeDb(db);

  res.status(201).json({ ok: true, message });
});

// Изменение статуса заявки.
app.patch('/api/admin/requests/:id', adminOnly, (req, res) => {
  const db = readDb();

  const request = db.requests.find(
    item => String(item.id) === String(req.params.id)
  );

  if (!request) {
    return res.status(404).json({
      ok: false,
      error: 'Заявка не найдена.'
    });
  }

  const status = String(req.body?.status || '').trim();

  if (!status) {
    return res.status(400).json({
      ok: false,
      error: 'Не вказано статус.'
    });
  }

  request.status = status;
  writeDb(db);

  res.json({ ok: true, request: safeRequest(request) });
});

// Удаление заявки.
app.delete('/api/admin/requests/:id', adminOnly, (req, res) => {
  const db = readDb();
  const id = String(req.params.id);
  const previousCount = db.requests.length;

  db.requests = db.requests.filter(
    request => String(request.id) !== id
  );

  if (db.requests.length === previousCount) {
    return res.status(404).json({
      ok: false,
      error: 'Заявка не найдена.'
    });
  }

  db.messages = db.messages.filter(
    message => String(message.requestId) !== id
  );

  writeDb(db);
  res.json({ ok: true });
});

// Неизвестные маршруты.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: 'API-маршрут не знайдено.'
    });
  }

  res.status(404).send('Сторінку не знайдено: ' + req.path);
});

// Обработка серверных ошибок.
app.use((error, req, res, next) => {
  console.error('Server error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: 'Внутрішня помилка сервера.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('RENT SPEC server started on port ' + PORT);
});
```
