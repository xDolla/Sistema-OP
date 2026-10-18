# Radiador Pro

**Sistema simples de gestão para oficinas de radiadores, com controle de peças, serviços e orçamento em um só lugar.**

O Radiador Pro ajuda pequenas oficinas a acompanhar o estoque e a rotina de atendimento. O painel reúne indicadores e gráficos de movimentação; o cadastro de peças registra saldo e quantidade mínima; e as ordens organizam os defeitos e veículos atendidos. Os orçamentos ligados às ordens apresentam os valores das peças e da mão de obra, com prévia pronta para impressão.

Esta versão de demonstração abre diretamente no navegador, sem login, e vem com dados de exemplo para explorar as telas e os fluxos.

## Abrir o sistema

Abra `index.html` em um navegador atualizado. Não há login: a demonstração abre direto no painel. Na primeira abertura, o navegador grava os dados de demonstração no armazenamento local, incluindo mais de 2.000 movimentações. As alterações ficam neste navegador e neste computador.

## O que está disponível

- Painel com indicadores, gráfico de entradas e saídas, composição do estoque e alerta de reposição.
- Cadastro e edição de peças, categoria, código, custo, saldo e estoque mínimo.
- Registro de entradas e saídas com validação de saldo, motivo e referência. A saída recalcula o estoque e sinaliza quando uma peça alcança o mínimo ou fica abaixo dele.
- Ordens de serviço sem valores: cliente, veículo, defeito, peça relacionada e status. Valores de peças e mão de obra aparecem no orçamento.
- Orçamentos vinculados a uma OS, com preço e quantidade das peças, mão de obra, validade, observações e total calculado.
- Prévia de impressão em A4 para OS e orçamento, com campos de assinatura; use o botão da impressora na ficha e depois “Imprimir documento”.
- Cadastro de veículos e exportação do estoque e do histórico para CSV.

## Teste automatizado

Com Node.js 20 ou mais recente, execute:

```sh
node --test tests/smoke.test.cjs
```

## Observação para evolução

Esta versão roda integralmente no navegador e usa dados de demonstração. Para comercialização com várias oficinas, será preciso acrescentar armazenamento e autenticação no servidor, separação dos dados por oficina, cópias de segurança e implantação hospedada.
