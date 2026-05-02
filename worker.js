// Ñande coming-soon worker
// Endpoints: POST /api/subscribe, GET /api/admin/count, GET /admin (basic auth),
//            GET /api/admin/list, GET /api/admin/csv, GET /api/health
// Tudo o mais cai no assets binding (index.html, _headers, robots.txt).

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {})
    }
  });
}

function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function rateLimit(env, ip, max = 5, windowSeconds = 3600) {
  const key = `rl:${ip}`;
  const now = Date.now();
  const raw = await env.RATE_LIMIT.get(key);
  let entries = raw ? JSON.parse(raw) : [];
  entries = entries.filter(t => now - t < windowSeconds * 1000);
  if (entries.length >= max) return false;
  entries.push(now);
  await env.RATE_LIMIT.put(key, JSON.stringify(entries), { expirationTtl: windowSeconds + 60 });
  return true;
}

async function handleSubscribe(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'Método no permitido' }, { status: 405 });
  }

  const ip = getClientIP(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'Solicitud inválida' }, { status: 400 });
  }

  // Honeypot: se preencheu, é bot
  if (body.website && body.website.trim() !== '') {
    return json({ ok: true, message: 'Listo. Te avisamos.' });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!EMAIL_RX.test(email) || email.length > 254) {
    return json({ ok: false, message: 'Revisá el correo, por favor.' }, { status: 400 });
  }

  // Rate limit por IP (5 inscrições/h)
  const allowed = await rateLimit(env, ip);
  if (!allowed) {
    return json({ ok: false, message: 'Demasiadas solicitudes. Intentá en una hora.' }, { status: 429 });
  }

  // Já existe?
  const key = `email:${email}`;
  const existing = await env.SUBSCRIBERS.get(key);
  if (existing) {
    return json({ ok: true, message: 'Ya estabas en la lista.' });
  }

  const record = {
    email,
    source: (body.source || 'unknown').toString().slice(0, 32),
    ip,
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 200),
    referer: (request.headers.get('Referer') || '').slice(0, 200),
    country: request.cf?.country || null,
    timestamp: new Date().toISOString()
  };

  await env.SUBSCRIBERS.put(key, JSON.stringify(record));

  return json({ ok: true, message: 'Listo. Te avisamos.' });
}

async function handleCount(env) {
  // KV list é caro — usamos um contador agregado
  const cached = await env.SUBSCRIBERS.get('_meta:count');
  if (cached) {
    const { count, ts } = JSON.parse(cached);
    if (Date.now() - ts < 60_000) {
      return json({ ok: true, count });
    }
  }
  // Recalcular
  let total = 0;
  let cursor;
  do {
    const list = await env.SUBSCRIBERS.list({ prefix: 'email:', cursor, limit: 1000 });
    total += list.keys.length;
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  await env.SUBSCRIBERS.put('_meta:count', JSON.stringify({ count: total, ts: Date.now() }), {
    expirationTtl: 86400
  });
  return json({ ok: true, count: total });
}

function basicAuthCheck(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return user === env.ADMIN_USER && pass === env.ADMIN_PASS;
  } catch {
    return false;
  }
}

function authChallenge() {
  return new Response('Auth requerida', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="nande-admin"',
      'Content-Type': 'text/plain'
    }
  });
}

async function handleAdminList(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();
  const list = [];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'email:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.SUBSCRIBERS.get(k.name);
      if (v) list.push(JSON.parse(v));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  list.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return json({ ok: true, total: list.length, subscribers: list });
}

