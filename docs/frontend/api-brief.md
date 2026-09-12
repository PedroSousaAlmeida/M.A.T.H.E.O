# MATHEO — brief da API para o frontend

Documento para quem vai desenhar/implementar as primeiras telas. Descreve o que a API já faz hoje (v0.2.0), como autenticar, os contratos de cada endpoint e os estados que a UI precisa representar.

## 1. O produto em uma frase

Um MEI (microempreendedor) cadastra sua empresa e o certificado digital uma vez, e a partir daí **emite, consulta, baixa (PDF/XML) e cancela notas fiscais de serviço (NFS-e)** em poucos cliques. Público: MEIs que hoje emitem nota manualmente no portal do governo.

## 2. Arquitetura que o frontend enxerga

```
[Frontend SPA] --login--> [Logto] (identidade: cadastro, login, senha, social)
      |                       |
      |  Bearer JWT (aud = https://api.matheo.local)
      v
[API NestJS]  http://localhost:3000/api/v0
```

- **Logto** cuida de cadastro e login. O frontend nunca lida com senha: redireciona para o Logto (SDK `@logto/react`, `@logto/vue` ou `@logto/browser`) e recebe um *access token* para o **API resource** `https://api.matheo.local`.
- A API só valida o token. O `sub` do token identifica o usuário. **1 usuário = 1 empresa** nesta versão.
- Todas as rotas ficam sob **`/api/v0`**. Todas exigem `Authorization: Bearer <token>`, exceto `GET /health`.
- `GET /health` (público) devolve `{ status, version, stage, apiVersion, environment, nfseEnv, commit, runtime, uptimeSeconds, timestamp, checks.database }` — o front pode mostrar `version`/`stage` no rodapé e usar `status` (`ok`/`degraded`, HTTP 200/503) numa página de status.

### 2.1 Configuração do Logto para a SPA

