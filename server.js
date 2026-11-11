'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env.local') });
const EPISODE_PRICE = 2;
const DAILY_REWARD = 10;
const GAME_ACTION_XP = 25;
const GAME_ACTION_COOLDOWN_MS = 1000;
const GAME_AUTO_ATTACK_PRICE = 50;
const GAME_AUTO_ATTACK_DURATION_MS = 5 * 60 * 1000;
const SESSION_DAYS = 30;
const BODY_LIMIT = 1024 * 1024;
const MIN_EPISODE_WORDS = 2000;
const MAX_EPISODE_WORDS = 5000;
const GENRES = new Set(['Hài hước', 'Kinh dị', 'Drama', 'Tình yêu', 'Hành động', '18+']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function readEnvironmentFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

readEnvironmentFile();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICES = {
  adam: process.env.ELEVENLABS_ADAM_VOICE_ID || '',
  eva: process.env.ELEVENLABS_EVA_VOICE_ID || ''
};
const ELEVENLABS_MODEL = 'eleven_v4';
const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (process.env.NODE_ENV === 'production' && (!adminEmail || !process.env.ADMIN_SETUP_KEY)) {
  throw new Error('Production requires ADMIN_EMAIL and ADMIN_SETUP_KEY environment variables.');
}

const databaseDirectory = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(databaseDirectory, { recursive: true });
const audioCacheDirectory = path.join(databaseDirectory, 'audio');
const audioGeneration = new Map();

let adminSetupKey = process.env.ADMIN_SETUP_KEY;
if (!adminSetupKey && process.env.NODE_ENV !== 'production') {
  const secretFile = path.join(databaseDirectory, 'admin-setup-key.txt');
  if (fs.existsSync(secretFile)) {
    adminSetupKey = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    adminSetupKey = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(secretFile, `${adminSetupKey}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Admin bootstrap key saved to ${secretFile}`);
  }
}

const database = new DatabaseSync(path.join(databaseDirectory, 'truyentruyentv.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
    last_checkin TEXT,
    streak INTEGER NOT NULL DEFAULT 0,
    age_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    genre TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'MỚI CẬP NHẬT',
    description TEXT NOT NULL,
    is_published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    preview TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(story_id, episode_number)
  );
  CREATE TABLE IF NOT EXISTS unlocked_episodes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, episode_id)
  );
  CREATE TABLE IF NOT EXISTS reading_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, story_id)
  );
  CREATE TABLE IF NOT EXISTS coin_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_progress (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
    xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
    total_actions INTEGER NOT NULL DEFAULT 0 CHECK (total_actions >= 0),
    last_action_at INTEGER NOT NULL DEFAULT 0,
    auto_attack_expires_at INTEGER NOT NULL DEFAULT 0
  );
