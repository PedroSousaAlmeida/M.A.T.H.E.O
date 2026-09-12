# MATHEO — brief da API para o frontend

Documento para quem vai desenhar/implementar as primeiras telas. Descreve o que a API já faz hoje (v0.1.0), como autenticar, os contratos de cada endpoint e os estados que a UI precisa representar.

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
| 409 | já existe empresa para o usuário; CNPJ já usado; cancelar nota que não está `ISSUED`; emissão concorrente | mensagem direta |
| 422 | certificado ausente/vencido/inválido; **nota rejeitada pelo fisco** (`details.code`, `details.reason`) | destacar o motivo; oferecer corrigir e reemitir |
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
  "createdAt": "...", "updatedAt": "..."
}
```
O certificado em si **nunca** volta na API. A UI só mostra `hasCertificate` e a validade (alertar quando faltar < 30 dias).

### 4.2 Notas (invoices)

**`POST /invoices`** — emite uma NFS-e (síncrono: a resposta já traz o resultado do fisco).

```json
{
  "tomadorDocumento": "12345678909",   // CPF (11) ou CNPJ (14) do cliente
  "tomadorNome": "Cliente Exemplo",    // 2–150
  "tomadorEmail": "cliente@x.com",     // opcional
  "descricao": "Consultoria em TI",    // 1–2000
  "valor": 150.00,                     // > 0, até 2 casas, máx 9.999.999.999,99
  "codigoTributacao": "01.01.01"       // código nacional de tributação (formato NN.NN.NN)
}
```
→ 201 `Invoice` com `status: "ISSUED"` · 422 rejeitada (`details.code`, `details.reason`; a nota fica salva como `REJECTED`) · 422 sem certificado · 502 fisco fora (nota fica `PENDING`) · 409 emissão concorrente (repetir).

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
  "tomadorDocumento": "12345678909", "tomadorNome": "Cliente Exemplo", "tomadorEmail": null,
  "descricao": "Consultoria em TI", "valor": "150.00", "codigoTributacao": "01.01.01",
  "chaveAcesso": "35503082...50 dígitos", "numeroNfse": "7",
  "rejectionReason": null,
  "cancelledAt": null, "cancelReason": null,
  "createdAt": "...", "updatedAt": "..."
}
```

### 4.3 Estados de uma nota

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

## 5. Fluxos de tela sugeridos

1. **Landing → Login/Cadastro** (Logto hospeda a tela; o front só redireciona).
2. **Onboarding** (primeiro acesso, `GET /companies/me` = 404): passo 1 dados da empresa (`POST /companies`); passo 2 certificado (`PUT .../certificate`, arrastar `.pfx` + senha). Pode pular o passo 2, mas a emissão fica bloqueada (mostrar aviso permanente "cadastre o certificado").
3. **Dashboard**: total emitido no mês, últimas notas, alerta de certificado (ausente / vence em X dias), atalho "Nova nota".
4. **Nova nota**: formulário dos 6 campos acima; ao enviar mostra loading ("enviando ao fisco…"), depois sucesso (número, chave, botões PDF/XML) ou o erro 422 com motivo.
5. **Lista de notas**: filtro por status, paginação, ações por linha.
6. **Detalhe da nota**: todos os campos + botões PDF/XML/cancelar (cancelar pede o motivo, mín. 15 caracteres).
7. **Empresa**: editar dados, trocar certificado.

## 6. Ambiente de desenvolvimento

- API: `bun run dev` → `http://localhost:3000/api/v0/health`.
- Logto: `http://localhost:3001` (OIDC), console `http://localhost:3002`.
- Gateway fiscal em modo **fake** (`NFSE_ENV=fake`): emite sem falar com o governo, mas monta e assina o XML de verdade. O PDF é um DANFSe simulado.
- Collection Postman com todos os requests: `docs/collections/matheo-nfse-api.postman_collection.json`.
- CORS ainda não está configurado na API — será liberado para a origem do front quando ele existir.

## 7. Próximas features já planejadas (deixar espaço na UI)

- **Trial de 30 dias** por empresa (`trialEndsAt`); emissão bloqueada com `402` após o prazo → tela de planos.
- **Tomadores salvos** (clientes recorrentes): CRUD + autocomplete no formulário de nota.
- **Serviços salvos** (descrição + código de tributação favoritos).
- Validação de dígito verificador de CPF/CNPJ no backend (hoje só formato).
- Múltiplas empresas por usuário / acesso de contador.
