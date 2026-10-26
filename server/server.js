'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'rp_admin_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const API_VERSION = '1.0.0';
const PERMISSIONS = ['dashboard', 'stock', 'movements', 'orders', 'budgets', 'vehicles', 'reports', 'exports'];
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(value)); };

function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hashPassword(password) { return crypto.scryptSync(password, crypto.randomBytes(16), 64).toString('hex'); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')); }
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false; const d = new Date(`${value}T12:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }

function createService({ dataFile = path.join(__dirname, 'data', 'admin.json'), adminEmail = process.env.ADMIN_EMAIL, adminPassword = process.env.ADMIN_PASSWORD, webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET, mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN, notificationUrl = process.env.PAYMENT_NOTIFICATION_URL, secureCookies = process.env.NODE_ENV === 'production', corsOrigins = process.env.API_CORS_ORIGINS || '', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (!validEmail(adminEmail) || typeof adminPassword !== 'string' || adminPassword.length < 12) throw new Error('Configure ADMIN_EMAIL e ADMIN_PASSWORD (mínimo de 12 caracteres).');
  const sessions = new Map(); const attempts = new Map(); const supportAttempts = new Map();
  const allowedOrigins = new Set(String(corsOrigins).split(',').map(origin => origin.trim()).filter(Boolean));
  let db;
  try { db = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; db = { clients: [], payments: [], billingNotifications: [], processedEvents: [], tickets: [] }; }
  db.clients ||= []; db.payments ||= []; db.billingNotifications ||= []; db.processedEvents ||= []; db.tickets ||= [];
  const persist = () => { fs.mkdirSync(path.dirname(dataFile), { recursive: true }); const temp = `${dataFile}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(temp, dataFile); };
  const cookie = (id, maxAge) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  function readBody(req, limit = 1024 * 1024) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > limit) { reject(Object.assign(new Error('Corpo muito grande.'), { status: 413 })); req.destroy(); } }); req.on('end', () => resolve(raw)); req.on('error', reject); }); }
  async function bodyJson(req) { const raw = await readBody(req); try { return { raw, value: JSON.parse(raw || '{}') }; } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); } }
  function sessionFor(req) { const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]; const id = bearer || (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1); const item = sessions.get(id); if (!item || item.expires < now()) { if (id) sessions.delete(id); return null; } item.expires = now() + SESSION_MS; return { id, item }; }
  function requireAdmin(req, res) { const session = sessionFor(req); if (!session) { json(res, 401, { error: 'Faça login para continuar.' }); return null; } return session; }
  function clientInput(value, existing = {}) {
    const email = String(value.email || '').trim().toLowerCase(); const business = String(value.business || '').trim();
    if (!business || !validEmail(email) || !validDate(value.dueDate)) throw Object.assign(new Error('Informe empresa, e-mail válido e vencimento.'), { status: 400 });
    if (db.clients.some(c => c.id !== existing.id && String(c.email).toLowerCase() === email)) throw Object.assign(new Error('Este e-mail já está cadastrado.'), { status: 409 });
    return { ...existing, id: existing.id || `CLI-${crypto.randomUUID()}`, business, owner: String(value.owner || '').trim(), email, phone: String(value.phone || '').trim(), plan: String(value.plan || 'Pro').trim(), price: Math.max(0, Number(value.price) || 0), cycle: value.cycle === 'Anual' ? 'Anual' : 'Mensal', dueDate: value.dueDate, startedAt: existing.startedAt || validDate(value.startedAt) && value.startedAt || new Date(now()).toISOString().slice(0, 10), subscriptionStatus: ['Ativa', 'Teste grátis', 'Cancelada'].includes(value.subscriptionStatus) ? value.subscriptionStatus : 'Ativa', permissions: Object.fromEntries(PERMISSIONS.map(k => [k, Boolean(value.permissions?.[k])])) };
  }
  function recordPayment(data) {
    const client = db.clients.find(c => c.id === data.clientId); const amount = Number(data.amount);
    if (!client || !Number.isFinite(amount) || amount <= 0 || !validDate(data.date)) throw Object.assign(new Error('Cliente, valor positivo e data válida são obrigatórios.'), { status: 400 });
    const payment = { id: String(data.providerPaymentId || `PAG-${crypto.randomUUID()}`), clientId: client.id, amount, date: data.date, method: String(data.method || 'Outro').slice(0, 40), reference: String(data.reference || '').slice(0, 160), status: 'Pago', source: data.source || 'manual' };
    if (db.payments.some(p => p.id === payment.id)) return { payment: db.payments.find(p => p.id === payment.id), duplicate: true };
    db.payments.unshift(payment); client.lastPayment = payment.date;
    if (client.subscriptionStatus !== 'Cancelada') { client.subscriptionStatus = 'Ativa'; const base = new Date(`${client.dueDate > payment.date ? client.dueDate : payment.date}T12:00:00Z`); if (client.cycle === 'Anual') base.setUTCFullYear(base.getUTCFullYear() + 1); else base.setUTCMonth(base.getUTCMonth() + 1); client.dueDate = base.toISOString().slice(0, 10); }
    persist(); return { payment, duplicate: false };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:");
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/v1/')) url.pathname = url.pathname.replace(/^\/api\/v1\//, '/api/');
      const origin = req.headers.origin;
      if (origin && allowedOrigins.has(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        res.setHeader('access-control-max-age', '600');
      }
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return res.writeHead(204).end();
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', apiVersion: API_VERSION });
      if (req.method === 'GET' && url.pathname === '/api/openapi.json') {
        const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
        return json(res, 200, spec, { 'cache-control': 'public, max-age=300' });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const ip = req.socket.remoteAddress || 'unknown'; const attempt = attempts.get(ip) || { count: 0, until: 0 }; if (attempt.until > now()) return json(res, 429, { error: 'Muitas tentativas. Tente novamente mais tarde.' });
        const { value } = await bodyJson(req); const ok = safeEqual(String(value.email || '').trim().toLowerCase(), adminEmail.toLowerCase()) && safeEqual(String(value.password || ''), adminPassword);
        if (!ok) { attempt.count++; if (attempt.count >= 8) { attempt.count = 0; attempt.until = now() + 15 * 60 * 1000; } attempts.set(ip, attempt); return json(res, 401, { error: 'E-mail ou senha incorretos.' }); }
        attempts.delete(ip); const accessToken = crypto.randomBytes(32).toString('base64url'); sessions.set(accessToken, { email: adminEmail, expires: now() + SESSION_MS }); return json(res, 200, { accessToken, tokenType: 'Bearer', expiresIn: SESSION_MS / 1000, user: { email: adminEmail, role: 'admin' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') { const s = requireAdmin(req, res); return s && json(res, 200, { email: s.item.email, role: 'admin' }); }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const s = sessionFor(req); if (s) sessions.delete(s.id); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/admin/me') { const s = requireAdmin(req, res); return s && json(res, 200, { email: s.item.email }); }
      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        const ip = req.socket.remoteAddress || 'unknown'; const attempt = attempts.get(ip) || { count: 0, until: 0 }; if (attempt.until > now()) return json(res, 429, { error: 'Muitas tentativas. Tente novamente mais tarde.' });
        const { value } = await bodyJson(req); const ok = safeEqual(String(value.email || '').trim().toLowerCase(), adminEmail.toLowerCase()) && safeEqual(String(value.password || ''), adminPassword);
        if (!ok) { attempt.count++; if (attempt.count >= 8) { attempt.count = 0; attempt.until = now() + 15 * 60 * 1000; } attempts.set(ip, attempt); return json(res, 401, { error: 'E-mail ou senha incorretos.' }); }
        attempts.delete(ip); const id = crypto.randomBytes(32).toString('base64url'); sessions.set(id, { email: adminEmail, expires: now() + SESSION_MS }); return json(res, 200, { email: adminEmail }, { 'set-cookie': cookie(id, SESSION_MS / 1000) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') { const s = sessionFor(req); if (s) sessions.delete(s.id); return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
      if (req.method === 'POST' && url.pathname === '/api/support/tickets') {
        const ip = req.socket.remoteAddress || 'unknown'; const rate = supportAttempts.get(ip) || { count: 0, until: 0 }; if (rate.until > now()) return json(res, 429, { error: 'Muitos chamados enviados. Tente novamente mais tarde.' });
        const { value } = await bodyJson(req); const name = String(value.name || '').trim(); const email = String(value.email || '').trim().toLowerCase(); const subject = String(value.subject || '').trim(); const message = String(value.message || '').trim();
        if (name.length < 2 || name.length > 120 || !validEmail(email) || subject.length < 4 || subject.length > 160 || message.length < 20 || message.length > 5000) return json(res, 400, { error: 'Confira nome, e-mail, assunto e descrição do problema (20 a 5.000 caracteres).' });
        if (rate.count >= 5) { rate.count = 0; rate.until = now() + 15 * 60 * 1000; supportAttempts.set(ip, rate); return json(res, 429, { error: 'Limite de chamados atingido. Tente novamente em 15 minutos.' }); }
        rate.count++; supportAttempts.set(ip, rate); const timestamp = new Date(now()).toISOString(); const ticket = { id: `SUP-${crypto.randomUUID()}`, name, email, phone: String(value.phone || '').trim().slice(0, 40), category: String(value.category || 'Dúvida').slice(0, 60), subject, message, status: 'Aberto', priority: 'Normal', createdAt: timestamp, updatedAt: timestamp, conversation: [{ id: crypto.randomUUID(), author: 'Cliente', message, createdAt: timestamp }] }; db.tickets.unshift(ticket); persist(); return json(res, 201, { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt });
      }
      const publicTicket = url.pathname.match(/^\/api\/support\/tickets\/([^/]+)$/);
      if (req.method === 'GET' && publicTicket) { const ticket = db.tickets.find(t => t.id === decodeURIComponent(publicTicket[1]) && t.email === String(url.searchParams.get('email') || '').trim().toLowerCase()); if (!ticket) return json(res, 404, { error: 'Chamado não encontrado. Confira o código e o e-mail usados no envio.' }); return json(res, 200, { id: ticket.id, subject: ticket.subject, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, conversation: ticket.conversation }); }
      if (req.method === 'POST' && url.pathname === '/api/payments/mercadopago/webhook') {
        if (!webhookSecret || !mpAccessToken) return json(res, 503, { error: 'Credenciais do webhook Mercado Pago não configuradas.' });
        const { raw, value: event } = await bodyJson(req); const paymentId = String(url.searchParams.get('data.id') || event.data?.id || ''); const type = url.searchParams.get('type') || event.type;
        if (type !== 'payment') return json(res, 200, { ok: true, ignored: true });
        if (!paymentId) return json(res, 400, { error: 'Notificação sem identificador de pagamento.' });
        if (db.payments.some(p => p.id === paymentId)) return json(res, 200, { ok: true, duplicate: true });
        const signatureHeader = String(req.headers['x-signature'] || ''); const ts = signatureHeader.match(/(?:^|,)\s*ts=([^,]+)/)?.[1]; const v1 = signatureHeader.match(/(?:^|,)\s*v1=([^,]+)/)?.[1]; const requestId = String(req.headers['x-request-id'] || '');
        if (!ts || !v1 || !requestId) return json(res, 401, { error: 'Assinatura Mercado Pago ausente.' });
        const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`; const expected = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex'); if (!safeEqual(v1, expected)) return json(res, 401, { error: 'Assinatura Mercado Pago inválida.' });
        const paymentResponse = await fetchImpl(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { authorization: `Bearer ${mpAccessToken}` } });
        if (!paymentResponse.ok) throw Object.assign(new Error('Não foi possível consultar o pagamento no Mercado Pago.'), { status: 502 });
        const payment = await paymentResponse.json();
        if (payment.status !== 'approved') return json(res, 200, { ok: true, ignored: true, status: payment.status });
        const clientId = String(payment.external_reference || payment.metadata?.client_id || ''); const client = db.clients.find(c => c.id === clientId);
        if (!client || String(payment.currency_id || 'BRL') !== 'BRL' || Number(payment.transaction_amount) !== Number(client.price)) return json(res, 422, { error: 'Pagamento aprovado não corresponde a cliente, moeda ou valor da assinatura.' });
        recordPayment({ clientId, amount: payment.transaction_amount, date: String(payment.date_approved || payment.date_created).slice(0, 10), method: payment.payment_method_id || 'Mercado Pago', reference: payment.external_reference || payment.id, providerPaymentId: String(payment.id), source: 'mercadopago' });
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        const auth = requireAdmin(req, res); if (!auth) return;
        if (req.method === 'GET' && url.pathname === '/api/admin/support/tickets') return json(res, 200, { tickets: db.tickets });
        const supportTicket = url.pathname.match(/^\/api\/admin\/support\/tickets\/([^/]+)$/);
        if (supportTicket && req.method === 'PUT') { const ticket = db.tickets.find(t => t.id === decodeURIComponent(supportTicket[1])); if (!ticket) return json(res, 404, { error: 'Chamado não encontrado.' }); const { value } = await bodyJson(req); if (value.status && !['Aberto', 'Em atendimento', 'Aguardando cliente', 'Resolvido', 'Fechado'].includes(value.status)) return json(res, 400, { error: 'Situação inválida.' }); if (value.status) ticket.status = value.status; const reply = String(value.reply || '').trim(); if (reply) { if (reply.length > 5000) return json(res, 400, { error: 'A resposta deve ter até 5.000 caracteres.' }); ticket.conversation.push({ id: crypto.randomUUID(), author: 'Suporte', message: reply, createdAt: new Date(now()).toISOString() }); } ticket.updatedAt = new Date(now()).toISOString(); persist(); return json(res, 200, ticket); }
        if (req.method === 'GET' && url.pathname === '/api/admin/data') return json(res, 200, { clients: db.clients, payments: db.payments, billingNotifications: db.billingNotifications });
        if (req.method === 'POST' && url.pathname === '/api/admin/import') { if (db.clients.length || db.payments.length) return json(res, 409, { error: 'Importação inicial só é permitida antes de existirem registros.' }); const { value } = await bodyJson(req); if (!Array.isArray(value.clients) || !Array.isArray(value.payments)) return json(res, 400, { error: 'Dados de importação inválidos.' }); db.clients = value.clients.map(c => clientInput(c)); db.payments = value.payments.filter(p => db.clients.some(c => c.id === p.clientId) && Number(p.amount) > 0 && validDate(p.date)).map(p => ({ id: String(p.id || `PAG-${crypto.randomUUID()}`), clientId: p.clientId, amount: Number(p.amount), date: p.date, method: String(p.method || 'Outro'), reference: String(p.reference || ''), status: p.status || 'Pago', source: 'import' })); db.billingNotifications = Array.isArray(value.billingNotifications) ? value.billingNotifications : []; persist(); return json(res, 201, { imported: db.clients.length }); }
        if (req.method === 'POST' && url.pathname === '/api/admin/clients') { const { value } = await bodyJson(req); const client = clientInput(value); db.clients.unshift(client); persist(); return json(res, 201, client); }
        const match = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
        const checkout = url.pathname.match(/^\/api\/admin\/clients\/([^/]+)\/checkout$/);
        if (checkout && req.method === 'POST') {
          if (!mpAccessToken || !notificationUrl || !/^https:\/\//i.test(notificationUrl)) return json(res, 503, { error: 'Configure token do Mercado Pago e URL HTTPS pública do webhook.' });
          const client = db.clients.find(c => c.id === decodeURIComponent(checkout[1])); if (!client) return json(res, 404, { error: 'Usuário não encontrado.' });
          const response = await fetchImpl('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { authorization: `Bearer ${mpAccessToken}`, 'content-type': 'application/json', 'x-idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ items: [{ title: `Assinatura ${client.plan} — ${client.business}`, quantity: 1, currency_id: 'BRL', unit_price: Number(client.price) }], external_reference: client.id, notification_url: notificationUrl, metadata: { client_id: client.id } }) });
          if (!response.ok) throw Object.assign(new Error('Mercado Pago não criou o link de pagamento.'), { status: 502 }); const preference = await response.json(); return json(res, 201, { id: preference.id, checkoutUrl: preference.init_point || preference.sandbox_init_point });
        }
        if (match && req.method === 'PUT') { const old = db.clients.find(c => c.id === decodeURIComponent(match[1])); if (!old) return json(res, 404, { error: 'Usuário não encontrado.' }); const { value } = await bodyJson(req); Object.assign(old, clientInput(value, old)); persist(); return json(res, 200, old); }
        if (match && req.method === 'DELETE') { const index = db.clients.findIndex(c => c.id === decodeURIComponent(match[1])); if (index < 0) return json(res, 404, { error: 'Usuário não encontrado.' }); db.clients.splice(index, 1); persist(); return json(res, 204, {}); }
        if (req.method === 'POST' && url.pathname === '/api/admin/payments') { const { value } = await bodyJson(req); return json(res, 201, recordPayment({ ...value, source: 'manual' })); }
        if (req.method === 'POST' && url.pathname === '/api/admin/reminders') { const { value } = await bodyJson(req); const client = db.clients.find(c => c.id === value.clientId); if (!client) return json(res, 404, { error: 'Usuário não encontrado.' }); const reminder = { id: `COB-${crypto.randomUUID()}`, clientId: client.id, date: new Date(now()).toISOString().slice(0, 10), message: String(value.message || '').slice(0, 1000), status: String(value.status || 'Pendente') }; db.billingNotifications.unshift(reminder); persist(); return json(res, 201, reminder); }
        return json(res, 404, { error: 'Rota administrativa não encontrada.' });
      }
      const pages = { '/': 'index.html', '/index.html': 'index.html', '/support.html': 'support.html', '/admin.html': 'admin.html', '/support-admin.html': 'support-admin.html' };
      if (req.method === 'GET' && pages[url.pathname]) { const file = path.join(__dirname, '..', pages[url.pathname]); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(file)); }
      if (req.method === 'GET' && /^\/(admin-portal\.js|admin-portal\.css|support-client\.js|support-admin\.js|support\.css|support-admin\.css|styles\.css|admin\.css|app\.js|admin-pages\.js|print\.css)$/.test(url.pathname)) { const file = path.join(__dirname, '..', path.basename(url.pathname)); res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(file)); }
      return json(res, 404, { error: 'Não encontrado.' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Erro interno.' }); }
  });
  return { server, db, persist };
}

if (require.main === module) {
  const service = createService(); const port = Number(process.env.PORT || 3000); const host = process.env.HOST || '127.0.0.1';
  service.server.listen(port, host, () => console.log(`Radiador Pro Admin disponível em http://${host}:${port}/admin.html`));
}
module.exports = { createService, PERMISSIONS };