async function handleAdminCSV(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();
  const rows = ['email,source,country,timestamp,referer'];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'email:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.SUBSCRIBERS.get(k.name);
      if (v) {
        const r = JSON.parse(v);
        const safe = (s) => `"${(s || '').replace(/"/g, '""')}"`;
        rows.push([r.email, r.source, r.country || '', r.timestamp, r.referer || ''].map(safe).join(','));
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return new Response(rows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nande-subscribers-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}

async function handleAdminPanel(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();

  // Coletar stats
  let total = 0;
  const last24h = [];
  const sourceCount = {};
  const countryCount = {};
  const dayMs = 86_400_000;
  const now = Date.now();

  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'email:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.SUBSCRIBERS.get(k.name);
      if (!v) continue;
      total++;
      const r = JSON.parse(v);
      sourceCount[r.source] = (sourceCount[r.source] || 0) + 1;
      countryCount[r.country || 'XX'] = (countryCount[r.country || 'XX'] || 0) + 1;
      if (now - new Date(r.timestamp).getTime() < dayMs) last24h.push(r);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  last24h.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><title>Ñande · Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#050D1F;--card:#0A1A33;--off:#E8ECF4;--mute:#8895AE;--accent:#C026FF;--violet:#6B1FD9;--line:rgba(255,255,255,.08)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--off);font-family:-apple-system,system-ui,sans-serif;padding:32px;line-height:1.5}
  h1{font-size:32px;margin-bottom:8px;background:linear-gradient(135deg,#E879F9,#6B1FD9);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--mute);font-size:14px;margin-bottom:32px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
  .stat .label{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
  .stat .value{font-size:36px;font-weight:700;color:#fff}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .btn{display:inline-block;padding:10px 18px;background:linear-gradient(135deg,var(--accent),var(--violet));color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px}
  .btn-sec{background:var(--card);border:1px solid var(--line)}
  table{width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;border-collapse:collapse;overflow:hidden}
  th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
  th{background:rgba(255,255,255,.03);color:var(--mute);text-transform:uppercase;letter-spacing:.08em;font-size:11px}
  tr:last-child td{border-bottom:none}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  .small-list{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .small-list h3{font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
  .small-list .row-item{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
  .small-list .row-item .k{color:var(--off)}
  .small-list .row-item .v{color:var(--mute);font-family:ui-monospace,monospace}
</style></head><body>
<h1>Ñande · Admin</h1>
<div class="sub">Panel de suscriptores · ${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</div>

<div class="stats">
  <div class="stat"><div class="label">Total</div><div class="value">${total}</div></div>
  <div class="stat"><div class="label">Últimas 24h</div><div class="value">${last24h.length}</div></div>
  <div class="stat"><div class="label">Fuentes</div><div class="value">${Object.keys(sourceCount).length}</div></div>
  <div class="stat"><div class="label">Países</div><div class="value">${Object.keys(countryCount).length}</div></div>
</div>

<div class="row">
  <a href="/api/admin/csv" class="btn">⬇ Exportar CSV</a>
  <a href="/api/admin/list" class="btn btn-sec">Ver JSON</a>
  <a href="/admin" class="btn btn-sec">Refrescar</a>
</div>

<div class="grid">
  <div class="small-list">
    <h3>Por fuente</h3>
    ${Object.entries(sourceCount).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="row-item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') || '<div class="row-item"><span class="v">Sin datos</span></div>'}
  </div>
  <div class="small-list">
    <h3>Por país</h3>
    ${Object.entries(countryCount).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`<div class="row-item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') || '<div class="row-item"><span class="v">Sin datos</span></div>'}
  </div>
</div>

<h2 style="margin-bottom:12px;font-size:18px">Últimos suscriptores (24h)</h2>
${last24h.length ? `
<table>
<thead><tr><th>Email</th><th>Fuente</th><th>País</th><th>Cuándo</th></tr></thead>
<tbody>
${last24h.slice(0,50).map(r=>`<tr><td>${r.email}</td><td>${r.source}</td><td>${r.country||'—'}</td><td>${new Date(r.timestamp).toLocaleString('es-PY',{timeZone:'America/Asuncion'})}</td></tr>`).join('')}
</tbody>
</table>` : '<div class="small-list"><div class="row-item"><span class="v">Sin suscripciones en las últimas 24h</span></div></div>'}

</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ROTAS API
    if (path === '/api/health') {
      return json({ ok: true, version: '2.0.0', ts: Date.now() });
    }
    if (path === '/api/subscribe') {
      return handleSubscribe(request, env);
    }
    if (path === '/api/admin/count') {
      return handleCount(env);
    }
    if (path === '/api/admin/list') {
      return handleAdminList(request, env);
    }
    if (path === '/api/admin/csv') {
      return handleAdminCSV(request, env);
    }
    if (path === '/admin' || path === '/admin/') {
      return handleAdminPanel(request, env);
    }

    // FALLBACK: assets estáticos
    return env.ASSETS.fetch(request);
  }
};
