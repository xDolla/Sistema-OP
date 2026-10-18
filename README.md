# Radiador Pro

**Sistema simples de gestão para oficinas de radiadores, com controle de peças, serviços e orçamento em um só lugar.**

O Radiador Pro ajuda pequenas oficinas a acompanhar o estoque e a rotina de atendimento. O painel reúne indicadores e gráficos de movimentação; o cadastro de peças registra saldo e quantidade mínima; e as ordens organizam os defeitos e veículos atendidos. Os orçamentos ligados às ordens apresentam os valores das peças e da mão de obra, com prévia pronta para impressão.

Esta versão de demonstração abre diretamente no navegador, sem login, e vem com dados de exemplo para explorar as telas e os fluxos.

## Abrir o sistema

Para explorar a demonstração local, abra `index.html` em um navegador atualizado. Para que o envio e acompanhamento de chamados funcionem, inicie o backend e abra o sistema em `http://127.0.0.1:3000/`.

## Publicar atualizações no GitHub

Este workspace tem uma cópia portátil do Git em `.git-tools/portable`, ignorada pelo repositório. O script `publicar.ps1` usa essa cópia automaticamente. Em um novo clone ou computador, instale o [Git for Windows](https://git-scm.com/download/win). No PowerShell, na pasta do projeto, configure seu nome e o e-mail associado à sua conta GitHub (o endereço `noreply` do GitHub também pode ser usado):

```powershell
$git = Join-Path $PWD '.git-tools\portable\cmd\git.exe'
& $git config user.name "Seu nome"
& $git config user.email "seu-email-do-GitHub"
```

O remoto `origin` deste projeto aponta para `https://github.com/xDolla/Sistema-OP.git`, na branch `main`. O Git Credential Manager cuida da autenticação segura. Para publicar mudanças depois, execute:

```powershell
.\publicar.ps1 "Descreva as alterações"
```

O script prepara e registra as alterações e envia a branch atual. Arquivos `.env` e `server/data/` ficam fora do Git para proteger credenciais e dados locais. Não inclua senhas, tokens ou dados de clientes no repositório.

## O que está disponível

- Painel com indicadores, gráfico de entradas e saídas, composição do estoque e alerta de reposição.
- Cadastro e edição de peças, categoria, código, custo, saldo e estoque mínimo.
- Registro de entradas e saídas com validação de saldo, motivo e referência. A saída recalcula o estoque e sinaliza quando uma peça alcança o mínimo ou fica abaixo dele.
- Ordens de serviço sem valores: cliente, veículo, defeito, peça relacionada e status. Valores de peças e mão de obra aparecem no orçamento.
- Orçamentos vinculados a uma OS, com preço e quantidade das peças, mão de obra, validade, observações e total calculado.
- Prévia de impressão em A4 para OS e orçamento, com campos de assinatura; use o botão da impressora na ficha e depois “Imprimir documento”.
- Cadastro de veículos e exportação do estoque e do histórico para CSV.
- Portal administrativo separado para cadastro de oficinas clientes, assinaturas, permissões e pagamentos.

## Portal administrativo com backend

O portal em `admin.html` usa um backend Node.js independente com sessão administrativa, gestão de clientes e permissões, histórico de recebimentos e cobranças. A API e os dados administrativos ficam no servidor em `server/data/admin.json`; a senha e as credenciais do gateway são fornecidas por variáveis de ambiente, nunca pelo navegador.

### Iniciar localmente

Instale Node.js 20 ou mais recente. No PowerShell, configure as credenciais e inicie o servidor:

```powershell
$env:ADMIN_EMAIL = 'seu-email@exemplo.com'
$env:ADMIN_PASSWORD = 'uma-senha-forte-com-12-caracteres-ou-mais'
$env:NODE_ENV = 'development'
cd server
node server.js
```

Abra `http://127.0.0.1:3000/` para o sistema do cliente, `http://127.0.0.1:3000/support.html` para abrir ou acompanhar chamados e `http://127.0.0.1:3000/admin.html` para a administração autenticada. Em hospedagem, publique atrás de HTTPS, defina `NODE_ENV=production` e encaminhe as páginas e `/api` para este servidor. O serviço escuta apenas em `127.0.0.1` por padrão, apropriado atrás de um proxy HTTPS.

### Portal de suporte

No sistema do cliente, **Ajuda e suporte** abre `support.html`. O chamado fica salvo no servidor; o cliente recebe um código e usa o e-mail informado para consultar a situação e as respostas. A equipe acessa `support-admin.html` com as credenciais administrativas, vê a fila, altera a situação e envia orientações. O cliente não recebe um link para o portal interno de suporte ou para a administração. As respostas ficam disponíveis no acompanhamento do chamado; envio de e-mail não está configurado.

### Mercado Pago

Configure as credenciais da aplicação do Mercado Pago e uma URL HTTPS pública para notificações:

```powershell
$env:MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-...'
$env:PAYMENT_WEBHOOK_SECRET = 'segredo-da-notificacao-do-mercado-pago'
$env:PAYMENT_NOTIFICATION_URL = 'https://seu-dominio.com/api/payments/mercadopago/webhook'
```

Reinicie o servidor e configure no painel do Mercado Pago o evento de pagamentos para a mesma URL. O portal cria links Checkout Pro. O webhook valida `x-signature`, consulta o pagamento pela API do Mercado Pago e só então registra pagamentos aprovados em BRL que correspondam ao valor da assinatura. A configuração do domínio HTTPS e das credenciais da sua conta ainda precisa ser feita pelo operador.

Os dados administrativos são gravados em arquivo JSON local e podem ser migrados automaticamente do `localStorage` antigo quando o portal estiver servido na mesma origem do sistema. Para uso multiusuário em produção, configure backup e substitua o arquivo JSON por banco transacional. O backend protege o portal; a aplicação da oficina legada em `index.html` continua sendo uma demonstração local e ainda não autentica oficinas nem aplica isolamento de dados entre elas.

O painel da oficina em `index.html` continua sendo uma demonstração local sem login. As telas de usuários, permissões, assinaturas e cobranças ficam no portal autenticado em `admin.html` e não aparecem na navegação do cliente.

## Teste automatizado

Com Node.js 20 ou mais recente, execute os testes da aplicação e da API:

```sh
node --test tests/*.test.cjs
```

## Observação para evolução

Esta versão roda integralmente no navegador e usa dados de demonstração. Para comercialização com várias oficinas, será preciso acrescentar armazenamento e autenticação no servidor, separação dos dados por oficina, cópias de segurança e implantação hospedada.