`);
const gameProgressColumns = database.prepare('PRAGMA table_info(game_progress)').all();
if (!gameProgressColumns.some((column) => column.name === 'auto_attack_expires_at')) {
  database.exec('ALTER TABLE game_progress ADD COLUMN auto_attack_expires_at INTEGER NOT NULL DEFAULT 0');
}

database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('site_name', 'TruyenTruyenTV');
database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
  'site_tagline',
  'Góc nhỏ của những câu chuyện lớn'
);
database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

function seedStories() {
  const initialStories = [
    {
      id: 'cuoc-hop-bat-on', title: 'Cuộc họp bất ổn', author: 'Mây Mù', genre: 'Hài hước', label: 'TRUYỆN MẪU',
      description: 'Một chiếc email gửi nhầm, ba chiếc ghế xoay và cuộc họp đi vào lòng đất.',
      episodeTitle: 'Khởi đầu', preview: 'Thứ Hai, 8 giờ sáng. Minh mở cửa phòng họp với tâm thế của người đã chuẩn bị sẵn một bài thuyết trình mười hai slide.',
      content: 'Cậu không ngờ thứ duy nhất được trình chiếu hôm nay lại là chiếc màn hình xanh. Cả phòng im lặng nhìn dòng chữ “Kế hoạch giải cứu thứ Hai” trên màn chiếu. Minh nuốt khan. “Ít nhất thì mọi người cũng đã có mặt đầy đủ,” cậu nói, cố tỏ ra bình tĩnh.'
    },
    {
      id: 'can-phong-13', title: 'Căn phòng số 13', author: 'An Nhiên', genre: 'Kinh dị', label: 'TRUYỆN MẪU',
      description: 'Khách sạn cũ có mười hai phòng. Vậy tiếng gõ cửa phòng bạn từ đâu?',
      episodeTitle: 'Chiếc chìa khóa', preview: 'Hành lang khách sạn chìm trong thứ ánh sáng vàng nhợt. Trên sơ đồ tầng, phòng cuối cùng mang số 12.',
      content: 'Nhưng chiếc chìa khóa trong tay Linh lại khắc một con số khác: 13. Cô định quay lại quầy lễ tân, nhưng thang máy đã khép cửa. Sau lưng cô, chiếc tay nắm cửa khẽ xoay xuống.'
    },
    {
      id: 'mua-he-nam-ay', title: 'Mùa hè năm ấy', author: 'Lam Phương', genre: 'Tình yêu', label: 'TRUYỆN MẪU',
      description: 'Gặp lại một người cũ ở tiệm sách quen, giữa ngày hè nhiều gió.',
      episodeTitle: 'Tiệm sách cũ', preview: 'Tiệm sách vẫn bật bản nhạc cũ, mùi giấy mới vẫn phảng phất trong không khí.',
      content: 'Chỉ có người đứng bên khung cửa sổ là khác — hoặc có lẽ, là người mà Hạ đã cố quên suốt bảy năm. “Cậu vẫn đọc trang cuối trước à?” Nam hỏi. Ngoài hiên, cơn mưa đầu mùa bắt đầu rơi.'
    },
    {
      id: 'nhung-manh-ghep', title: 'Những mảnh ghép', author: 'Dạ Thảo', genre: 'Drama', label: 'TRUYỆN MẪU',
      description: 'Một bức thư cũ mở ra bí mật mà cả gia đình chôn giấu.',
      episodeTitle: 'Bức thư không tên', preview: 'Bức thư nằm dưới đáy chiếc hộp gỗ, không đề tên người nhận. Nét chữ của mẹ đã nhòe đi ở dòng đầu tiên.',
      content: 'Cái tên cuối thư thì vẫn rõ ràng: “Gửi con, khi con đã sẵn sàng.” Vy đọc đi đọc lại dòng chữ ấy. Mẹ cô mất đã ba năm, còn chiếc hộp này bị khóa trong căn gác xép từ lâu hơn thế.'
    },
    {
      id: 'chuyen-tau-cuoi', title: 'Chuyến tàu cuối', author: 'K. Minh', genre: 'Hành động', label: 'TRUYỆN MẪU',
      description: 'Chuyến tàu đêm chỉ có một điểm dừng — và không ai được phép xuống.',
      episodeTitle: 'Chuyến tàu đêm', preview: 'Đèn trong toa chớp tắt. Khi sáng trở lại, người soát vé đã biến mất, cửa sổ phủ đầy sương lạnh.',
      content: 'Tấm bản đồ hành trình chỉ còn một chấm đỏ đang nhấp nháy. “Tất cả ngồi yên!” Giọng nói vang lên từ loa, méo mó như phát ra dưới nước. Ở cuối toa, một hành khách đứng dậy — người duy nhất trên tàu không có bóng.'
    },
    {
      id: 'dem-khong-ngu', title: 'Đêm không ngủ', author: 'Hạ Lam', genre: '18+', label: 'TRUYỆN MẪU',
      description: 'Hai người trưởng thành, một lời hẹn cũ và những điều chưa từng nói.',
      episodeTitle: 'Quán cà phê cuối phố', preview: 'Thành phố lên đèn, quán cà phê nhỏ dần vắng khách. Họ ngồi đối diện nhau, giữa hai tách trà đã nguội.',
      content: '“Em vẫn nghĩ anh sẽ không đến.” Mai khẽ xoay chiếc nhẫn trên tay. Khải nhìn ra con phố mưa, nơi những vệt đèn kéo dài như ký ức. Đêm nay, họ không cần vội trả lời bất cứ điều gì.'
    }
  ];

  const addStory = database.prepare(
    'INSERT OR IGNORE INTO stories (id, title, author, genre, label, description) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const addEpisode = database.prepare(
    'INSERT OR IGNORE INTO episodes (id, story_id, episode_number, title, preview, content) VALUES (?, ?, 1, ?, ?, ?)'
  );
  for (const story of initialStories) {
    addStory.run(story.id, story.title, story.author, story.genre, story.label, story.description);
    addEpisode.run(`${story.id}-episode-1`, story.id, story.episodeTitle, story.preview, story.content);
  }
  database.prepare(`
    UPDATE stories SET label = 'TRUYỆN MẪU'
    WHERE id IN ('cuoc-hop-bat-on', 'can-phong-13', 'mua-he-nam-ay',
      'nhung-manh-ghep', 'chuyen-tau-cuoi', 'dem-khong-ngu')
  `).run();
}

seedStories();

const rateLimits = new Map();
const statements = {
  userById: database.prepare('SELECT * FROM users WHERE id = ?'),
  sessionByHash: database.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `),
  hasAdmin: database.prepare("SELECT 1 FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1"),
  storyById: database.prepare('SELECT * FROM stories WHERE id = ? AND is_published = 1'),
  storyByIdAny: database.prepare('SELECT * FROM stories WHERE id = ?'),
  getEpisode: database.prepare('SELECT * FROM episodes WHERE story_id = ? AND episode_number = ?'),
  isEpisodeUnlocked: database.prepare('SELECT 1 FROM unlocked_episodes WHERE user_id = ? AND episode_id = ?'),
  userProgress: database.prepare(`
    SELECT reading_progress.story_id AS storyId, stories.title AS storyTitle,
      reading_progress.episode_number AS episodeNumber, reading_progress.updated_at AS updatedAt
    FROM reading_progress JOIN stories ON stories.id = reading_progress.story_id
    WHERE reading_progress.user_id = ? ORDER BY reading_progress.updated_at DESC LIMIT 50
  `),
  userUnlocks: database.prepare(`
    SELECT unlocked_episodes.episode_id AS episodeId FROM unlocked_episodes
    WHERE unlocked_episodes.user_id = ?
  `)
};

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers
  });
  response.end(JSON.stringify(value));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator === -1
      ? ['', '']
      : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  if (!rawBody) return {};
  try {
    const body = JSON.parse(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body.');
    return body;
  } catch {
    const error = new Error('Invalid JSON body.');
    error.status = 400;
    throw error;
  }
}

function validateOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function limitRequest(request, route, maximum = 10) {
  const now = Date.now();
  const ip = request.socket.remoteAddress || 'unknown';
  const key = `${route}:${ip}`;
  const recent = (rateLimits.get(key) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= maximum) return false;
  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionCookie(value, maxAge) {
  const parts = [`ttv_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  return { token, maxAge: SESSION_DAYS * 24 * 60 * 60 };
}

function currentUser(request) {
  const token = parseCookies(request.headers.cookie).ttv_session;
  if (!token || token.length > 200) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = statements.sessionByHash.get(tokenHash, Date.now());
  return user && user.is_active ? user : null;
}

function requireUser(request, response) {
  const user = currentUser(request);
  if (!user) {
    json(response, 401, { error: 'Vui lòng đăng nhập để tiếp tục.' });
    return null;
  }
  return user;
}

function requireAdmin(request, response) {
  const user = requireUser(request, response);
  if (!user) return null;
  if (user.role !== 'admin') {
    json(response, 403, { error: 'Bạn không có quyền thực hiện thao tác này.' });
    return null;
  }
  return user;
}

function dateInVietnam(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function gamePayload(userId) {
  const progress = database.prepare(
    'SELECT level, xp, total_actions, auto_attack_expires_at FROM game_progress WHERE user_id = ?'
  ).get(userId);
  const nextLevelXp = progress.level * 100;
  return {
    level: progress.level,
    xp: progress.xp,
    nextLevelXp,
    totalActions: progress.total_actions,
    xpPerAction: GAME_ACTION_XP,
    autoAttackExpiresAt: progress.auto_attack_expires_at,
    autoAttackPrice: GAME_AUTO_ATTACK_PRICE,
    autoAttackDurationMs: GAME_AUTO_ATTACK_DURATION_MS
  };
}

function unlockedEpisodeIds(userId) {
  return statements.userUnlocks.all(userId).map((row) => row.episodeId);
}

function mePayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    coins: user.coins,
    lastCheckin: user.last_checkin,
    streak: user.streak,
    ageConfirmed: Boolean(user.age_confirmed),
    canBootstrapAdmin: user.email.toLowerCase() === adminEmail &&
      !statements.hasAdmin.get() &&
      Boolean(adminSetupKey),
    progress: statements.userProgress.all(user.id),
    unlockedEpisodeIds: unlockedEpisodeIds(user.id)
  };
}

function storyList(user) {
  const progress = new Map(statements.userProgress.all(user.id).map((item) => [item.storyId, item]));
  return database.prepare(`
    SELECT stories.*,
      COUNT(episodes.id) AS episode_count,
      (SELECT episodes.title FROM episodes WHERE episodes.story_id = stories.id
        ORDER BY episodes.episode_number LIMIT 1) AS first_episode_title,
      (SELECT episodes.preview FROM episodes WHERE episodes.story_id = stories.id
        ORDER BY episodes.episode_number LIMIT 1) AS preview,
      (SELECT episodes.content FROM episodes WHERE episodes.story_id = stories.id
        ORDER BY episodes.episode_number LIMIT 1) AS first_episode_content
    FROM stories
    LEFT JOIN episodes ON episodes.story_id = stories.id
    WHERE stories.is_published = 1
    GROUP BY stories.id
    ORDER BY stories.created_at DESC
  `).all().map((story) => ({
    id: story.id,
    title: story.title,
    author: story.author,
    genre: story.genre,
    label: story.label,
    description: story.description,
    episodes: story.episode_count,
    sampleOnly: story.first_episode_content !== null &&
      (countWords(story.first_episode_content) < MIN_EPISODE_WORDS ||
        countWords(story.first_episode_content) > MAX_EPISODE_WORDS),
    firstEpisodeTitle: story.first_episode_title,
    preview: story.preview,
    progress: progress.get(story.id) || null
  }));
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function validateEpisodeContent(content) {
  const wordCount = countWords(content);
  if (wordCount < MIN_EPISODE_WORDS || wordCount > MAX_EPISODE_WORDS) {
    const error = new Error(`Nội dung mỗi tập phải có từ ${MIN_EPISODE_WORDS.toLocaleString('vi-VN')} đến ${MAX_EPISODE_WORDS.toLocaleString('vi-VN')} từ. Hiện tại: ${wordCount.toLocaleString('vi-VN')} từ.`);
    error.status = 400;
    throw error;
  }
  return wordCount;
}

function getEpisodeAudioPath(episode, voiceId) {
  const cacheKey = crypto.createHash('sha256')
    .update(`${ELEVENLABS_MODEL}\0vi\0${voiceId}\0${episode.title}\0${episode.content}`)
    .digest('hex');
  return path.join(audioCacheDirectory, `${cacheKey}.mp3`);
}

let elevenLabsClientPromise;

async function createEpisodeAudio(episode, voiceId) {
  const audioPath = getEpisodeAudioPath(episode, voiceId);
  if (fs.existsSync(audioPath)) return audioPath;

  const cacheKey = path.basename(audioPath, '.mp3');
  if (audioGeneration.has(cacheKey)) return audioGeneration.get(cacheKey);

  const generation = (async () => {
    fs.mkdirSync(audioCacheDirectory, { recursive: true });
    elevenLabsClientPromise ||= import('@elevenlabs/elevenlabs-js')
      .then(({ ElevenLabsClient }) => new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY }));
    const client = await elevenLabsClientPromise;
    const audioStream = await client.textToSpeech.convert(voiceId, {
        text: `${episode.title}. ${episode.content}`,
        modelId: ELEVENLABS_MODEL,
        languageCode: 'vi',
        applyTextNormalization: 'on',
        outputFormat: 'mp3_44100_128',
        voiceSettings: {
          stability: 0.45,
          similarityBoost: 0.78
        }
    });
    const chunks = [];
    let audioSize = 0;
    for await (const chunk of audioStream) {
      audioSize += chunk.byteLength;
      if (audioSize > 25 * 1024 * 1024) {
        throw new Error('Dịch vụ giọng đọc trả về tệp âm thanh quá lớn.');
      }
      chunks.push(Buffer.from(chunk));
    }
    const audio = Buffer.concat(chunks, audioSize);
    if (!audio.length) {
      throw new Error('Dịch vụ giọng đọc trả về tệp âm thanh không hợp lệ.');
    }
    const temporaryPath = `${audioPath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryPath, audio, { flag: 'wx' });
    try {
      await fs.promises.rename(temporaryPath, audioPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      if (!fs.existsSync(audioPath)) throw error;
    }
    return audioPath;
  })().catch((error) => {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('Tạo âm thanh mất quá nhiều thời gian. Vui lòng thử lại.');
    }
    throw error;
  }).finally(() => audioGeneration.delete(cacheKey));

  audioGeneration.set(cacheKey, generation);
  return generation;
}

function transaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function slugify(text) {
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    const error = new Error(`${label} không hợp lệ (tối đa ${maximum} ký tự).`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function optionalAccountData(user) {
  return {
    id: user.id, name: user.name, email: user.email, role: user.role,
    coins: user.coins, lastCheckin: user.last_checkin, streak: user.streak
  };
}

async function handleApi(request, response, requestUrl) {
  const pathname = requestUrl.pathname;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/config') {
    return json(response, 200, {
      siteName: database.prepare("SELECT value FROM settings WHERE key = 'site_name'").get().value,
      siteTagline: database.prepare("SELECT value FROM settings WHERE key = 'site_tagline'").get().value
    });
  }

  if (method === 'POST' && ['/api/register', '/api/login', '/api/admin/bootstrap'].includes(pathname) &&
      (!request.headers['content-type'] || !request.headers['content-type'].startsWith('application/json'))) {
    return json(response, 415, { error: 'Yêu cầu nội dung JSON.' });
  }
  if (method !== 'GET' && !validateOrigin(request)) {
    return json(response, 403, { error: 'Yêu cầu không hợp lệ.' });
  }

  if (method === 'POST' && pathname === '/api/register') {
    if (!limitRequest(request, pathname, 5)) return json(response, 429, { error: 'Thử đăng ký lại sau ít phút.' });
    const body = await readJson(request);
    const name = requiredText(body.name, 'Tên hiển thị', 50);
    const email = requiredText(body.email, 'Email', 254).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
      return json(response, 400, { error: 'Vui lòng dùng email hợp lệ và mật khẩu từ 10 ký tự.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const userId = crypto.randomUUID();
    try {
      database.prepare(`
        INSERT INTO users (id, name, email, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)
      `).run(userId, name, email, salt, passwordHash(password, salt));
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message)) {
        return json(response, 409, { error: 'Email này đã có tài khoản.' });
      }
      throw error;
    }
    const session = createSession(userId);
    const user = statements.userById.get(userId);
    return json(response, 201, { user: mePayload(user) }, { 'Set-Cookie': sessionCookie(session.token, session.maxAge) });
  }

  if (method === 'POST' && pathname === '/api/login') {
    if (!limitRequest(request, pathname, 12)) return json(response, 429, { error: 'Thử đăng nhập lại sau ít phút.' });
    const body = await readJson(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length > 128) return json(response, 401, { error: 'Email hoặc mật khẩu không đúng.' });
    const user = database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    const candidate = user ? passwordHash(password, user.password_salt) : passwordHash(password || 'invalid', '00000000000000000000000000000000');
    const valid = user && sameSecret(candidate, user.password_hash);
    if (!valid || !user.is_active) return json(response, 401, { error: 'Email hoặc mật khẩu không đúng.' });
    const session = createSession(user.id);
    return json(response, 200, { user: mePayload(user) }, { 'Set-Cookie': sessionCookie(session.token, session.maxAge) });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(request.headers.cookie).ttv_session;
    if (token) {
      database.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(crypto.createHash('sha256').update(token).digest('hex'));
    }
    return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (method === 'GET' && pathname === '/api/me') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, { user: mePayload(user) });
  }

  if (method === 'GET' && pathname === '/api/session') {
    const user = currentUser(request);
    return json(response, 200, { user: user ? mePayload(user) : null });
  }

  if (method === 'POST' && pathname === '/api/age/confirm') {
    const user = requireUser(request, response);
    if (!user) return;
    database.prepare('UPDATE users SET age_confirmed = 1 WHERE id = ?').run(user.id);
    return json(response, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/stories') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, { stories: storyList(user) });
  }

  if (method === 'GET' && pathname === '/api/game') {
    const user = requireUser(request, response);
    if (!user) return;
    database.prepare('INSERT OR IGNORE INTO game_progress (user_id) VALUES (?)').run(user.id);
    return json(response, 200, { game: gamePayload(user.id) });
  }

  if (method === 'POST' && pathname === '/api/game/auto-attack') {
    const user = requireUser(request, response);
    if (!user) return;
    await readJson(request);
    const now = Date.now();
    const result = transaction(() => {
      database.prepare('INSERT OR IGNORE INTO game_progress (user_id) VALUES (?)').run(user.id);
      const currentUser = statements.userById.get(user.id);
      if (currentUser.coins < GAME_AUTO_ATTACK_PRICE) return false;

      const progress = database.prepare(
        'SELECT auto_attack_expires_at FROM game_progress WHERE user_id = ?'
      ).get(user.id);
      const expiresAt = Math.max(now, progress.auto_attack_expires_at) + GAME_AUTO_ATTACK_DURATION_MS;
      database.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
        .run(GAME_AUTO_ATTACK_PRICE, user.id);
      database.prepare('UPDATE game_progress SET auto_attack_expires_at = ? WHERE user_id = ?')
        .run(expiresAt, user.id);
      database.prepare('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), user.id, -GAME_AUTO_ATTACK_PRICE, 'Kích hoạt tấn công tự động trong 5 phút');
      return true;
    });
    if (!result) return json(response, 422, { error: 'Bạn cần có ít nhất 50 xu để kích hoạt tấn công tự động.' });
    return json(response, 200, {
      game: gamePayload(user.id),
      user: mePayload(statements.userById.get(user.id))
    });
  }

  if (method === 'POST' && pathname === '/api/game/action') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const now = Date.now();
    const result = transaction(() => {
      database.prepare('INSERT OR IGNORE INTO game_progress (user_id) VALUES (?)').run(user.id);
      const progress = database.prepare('SELECT * FROM game_progress WHERE user_id = ?').get(user.id);
      if (body.automatic === true && progress.auto_attack_expires_at <= now) {
        return { autoAttackExpired: true };
      }
      const cooldownRemaining = GAME_ACTION_COOLDOWN_MS - (now - progress.last_action_at);
      if (cooldownRemaining > 0) return { cooldownRemaining };

      let xp = progress.xp + GAME_ACTION_XP;
      let level = progress.level;
      let levelsGained = 0;
      while (xp >= level * 100) {
        xp -= level * 100;
        level += 1;
        levelsGained += 1;
      }

      database.prepare(`
        UPDATE game_progress
        SET level = ?, xp = ?, total_actions = total_actions + 1, last_action_at = ?
        WHERE user_id = ?
      `).run(level, xp, now, user.id);
      if (levelsGained) {
        database.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(levelsGained, user.id);
        database.prepare('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)')
          .run(crypto.randomUUID(), user.id, levelsGained, `Lên cấp ${level} trong trò chơi`);
      }
      return { levelsGained };
    });
    if (result.autoAttackExpired) {
      return json(response, 403, { error: 'Thời gian tấn công tự động đã hết.' });
    }
    if (result.cooldownRemaining) {
      return json(response, 429, {
        error: 'Bạn hãy chờ một chút trước khi ra đòn tiếp theo.',
        retryAfterMs: result.cooldownRemaining
      });
    }
    return json(response, 200, {
      game: gamePayload(user.id),
      user: mePayload(statements.userById.get(user.id)),
      levelsGained: result.levelsGained
    });
  }

  if (method === 'GET' && pathname === '/api/audio/status') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, {
      available: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICES.adam && ELEVENLABS_VOICES.eva),
      voices: ['adam', 'eva'],
      model: ELEVENLABS_MODEL,
      provider: 'ElevenLabs'
    });
  }

  const episodeAudioRoute = pathname.match(/^\/api\/stories\/([a-z0-9-]+)\/episodes\/(\d+)\/audio$/);
  if (episodeAudioRoute && method === 'GET') {
    const user = requireUser(request, response);
    if (!user) return;
    const [, storyId, episodeNumberText] = episodeAudioRoute;
    const voice = requestUrl.searchParams.get('voice');
    const voiceId = ELEVENLABS_VOICES[voice];
    if (!voiceId || !ELEVENLABS_API_KEY) {
      return json(response, 503, { error: 'Adam/Eva chưa được cấu hình trên máy chủ. Admin cần thêm ELEVENLABS_API_KEY cùng hai voice ID.' });
    }
    if (!limitRequest(request, `/api/audio/${user.id}`, 10)) {
      return json(response, 429, { error: 'Bạn đã yêu cầu nhiều lượt tạo audio. Hãy đợi ít phút rồi thử lại.' });
    }
    const story = statements.storyById.get(storyId);
    if (!story) return json(response, 404, { error: 'Không tìm thấy truyện.' });
    if (story.genre === '18+' && !user.age_confirmed) {
      return json(response, 403, { error: 'Cần xác nhận đủ 18 tuổi để nghe thể loại này.' });
    }
    const episode = statements.getEpisode.get(storyId, Number(episodeNumberText));
    if (!episode) return json(response, 404, { error: 'Không tìm thấy tập truyện.' });
    if (!statements.isEpisodeUnlocked.get(user.id, episode.id)) {
      return json(response, 403, { error: 'Bạn cần mở khóa tập truyện trước khi nghe bản đầy đủ.' });
    }
    try {
      validateEpisodeContent(episode.content);
    } catch (error) {
      return json(response, error.status, {
        error: 'Đây là đoạn trích mẫu chưa đủ độ dài. Admin cần cập nhật thành tập 2.000–5.000 từ trước khi tạo audio.'
      });
    }
    try {
      const audioPath = await createEpisodeAudio(episode, voiceId);
      const audio = await fs.promises.readFile(audioPath);
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Cache-Control': 'private, max-age=86400',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(audio);
    } catch (error) {
      if (error.status) return json(response, error.status, { error: error.message });
      console.error('ElevenLabs audio generation failed:', error);
      return json(response, 502, { error: 'Không thể tạo audio lúc này. Kiểm tra cấu hình ElevenLabs và thử lại.' });
    }
  }

  const episodeRoute = pathname.match(/^\/api\/stories\/([a-z0-9-]+)\/episodes\/(\d+)$/);
  if (episodeRoute && method === 'GET') {
    const user = requireUser(request, response);
    if (!user) return;
    const [, storyId, episodeNumberText] = episodeRoute;
    const story = statements.storyById.get(storyId);
    if (!story) return json(response, 404, { error: 'Không tìm thấy truyện.' });
    if (story.genre === '18+' && !user.age_confirmed) {
      return json(response, 403, { error: 'Cần xác nhận đủ 18 tuổi để đọc thể loại này.' });
    }
    const episode = statements.getEpisode.get(storyId, Number(episodeNumberText));
    if (!episode) return json(response, 404, { error: 'Không tìm thấy tập truyện.' });
    const unlocked = Boolean(statements.isEpisodeUnlocked.get(user.id, episode.id));
    return json(response, 200, {
      story: { id: story.id, title: story.title, author: story.author, genre: story.genre },
      episode: {
        number: episode.episode_number,
        title: episode.title,
        preview: episode.preview,
        content: unlocked ? episode.content : null,
        unlocked,
        wordCount: countWords(episode.content),
        meetsLengthRequirement: countWords(episode.content) >= MIN_EPISODE_WORDS &&
          countWords(episode.content) <= MAX_EPISODE_WORDS
      }
    });
  }

  const unlockRoute = pathname.match(/^\/api\/stories\/([a-z0-9-]+)\/episodes\/(\d+)\/unlock$/);
  if (unlockRoute && method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    const [, storyId, episodeNumberText] = unlockRoute;
    const story = statements.storyById.get(storyId);
    if (!story) return json(response, 404, { error: 'Không tìm thấy truyện.' });
    if (story.genre === '18+' && !user.age_confirmed) {
      return json(response, 403, { error: 'Cần xác nhận đủ 18 tuổi để đọc thể loại này.' });
    }
    const episode = statements.getEpisode.get(storyId, Number(episodeNumberText));
    if (!episode) return json(response, 404, { error: 'Không tìm thấy tập truyện.' });
    if (!statements.isEpisodeUnlocked.get(user.id, episode.id)) {
      try {
        validateEpisodeContent(episode.content);
      } catch {
        return json(response, 422, { error: 'Đây là đoạn trích mẫu chưa đủ độ dài, Admin cần cập nhật thành tập 2.000–5.000 từ.' });
      }
    }
    const result = transaction(() => {
      if (statements.isEpisodeUnlocked.get(user.id, episode.id)) {
        return { alreadyUnlocked: true };
      }
      const debit = database.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?')
        .run(EPISODE_PRICE, user.id, EPISODE_PRICE);
      if (!debit.changes) return null;
      database.prepare('INSERT INTO unlocked_episodes (user_id, episode_id) VALUES (?, ?)')
        .run(user.id, episode.id);
      database.prepare('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), user.id, -EPISODE_PRICE, `Mở khóa ${story.title} — tập ${episode.episode_number}`);
      return { alreadyUnlocked: false };
    });
    if (!result) return json(response, 402, { error: 'Bạn chưa đủ coin để mở khóa tập truyện này.' });
    return json(response, 200, { user: mePayload(statements.userById.get(user.id)), ...result });
  }

  if (method === 'POST' && pathname === '/api/checkin') {
    const user = requireUser(request, response);
    if (!user) return;
    const today = dateInVietnam();
    const result = transaction(() => {
      const fresh = statements.userById.get(user.id);
      if (fresh.last_checkin === today) return false;
      const streak = fresh.last_checkin === previousDate(today) ? fresh.streak + 1 : 1;
      database.prepare('UPDATE users SET coins = coins + ?, last_checkin = ?, streak = ? WHERE id = ?')
        .run(DAILY_REWARD, today, streak, user.id);
      database.prepare('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), user.id, DAILY_REWARD, 'Điểm danh hàng ngày');
      return true;
    });
    if (!result) return json(response, 409, { error: 'Bạn đã điểm danh hôm nay rồi.' });
    return json(response, 200, { user: mePayload(statements.userById.get(user.id)) });
  }

  if (method === 'POST' && pathname === '/api/coins/demo-topup') {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_TOPUP === 'false') {
      return json(response, 403, { error: 'Nạp tiền cần được kết nối với cổng thanh toán trước khi đưa vào hoạt động.' });
    }
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const amount = Number(body.amount);
    if (![20, 65, 135].includes(amount)) return json(response, 400, { error: 'Gói coin không hợp lệ.' });
    transaction(() => {
      database.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, user.id);
      database.prepare('INSERT INTO coin_transactions (id, user_id, amount, reason) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), user.id, amount, 'Nạp coin thử nghiệm');
    });
    return json(response, 200, { user: mePayload(statements.userById.get(user.id)) });
  }

  if (method === 'POST' && pathname === '/api/progress') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const storyId = requiredText(body.storyId, 'Mã truyện', 80);
    const episodeNumber = Number(body.episodeNumber);
    const story = statements.storyById.get(storyId);
    if (!story || !Number.isInteger(episodeNumber) || episodeNumber < 1 ||
        !statements.getEpisode.get(storyId, episodeNumber)) {
      return json(response, 400, { error: 'Vị trí đọc truyện không hợp lệ.' });
    }
    if (story.genre === '18+' && !user.age_confirmed) {
      return json(response, 403, { error: 'Cần xác nhận đủ 18 tuổi để đọc thể loại này.' });
    }
    database.prepare(`
      INSERT INTO reading_progress (user_id, story_id, episode_number)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, story_id) DO UPDATE SET
        episode_number = excluded.episode_number, updated_at = CURRENT_TIMESTAMP
    `).run(user.id, storyId, episodeNumber);
    return json(response, 200, { progress: statements.userProgress.all(user.id) });
  }

  if (method === 'POST' && pathname === '/api/admin/bootstrap') {
    if (!limitRequest(request, pathname, 5)) return json(response, 429, { error: 'Thử lại sau ít phút.' });
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    if (user.email.toLowerCase() !== adminEmail || !adminSetupKey) {
      return json(response, 403, { error: 'Tài khoản này không được cấu hình làm Admin.' });
    }
    const promoted = transaction(() => {
      if (statements.hasAdmin.get()) return false;
      if (!sameSecret(body.setupKey, adminSetupKey)) return null;
      return database.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND email = ? COLLATE NOCASE")
        .run(user.id, adminEmail).changes > 0;
    });
    if (promoted === null) return json(response, 403, { error: 'Mã thiết lập Admin không chính xác.' });
    if (!promoted) return json(response, 409, { error: 'Quyền Admin đã được thiết lập hoặc không thể cấp.' });
    const savedKey = path.join(databaseDirectory, 'admin-setup-key.txt');
    if (fs.existsSync(savedKey)) fs.rmSync(savedKey, { force: true });
    adminSetupKey = '';
    return json(response, 200, { user: mePayload(statements.userById.get(user.id)) });
  }

  if (pathname.startsWith('/api/admin/')) {
    const admin = requireAdmin(request, response);
    if (!admin) return;

    if (method === 'GET' && pathname === '/api/admin/users') {
      const users = database.prepare(`
        SELECT id, name, email, role, is_active AS active, coins, created_at AS createdAt
        FROM users ORDER BY created_at DESC LIMIT 500
      `).all();
      return json(response, 200, { users });
    }

    const userRoute = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/status$/);
    if (userRoute && method === 'PATCH') {
      const userId = userRoute[1];
      const body = await readJson(request);
      if (userId === admin.id) return json(response, 400, { error: 'Không thể khóa tài khoản Admin đang đăng nhập.' });
      if (typeof body.active !== 'boolean') return json(response, 400, { error: 'Trạng thái tài khoản không hợp lệ.' });
      const target = statements.userById.get(userId);
      if (!target) return json(response, 404, { error: 'Không tìm thấy tài khoản.' });
      if (target.role === 'admin') return json(response, 403, { error: 'Không thể khóa tài khoản Admin khác tại đây.' });
      database.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(Number(body.active), userId);
      if (!body.active) database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return json(response, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/stories') {
      const stories = database.prepare(`
        SELECT stories.id, stories.title, stories.author, stories.genre, stories.label,
          stories.description, stories.is_published AS published,
          COUNT(episodes.id) AS episodeCount
        FROM stories LEFT JOIN episodes ON episodes.story_id = stories.id
        GROUP BY stories.id ORDER BY stories.created_at DESC
      `).all().map((story) => {
        const episodes = database.prepare(`
          SELECT episode_number AS number, title, content
          FROM episodes WHERE story_id = ? ORDER BY episode_number
        `).all(story.id).map((episode) => ({
          number: episode.number,
          title: episode.title,
          wordCount: countWords(episode.content)
        }));
        return {
          ...story,
          episodes,
          sampleOnly: episodes.some((episode) =>
            episode.wordCount < MIN_EPISODE_WORDS || episode.wordCount > MAX_EPISODE_WORDS)
        };
      });
      return json(response, 200, { stories });
    }

    if (method === 'POST' && pathname === '/api/admin/stories') {
      const body = await readJson(request);
      const title = requiredText(body.title, 'Tên truyện', 120);
      const author = requiredText(body.author, 'Tác giả', 80);
      const genre = requiredText(body.genre, 'Thể loại', 20);
      const description = requiredText(body.description, 'Mô tả', 400);
      const episodeTitle = requiredText(body.episodeTitle, 'Tên tập', 120);
      const preview = requiredText(body.preview, 'Đoạn giới thiệu tập', 2000);
      const content = requiredText(body.content, 'Nội dung tập', 100000);
      validateEpisodeContent(content);
      if (!GENRES.has(genre)) return json(response, 400, { error: 'Thể loại không hợp lệ.' });
      let storyId = slugify(title);
      if (!storyId) return json(response, 400, { error: 'Tên truyện không hợp lệ.' });
      while (statements.storyByIdAny.get(storyId)) storyId = `${slugify(title).slice(0, 60)}-${crypto.randomBytes(3).toString('hex')}`;
      const episodeId = `${storyId}-episode-1`;
      transaction(() => {
        database.prepare(`
          INSERT INTO stories (id, title, author, genre, label, description)
          VALUES (?, ?, ?, ?, 'MỚI CẬP NHẬT', ?)
        `).run(storyId, title, author, genre, description);
        database.prepare(`
          INSERT INTO episodes (id, story_id, episode_number, title, preview, content)
          VALUES (?, ?, 1, ?, ?, ?)
        `).run(episodeId, storyId, episodeTitle, preview, content);
      });
      return json(response, 201, { ok: true, storyId });
    }

    const addEpisodeRoute = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/episodes$/);
    if (addEpisodeRoute && method === 'POST') {
      const storyId = addEpisodeRoute[1];
      const story = statements.storyByIdAny.get(storyId);
      if (!story) return json(response, 404, { error: 'Không tìm thấy truyện.' });
      const body = await readJson(request);
      const title = requiredText(body.title, 'Tên tập', 120);
      const preview = requiredText(body.preview, 'Đoạn giới thiệu tập', 2000);
      const content = requiredText(body.content, 'Nội dung tập', 100000);
      validateEpisodeContent(content);
      const episodeNumber = database.prepare('SELECT COALESCE(MAX(episode_number), 0) + 1 AS next FROM episodes WHERE story_id = ?')
        .get(storyId).next;
      database.prepare(`
        INSERT INTO episodes (id, story_id, episode_number, title, preview, content) VALUES (?, ?, ?, ?, ?, ?)
      `).run(`${storyId}-episode-${episodeNumber}`, storyId, episodeNumber, title, preview, content);
      return json(response, 201, { ok: true, episodeNumber });
    }

    const adminEpisodesRoute = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/episodes$/);
    if (adminEpisodesRoute && method === 'GET') {
      const storyId = adminEpisodesRoute[1];
      if (!statements.storyByIdAny.get(storyId)) return json(response, 404, { error: 'Không tìm thấy truyện.' });
      const episodes = database.prepare(`
        SELECT episode_number AS number, title, preview, content
        FROM episodes WHERE story_id = ? ORDER BY episode_number
      `).all(storyId).map((episode) => ({ ...episode, wordCount: countWords(episode.content) }));
      return json(response, 200, { episodes });
    }

    const updateEpisodeRoute = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/episodes\/(\d+)$/);
    if (updateEpisodeRoute && method === 'PUT') {
      const [, storyId, episodeNumberText] = updateEpisodeRoute;
      const episodeNumber = Number(episodeNumberText);
      const episode = statements.getEpisode.get(storyId, episodeNumber);
      if (!episode) return json(response, 404, { error: 'Không tìm thấy tập truyện.' });
      const body = await readJson(request);
      const title = requiredText(body.title, 'Tên tập', 120);
      const preview = requiredText(body.preview, 'Đoạn giới thiệu tập', 2000);
      const content = requiredText(body.content, 'Nội dung tập', 100000);
      const wordCount = validateEpisodeContent(content);
      database.prepare(`
        UPDATE episodes SET title = ?, preview = ?, content = ? WHERE story_id = ? AND episode_number = ?
      `).run(title, preview, content, storyId, episodeNumber);
      return json(response, 200, { ok: true, episodeNumber, wordCount });
    }

    const storyStatusRoute = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/status$/);
    if (storyStatusRoute && method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body.published !== 'boolean') return json(response, 400, { error: 'Trạng thái truyện không hợp lệ.' });
      const result = database.prepare('UPDATE stories SET is_published = ? WHERE id = ?')
        .run(Number(body.published), storyStatusRoute[1]);
      if (!result.changes) return json(response, 404, { error: 'Không tìm thấy truyện.' });
      return json(response, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/settings') {
      const settings = database.prepare('SELECT key, value FROM settings').all();
      return json(response, 200, {
        siteName: settings.find((item) => item.key === 'site_name')?.value || 'TruyenTruyenTV',
        siteTagline: settings.find((item) => item.key === 'site_tagline')?.value || ''
      });
    }

    if (method === 'PATCH' && pathname === '/api/admin/settings') {
      const body = await readJson(request);
      const siteName = requiredText(body.siteName, 'Tên website', 60);
      const siteTagline = requiredText(body.siteTagline, 'Mô tả website', 160);
      const update = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      transaction(() => {
        update.run('site_name', siteName);
        update.run('site_tagline', siteTagline);
      });
      return json(response, 200, { siteName, siteTagline });
    }
    return json(response, 404, { error: 'Không tìm thấy chức năng quản trị.' });
  }

  return json(response, 404, { error: 'Không tìm thấy đường dẫn API.' });
}

