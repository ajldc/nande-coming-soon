# Estrutura para deploy do Worker Ñande

## Como fazer upload no GitHub

### Passo 1 — Apagar arquivos antigos da raiz
No repo `ajldc/nande-coming-soon` (branch main), DELETAR:
- `index.html` (raiz)
- `_headers` (raiz)
- `robots.txt` (raiz)

(O `wrangler.toml` que está no repo também pode ser deletado, mas será sobrescrito pelo upload.)

### Passo 2 — Upload em massa
1. No GitHub, clique em "Add file" → "Upload files"
2. Arraste a pasta `nande-deploy` inteira (com subpastas `public/` e `src/`) para o uploader
3. OU arraste arquivo por arquivo, mas mantenha a estrutura:
   - `wrangler.toml` (raiz)
   - `src/worker.js`
   - `public/index.html`
   - `public/_headers`
   - `public/robots.txt`
4. Commit message sugerido: `feat: add worker with email capture endpoints`
5. Clique em "Commit changes"

### Passo 3 — O que vai acontecer
- O Cloudflare Worker faz auto-deploy via GitHub Action (~1-2 minutos)
- Os endpoints `/api/subscribe`, `/api/admin/count`, `/admin` ficam disponíveis
- O site continua funcionando porque os assets agora vivem em `/public`

### Passo 4 — Avise o Claude
Quando o upload terminar, me avise para eu:
1. Configurar os secrets `ADMIN_USER` e `ADMIN_PASS` no Cloudflare
2. Testar `/api/subscribe` e o painel `/admin`
3. Verificar contagem ao vivo no site
