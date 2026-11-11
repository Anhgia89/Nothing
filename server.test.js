'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'truyentruyentv-test-'));
process.env.DATA_DIR = temporaryDirectory;
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_SETUP_KEY = 'test-only-admin-bootstrap-key';
process.env.NODE_ENV = 'test';

const { startServer, closeDatabase } = require('./server');

test('accounts, reading, coins and admin operations are persisted and protected', { timeout: 30000 }, async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let memberCookie = '';
  let adminCookie = '';
  const contentWithWords = (count) => Array.from({ length: count }, (_, index) => `từ${index}`).join(' ');
  const validEpisodeContent = contentWithWords(2000);

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
    return { response, data };
  }

  const home = await request('/');
  assert.equal(home.response.status, 200);
  assert.match(home.data, /TruyenTruyenTV/);
  assert.equal((await request('/server.js')).response.status, 404);
  const config = await request('/api/config');
  assert.equal(config.data.siteName, 'TruyenTruyenTV');
  assert.equal((await request('/api/session')).data.user, null);
  assert.equal((await request('/api/me')).response.status, 401);

  const registration = await request('/api/register', {
    method: 'POST',
    body: { name: 'Độc giả', email: 'reader@example.test', password: 'a-strong-password' }
  });
  assert.equal(registration.response.status, 201);
  memberCookie = registration.response.headers.get('set-cookie').split(';')[0];
  assert.equal(registration.data.user.role, 'member');
  assert.equal(registration.data.user.coins, 0);
  const duplicate = await request('/api/register', {
    method: 'POST',
    body: { name: 'Trùng email', email: 'READER@example.test', password: 'a-strong-password' }
  });
  assert.equal(duplicate.response.status, 409);

  const protectedAdmin = await request('/api/admin/users', { cookie: memberCookie });
  assert.equal(protectedAdmin.response.status, 403);
  const invalidOrigin = await request('/api/checkin', {
    method: 'POST', body: {}, cookie: memberCookie, headers: { Origin: 'https://attacker.example' }
  });
  assert.equal(invalidOrigin.response.status, 403);

  const stories = await request('/api/stories', { cookie: memberCookie });
  assert.equal(stories.data.stories.length, 6);
  assert.equal(stories.data.stories[0].sampleOnly, true);
  const lockedEpisode = await request('/api/stories/cuoc-hop-bat-on/episodes/1', { cookie: memberCookie });
  assert.equal(lockedEpisode.data.episode.unlocked, false);
  assert.equal(lockedEpisode.data.episode.content, null);
  assert.equal(lockedEpisode.data.episode.meetsLengthRequirement, false);
  assert.equal(lockedEpisode.data.episode.wordCount < 2000, true);
  const tooPoor = await request('/api/stories/cuoc-hop-bat-on/episodes/1/unlock', {
    method: 'POST', body: {}, cookie: memberCookie
  });
  assert.equal(tooPoor.response.status, 422);
  assert.equal((await request('/api/audio/status', { cookie: memberCookie })).data.available, false);

  const checkin = await request('/api/checkin', { method: 'POST', body: {}, cookie: memberCookie });
  assert.equal(checkin.data.user.coins, 10);
  assert.equal(checkin.data.user.streak, 1);
  assert.equal((await request('/api/checkin', { method: 'POST', body: {}, cookie: memberCookie })).response.status, 409);
  const ageCheck = await request('/api/stories/dem-khong-ngu/episodes/1', { cookie: memberCookie });
  assert.equal(ageCheck.response.status, 403);
  await request('/api/age/confirm', { method: 'POST', body: {}, cookie: memberCookie });
  assert.equal((await request('/api/stories/dem-khong-ngu/episodes/1', { cookie: memberCookie })).response.status, 200);

  const logout = await request('/api/logout', { method: 'POST', body: {}, cookie: memberCookie });
  assert.equal(logout.response.status, 200);
  const login = await request('/api/login', {
    method: 'POST', body: { email: 'reader@example.test', password: 'a-strong-password' }
  });
  memberCookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal(login.data.user.progress.length, 0);
  assert.equal(login.data.user.unlockedEpisodeIds.length, 0);
  const badLogin = await request('/api/login', {
    method: 'POST', body: { email: 'reader@example.test', password: 'wrong-password' }
  });
  assert.equal(badLogin.response.status, 401);

  const adminSignup = await request('/api/register', {
    method: 'POST',
    body: { name: 'Website Admin', email: 'admin@example.test', password: 'another-strong-password' }
  });
  assert.equal(adminSignup.data.user.role, 'member');
  assert.equal(adminSignup.data.user.canBootstrapAdmin, true);
  adminCookie = adminSignup.response.headers.get('set-cookie').split(';')[0];
  const wrongKey = await request('/api/admin/bootstrap', {
    method: 'POST', body: { setupKey: 'wrong' }, cookie: adminCookie
  });
  assert.equal(wrongKey.response.status, 403);
  const promoted = await request('/api/admin/bootstrap', {
    method: 'POST', body: { setupKey: 'test-only-admin-bootstrap-key' }, cookie: adminCookie
  });
  assert.equal(promoted.data.user.role, 'admin');
  const adminUserList = await request('/api/admin/users', { cookie: adminCookie });
  assert.equal(adminUserList.response.status, 200);
  assert.equal(adminUserList.data.users.length, 2);
  const adminStoryList = await request('/api/admin/stories', { cookie: adminCookie });
  assert.equal(adminStoryList.response.status, 200);
  assert.equal(adminStoryList.data.stories.length, 6);
  const sampleUpdated = await request('/api/admin/stories/cuoc-hop-bat-on/episodes/1', {
    method: 'PUT', cookie: adminCookie,
    body: { title: 'Tập một bản đầy đủ', preview: 'Bản cập nhật', content: validEpisodeContent }
  });
  assert.equal(sampleUpdated.response.status, 200);
  assert.equal(sampleUpdated.data.wordCount, 2000);

  const storyUpload = await request('/api/admin/stories', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      title: 'Truyện do Admin đăng',
      author: 'Tác giả',
      genre: 'Drama',
      description: 'Mô tả truyện.',
      episodeTitle: 'Tập đầu',
      preview: 'Đoạn xem thử.',
      content: validEpisodeContent
    }
  });
  assert.equal(storyUpload.response.status, 201);
  const unlocked = await request(`/api/stories/${storyUpload.data.storyId}/episodes/1/unlock`, {
    method: 'POST', body: {}, cookie: memberCookie
  });
  assert.equal(unlocked.data.user.coins, 8);
  const fullEpisode = await request(`/api/stories/${storyUpload.data.storyId}/episodes/1`, { cookie: memberCookie });
  assert.equal(fullEpisode.data.episode.unlocked, true);
  assert.equal(fullEpisode.data.episode.wordCount, 2000);
  assert.equal(fullEpisode.data.episode.meetsLengthRequirement, true);
  assert.equal((await request(`/api/stories/${storyUpload.data.storyId}/episodes/1/audio?voice=adam`, {
    cookie: memberCookie
  })).response.status, 503);
  const progress = await request('/api/progress', {
    method: 'POST', body: { storyId: storyUpload.data.storyId, episodeNumber: 1 }, cookie: memberCookie
  });
  assert.equal(progress.data.progress[0].storyTitle, 'Truyện do Admin đăng');
  await request('/api/logout', { method: 'POST', body: {}, cookie: memberCookie });
  const returningMember = await request('/api/login', {
    method: 'POST', body: { email: 'reader@example.test', password: 'a-strong-password' }
  });
  memberCookie = returningMember.response.headers.get('set-cookie').split(';')[0];
  assert.equal(returningMember.data.user.progress[0].storyId, storyUpload.data.storyId);
  assert.equal(returningMember.data.user.unlockedEpisodeIds.length, 1);
  const appended = await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Tập hai', preview: 'Thử', content: contentWithWords(5000) }
  });
  assert.equal(appended.data.episodeNumber, 2);
  const invalidShortEpisode = await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Quá ngắn', preview: 'Thử', content: contentWithWords(1999) }
  });
  assert.equal(invalidShortEpisode.response.status, 400);
  const invalidLongEpisode = await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Quá dài', preview: 'Thử', content: contentWithWords(5001) }
  });
  assert.equal(invalidLongEpisode.response.status, 400);
  const episodeList = await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes`, { cookie: adminCookie });
  assert.equal(episodeList.data.episodes[1].wordCount, 5000);
  const updatedEpisode = await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes/2`, {
    method: 'PUT', cookie: adminCookie, body: { title: 'Tập hai đã sửa', preview: 'Đã cập nhật', content: validEpisodeContent }
  });
  assert.equal(updatedEpisode.response.status, 200);
  assert.equal(updatedEpisode.data.wordCount, 2000);
  assert.equal((await request(`/api/admin/stories/${storyUpload.data.storyId}/episodes/2`, {
    method: 'PUT', cookie: adminCookie, body: { title: 'Tập lỗi', preview: 'Sai', content: contentWithWords(1999) }
  })).response.status, 400);
  const refreshedAdminStories = await request('/api/admin/stories', { cookie: adminCookie });
  assert.equal(refreshedAdminStories.data.stories.find((story) => story.id === storyUpload.data.storyId).episodeCount, 2);
  assert.equal(refreshedAdminStories.data.stories.find((story) => story.id === storyUpload.data.storyId).sampleOnly, false);

  const changedSettings = await request('/api/admin/settings', {
    method: 'PATCH', cookie: adminCookie, body: { siteName: 'TruyenTruyenTV Test', siteTagline: 'Chuyện để đọc' }
  });
  assert.equal(changedSettings.data.siteName, 'TruyenTruyenTV Test');
  const topup = await request('/api/coins/demo-topup', {
    method: 'POST', cookie: memberCookie, body: { amount: 20 }
  });
  assert.equal(topup.data.user.coins, 28);
  const initialGame = await request('/api/game', { cookie: memberCookie });
  assert.deepEqual(initialGame.data.game, {
    level: 1, xp: 0, nextLevelXp: 100, totalActions: 0, xpPerAction: 25
  });
  assert.equal((await request('/api/game')).response.status, 401);
  for (let action = 0; action < 4; action += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1010));
    const attack = await request('/api/game/action', {
      method: 'POST', body: {}, cookie: memberCookie
    });
    assert.equal(attack.response.status, 200);
    if (action < 3) assert.equal(attack.data.levelsGained, 0);
    else {
      assert.equal(attack.data.levelsGained, 1);
      assert.equal(attack.data.user.coins, 29);
      assert.equal(attack.data.game.level, 2);
      assert.equal(attack.data.game.xp, 0);
    }
  }
  const gameAfterRefresh = await request('/api/game', { cookie: memberCookie });
  assert.equal(gameAfterRefresh.data.game.level, 2);
  assert.equal(gameAfterRefresh.data.game.totalActions, 4);
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const productionTopup = await request('/api/coins/demo-topup', {
    method: 'POST', cookie: memberCookie, body: { amount: 20 }
  });
  process.env.NODE_ENV = previousEnvironment;
  assert.equal(productionTopup.response.status, 403);
  const disabledMember = await request(`/api/admin/users/${registration.data.user.id}/status`, {
    method: 'PATCH', cookie: adminCookie, body: { active: false }
  });
  assert.equal(disabledMember.response.status, 200);
  assert.equal((await request('/api/me', { cookie: memberCookie })).response.status, 401);
});
