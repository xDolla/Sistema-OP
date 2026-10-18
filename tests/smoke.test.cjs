const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootApp() {
  const storage = new Map();
  const elements = {
    '#content': { innerHTML: '', listeners: {}, addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); } },
    '#todayLabel': { textContent: '' },
    '#pageTitle': { textContent: '' },
    '#lowBadge': { textContent: '', style: {} },
    '#billingBadge': { textContent: '', style: {} },
    '#notificationDot': { style: {} },
    '#sidebar': { classList: { remove() {}, toggle() {} } },
    '#modalBackdrop': { hidden: true },
    '#modalTitle': { textContent: '' },
    '#modalEyebrow': { textContent: '' },
    '#modalClose': { onclick: null },
    '#modalBody': { innerHTML: '', querySelector() { return { addEventListener() {} }; } },
    '#toasts': { append() {} },
    '#movementChart': null,
    '#mobileMenu': { addEventListener() {} },
    '#notificationBtn': { addEventListener() {} },
    '#profileBtn': { addEventListener() {} }
  };
  const document = {
    title: '', body: { style: {} },
    querySelector: selector => elements[selector] || null,
    querySelectorAll: () => [],
    createElement: () => ({ className: '', textContent: '', remove() {} })
  };
  const elementsClick = (action, id) => elements['#content'].listeners.click.forEach(callback => callback({ target: { closest: () => ({ dataset: { action, id } }) } }));
  const context = {
    document, location: { hash: '' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener() {}, print() {} }, console, Intl, Date, Math, JSON, Blob, URL, setTimeout, clearTimeout,
    globalThis: null, elementsClick
  };
  context.globalThis = context;
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'admin-pages.js'), 'utf8');
  vm.runInNewContext(adminSource, context, { filename: 'admin-pages.js' });
  let source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  source = source.replace('  render();\n})();', '  render();\n  globalThis.__testApi = { db, lowParts, addMovement, recordMovement, createOrder, createBudget, getPart, saveState, budgetTotal, setPage, click: (action,id) => elementsClick(action,id), showPrint, clientHealth, billingClients, saveAdminClient, registerSubscriptionPayment, createBillingNotice, dayDistance };\n})();');
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return { api: context.__testApi, storage, content: elements['#content'], modal: elements['#modalBackdrop'], modalTitle: elements['#modalTitle'], modalBody: elements['#modalBody'] };
}

test('carrega o conjunto de demonstração com mais de 2.000 movimentações', () => {
  const { api } = bootApp();
  assert.equal(api.db.parts.length, 14);
  assert.equal(api.db.vehicles.length, 12);
  assert.equal(api.db.orders.length, 14);
  assert.equal(api.db.budgets.length, 9);
  assert.equal(api.db.movements.length, 2500);
});

test('saída atualiza o saldo e entrada pode tirar uma peça da lista de reposição', () => {
  const { api } = bootApp();
  const part = api.getPart('P-001');
  const original = part.stock;
  api.addMovement(part, 'Saída', original - part.min, 'Uso em ordem de serviço', 'OS-TESTE');
  assert.equal(part.stock, part.min);
  assert.ok(api.lowParts().some(item => item.id === part.id));
  assert.equal(api.db.movements[0].type, 'Saída');
  api.addMovement(part, 'Entrada', 3, 'Compra de fornecedor', 'NF-TESTE');
  assert.equal(part.stock, part.min + 3);
  assert.ok(!api.lowParts().some(item => item.id === part.id));
  assert.equal(api.db.movements[0].type, 'Entrada');
});

test('orçamento de demonstração soma itens e mão de obra', () => {
  const { api } = bootApp();
  const budget = api.db.budgets[0];
  const expected = budget.items.reduce((sum, item) => sum + item.qty * item.price, 0) + budget.labor;
  assert.equal(api.budgetTotal(budget), expected);
  assert.ok(api.db.orders.some(order => order.id === budget.orderId));
});

test('estado inicial é persistido para as próximas aberturas', () => {
  const { storage } = bootApp();
  const saved = JSON.parse(storage.get('radiadorPro.v1'));
  assert.equal(saved.movements.length, 2500);
  assert.equal(saved.seeded, true);
});

test('ordens, orçamentos e estoque exibem suas telas de gestão', () => {
  const { api, content } = bootApp();
  api.setPage('ordens');
  assert.match(content.innerHTML, /Ordens de serviço/);
  assert.doesNotMatch(content.innerHTML, /Mão de obra|R\$/);
  assert.match(content.innerHTML, /Abrir ordem de serviço/);
  api.setPage('orcamentos');
  assert.match(content.innerHTML, /Orçamentos/);
  assert.match(content.innerHTML, /VALOR TOTAL/);
  api.setPage('estoque');
  assert.match(content.innerHTML, /Peças cadastradas/);
  assert.ok(api.lowParts().length > 0);
});