No console do Logto (dev: http://localhost:3002):

1. *Applications → Create → Single-page app* (React/Vue/Vanilla). Redirect URI: a URL do front (ex.: `http://localhost:5173/callback`). Post sign-out URI: `http://localhost:5173`.
2. Ao inicializar o SDK, informe o resource: `resources: ['https://api.matheo.local']`, `scopes: ['openid', 'profile', 'email', 'offline_access']`.
3. Para chamar a API: `const token = await logto.getAccessToken('https://api.matheo.local')`. Sem o `resource` o Logto devolve token opaco e a API responde 401.
4. Cadastro self-service: *Sign-in experience → Sign-up and sign-in* (e-mail/username + senha; social opcional).

Ambientes: `LOGTO_ENDPOINT` (dev `http://localhost:3001`), issuer `${LOGTO_ENDPOINT}/oidc`.

## 3. Convenções da API

- JSON em UTF-8; datas em ISO 8601 (`2026-09-12T18:59:43.134Z`); dinheiro como **string decimal com 2 casas** na resposta (`"150.00"`) e **número** na requisição (`150` ou `150.5`).
- Documentos (CPF/CNPJ) e telefone: **só dígitos** (`"12345678909"`, `"12345678000199"`, `"11999999999"`).
- Erros sempre no formato:

```json
{ "statusCode": 422, "message": "NFS-e rejected by the national API", "details": { "...": "..." } }
```

| Código | Quando | O que a UI faz |
|---|---|---|
| 400 | corpo inválido (`message: "Validation failed"`, `details: ["cnpj must be 14 digits", ...]`) | mostrar erros por campo (as mensagens citam o nome do campo) |
| 401 | sem token / token inválido ou expirado | renovar token pelo SDK ou mandar pro login |
| 404 | empresa ainda não cadastrada (`GET /companies/me`) ou nota não encontrada | onboarding / lista vazia |
| 409 | já existe empresa para o usuário; CNPJ já usado; documento de cliente já cadastrado; cancelar nota que não está `ISSUED`; emissão concorrente | mensagem direta |
| 422 | certificado ausente/vencido/inválido; **nota rejeitada pelo fisco** (`details.code`, `details.reason`) | destacar o motivo; oferecer corrigir e reemitir |
| 402 | trial de 30 dias vencido (só ao emitir; `details.trialEndsAt`) | tela de planos |
| 429 | limite de requisições (60/min geral, 10/min para emitir) | aguardar |
| 502 | API Nacional fora do ar — nota fica `PENDING` | avisar "tente de novo em instantes"; a nota aparece na lista como pendente |
| 503 | Logto/JWKS inacessível | tela de erro genérica |
| 500 | erro interno | tela de erro genérica |

Paginação: `?page=1&limit=20` → `{ "data": [...], "page": 1, "limit": 20, "total": 37 }`.

## 4. Endpoints

### 4.1 Empresa

**`GET /companies/me`** → 200 `Company` | 404 se ainda não cadastrou (→ onboarding).

**`POST /companies`** — cria a empresa do usuário (uma vez).

```json
{
  "cnpj": "12345678000199",            // obrigatório, 14 dígitos
  "razaoSocial": "Minha MEI LTDA",     // 2–150
  "inscricaoMunicipal": "123456",      // opcional
  "codigoMunicipio": "3550308",        // obrigatório, código IBGE de 7 dígitos (São Paulo = 3550308)
  "email": "contato@exemplo.com",      // opcional
  "telefone": "11999999999"            // opcional, 10–11 dígitos
}
```
→ 201 `Company` · 409 se já tem empresa ou CNPJ já usado.

**`PATCH /companies/me`** — mesmos campos, todos opcionais, **exceto `cnpj`** (não muda). → 200 `Company`.

**`PUT /companies/me/certificate`** — upload do certificado A1. `multipart/form-data` com `file` (arquivo `.pfx`, máx. 10 KB) e `password` (texto). → 200 `Company` · 422 senha errada/arquivo inválido.

`Company`:
```json
{
  "id": "uuid", "cnpj": "12345678000199", "razaoSocial": "Minha MEI LTDA",
  "inscricaoMunicipal": "123456", "codigoMunicipio": "3550308",
  "email": "contato@exemplo.com", "telefone": "11999999999",
  "hasCertificate": true, "certificateExpiry": "2027-09-12T16:42:00.000Z",
  "plan": "TRIAL", "trialEndsAt": "2026-10-12T00:00:00.000Z",
  "createdAt": "...", "updatedAt": "..."
}
```
O certificado em si **nunca** volta na API. A UI só mostra `hasCertificate` e a validade (alertar quando faltar < 30 dias).

`plan` é `"TRIAL"` ou `"ACTIVE"`; `trialEndsAt` marca o fim dos 30 dias contados a partir do `POST /companies`. Ver seção 5 para o que acontece quando o trial vence.

### 4.2 Notas (invoices)

**`POST /invoices`** — emite uma NFS-e (síncrono: a resposta já traz o resultado do fisco).

O tomador (cliente) é identificado de uma destas duas formas — **exatamente uma**, nunca as duas nem nenhuma (senão `400`):

- `"customerId": "uuid"` — um cliente salvo (ver 4.3); ou
- `"tomadorDocumento"` + `"tomadorNome"` (+ `"tomadorEmail"` opcional) — dados soltos. Nesse caso pode mandar `"saveCustomer": true` para salvar automaticamente esse tomador como cliente da empresa (fica disponível em `/customers` depois).

```json
{
  "customerId": "uuid",                // opcional — exclusivo com tomadorDocumento/tomadorNome
  "tomadorDocumento": "12345678909",   // obrigatório sem customerId — CPF (11) ou CNPJ (14) do cliente
  "tomadorNome": "Cliente Exemplo",    // obrigatório sem customerId — 2–150
  "tomadorEmail": "cliente@x.com",     // opcional
  "saveCustomer": true,                // opcional — só com tomadorDocumento/tomadorNome
  "descricao": "Consultoria em TI",    // 1–2000
  "valor": 150.00,                     // > 0, até 2 casas, máx 9.999.999.999,99
  "codigoTributacao": "01.01.01"       // código nacional de tributação (formato NN.NN.NN)
}
```
→ 201 `Invoice` com `status: "ISSUED"` · 400 `customerId` e `tomador*` juntos ou nenhum dos dois · 402 trial vencido (ver seção 5) · 422 rejeitada (`details.code`, `details.reason`; a nota fica salva como `REJECTED`) · 422 sem certificado · 502 fisco fora (nota fica `PENDING`) · 409 emissão concorrente (repetir).

**`GET /invoices?status=&page=&limit=`** → lista paginada, mais recentes primeiro. `status` ∈ `PENDING | ISSUED | REJECTED | CANCELLED`.

**`GET /invoices/:id`** → `Invoice`.

**`GET /invoices/:id/xml`** → `application/xml` (só `ISSUED`/`CANCELLED`; 404 se não emitida).

**`GET /invoices/:id/pdf`** → `application/pdf` (DANFSe), `Content-Disposition: inline`. Abrir em nova aba ou baixar.

**`POST /invoices/:id/cancel`** — `{ "motivo": "texto de 15 a 255 caracteres" }` → 200 `Invoice` com `status: "CANCELLED"` · 409 se não está `ISSUED` · 422 fisco recusou.

`Invoice`:
```json
{
  "id": "uuid", "companyId": "uuid",
  "status": "ISSUED",
  "dpsNumero": 7, "dpsSerie": "1",
  "customerId": null,
  "tomadorDocumento": "12345678909", "tomadorNome": "Cliente Exemplo", "tomadorEmail": null,
  "descricao": "Consultoria em TI", "valor": "150.00", "codigoTributacao": "01.01.01",
  "chaveAcesso": "35503082...50 dígitos", "numeroNfse": "7",
  "rejectionReason": null,
  "cancelledAt": null, "cancelReason": null,
  "createdAt": "...", "updatedAt": "..."
}
```

### 4.3 Tomadores (customers)

Clientes salvos da empresa, para reaproveitar em novas notas sem redigitar. Sempre escopados à empresa do usuário logado (nunca aparece cliente de outra empresa).

| Método | Rota | Body / query | Resposta |
|---|---|---|---|
| `POST` | `/customers` | `{ "documento": "98765432000100", "nome": "Empresa Cliente", "email"?: "...", "telefone"?: "..." }` | 201 `Customer` · 409 documento já cadastrado |
| `GET` | `/customers?search=&page=&limit=` | `search` filtra por nome (contém, sem case) ou início do documento | paginado `{ data, page, limit, total }`, ordem por nome |
| `GET` | `/customers/:id` | — | `Customer` · 404 |
| `PATCH` | `/customers/:id` | qualquer campo acima | `Customer` · 409 |
| `DELETE` | `/customers/:id` | — | 204 (notas antigas ficam intactas, com `customerId: null`) |

`Customer`:
```json
{
  "id": "uuid", "documento": "98765432000100", "nome": "Empresa Cliente",
  "email": "fin@cliente.com", "telefone": null,
  "createdAt": "...", "updatedAt": "..."
}
```

UI sugerida no formulário de nota: campo "Cliente" com autocomplete (busca em `/customers?search=`); ao escolher, preenche e trava documento/nome e manda `customerId`; opção "novo cliente" abre os campos livres de tomador + checkbox "salvar este cliente" (manda `saveCustomer: true`).

### 4.4 Estados de uma nota

```
POST /invoices ──> PENDING ──(fisco aceitou)──> ISSUED ──(cancel)──> CANCELLED
                      │
                      └──(fisco rejeitou)──> REJECTED   (final; corrigir e emitir uma nova)
PENDING que ficou (fisco fora do ar) aparece na lista até ser reconciliada (futuro).
```

| Status | Cor sugerida | Ações disponíveis |
|---|---|---|
| ISSUED | verde | ver, PDF, XML, cancelar |
| CANCELLED | cinza | ver, PDF, XML |
| REJECTED | vermelho | ver motivo (`rejectionReason`), "emitir novamente" (pré-preenche o formulário) |
| PENDING | amarelo | ver; sem ações |

## 5. Registro, onboarding e o "gate" por estado

O Logto só sabe **quem** a pessoa é. Quem ela é **como MEI** (CNPJ, município, certificado) o app pergunta uma única vez, na tela de onboarding ("complete seu cadastro"). O front decide qual tela mostrar olhando o **estado** devolvido pela API — não existe permissão especial no Logto.

```
[Landing] → "Criar conta" → tela do Logto (e-mail+senha ou social) → token
    → GET /companies/me
         ├─ 404 ───────────────────────→ ONBOARDING (obrigatório; nada mais funciona sem empresa)
         └─ 200 ┬─ hasCertificate=false → DASHBOARD com aviso fixo "cadastre seu certificado"
                │                           (emitir nota fica bloqueado; API responde 422)
                └─ hasCertificate=true  → DASHBOARD, uso pleno
```

Regras:
- **Onboarding em 2 passos**: (1) dados da empresa → `POST /companies` — cria a empresa e **inicia o trial de 30 dias** (o trial conta a partir daqui, não do registro no Logto); (2) certificado → `PUT /companies/me/certificate`. O passo 2 **pode ser pulado** ("fazer depois"): o usuário entra no app e cadastra o `.pfx` quando tiver, pelo aviso do dashboard ou pela tela Empresa.
- Enquanto `GET /companies/me` for 404, todas as rotas de nota respondem 404 — o front deve manter o usuário no onboarding.
- Trial vencido (`plan: "TRIAL"` e `trialEndsAt` no passado): só a **emissão** bloqueia (`402`); consultar, baixar e cancelar continuam. O front mostra "X dias restantes" no dashboard e a tela de planos ao receber 402.

## 6. Fluxos de tela sugeridos

1. **Landing → Login/Cadastro** (Logto hospeda a tela; o front só redireciona).
2. **Onboarding** (primeiro acesso, `GET /companies/me` = 404): passo 1 dados da empresa (`POST /companies`); passo 2 certificado (`PUT .../certificate`, arrastar `.pfx` + senha) com opção "fazer depois".
3. **Dashboard**: total emitido no mês, últimas notas, alerta de certificado (ausente / vence em X dias), atalho "Nova nota".
4. **Nova nota**: formulário dos 6 campos acima; ao enviar mostra loading ("enviando ao fisco…"), depois sucesso (número, chave, botões PDF/XML) ou o erro 422 com motivo.
5. **Lista de notas**: filtro por status, paginação, ações por linha.
6. **Detalhe da nota**: todos os campos + botões PDF/XML/cancelar (cancelar pede o motivo, mín. 15 caracteres).
7. **Empresa**: editar dados, trocar certificado.

## 7. Ambiente de desenvolvimento

- API: `bun run dev` → `http://localhost:3000/api/v0/health`.
- Logto: `http://localhost:3001` (OIDC), console `http://localhost:3002`.
- Gateway fiscal em modo **fake** (`NFSE_ENV=fake`): emite sem falar com o governo, mas monta e assina o XML de verdade. O PDF é um DANFSe simulado.
- Collection Postman com todos os requests: `docs/collections/matheo-nfse-api.postman_collection.json`.
- CORS ainda não está configurado na API — será liberado para a origem do front quando ele existir.

## 8. Trial e tomadores (v0.2.0) — entregue

Trial de 30 dias e tomadores salvos (clientes) já estão na API e documentados junto dos endpoints: `Company.plan`/`trialEndsAt` e o gate `402` na seção 4.1 e na seção 5; `/customers` e o `POST /invoices` com `customerId`/`saveCustomer` na seção 4.3. Spec original: `docs/superpowers/specs/2026-09-12-trial-and-customers-design.md`.

## 9. Próximas features (deixar espaço na UI)

- **Serviços salvos** (descrição + código de tributação favoritos).
- Validação de dígito verificador de CPF/CNPJ no backend (hoje só formato).
- Múltiplas empresas por usuário / acesso de contador.
