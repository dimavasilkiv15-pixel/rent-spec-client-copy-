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
const PUBLIC_DIR = ROOT;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const SESSION_COOKIE_NAME = 'rent-spec.sid';
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000;

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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  console.error('SESSION_SECRET is not configured.');
  process.exit(1);
}

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
    maxAge: SESSION_MAX_AGE,
    path: '/'
  }
}));

// Защита серверных файлов и базы данных.
app.use((req, res, next) => {
  let requestedPath;

  try {
    requestedPath = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    return res.sendStatus(400);
  }

  const blocked =
    requestedPath === 'server.js' ||
    requestedPath === 'package.json' ||
    requestedPath === 'package-lock.json' ||
    requestedPath === '.env' ||
    requestedPath.startsWith('.env.') ||
    requestedPath === 'data' ||
    requestedPath.startsWith('data/') ||
    requestedPath === 'node_modules' ||
    requestedPath.startsWith('node_modules/') ||
    requestedPath === '.git' ||
    requestedPath.startsWith('.git/');

  if (blocked) {
    return res.sendStatus(404);
  }

  next();
});

// Статические файлы сайта.
app.use(express.static(PUBLIC_DIR, { index: false }));

// Безопасная отправка HTML-файлов.
function sendHtmlFile(filename, label) {
  return (req, res) => {
    const file = path.join(ROOT, filename);

    if (!fs.existsSync(file)) {
      return res.status(404).send(`Файл ${filename} не найден в репозитории.`);
    }

    res.sendFile(file, error => {
      if (error && !res.headersSent) {
        console.error(`${label} error:`, error.message);
        res.status(500).send(`Не удалось открыть ${filename}.`);
      }
    });
  };
}

app.get('/', sendHtmlFile('index.html', 'index.html'));
app.get('/index.html', sendHtmlFile('index.html', 'index.html'));
app.get('/admin.html', sendHtmlFile('admin.html', 'admin.html'));
app.get('/status.html', sendHtmlFile('status.html', 'status.html'));

// Чтение базы данных.
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

// Запись базы данных.
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

function adminOnly(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.status(401).json({
      ok: false,
      error: 'Требуется вход администратора.'
    });
  }

  next();
}

// Публичные данные сайта.
app.get('/api/public', (req, res) => {
  try {
    const db = readDb();
    const settings = db.settings;

    res.json({
      siteName: settings.siteName || settings.site_name || 'Оренда спецтехніки',
      city: settings.city || 'Україна',
      equipment: db.equipment.filter(
        item => String(item.status || '').toLowerCase() !== 'hidden'
      )
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить данные сайта.'
    });
  }
});

// Создание заявки.
app.post('/api/requests', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || body.customer || '').trim();
  const phone = String(body.phone || '').trim();
  const equipment = String(body.equipment || '').trim();

  if (!name || !phone || (!equipment && !body.equipment_id)) {
    return res.status(400).json({
      ok: false,
      error: 'Заповніть ім’я, телефон і виберіть техніку.'
    });
  }

  try {
    const db = readDb();

    const request = {
      id: makeId(),
      name,
      customer: name,
      phone,
      equipment,
      equipment_id: body.equipment_id || null,
      duration: String(body.duration || body.rental_duration || ''),
      rental_duration: String(body.rental_duration || body.duration || ''),
      address: String(body.address || body.delivery_address || ''),
      delivery_address: String(body.delivery_address || body.address || ''),
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
      process.env.SITE_URL || `${req.protocol}://${req.get('host')}`
    ).replace(/\/+$/, '');

    const statusUrl =
      `${base}/status.html?token=${encodeURIComponent(request.public_token)}`;

    res.status(201).json({
      ok: true,
      request: safeRequest(request),
      statusUrl
    });
  } catch (error) {
    console.error('Create request error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось сохранить заявку.'
    });
  }
});

// Получение статуса заявки.
app.get('/api/requests/status/:token', (req, res) => {
  try {
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

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      request: { ...safeRequest(request), messages },
      messages,
      statusLabel: request.status || 'Новая'
    });
  } catch (error) {
    console.error('Get request status error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить статус заявки.'
    });
  }
});

// Сообщение клиента.
app.post('/api/requests/status/:token/messages', (req, res) => {
  const text = String(req.body?.text || req.body?.message || '').trim();

  if (!text || text.length > 5000) {
    return res.status(400).json({
      ok: false,
      error: 'Введите сообщение длиной до 5000 символов.'
    });
  }

  try {
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
  } catch (error) {
    console.error('Client message error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось отправить сообщение.'
    });
  }
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
      error: 'Неверный логин или пароль.'
    });
  }

  req.session.regenerate(error => {
    if (error) {
      console.error('Session regenerate error:', error.message);
      return res.status(500).json({
        ok: false,
        error: 'Ошибка создания сессии.'
      });
    }

    req.session.isAdmin = true;
    req.session.username = username;

    req.session.save(saveError => {
      if (saveError) {
        console.error('Session save error:', saveError.message);
        return res.status(500).json({
          ok: false,
          error: 'Ошибка сохранения сессии.'
        });
      }

      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, username });
    });
  });
});

// Проверка авторизации.
app.get('/api/admin/me', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!req.session?.isAdmin) {
    return res.status(401).json({
      ok: false,
      error: 'Не выполнен вход.'
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
      console.error('Session destroy error:', error.message);
      return res.status(500).json({
        ok: false,
        error: 'Не удалось завершить сессию.'
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
  try {
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

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      requests,
      messages,
      equipment: db.equipment,
      settings: db.settings
    });
  } catch (error) {
    console.error('Admin data error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить данные админ-панели.'
    });
  }
});

// Ответ администратора на заявку.
app.post('/api/admin/requests/:id/reply', adminOnly, (req, res) => {
  const text = String(req.body?.text || req.body?.message || '').trim();

  if (!text || text.length > 5000) {
    return res.status(400).json({
      ok: false,
      error: 'Введите сообщение длиной до 5000 символов.'
    });
  }

  try {
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
  } catch (error) {
    console.error('Admin reply error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось отправить ответ.'
    });
  }
});

// Изменение статуса заявки.
app.patch('/api/admin/requests/:id', adminOnly, (req, res) => {
  const status = String(req.body?.status || '').trim();

  if (!status) {
    return res.status(400).json({
      ok: false,
      error: 'Не указан статус.'
    });
  }

  try {
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

    request.status = status;
    writeDb(db);

    res.json({ ok: true, request: safeRequest(request) });
  } catch (error) {
    console.error('Update request error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось обновить заявку.'
    });
  }
});

// Удаление заявки.
app.delete('/api/admin/requests/:id', adminOnly, (req, res) => {
  try {
    const db = readDb();
    const id = String(req.params.id);
    const count = db.requests.length;

    db.requests = db.requests.filter(
      request => String(request.id) !== id
    );

    if (db.requests.length === count) {
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
  } catch (error) {
    console.error('Delete request error:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Не удалось удалить заявку.'
    });
  }
});

// Неизвестные API-маршруты и страницы.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: 'API-маршрут не найден.'
    });
  }

  res.status(404).send('Страница не найдена: ' + req.path);
});

// Общая обработка ошибок.
app.use((error, req, res, next) => {
  console.error('Server error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: 'Внутренняя ошибка сервера.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});
```
