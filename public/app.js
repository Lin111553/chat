const $ = id => document.getElementById(id);
const authScreen = $('authScreen');
const app = $('app');
const authForm = $('authForm');
let authMode = 'login';
let currentUser = null;
let activeContact = null;
let currentView = 'chats';
let socket = null;
let conversations = [];
let searchResults = [];
let shownMessageIds = new Set();
let searchTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后再试');
  return data;
}
function setAuthMode(mode) {
  authMode = mode;
  $('authSubmit').textContent = mode === 'login' ? '登录' : '注册并进入';
  $('toggleAuth').textContent = mode === 'login' ? '没有账号？立即注册' : '已有账号？返回登录';
  $('authDescription').textContent = mode === 'login' ? '登录后与好友开始聊天' : '注册一个昵称，开始使用小聚';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').textContent = '';
}
$('toggleAuth').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
authForm.addEventListener('submit', async event => {
  event.preventDefault();
  $('authError').textContent = '';
  $('authSubmit').disabled = true;
  try {
    const body = JSON.stringify({ username: $('username').value.trim(), password: $('password').value });
    const data = await api(`/api/auth/${authMode}`, { method: 'POST', body });
    $('password').value = '';
    await enterApp(data.user);
  } catch (error) { $('authError').textContent = error.message; }
  finally { $('authSubmit').disabled = false; }
});
async function enterApp(user) {
  currentUser = user;
  authScreen.classList.add('hidden');
  app.classList.remove('hidden');
  $('myAvatar').textContent = user.username.slice(0, 1);
  $('search').value = '';
  connectSocket();
  await loadConversations();
  if (conversations.length) await selectContact({ id: conversations[0].id, username: conversations[0].username });
  else renderMessages([]);
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on('connect_error', () => { $('statusText').textContent = '实时连接中断，请刷新页面重试'; });
  socket.on('connect', () => { $('statusText').textContent = '已连接 · 消息实时传送'; });
  socket.on('message:new', message => {
    if (activeContact && (Number(message.senderId) === activeContact.id || Number(message.receiverId) === activeContact.id)) {
      appendMessage(message);
    }
    loadConversations();
  });
}
async function loadConversations() {
  if (!currentUser) return;
  try {
    conversations = (await api('/api/conversations')).conversations;
    if (currentView === 'chats') renderList();
  } catch (error) { $('statusText').textContent = error.message; }
}
function setView(view) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('search').placeholder = view === 'news' ? '新闻服务尚未接入' : '搜索好友昵称';
  $('search').disabled = view === 'news';
  $('newChat').classList.toggle('hidden', view === 'news');
  $('messageForm').classList.toggle('hidden', view === 'news');
  $('messageList').classList.toggle('hidden', view === 'news');
  if (view === 'news') {
    $('chatTitle').textContent = '发现';
    $('chatSubtitle').textContent = '新闻';
    $('messageList').classList.remove('hidden');
    renderMessages([], '新闻聚合尚未接入。这里不会展示虚构新闻；接入新华社、AP、BBC 的实时内容需要获得可用的 RSS/API 或配置新闻后端。');
  } else {
    renderList();
    if (activeContact) showContactHeader();
  }
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
function renderList() {
  const list = $('list');
  list.replaceChildren();
  if (currentView === 'news') return;
  const query = $('search').value.trim().toLocaleLowerCase();
  const source = query ? searchResults : currentView === 'contacts' ? [] : conversations;
  const rows = source.filter(user => user.username.toLocaleLowerCase().includes(query));
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'list-empty';
    empty.textContent = query ? '没有找到匹配的用户' : currentView === 'contacts' ? '输入昵称搜索用户' : '还没有聊天，搜索昵称开始联系';
    list.append(empty); return;
  }
  rows.forEach(user => {
    const item = document.createElement('button'); item.className = `contact-row${activeContact?.id === user.id ? ' selected' : ''}`; item.type = 'button';
    const avatar = document.createElement('span'); avatar.className = 'contact-avatar'; avatar.textContent = user.username.slice(0, 1);
    const info = document.createElement('span'); info.className = 'contact-info';
    const name = document.createElement('span'); name.className = 'contact-name'; name.textContent = user.username;
    const preview = document.createElement('span'); preview.className = 'contact-preview'; preview.textContent = user.lastMessage || (query || currentView === 'contacts' ? '点击开始聊天' : '暂无消息');
    info.append(name, preview); item.append(avatar, info);
    item.addEventListener('click', () => selectContact({ id: user.id, username: user.username }));
    list.append(item);
  });
}
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = $('search').value.trim();
  if (!query) { searchResults = []; renderList(); return; }
  searchTimer = setTimeout(async () => {
    try { searchResults = (await api(`/api/users/search?q=${encodeURIComponent(query)}`)).users; renderList(); }
    catch (error) { $('statusText').textContent = error.message; }
  }, 220);
});
$('newChat').addEventListener('click', () => { $('search').focus(); $('search').placeholder = '输入好友昵称进行搜索'; });
async function selectContact(contact) {
  activeContact = contact;
  currentView = 'chats';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'chats'));
  $('search').disabled = false;
  $('messageForm').classList.remove('hidden');
  $('messageList').classList.remove('hidden');
  $('app').classList.add('chat-open');
  $('messageText').disabled = false;
  $('sendButton').disabled = false;
  showContactHeader(); renderList();
  try {
    const data = await api(`/api/messages/${contact.id}`);
    if (activeContact?.id === contact.id) renderMessages(data.messages);
  } catch (error) { renderMessages([], error.message); }
}
function showContactHeader() {
  $('chatTitle').textContent = activeContact ? activeContact.username : '选择一个联系人';
  $('chatSubtitle').textContent = activeContact ? '与好友的聊天' : '搜索昵称，找到后即可开始聊天';
}
function renderMessages(messages, emptyText = '还没有消息，发送一条消息开始聊天吧') {
  shownMessageIds = new Set();
  const container = $('messageList'); container.replaceChildren();
  if (!messages.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = emptyText; container.append(empty); return; }
  messages.forEach(appendMessage);
}
function appendMessage(message) {
  if (shownMessageIds.has(message.id)) return;
  shownMessageIds.add(message.id);
  const empty = $('messageList').querySelector('.empty-state'); if (empty) empty.remove();
  const mine = Number(message.senderId) === currentUser.id;
  const row = document.createElement('article'); row.className = `message${mine ? ' mine' : ''}`;
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = (mine ? currentUser.username : activeContact?.username || '友').slice(0, 1);
  const bubble = document.createElement('div'); bubble.className = 'message-bubble'; bubble.textContent = message.text;
  const time = document.createElement('time'); time.className = 'message-time'; time.dateTime = message.createdAt; time.textContent = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const content = document.createElement('div'); content.className = 'message-content'; content.append(bubble, time); row.append(avatar, content); $('messageList').append(row); $('messageList').scrollTop = $('messageList').scrollHeight;
}
$('messageForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('messageText').value.trim();
  if (!text || !activeContact) return;
  if (!socket?.connected) { $('statusText').textContent = '暂未连接服务器，请稍后重试'; return; }
  $('sendButton').disabled = true;
  socket.emit('message:send', { to: activeContact.id, text }, result => {
    $('sendButton').disabled = false;
    if (result?.error) { $('statusText').textContent = result.error; return; }
    $('messageText').value = '';
    $('statusText').textContent = '已发送';
  });
});
$('messageText').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('messageForm').requestSubmit(); }
});
async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  socket?.disconnect(); socket = null; currentUser = null; activeContact = null; conversations = [];
  app.classList.add('hidden'); app.classList.remove('chat-open'); authScreen.classList.remove('hidden'); setAuthMode('login');
}
$('logout').addEventListener('click', logout); $('logoutTop').addEventListener('click', logout);
$('back').addEventListener('click', () => app.classList.remove('chat-open'));
async function restoreSession() {
  try { const data = await api('/api/me'); await enterApp(data.user); }
  catch { authScreen.classList.remove('hidden'); app.classList.add('hidden'); }
}
restoreSession();