test('botões de abrir OS e orçamento mostram seus formulários', () => {
  const { api, modal, modalTitle, modalBody } = bootApp();
  api.setPage('ordens');
  api.click('new-order');
  assert.equal(modal.hidden, false);
  assert.equal(modalTitle.textContent, 'Abrir ordem de serviço');
  assert.doesNotMatch(modalBody.innerHTML, /Mão de obra prevista|R\$/);
  api.setPage('orcamentos');
  api.click('new-quote');
  assert.equal(modal.hidden, false);
  assert.equal(modalTitle.textContent, 'Criar orçamento');
});

test('prévia de impressão da OS e do orçamento inclui identificação e totais', () => {
  const { api, content } = bootApp();
  api.setPage('ordens');
  api.click('print-order', api.db.orders[0].id);
  assert.match(content.innerHTML, /class="print-sheet"/);
  assert.match(content.innerHTML, /Assinatura do cliente/);
  assert.doesNotMatch(content.innerHTML, /Valor unitário|Total do orçamento|Mão de obra estimada|R\$/);
  api.setPage('orcamentos');
  api.click('print-quote', api.db.budgets[0].id);
  assert.match(content.innerHTML, /class="print-sheet"/);
  assert.match(content.innerHTML, /Total do orçamento/);
});

test('simulação de uma jornada de oficina: recebimento, atendimentos, orçamentos, saídas, alerta e reposição', () => {
  const { api, storage, content } = bootApp();
  const part = api.getPart('P-001');
  const baselineMovements = api.db.movements.length;
  const baselineOrders = api.db.orders.length;
  const baselineBudgets = api.db.budgets.length;
  const day = '2026-10-18';

  // 08:00 — abrir o turno e conferir a tela inicial e a carteira já carregada.
  api.setPage('dashboard');
  assert.match(content.innerHTML, /Movimentação de peças/);
  assert.equal(api.db.movements.length, 2500);

  // 09:00 — receber mercadoria do fornecedor.
  assert.equal(api.recordMovement({ type: 'Entrada', partId: part.id, qty: 8, date: day, reason: 'Compra de fornecedor', ref: 'NF-DIA-01' }), true);
  assert.equal(part.stock, 16);

  // 09:30 — abrir três ordens com cliente, defeito, veículo e peça vinculada.
  const newOrders = [0, 1, 2].map((i) => api.createOrder({ vehicleId: api.db.vehicles[i].id, defect: ['Vazamento após aquecimento', 'Ventoinha não aciona', 'Radiador obstruído'][i], partId: part.id, status: 'Aguardando aprovação', labor: 220 + i * 35, date: day }));
  assert.equal(api.db.orders.length, baselineOrders + 3);
  assert.ok(newOrders.every(order => order && order.client && order.vehicleId && order.partIds.includes(part.id)));
  assert.match(newOrders[0].defect, /Vazamento/);

  // 10:00 — preparar um orçamento por ordem e conferir vínculo, valores e aprovação.
  const newBudgets = newOrders.map((order, i) => api.createBudget({ orderId: order.id, partId: part.id, qty: i + 1, price: 110, labor: 220 + i * 35, validUntil: '2026-10-25', notes: 'Peças e mão de obra com garantia.' }));
  assert.equal(api.db.budgets.length, baselineBudgets + 3);
  assert.ok(newBudgets.every((budget, i) => budget.orderId === newOrders[i].id && budget.client === newOrders[i].client));
  assert.equal(api.budgetTotal(newBudgets[0]), 330);
  newBudgets[0].status = 'Aprovado';
  newBudgets[1].status = 'Aprovado';
  newOrders[0].status = 'Concluída';
  api.saveState();
  assert.equal(api.db.budgets.filter(budget => newBudgets.some(item => item.id === budget.id) && budget.status === 'Aprovado').length, 2);

  // 12:00–14:00 — lançar consumo em serviços concluídos e verificar o nível mínimo.
  for (const [qty, ref] of [[3, newOrders[0].id], [2, newOrders[1].id], [5, newOrders[2].id], [2, 'OS-EXTRA-01']]) {
    assert.equal(api.recordMovement({ type: 'Saída', partId: part.id, qty, date: day, reason: 'Uso em ordem de serviço', ref }), true);
  }
  assert.equal(part.stock, 4);
  assert.ok(api.lowParts().some(item => item.id === part.id), 'alerta deve aparecer quando o saldo alcança o mínimo');
  assert.equal(api.recordMovement({ type: 'Saída', partId: part.id, qty: 1, date: day, reason: 'Uso em ordem de serviço', ref: newOrders[2].id }), true);
  assert.equal(part.stock, 3);
  assert.ok(api.lowParts().some(item => item.id === part.id), 'alerta deve continuar abaixo do mínimo');
  const countBeforeRejectedSale = api.db.movements.length;
  assert.equal(api.recordMovement({ type: 'Saída', partId: part.id, qty: 999, date: day, reason: 'Venda balcão', ref: 'VENDA-IMPOSSÍVEL' }), false);
  assert.equal(api.db.movements.length, countBeforeRejectedSale, 'venda acima do saldo não pode gerar movimento');
  assert.equal(part.stock, 3, 'saldo não pode ficar negativo');

  // 15:00 — repor a peça e confirmar que ela desaparece da lista de reposição.
  assert.equal(api.recordMovement({ type: 'Entrada', partId: part.id, qty: 6, date: day, reason: 'Compra de fornecedor', ref: 'NF-DIA-02' }), true);
  assert.equal(part.stock, 9);
  assert.ok(!api.lowParts().some(item => item.id === part.id));

  // 17:00 — revisar ordens, propostas, documentos de impressão e persistência.
  api.setPage('ordens');
  assert.match(content.innerHTML, /Vazamento após aquecimento/);
  api.showPrint('order', newOrders[0].id);
  assert.ok(content.innerHTML.includes(newOrders[0].id));
  assert.match(content.innerHTML, /Assinatura do cliente/);
  api.showPrint('quote', newBudgets[0].id);
  assert.match(content.innerHTML, /Total do orçamento/);
  assert.match(content.innerHTML, /garantia/i);
  assert.equal(api.db.movements.length, baselineMovements + 7);
  const saved = JSON.parse(storage.get('radiadorPro.v1'));
  assert.equal(saved.parts.find(item => item.id === part.id).stock, 9);
  assert.ok(saved.orders.some(order => order.id === newOrders[0].id));
  assert.ok(saved.budgets.some(budget => budget.id === newBudgets[0].id));
});