function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'"
    ].join('; ')
  };
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }
  return headers;
}

function createServer() {
  return http.createServer(async (request, response) => {
    const headers = securityHeaders();
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (requestUrl.pathname.startsWith('/api/')) {
        const apiResponse = {
          writeHead(status, values) {
            response.writeHead(status, { ...headers, ...values });
            return response;
          },
          end(body) { response.end(body); }
        };
        await handleApi(request, apiResponse, requestUrl);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
        response.end('Method not allowed.');
        return;
      }
      let relative = decodeURIComponent(requestUrl.pathname);
      if (relative === '/') relative = '/index.html';
      if (!['/index.html', '/style.css', '/game.js'].includes(relative)) {
        response.writeHead(404, headers);
        response.end('Not found.');
        return;
      }
      const filePath = path.resolve(ROOT, `.${relative}`);
      if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
        response.writeHead(404, headers);
        response.end('Not found.');
        return;
      }
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        response.writeHead(404, headers);
        response.end('Not found.');
        return;
      }
      if (!stat.isFile() || path.basename(filePath).startsWith('.')) {
        response.writeHead(404, headers);
        response.end('Not found.');
        return;
      }
      response.writeHead(200, {
        ...headers,
        'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': stat.size
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error.status) return json(response, error.status, { error: error.message }, headers);
      console.error('Request failed:', error);
      return json(response, 500, { error: 'Đã xảy ra lỗi trên máy chủ. Vui lòng thử lại.' }, headers);
    }
  });
}

async function startServer({ host = process.env.HOST || '0.0.0.0', port = Number(process.env.PORT || 3000) } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (address && typeof address === 'object') {
    console.log(`TruyenTruyenTV đang chạy tại http://${host}:${address.port}`);
  }
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Không thể khởi động máy chủ:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  startServer,
  closeDatabase() {
    if (database.isOpen) database.close();
  }
};
