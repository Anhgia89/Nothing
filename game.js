'use strict';

const EPISODE_PRICE = 2;
const categories = ['Tất cả', 'Hài hước', 'Kinh dị', 'Drama', 'Tình yêu', 'Hành động', '18+'];
const coverStyles = {
  'Hài hước': ['cover-comedy', '☻'],
  'Kinh dị': ['cover-horror', '☾'],
  Drama: ['cover-drama', '◇'],
  'Tình yêu': ['cover-romance', '✿'],
  'Hành động': ['cover-action', '↗'],
  '18+': ['cover-mature', '♡']
};
const $ = (id) => document.getElementById(id);
let user = null;
let stories = [];
let gameProgress = null;
let gameAutoAttackTimeout = null;
let gameAutoAttackInFlight = false;
let siteConfig = { siteName: 'TruyenTruyenTV', siteTagline: 'Góc nhỏ của những câu chuyện lớn' };
let activeCategory = 'Tất cả';
let activeStory = null;
let activeEpisode = 1;
let pendingMatureStory = null;
let toastTimer;
let audioObjectUrl = null;
let audioConfigured = false;
let currentAudioAllowed = false;
let audioRequestController = null;

async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Máy chủ trả về phản hồi không hợp lệ.');
  }
  if (!response.ok) {
    const error = new Error(data.error || 'Không thể hoàn tất yêu cầu.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
}

function updateClock() {
  $('liveClock').textContent = new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

function updateSiteBranding() {
  document.title = `${siteConfig.siteName} — Chuyện hay, đọc mỗi ngày`;
  document.querySelectorAll('.brand-name').forEach((element) => {
    const name = element.firstChild;
    if (name) name.textContent = siteConfig.siteName;
  });
  $('siteTagline').textContent = siteConfig.siteTagline.toLocaleUpperCase('vi');
}

function renderBalance() {
  if (!user) return;
  $('coinBalance').textContent = user.coins.toLocaleString('vi-VN');
  $('streakCount').textContent = String(user.streak);
  const checkedIn = user.lastCheckin === new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  $('checkinButton').disabled = checkedIn;
  $('checkinButton').innerHTML = checkedIn ? 'Đã điểm danh <span>✓</span>' : 'Điểm danh <span>→</span>';
  $('profileButton').textContent = user.name.slice(0, 1).toLocaleUpperCase('vi');
  $('openAdmin').hidden = user.role !== 'admin';
  renderContinueReading();
}

function renderContinueReading() {
  const progress = user?.progress?.[0];
  if (!progress) {
    $('continueSection').hidden = true;
    return;
  }
  $('continueDescription').textContent = `${progress.storyTitle} · Tập ${progress.episodeNumber}`;
  $('continueSection').hidden = false;
  $('continueButton').onclick = () => openStory(progress.storyId, progress.episodeNumber);
}

function renderFilters() {
  const container = $('filters');
  container.replaceChildren(...categories.map((category) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-chip${activeCategory === category ? ' active' : ''}`;
    button.textContent = category;
    button.addEventListener('click', () => {
      activeCategory = category;
      renderFilters();
      renderStories();
    });
    return button;
  }));
}

function createStoryCard(story, index, total) {
  const [coverClass, symbol] = coverStyles[story.genre] || coverStyles.Drama;
  const article = document.createElement('article');
  article.className = 'story-card';
  article.dataset.storyId = story.id;
  article.tabIndex = 0;
  article.setAttribute('role', 'button');
  article.setAttribute('aria-label', `Đọc truyện ${story.title}`);

  const cover = document.createElement('div');
  cover.className = `story-cover ${coverClass}`;
  const flag = document.createElement('span');
  flag.className = `story-flag${story.genre === '18+' ? ' age' : ''}`;
  flag.textContent = story.sampleOnly ? 'CÓ TẬP MẪU' : story.progress ? 'ĐỌC TIẾP' : story.label;
  const mark = document.createElement('span');
  mark.className = 'cover-symbol';
  mark.textContent = symbol;
  const number = document.createElement('span');
  number.className = 'cover-number';
  number.textContent = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  cover.append(flag, mark, number);

  const info = document.createElement('div');
  info.className = 'story-info';
  const meta = document.createElement('div');
  meta.className = 'story-meta';
  const genre = document.createElement('span');
  genre.textContent = story.genre;
  const episodeCount = document.createElement('span');
  episodeCount.textContent = `${story.episodes} tập`;
  meta.append(genre, episodeCount);

  const title = document.createElement('h3');
  title.textContent = story.title;
  const description = document.createElement('p');
  description.textContent = story.description;
  const footer = document.createElement('div');
  footer.className = 'story-card-footer';
  const author = document.createElement('span');
  author.textContent = `Tác giả · ${story.author}`;
  const read = document.createElement('span');
  read.textContent = 'Đọc thử ↗';
  footer.append(author, read);
  info.append(meta, title, description, footer);
  article.append(cover, info);

  const open = () => openStory(story.id, story.progress?.episodeNumber || 1);
  article.addEventListener('click', open);
  article.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  return article;
}

function renderStories() {
  if (!user) return;
  const query = $('searchInput').value.trim().toLocaleLowerCase('vi');
  const matches = stories.filter((story) => {
    const categoryMatches = activeCategory === 'Tất cả' || story.genre === activeCategory;
    const queryMatches = `${story.title} ${story.author} ${story.genre}`.toLocaleLowerCase('vi').includes(query);
    return categoryMatches && queryMatches;
  });
  const grid = $('storyGrid');
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Chưa tìm thấy câu chuyện phù hợp. Thử một từ khóa khác nhé.';
    grid.replaceChildren(empty);
    return;
  }
  grid.replaceChildren(...matches.map((story, index) => createStoryCard(story, index, matches.length)));
}

function countWords(text) {
  const content = text.trim();
  return content ? content.split(/\s+/u).length : 0;
}

function updateWordCounters() {
  document.querySelectorAll('[data-word-counter]').forEach((counter) => {
    const form = $(counter.dataset.wordCounter);
    const count = countWords(form.elements.content.value);
    counter.textContent = `${count.toLocaleString('vi-VN')} / 2.000–5.000 từ`;
    counter.classList.toggle('within-limit', count >= 2000 && count <= 5000);
    counter.classList.toggle('over-limit', count > 5000);
  });
}

async function loadStories() {
  const result = await api('/api/stories');
  stories = result.stories;
  renderStories();
}

function renderGame() {
  if (!gameProgress) return;
  const progressPercent = Math.min(100, gameProgress.xp / gameProgress.nextLevelXp * 100);
  const autoAttackRemaining = Math.max(0, gameProgress.autoAttackExpiresAt - Date.now());
  $('gameLevel').textContent = String(gameProgress.level);
  $('gameXp').textContent = `${gameProgress.xp} / ${gameProgress.nextLevelXp} XP`;
  $('gameProgress').setAttribute('aria-valuemax', String(gameProgress.nextLevelXp));
  $('gameProgress').setAttribute('aria-valuenow', String(gameProgress.xp));
  $('gameProgressFill').style.width = `${progressPercent}%`;
  $('gameRewardHint').textContent =
    `Mỗi đòn đánh nhận ${gameProgress.xpPerAction} XP · Lên cấp nhận 1 xu · Tự động 5 phút: ${gameProgress.autoAttackPrice} xu`;
  $('gameAutoAttack').disabled = autoAttackRemaining > 0;
  $('gameAutoAttack').textContent = autoAttackRemaining > 0
    ? `Đang tự động · ${Math.ceil(autoAttackRemaining / 1000)} giây`
    : `Tự động · ${gameProgress.autoAttackPrice} xu`;
}

async function loadGame() {
  try {
    const result = await api('/api/game');
    gameProgress = result.game;
    renderGame();
    scheduleAutoAttack();
  } catch (error) {
    showToast(error.message);
    console.error('Không thể tải tiến trình trò chơi:', error);
  }
}

function scheduleAutoAttack(delay = 0) {
  window.clearTimeout(gameAutoAttackTimeout);
  if (!gameProgress || gameProgress.autoAttackExpiresAt <= Date.now()) {
    renderGame();
    return;
  }
  gameAutoAttackTimeout = window.setTimeout(runAutoAttack, Math.min(
    delay || 100,
    gameProgress.autoAttackExpiresAt - Date.now()
  ));
}

async function performGameAttack(automatic = false) {
  const button = $('gameAction');
  if (!automatic) {
    button.disabled = true;
    $('gameStatus').textContent = 'Đang chiến đấu…';
  }
  try {
    const result = await api('/api/game/action', { method: 'POST', body: { automatic } });
    gameProgress = result.game;
    user = result.user;
    renderGame();
    renderBalance();
    if (!automatic || result.levelsGained) $('gameStatus').textContent = result.levelsGained
      ? `Lên cấp ${gameProgress.level}! Bạn nhận 1 xu ✦`
      : 'Đòn đánh thành công! +25 XP';
    if (result.levelsGained) renderAccount();
    return true;
  } catch (error) {
    if (!automatic || error.status !== 429) $('gameStatus').textContent = error.message;
    if (!automatic) showToast(error.message);
    if (automatic && error.status !== 429) {
      gameProgress.autoAttackExpiresAt = 0;
      renderGame();
      showToast(error.message);
    }
    return error.status === 429;
  } finally {
    if (!automatic) button.disabled = false;
  }
}

async function runAutoAttack() {
  if (gameAutoAttackInFlight || !gameProgress || gameProgress.autoAttackExpiresAt <= Date.now()) {
    renderGame();
    return;
  }
  gameAutoAttackInFlight = true;
  try {
    const retry = await performGameAttack(true);
    if (gameProgress.autoAttackExpiresAt > Date.now()) {
      scheduleAutoAttack(retry ? 1100 : 1100);
    }
  } finally {
    gameAutoAttackInFlight = false;
  }
}

async function buyAutoAttack() {
  const button = $('gameAutoAttack');
  button.disabled = true;
  try {
    const result = await api('/api/game/auto-attack', { method: 'POST', body: {} });
    gameProgress = result.game;
    user = result.user;
    renderGame();
    renderBalance();
    $('gameStatus').textContent = 'Đã kích hoạt tấn công tự động trong 5 phút.';
    showToast('Đã dùng 50 xu để bật tự động chiến đấu trong 5 phút.');
    renderAccount();
    scheduleAutoAttack();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

function playGame() {
  performGameAttack();
}

function renderReadingHistory() {
  const container = $('readingHistory');
  container.replaceChildren();
  if (!user.progress.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Bạn chưa mở truyện nào. Khi đọc, chúng sẽ hiện ở đây.';
    container.append(empty);
    return;
  }
  for (const progress of user.progress) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    const title = document.createElement('strong');
    title.textContent = progress.storyTitle;
    const episode = document.createElement('span');
    episode.textContent = `Tập ${progress.episodeNumber} · Đọc tiếp →`;
    button.append(title, episode);
    button.addEventListener('click', () => {
      $('accountDialog').close();
      openStory(progress.storyId, progress.episodeNumber);
    });
    container.append(button);
  }
}

function renderAccount() {
  if (!user) return;
  $('accountAvatar').textContent = user.name.slice(0, 1).toLocaleUpperCase('vi');
  $('accountName').textContent = `${user.name}${user.role === 'admin' ? ' · Admin' : ''}`;
  $('accountEmail').textContent = user.email;
  $('adminSetupForm').hidden = !user.canBootstrapAdmin;
  renderReadingHistory();
}

async function refreshUser() {
  const result = await api('/api/me');
  user = result.user;
  renderBalance();
  renderStories();
  return user;
}

async function initializeSignedIn() {
  renderBalance();
  renderStories();
  await Promise.all([loadStories(), loadAudioStatus(), loadGame()]);
  renderAccount();
}

async function loadAudioStatus() {
  try {
    const result = await api('/api/audio/status');
    audioConfigured = result.available;
    $('audioStatus').textContent = audioConfigured
      ? 'Giọng AI tiếng Việt · ElevenLabs'
      : 'Admin cần cấu hình API key và voice ID Adam/Eva';
    $('audioVoice').disabled = !audioConfigured;
  } catch (error) {
    audioConfigured = false;
    $('audioStatus').textContent = 'Không kiểm tra được dịch vụ âm thanh';
    $('audioVoice').disabled = true;
    console.error('Không thể kiểm tra cấu hình audio:', error);
  }
}

function setAuthMode(mode) {
  const register = mode === 'register';
  $('nameField').hidden = !register;
  $('nameField').querySelector('input').required = register;
  $('authTitle').textContent = register ? 'Tạo tài khoản đọc truyện' : 'Những câu chuyện đang chờ bạn.';
  $('authDescription').textContent = register
    ? 'Tạo tài khoản để lưu truyện đã đọc và đồng bộ trên website.'
    : 'Đăng nhập để lưu truyện đã đọc và đồng bộ tài khoản trên website.';
  $('authSubmit').innerHTML = register ? 'Tạo tài khoản <span>→</span>' : 'Đăng nhập <span>→</span>';
  $('loginTab').classList.toggle('active', !register);
  $('registerTab').classList.toggle('active', register);
  $('authForm').dataset.mode = mode;
  $('authForm').elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('authMessage').textContent = '';
}

async function openStory(storyId, episodeNumber = 1) {
  const story = stories.find((item) => item.id === storyId);
  if (!story) {
    showToast('Không tìm thấy câu chuyện này.');
    return;
  }
  if (story.genre === '18+' && !user.ageConfirmed) {
    pendingMatureStory = { storyId, episodeNumber };
    $('ageDialog').showModal();
    return;
  }
  stopAudio();
  activeStory = story;
  activeEpisode = Math.max(1, Number(episodeNumber) || 1);
  $('readerDialog').showModal();
  await renderReader();
}

async function renderReader() {
  if (!activeStory) return;
  currentAudioAllowed = false;
  stopAudio();
  $('readerGenre').textContent = `${activeStory.genre} · ${activeStory.episodes} tập`;
  $('readerTitle').textContent = activeStory.title;
  $('readerByline').textContent = `Một câu chuyện của ${activeStory.author} · Truyện chữ`;
  $('episodePrice').textContent = 'Đang tải tập truyện...';
  $('unlockEpisode').disabled = true;
  $('chapterContent').textContent = 'Đang tải nội dung…';

  const episodeList = $('episodeList');
  episodeList.replaceChildren(...Array.from({ length: activeStory.episodes }, (_, index) => {
    const episode = index + 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `episode-button${episode === activeEpisode ? ' active' : ''}${
      user.unlockedEpisodeIds.includes(`${activeStory.id}-episode-${episode}`) ? ' unlocked' : ''
    }`;
    button.textContent = `Tập ${episode}`;
    button.addEventListener('click', () => {
      activeEpisode = episode;
      renderReader();
    });
    return button;
  }));

  try {
    const result = await api(`/api/stories/${encodeURIComponent(activeStory.id)}/episodes/${activeEpisode}`);
    const { episode } = result;
    const article = document.createElement('article');
    article.className = 'chapter-content';
    const heading = document.createElement('p');
    heading.className = 'chapter-heading';
    heading.textContent = `Tập ${episode.number}: ${episode.title}`;
    const preview = document.createElement('p');
    preview.textContent = episode.preview;
    article.append(heading, preview);
    if (episode.unlocked) {
      const content = document.createElement('p');
      content.textContent = episode.content;
      article.append(content);
    } else {
      const teaser = document.createElement('p');
      teaser.textContent = 'Mở khóa tập này để tiếp tục đọc.';
      teaser.className = 'locked-note';
      article.append(teaser);
    }
    $('chapterContent').replaceWith(article);
    article.id = 'chapterContent';
    const validLength = episode.meetsLengthRequirement;
    $('episodePrice').textContent = !validLength
      ? `Đoạn trích mẫu · ${episode.wordCount.toLocaleString('vi-VN')} từ · cần đủ 2.000–5.000 từ`
      : episode.unlocked ? `Bạn đã mở khóa · ${episode.wordCount.toLocaleString('vi-VN')} từ` : `Mở khóa tập này với ${EPISODE_PRICE} coin · ${episode.wordCount.toLocaleString('vi-VN')} từ`;
    $('unlockEpisode').disabled = episode.unlocked || !validLength;
    $('unlockEpisode').innerHTML = !validLength
      ? 'Đoạn trích mẫu'
      : episode.unlocked
      ? 'Đã mở khóa <span>✓</span>'
      : `Mở khóa tập <span>✦ ${EPISODE_PRICE}</span>`;
    currentAudioAllowed = Boolean(validLength && episode.unlocked && audioConfigured);
    $('audioToggle').disabled = !currentAudioAllowed;
    $('audioStatus').textContent = !validLength
      ? 'Tập chưa đủ 2.000 từ để mua hoặc tạo audio'
      : audioConfigured ? 'Giọng AI tiếng Việt · ElevenLabs' : 'Admin cần cấu hình API key và voice ID Adam/Eva';
    $('audioPlayer').hidden = true;
    await api('/api/progress', { method: 'POST', body: { storyId: activeStory.id, episodeNumber: activeEpisode } });
    await refreshUser();
  } catch (error) {
    $('chapterContent').textContent = error.message;
    $('episodePrice').textContent = 'Không thể tải tập truyện';
    $('unlockEpisode').disabled = true;
    if (error.status === 401) showAuthDialog('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
}

function showAuthDialog(message = '') {
  setAuthMode('login');
  $('authMessage').textContent = message;
  if (!$('authDialog').open) $('authDialog').showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const mode = form.dataset.mode;
  $('authSubmit').disabled = true;
  $('authMessage').textContent = 'Đang xử lý…';
  try {
    const result = await api(mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: Object.fromEntries(formData)
    });
    user = result.user;
    $('authDialog').close();
    await initializeSignedIn();
    if (user.canBootstrapAdmin) {
      showToast('Để kích hoạt Admin, mở tài khoản và nhập mã thiết lập trên máy chủ.');
    } else {
      showToast(mode === 'register' ? 'Tạo tài khoản thành công. Chào mừng bạn!' : `Chào mừng trở lại, ${user.name}!`);
    }
  } catch (error) {
    $('authMessage').textContent = error.message;
  } finally {
    $('authSubmit').disabled = false;
  }
}

async function checkIn() {
  $('checkinButton').disabled = true;
  try {
    const result = await api('/api/checkin', { method: 'POST', body: {} });
    user = result.user;
    renderBalance();
    renderAccount();
    showToast('Điểm danh thành công! Bạn nhận được 10 coin ✦');
  } catch (error) {
    if (error.status === 409) {
      await refreshUser();
      showToast('Bạn đã điểm danh hôm nay rồi!');
    } else {
      showToast(error.message);
    }
    $('checkinButton').disabled = false;
  }
}

async function unlockEpisode() {
  if (!activeStory) return;
  $('unlockEpisode').disabled = true;
  try {
    const result = await api(`/api/stories/${encodeURIComponent(activeStory.id)}/episodes/${activeEpisode}/unlock`, {
      method: 'POST',
      body: {}
    });
    user = result.user;
    await renderReader();
    showToast(`Đã mở khóa tập ${activeEpisode} của “${activeStory.title}”`);
  } catch (error) {
    showToast(error.message);
    $('unlockEpisode').disabled = false;
  }
}

function renderPackages() {
  const packages = [
    { coins: 20, label: 'Gói khởi đầu' },
    { coins: 65, label: '60 coin + 5 tặng', tag: 'BONUS' },
    { coins: 135, label: '120 coin + 15 tặng', tag: 'BONUS' }
  ];
  const container = $('coinPackages');
  container.replaceChildren(...packages.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'coin-package';
    const coins = document.createElement('span');
    coins.className = 'package-coins';
    coins.textContent = `${item.coins} coin`;
    const label = document.createElement('span');
    label.className = 'package-price';
    label.textContent = item.label;
    button.append(coins, label);
    if (item.tag) {
      const tag = document.createElement('span');
      tag.className = 'package-tag';
      tag.textContent = item.tag;
      button.append(tag);
    }
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api('/api/coins/demo-topup', { method: 'POST', body: { amount: item.coins } });
        user = result.user;
        renderBalance();
        $('topupDialog').close();
        showToast(`Đã nạp thử ${item.coins} coin vào ví!`);
      } catch (error) {
        showToast(error.message);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }));
}

async function speakChapter() {
  const player = $('audioPlayer');
  if (!audioConfigured || !activeStory) {
    showToast('Giọng Adam/Eva chưa được cấu hình trên máy chủ.');
    return;
  }
  if (player.src) {
    if (player.paused) {
      try {
        await player.play();
        $('audioToggle').innerHTML = '<span>Ⅱ</span> Tạm dừng';
      } catch {
        showToast('Không thể phát audio trên thiết bị này.');
      }
    } else {
      player.pause();
      $('audioToggle').innerHTML = '<span>▶</span> Tiếp tục nghe';
    }
    return;
  }
  $('audioToggle').disabled = true;
  $('audioToggle').innerHTML = '<span>…</span> Đang tạo giọng đọc';
  $('audioStatus').textContent = `Đang tạo audio bằng giọng ${$('audioVoice').value === 'adam' ? 'Adam' : 'Eva'}…`;
  const controller = new AbortController();
  audioRequestController = controller;
  try {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(activeStory.id)}/episodes/${activeEpisode}/audio?voice=${encodeURIComponent($('audioVoice').value)}`,
      {
        credentials: 'same-origin',
        headers: { Accept: 'audio/mpeg, application/json' },
        signal: controller.signal
      }
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Không thể tạo audio.');
    }
    const audio = await response.blob();
    audioObjectUrl = URL.createObjectURL(audio);
    player.src = audioObjectUrl;
    player.playbackRate = Number($('audioRate').value);
    player.hidden = false;
    await player.play();
    $('audioToggle').innerHTML = '<span>Ⅱ</span> Tạm dừng';
    $('audioStatus').textContent = `Đang phát bằng giọng ${$('audioVoice').value === 'adam' ? 'Adam' : 'Eva'}`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('audioStatus').textContent = audioConfigured
      ? 'Không thể phát audio · hãy thử lại'
      : 'Admin cần cấu hình API key và voice ID Adam/Eva';
    showToast(error.message);
  } finally {
    if (audioRequestController === controller) audioRequestController = null;
    $('audioToggle').disabled = !currentAudioAllowed;
  }
}

function stopAudio() {
  if (audioRequestController) audioRequestController.abort();
  audioRequestController = null;
  const player = $('audioPlayer');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.hidden = true;
  }
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  audioObjectUrl = null;
  if ($('audioToggle')) {
    $('audioToggle').innerHTML = '<span>▶</span> Nghe truyện';
    $('audioToggle').disabled = !currentAudioAllowed;
  }
}

function createAdminRow(primary, secondary, statusText, actions = []) {
  const row = document.createElement('div');
  row.className = 'admin-row';
  const info = document.createElement('div');
  info.className = 'admin-row-info';
  const title = document.createElement('strong');
  title.textContent = primary;
  const subtitle = document.createElement('span');
  subtitle.textContent = secondary;
  info.append(title, subtitle);
  const status = document.createElement('span');
  status.className = 'admin-row-status';
  status.textContent = statusText;
  row.append(info, status, ...actions);
  return row;
}

async function loadAdminUsers() {
  const container = $('adminUserList');
  container.textContent = 'Đang tải danh sách tài khoản...';
  try {
    const result = await api('/api/admin/users');
    if (!result.users.length) {
      container.textContent = 'Chưa có tài khoản.';
      return;
    }
    container.replaceChildren(...result.users.map((account) => {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = `quiet-button account-status-button${account.active ? ' danger' : ''}`;
      action.textContent = account.role === 'admin' ? 'Admin' : account.active ? 'Khóa' : 'Mở khóa';
      action.disabled = account.role === 'admin';
      action.addEventListener('click', async () => {
        try {
          await api(`/api/admin/users/${encodeURIComponent(account.id)}/status`, {
            method: 'PATCH', body: { active: !account.active }
          });
          await loadAdminUsers();
          showToast(account.active ? 'Đã khóa tài khoản.' : 'Đã mở khóa tài khoản.');
        } catch (error) {
          showToast(error.message);
        }
      });
      return createAdminRow(account.name, account.email, `${account.coins} coin`, [action]);
    }));
  } catch (error) {
    container.textContent = error.message;
  }
}

async function loadAdminStories() {
  const container = $('adminStoryList');
  container.textContent = 'Đang tải kho truyện...';
  try {
    const result = await api('/api/admin/stories');
    if (!result.stories.length) {
      container.textContent = 'Chưa có truyện.';
      return;
    }
    container.replaceChildren(...result.stories.map((story) => {
      const editEpisode = document.createElement('button');
      editEpisode.type = 'button';
      editEpisode.className = 'quiet-button';
      editEpisode.textContent = 'Sửa tập';
      editEpisode.addEventListener('click', async () => {
        try {
          const result = await api(`/api/admin/stories/${encodeURIComponent(story.id)}/episodes`);
          const form = $('episodeUploadForm');
          const select = form.elements.episodeNumber;
          select.replaceChildren(...result.episodes.map((episode) => {
            const option = document.createElement('option');
            option.value = String(episode.number);
            option.textContent = `Tập ${episode.number} · ${episode.wordCount.toLocaleString('vi-VN')} từ${episode.wordCount < 2000 || episode.wordCount > 5000 ? ' · đoạn trích' : ''}`;
            return option;
          }));
          form.hidden = false;
          form.dataset.mode = 'edit';
          form.elements.storyId.value = story.id;
          $('episodeSelectField').hidden = false;
          $('episodeUploadTitle').textContent = `Sửa tập của “${story.title}”`;
          form.querySelector('button[type="submit"]').innerHTML = 'Lưu tập <span>✓</span>';
          const loadSelectedEpisode = () => {
            const episode = result.episodes.find((item) => item.number === Number(select.value));
            if (!episode) return;
            form.elements.title.value = episode.title;
            form.elements.preview.value = episode.preview;
            form.elements.content.value = episode.content;
            updateWordCounters();
          };
          select.onchange = loadSelectedEpisode;
          loadSelectedEpisode();
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (error) {
          showToast(error.message);
        }
      });
      const addEpisode = document.createElement('button');
      addEpisode.type = 'button';
      addEpisode.className = 'quiet-button';
      addEpisode.textContent = 'Thêm tập';
      addEpisode.addEventListener('click', () => {
        const form = $('episodeUploadForm');
        form.hidden = false;
        form.dataset.mode = 'add';
        $('episodeSelectField').hidden = true;
        form.elements.episodeNumber.replaceChildren();
        form.querySelector('button[type="submit"]').innerHTML = 'Thêm tập <span>↑</span>';
        form.elements.storyId.value = story.id;
        $('episodeUploadTitle').textContent = `Thêm tập cho “${story.title}”`;
        form.reset();
        form.elements.storyId.value = story.id;
        updateWordCounters();
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        form.elements.title.focus();
      });
      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = 'quiet-button';
      visibility.textContent = story.published ? 'Ẩn' : 'Đăng lại';
      visibility.addEventListener('click', async () => {
        try {
          await api(`/api/admin/stories/${encodeURIComponent(story.id)}/status`, {
            method: 'PATCH', body: { published: !story.published }
          });
          await Promise.all([loadAdminStories(), loadStories()]);
          showToast(story.published ? 'Đã ẩn truyện khỏi thư viện.' : 'Đã đăng lại truyện.');
        } catch (error) {
          showToast(error.message);
        }
      });
      return createAdminRow(
        story.title,
        `${story.author} · ${story.genre} · ${story.episodeCount} tập${story.sampleOnly ? ' · cần cập nhật đoạn trích' : ''}`,
        story.published ? 'Đang đăng' : 'Đã ẩn',
        [editEpisode, addEpisode, visibility]
      );
    }));
  } catch (error) {
    container.textContent = error.message;
  }
}

async function loadAdminSettings() {
  try {
    const result = await api('/api/admin/settings');
    $('settingsForm').elements.siteName.value = result.siteName;
    $('settingsForm').elements.siteTagline.value = result.siteTagline;
  } catch (error) {
    showToast(error.message);
  }
}

async function openAdmin() {
  if (user?.role !== 'admin') return;
  $('adminDialog').showModal();
  await Promise.all([loadAdminUsers(), loadAdminStories(), loadAdminSettings()]);
}

function switchAdminPanel(name) {
  document.querySelectorAll('.admin-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.adminPanel === name));
  document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `admin${name[0].toUpperCase()}${name.slice(1)}Panel`));
}

async function submitStoryUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/admin/stories', {
      method: 'POST', body: Object.fromEntries(new FormData(form))
    });
    form.reset();
    await Promise.all([loadAdminStories(), loadStories()]);
    showToast('Đã đăng truyện mới lên TruyenTruyenTV.');
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function submitEpisodeUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  const storyId = body.storyId;
  const episodeNumber = body.episodeNumber;
  const editing = form.dataset.mode === 'edit';
  delete body.storyId;
  delete body.episodeNumber;
  try {
    const result = await api(
      `/api/admin/stories/${encodeURIComponent(storyId)}/episodes${editing ? `/${encodeURIComponent(episodeNumber)}` : ''}`,
      { method: editing ? 'PUT' : 'POST', body }
    );
    form.reset();
    form.hidden = true;
    form.dataset.mode = 'add';
    $('episodeSelectField').hidden = true;
    form.querySelector('button[type="submit"]').innerHTML = 'Thêm tập <span>↑</span>';
    await Promise.all([loadAdminStories(), loadStories()]);
    showToast(editing ? `Đã cập nhật tập ${result.episodeNumber}.` : `Đã đăng tập ${result.episodeNumber}.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function submitSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const result = Object.fromEntries(new FormData(form));
  try {
    const saved = await api('/api/admin/settings', { method: 'PATCH', body: result });
    siteConfig = saved;
    updateSiteBranding();
    showToast('Đã lưu cài đặt website.');
  } catch (error) {
    showToast(error.message);
  }
}

async function submitAdminSetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/admin/bootstrap', {
      method: 'POST',
      body: { setupKey: form.elements.setupKey.value }
    });
    user = result.user;
    renderBalance();
    renderAccount();
    form.reset();
    showToast('Đã kích hoạt quyền Admin cho tài khoản.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  stopAudio();
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch (error) {
    showToast(error.message);
    return;
  }
  user = null;
  $('accountDialog').close();
  showAuthDialog('Bạn đã đăng xuất.');
}

async function confirmAdultAge() {
  try {
    await api('/api/age/confirm', { method: 'POST', body: {} });
    user.ageConfirmed = true;
    $('ageDialog').close();
    const pending = pendingMatureStory;
    pendingMatureStory = null;
    if (pending) await openStory(pending.storyId, pending.episodeNumber);
  } catch (error) {
    showToast(error.message);
  }
}

$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('registerTab').addEventListener('click', () => setAuthMode('register'));
$('authForm').addEventListener('submit', submitAuth);
$('searchInput').addEventListener('input', renderStories);
$('checkinButton').addEventListener('click', checkIn);
$('gameAction').addEventListener('click', playGame);
$('gameAutoAttack').addEventListener('click', buyAutoAttack);
$('unlockEpisode').addEventListener('click', unlockEpisode);
$('audioToggle').addEventListener('click', speakChapter);
$('audioStop').addEventListener('click', stopAudio);
$('audioRate').addEventListener('change', () => {
  $('audioPlayer').playbackRate = Number($('audioRate').value);
});
$('audioVoice').addEventListener('change', stopAudio);
$('audioPlayer').addEventListener('ended', () => {
  $('audioToggle').innerHTML = '<span>▶</span> Nghe truyện';
  $('audioStatus').textContent = 'Đã nghe hết tập truyện';
});
$('audioPlayer').addEventListener('error', () => {
  $('audioToggle').innerHTML = '<span>▶</span> Nghe truyện';
});
$('openTopup').addEventListener('click', () => $('topupDialog').showModal());
$('profileButton').addEventListener('click', () => {
  renderAccount();
  $('accountDialog').showModal();
});
$('logoutButton').addEventListener('click', logout);
$('openAdmin').addEventListener('click', openAdmin);
$('ageNo').addEventListener('click', () => $('ageDialog').close());
$('ageYes').addEventListener('click', confirmAdultAge);
$('authDialog').addEventListener('cancel', (event) => event.preventDefault());
$('adminSetupForm').addEventListener('submit', submitAdminSetup);
$('storyUploadForm').addEventListener('submit', submitStoryUpload);
$('episodeUploadForm').addEventListener('submit', submitEpisodeUpload);
$('settingsForm').addEventListener('submit', submitSettings);
$('refreshUsersButton').addEventListener('click', loadAdminUsers);
$('refreshStoriesButton').addEventListener('click', loadAdminStories);
$('cancelEpisodeButton').addEventListener('click', () => {
  const form = $('episodeUploadForm');
  form.hidden = true;
  form.reset();
  form.dataset.mode = 'add';
  $('episodeSelectField').hidden = true;
  form.querySelector('button[type="submit"]').innerHTML = 'Thêm tập <span>↑</span>';
  updateWordCounters();
});
document.querySelectorAll('[data-word-counter]').forEach((counter) => {
  $(counter.dataset.wordCounter).elements.content.addEventListener('input', updateWordCounters);
});
document.querySelectorAll('.admin-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchAdminPanel(tab.dataset.adminPanel));
});
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => {
    $(button.dataset.close).close();
    if (button.dataset.close === 'readerDialog') stopAudio();
  });
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
      if (dialog.id === 'readerDialog') stopAudio();
    }
  });
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('searchInput').focus();
  }
});
$('readerDialog').addEventListener('close', stopAudio);

async function start() {
  renderPackages();
  updateClock();
  window.setInterval(updateClock, 1000);
  try {
    siteConfig = await api('/api/config');
    updateSiteBranding();
  } catch (error) {
    showToast(error.message);
  }
  try {
    const result = await api('/api/session');
    user = result.user;
    if (!user) {
      setAuthMode('login');
      $('authDialog').showModal();
      return;
    }
    await initializeSignedIn();
  } catch (error) {
    if (error.status === 401) {
      setAuthMode('login');
      $('authDialog').showModal();
      return;
    }
    showToast(error.message);
    setAuthMode('login');
    $('authDialog').showModal();
  }
}

start();