test('administração carrega clientes e os estados de assinatura para alertas', () => {
  const { api } = bootApp();
  assert.equal(api.db.clients.length, 8);
  assert.equal(api.db.payments.length, 5);
  assert.ok(api.db.clients.every(client => client.permissions && Object.keys(client.permissions).length === 8));
  assert.equal(api.clientHealth(api.db.clients.find(c => c.id === 'CLI-0005')), 'Em atraso');
  assert.ok(api.billingClients().some(client => client.id === 'CLI-0002'));
});

test('a área administrativa não está disponível na navegação do sistema da oficina', () => {
  const { api, content } = bootApp();
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(index, /href="support\.html"/);
  assert.doesNotMatch(index, /href="admin\.html"/);
  assert.doesNotMatch(index, /data-page="clientes"|data-page="assinaturas"|data-page="cobrancas"/);
  api.setPage('clientes');
  assert.match(content.innerHTML, /Movimentação de peças/);
  api.setPage('assinaturas');
  assert.match(content.innerHTML, /Movimentação de peças/);
  api.setPage('cobrancas');
  assert.match(content.innerHTML, /Movimentação de peças/);
});

test('admin consegue cadastrar cliente com permissões específicas e rejeitar e-mail duplicado', () => {
  const { api } = bootApp();
  const newClient = api.saveAdminClient({ business: 'Radiadores Teste', owner: 'Joana Silva', email: 'joana@teste.example', phone: '11999990000', plan: 'Essencial', price: 89, cycle: 'Mensal', dueDate: '2026-11-20', startedAt: '2026-10-18', subscriptionStatus: 'Ativa', perm_dashboard: 'on', perm_stock: 'on', perm_orders: 'on' });
  assert.ok(newClient);
  assert.equal(newClient.permissions.stock, true);
  assert.equal(newClient.permissions.budgets, false);
  assert.equal(api.db.clients.length, 9);
  const duplicate = api.saveAdminClient({ business: 'Duplicado', owner: 'Outra pessoa', email: 'joana@teste.example', plan: 'Pro', price: 149, cycle: 'Mensal', dueDate: '2026-11-20', subscriptionStatus: 'Ativa' });
  assert.equal(duplicate, false);
  assert.equal(api.db.clients.length, 9);
});

test('registrar pagamento atualiza o histórico, reativa a assinatura e avança o vencimento', () => {
  const { api, storage } = bootApp();
  const client = api.db.clients.find(c => c.id === 'CLI-0005');
  const beforeCount = api.db.payments.length;
  assert.equal(api.clientHealth(client), 'Em atraso');
  assert.equal(api.registerSubscriptionPayment({ clientId: client.id, amount: 149, date: '2026-10-18', method: 'PIX', reference: 'REC-TEST-01' }), true);
  assert.equal(api.db.payments.length, beforeCount + 1);
  assert.equal(client.subscriptionStatus, 'Ativa');
  assert.equal(client.lastPayment, '2026-10-18');
  assert.equal(client.dueDate, '2026-11-18');
  assert.equal(api.clientHealth(client), 'Ativa');
  assert.ok(JSON.parse(storage.get('radiadorPro.v1')).payments.some(p => p.reference === 'REC-TEST-01'));
});

test('central registra lembrete local e mantém trilha de cobrança sem enviar mensagem', () => {
  const { api } = bootApp();
  const client = api.db.clients.find(c => c.id === 'CLI-0005');
  const notice = api.createBillingNotice(client.id);
  assert.equal(notice.clientId, client.id);
  assert.match(notice.message, /está vencida há/);
  assert.equal(client.lastReminder, notice.date);
  api.setPage('cobrancas');
  assert.match(api.db.billingNotifications[0].message, /Próximo vencimento/);
});
