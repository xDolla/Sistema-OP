const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createService } = require('../server/server');

async function start(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiador-admin-'));
  const service = createService({ dataFile: path.join(dir, 'store.json'), adminEmail: 'admin@example.test', adminPassword: 'senha-segura-para-teste', webhookSecret: 'webhook-test-secret', mpAccessToken: 'mp-test-token', notificationUrl: 'https://admin.example.test/api/payments/mercadopago/webhook', ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...service, base: `http://127.0.0.1:${service.server.address().port}` };
}
const request = (base, route, options = {}) => fetch(`${base}${route}`, options);
async function login(base) { const response = await request(base, '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password: 'senha-segura-para-teste' }) }); return { response, cookie: response.headers.get('set-cookie').split(';')[0] }; }

test('backend recusa credenciais padrão fracas', () => {
  assert.throws(() => createService({ dataFile: path.join(os.tmpdir(), 'rp-test.json'), adminEmail: 'admin@example.test', adminPassword: 'curta' }), /mínimo de 12/);
});

test('portais e backend têm sintaxe JavaScript válida', () => {
  for (const file of ['../admin-portal.js', '../support-client.js', '../support-admin.js', '../server/server.js']) new vm.Script(fs.readFileSync(path.join(__dirname, file), 'utf8'), { filename: file });
});

test('API exige login e permite gerenciar usuários somente na sessão admin', async t => {
  const app = await start(t);
  assert.equal((await request(app.base, '/api/admin/data')).status, 401);
  const { response: loginResponse, cookie } = await login(app.base);
  assert.equal(loginResponse.status, 200);
  assert.equal((await request(app.base, '/api/admin/data', { headers: { cookie } })).status, 200);
  const created = await request(app.base, '/api/admin/clients', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ business: 'Oficina Teste', email: 'oficina@example.test', dueDate: '2026-12-01', price: 149, permissions: { stock: true } }) });
  assert.equal(created.status, 201);
  const client = await created.json(); assert.equal(client.permissions.stock, true);
  assert.equal((await request(app.base, '/api/admin/data', { headers: { cookie } })).status, 200);
  assert.equal((await request(app.base, '/api/admin/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })).status, 401);
});

test('webhook Mercado Pago valida assinatura, consulta API e reconcilia apenas uma vez', async t => {
  const app = await start(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'pay-1', status: 'approved', currency_id: 'BRL', transaction_amount: 89, external_reference: app.db.clients[0].id, date_approved: '2026-10-18T12:00:00Z', payment_method_id: 'pix' }) }) });
  const { cookie } = await login(app.base);
  const created = await request(app.base, '/api/admin/clients', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ business: 'Radiadores Sul', email: 'sul@example.test', dueDate: '2026-10-01', price: 89, cycle: 'Mensal', subscriptionStatus: 'Ativa' }) });
  const client = await created.json();
  const event = { id: 17, action: 'payment.updated', type: 'payment', data: { id: 'pay-1' } }, requestId = 'request-1', ts = '1781740000000';
  const raw = JSON.stringify(event), manifest = `id:pay-1;request-id:${requestId};ts:${ts};`, signature = crypto.createHmac('sha256', 'webhook-test-secret').update(manifest).digest('hex');
  const route = '/api/payments/mercadopago/webhook?type=payment&data.id=pay-1';
  const invalid = await request(app.base, route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=bad` }, body: raw }); assert.equal(invalid.status, 401);
  const paid = await request(app.base, route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}` }, body: raw }); assert.equal(paid.status, 200);
  const duplicate = await request(app.base, route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}` }, body: raw }); assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(app.db.payments.length, 1); assert.equal(app.db.payments[0].source, 'mercadopago'); assert.equal(app.db.clients[0].dueDate, '2026-11-18');
});

test('API cria checkout Mercado Pago com cliente e valor da assinatura', async t => {
  let preference;
  const app = await start(t, { fetchImpl: async (url, options) => { preference = { url, options, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://www.mercadopago.com/checkout/pref-1' }) }; } });
  const { cookie } = await login(app.base);
  const response = await request(app.base, '/api/admin/clients', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ business: 'Oficina Checkout', email: 'checkout@example.test', dueDate: '2026-12-01', price: 149, plan: 'Pro' }) });
  const client = await response.json();
  const checkout = await request(app.base, `/api/admin/clients/${encodeURIComponent(client.id)}/checkout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(checkout.status, 201); assert.equal((await checkout.json()).checkoutUrl, 'https://www.mercadopago.com/checkout/pref-1');
  assert.equal(preference.url, 'https://api.mercadopago.com/checkout/preferences'); assert.equal(preference.body.external_reference, client.id); assert.equal(preference.body.items[0].unit_price, 149); assert.match(preference.body.notification_url, /^https:\/\//);
});

test('cliente abre chamado e acompanha resposta no portal de suporte', async t => {
  const app = await start(t);
  const home = await request(app.base, '/'); assert.equal(home.status, 200); const customerApp = await home.text(); assert.match(customerApp, /href="support\.html"/); assert.doesNotMatch(customerApp, /href="admin\.html"/);
  const supportPage = await request(app.base, '/support.html'); assert.equal(supportPage.status, 200); assert.doesNotMatch(await supportPage.text(), /support-admin\.html/);
  const opened = await request(app.base, '/api/support/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana Cliente', email: 'ana@example.test', category: 'Problema técnico', subject: 'Não consigo salvar ordem', message: 'Ao clicar em salvar, a tela fica carregando e não grava a ordem de serviço.' }) });
  assert.equal(opened.status, 201); const ticket = await opened.json(); assert.equal(ticket.status, 'Aberto');
  assert.equal((await request(app.base, `/api/support/tickets/${ticket.id}?email=wrong@example.test`)).status, 404);
  assert.equal((await request(app.base, '/api/admin/support/tickets')).status, 401);
  const { cookie } = await login(app.base);
  const queue = await request(app.base, '/api/admin/support/tickets', { headers: { cookie } }); assert.equal((await queue.json()).tickets.length, 1);
  const reply = await request(app.base, `/api/admin/support/tickets/${ticket.id}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Resolvido', reply: 'Atualize a página e tente novamente. A ordem agora foi salva corretamente.' }) }); assert.equal(reply.status, 200);
  const tracking = await request(app.base, `/api/support/tickets/${ticket.id}?email=ana%40example.test`); const result = await tracking.json(); assert.equal(result.status, 'Resolvido'); assert.equal(result.conversation.length, 2); assert.equal(result.conversation[1].author, 'Suporte');
});
