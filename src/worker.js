// Ñande coming-soon worker v3.0.0
// Endpoints:
//   GET  /api/health
//   POST /api/subscribe
//   GET  /api/admin/count
//   GET  /admin                 (basic auth - dashboard)
//   GET  /api/admin/list        (basic auth - JSON)
//   GET  /api/admin/csv         (basic auth - download)
//   POST /api/admin/delete      (basic auth - body: {email})
// Assets estáticos via env.ASSETS (fallback).

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

// Parser de User-Agent. Detecta OS, browser, dispositivo, modelo.
function parseUserAgent(ua) {
  if (!ua) return { os: null, osVersion: null, browser: null, browserVersion: null, device: 'unknown', model: null, isBot: false };
  const lower = ua.toLowerCase();

  // Bot detection
  const botPatterns = [
    'bot', 'crawler', 'spider', 'curl', 'wget', 'python-requests', 'go-http-client',
    'headless', 'phantom', 'selenium', 'playwright', 'puppeteer', 'fetch',
    'facebookexternalhit', 'whatsapp', 'telegram', 'twitterbot', 'linkedinbot',
    'slackbot', 'discordbot', 'googlebot', 'bingbot', 'yandex', 'baiduspider',
    'duckduckbot', 'applebot', 'amazonbot', 'gptbot', 'claudebot', 'ahrefsbot',
    'semrushbot', 'mj12bot', 'dotbot', 'rogerbot', 'lighthouse'
  ];
  const isBot = botPatterns.some(p => lower.includes(p));

  // OS
  let os = null, osVersion = null;
  if (/windows nt 10\.0/i.test(ua) && /windows nt 10\.0; win64; x64/i.test(ua) && /\b(11)\b/.test(ua)) { os = 'Windows'; osVersion = '11'; }
  else if (/windows nt 10/i.test(ua)) { os = 'Windows'; osVersion = '10/11'; }
  else if (/windows nt 6\.3/i.test(ua)) { os = 'Windows'; osVersion = '8.1'; }
  else if (/windows nt 6\.2/i.test(ua)) { os = 'Windows'; osVersion = '8'; }
  else if (/windows nt 6\.1/i.test(ua)) { os = 'Windows'; osVersion = '7'; }
  else if (/windows/i.test(ua)) { os = 'Windows'; osVersion = '?'; }
  else if (/iphone os (\d+)[_.](\d+)/i.test(ua)) {
    const m = ua.match(/iphone os (\d+)[_.](\d+)/i);
    os = 'iOS'; osVersion = `${m[1]}.${m[2]}`;
  }
  else if (/ipad.*os (\d+)[_.](\d+)/i.test(ua)) {
    const m = ua.match(/os (\d+)[_.](\d+)/i);
    os = 'iPadOS'; osVersion = `${m[1]}.${m[2]}`;
  }
  else if (/mac os x (\d+)[_.](\d+)/i.test(ua)) {
    const m = ua.match(/mac os x (\d+)[_.](\d+)/i);
    os = 'macOS'; osVersion = `${m[1]}.${m[2]}`;
  }
  else if (/android (\d+(?:\.\d+)?)/i.test(ua)) {
    const m = ua.match(/android (\d+(?:\.\d+)?)/i);
    os = 'Android'; osVersion = m[1];
  }
  else if (/linux/i.test(ua)) { os = 'Linux'; osVersion = null; }
  else if (/cros/i.test(ua)) { os = 'ChromeOS'; osVersion = null; }

  // Browser (ordem importa: Edge antes de Chrome, Brave antes de Chrome, etc)
  let browser = null, browserVersion = null;
  if (/edg\/(\d+)/i.test(ua)) {
    browser = 'Edge'; browserVersion = ua.match(/edg\/(\d+)/i)[1];
  } else if (/opr\/(\d+)/i.test(ua) || /opera\/(\d+)/i.test(ua)) {
    browser = 'Opera';
    const m = ua.match(/(?:opr|opera)\/(\d+)/i); browserVersion = m ? m[1] : null;
  } else if (/firefox\/(\d+)/i.test(ua)) {
    browser = 'Firefox'; browserVersion = ua.match(/firefox\/(\d+)/i)[1];
  } else if (/crios\/(\d+)/i.test(ua)) {
    browser = 'Chrome iOS'; browserVersion = ua.match(/crios\/(\d+)/i)[1];
  } else if (/fxios\/(\d+)/i.test(ua)) {
    browser = 'Firefox iOS'; browserVersion = ua.match(/fxios\/(\d+)/i)[1];
  } else if (/chrome\/(\d+)/i.test(ua)) {
    browser = 'Chrome'; browserVersion = ua.match(/chrome\/(\d+)/i)[1];
  } else if (/safari\/(\d+)/i.test(ua) && /version\/(\d+(?:\.\d+)?)/i.test(ua)) {
    browser = 'Safari'; browserVersion = ua.match(/version\/(\d+(?:\.\d+)?)/i)[1];
  } else if (/safari/i.test(ua)) {
    browser = 'Safari'; browserVersion = '?';
  }

  // Device + modelo
  let device = 'desktop', model = null;
  if (/ipad/i.test(ua)) {
    device = 'tablet'; model = 'iPad';
  } else if (/iphone/i.test(ua)) {
    device = 'mobile'; model = 'iPhone';
  } else if (/android/i.test(ua) && /mobile/i.test(ua)) {
    device = 'mobile';
    // Tentar extrair modelo: ex "SM-G998B", "Pixel 8", "Mi 11"
    const mm = ua.match(/;\s*([A-Z][\w\-+ ]+?)\s*(?:Build\/|\))/);
    if (mm) model = mm[1].trim();
  } else if (/android/i.test(ua)) {
    device = 'tablet';
    const mm = ua.match(/;\s*([A-Z][\w\-+ ]+?)\s*(?:Build\/|\))/);
    if (mm) model = mm[1].trim();
  } else if (/mobile|opera mini|opera mobi/i.test(ua)) {
    device = 'mobile';
  }

  return { os, osVersion, browser, browserVersion, device, model, isBot };
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
  try { body = await request.json(); } catch {
    return json({ ok: false, message: 'Solicitud inválida' }, { status: 400 });
  }

  // Honeypot
  if (body.website && body.website.trim() !== '') {
    return json({ ok: true, message: 'Listo. Te avisamos.' });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!EMAIL_RX.test(email) || email.length > 254) {
    return json({ ok: false, message: 'Revisá el correo, por favor.' }, { status: 400 });
  }

  const allowed = await rateLimit(env, ip);
  if (!allowed) {
    return json({ ok: false, message: 'Demasiadas solicitudes. Intentá en una hora.' }, { status: 429 });
  }

  const key = `email:${email}`;
  const existing = await env.SUBSCRIBERS.get(key);
  if (existing) {
    return json({ ok: true, message: 'Ya estabas en la lista.' });
  }

  // Captura completa
  const ua = request.headers.get('User-Agent') || '';
  const uaParsed = parseUserAgent(ua);
  const cf = request.cf || {};
  const acceptLang = request.headers.get('Accept-Language') || null;
  const primaryLang = acceptLang ? acceptLang.split(',')[0].trim().split(';')[0].trim() : null;

  // Hora local do user (via timezone do CF)
  let localTime = null;
  if (cf.timezone) {
    try {
      localTime = new Date().toLocaleString('sv-SE', { timeZone: cf.timezone });
    } catch { localTime = null; }
  }

  const record = {
    // Core
    email,
    source: (body.source || 'unknown').toString().slice(0, 32),
    timestamp: new Date().toISOString(),
    localTime,

    // Network
    ip,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
    httpProtocol: cf.httpProtocol || null,
    tlsVersion: cf.tlsVersion || null,

    // Geo
    country: cf.country || null,
    countryName: cf.country || null, // CF não dá nome completo, só código
    region: cf.region || null,
    regionCode: cf.regionCode || null,
    city: cf.city || null,
    postalCode: cf.postalCode || null,
    continent: cf.continent || null,
    latitude: cf.latitude || null,
    longitude: cf.longitude || null,
    timezone: cf.timezone || null,
    metroCode: cf.metroCode || null,

    // Device + Browser
    userAgent: ua.slice(0, 500),
    os: uaParsed.os,
    osVersion: uaParsed.osVersion,
    browser: uaParsed.browser,
    browserVersion: uaParsed.browserVersion,
    device: uaParsed.device,
    model: uaParsed.model,
    isBot: uaParsed.isBot,

    // Locale
    acceptLanguage: acceptLang,
    primaryLanguage: primaryLang,

    // Origem
    referer: (request.headers.get('Referer') || '').slice(0, 300),
    origin: request.headers.get('Origin') || null
  };

  await env.SUBSCRIBERS.put(key, JSON.stringify(record));

  // Invalidar cache de count
  await env.SUBSCRIBERS.delete('_meta:count');

  return json({ ok: true, message: 'Listo. Te avisamos.' });
}

async function handleCount(env) {
  const cached = await env.SUBSCRIBERS.get('_meta:count');
  if (cached) {
    const { count, ts } = JSON.parse(cached);
    if (Date.now() - ts < 60_000) return json({ ok: true, count });
  }
  let total = 0;
  let cursor;
  do {
    const list = await env.SUBSCRIBERS.list({ prefix: 'email:', cursor, limit: 1000 });
    total += list.keys.length;
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  await env.SUBSCRIBERS.put('_meta:count', JSON.stringify({ count: total, ts: Date.now() }), { expirationTtl: 86400 });
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
  } catch { return false; }
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

async function listAllSubscribers(env) {
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
  return list;
}

async function handleAdminList(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();
  const list = await listAllSubscribers(env);
  return json({ ok: true, total: list.length, subscribers: list });
}

async function handleAdminCSV(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();
  const list = await listAllSubscribers(env);

  const cols = [
    'email','source','timestamp','localTime',
    'ip','asn','asOrganization','httpProtocol','tlsVersion',
    'country','region','city','postalCode','continent','latitude','longitude','timezone',
    'os','osVersion','browser','browserVersion','device','model','isBot',
    'acceptLanguage','primaryLanguage','referer','origin','userAgent'
  ];
  const safe = (s) => `"${(s == null ? '' : String(s)).replace(/"/g, '""').replace(/[\r\n]/g, ' ')}"`;
  const rows = [cols.join(',')];
  for (const r of list) {
    rows.push(cols.map(c => safe(r[c])).join(','));
  }

  return new Response(rows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nande-subscribers-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}

async function handleAdminDelete(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'Use POST' }, { status: 405 });
  }
  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return json({ ok: false, message: 'Email requerido' }, { status: 400 });

  // Suporte a wildcard: deletar todos os com sufixo
  if (email.startsWith('*@')) {
    const suffix = email.slice(1); // "@nande-test.local"
    const list = await listAllSubscribers(env);
    let deleted = 0;
    for (const r of list) {
      if (r.email.endsWith(suffix)) {
        await env.SUBSCRIBERS.delete(`email:${r.email}`);
        deleted++;
      }
    }
    await env.SUBSCRIBERS.delete('_meta:count');
    return json({ ok: true, deleted, pattern: email });
  }

  const key = `email:${email}`;
  const existing = await env.SUBSCRIBERS.get(key);
  if (!existing) return json({ ok: false, message: 'No existe' }, { status: 404 });
  await env.SUBSCRIBERS.delete(key);
  await env.SUBSCRIBERS.delete('_meta:count');
  return json({ ok: true, deleted: email });
}

async function handleAdminPanel(request, env) {
  if (!basicAuthCheck(request, env)) return authChallenge();

  const list = await listAllSubscribers(env);
  const total = list.length;
  const dayMs = 86_400_000;
  const now = Date.now();
  const last24h = list.filter(r => now - new Date(r.timestamp).getTime() < dayMs);

  const sourceCount = {};
  const countryCount = {};
  const deviceCount = {};
  const browserCount = {};
  const osCount = {};
  const langCount = {};
  for (const r of list) {
    sourceCount[r.source || 'unknown'] = (sourceCount[r.source || 'unknown'] || 0) + 1;
    countryCount[r.country || 'XX'] = (countryCount[r.country || 'XX'] || 0) + 1;
    deviceCount[r.device || 'unknown'] = (deviceCount[r.device || 'unknown'] || 0) + 1;
    browserCount[r.browser || 'unknown'] = (browserCount[r.browser || 'unknown'] || 0) + 1;
    osCount[r.os || 'unknown'] = (osCount[r.os || 'unknown'] || 0) + 1;
    langCount[r.primaryLanguage || 'unknown'] = (langCount[r.primaryLanguage || 'unknown'] || 0) + 1;
  }

  const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><title>Ñande · Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#050D1F;--card:#0A1A33;--off:#E8ECF4;--mute:#8895AE;--accent:#C026FF;--violet:#6B1FD9;--line:rgba(255,255,255,.08);--ok:#4ADE80;--err:#F87171}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--off);font-family:-apple-system,system-ui,sans-serif;padding:32px;line-height:1.5}
  h1{font-size:32px;margin-bottom:8px;background:linear-gradient(135deg,#E879F9,#6B1FD9);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--mute);font-size:14px;margin-bottom:32px}
  h2{font-size:18px;margin:24px 0 12px;color:#fff}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:32px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  .stat .label{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
  .stat .value{font-size:32px;font-weight:700;color:#fff}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .btn{display:inline-block;padding:10px 18px;background:linear-gradient(135deg,var(--accent),var(--violet));color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:13px;border:none;cursor:pointer;font-family:inherit}
  .btn-sec{background:var(--card);border:1px solid var(--line)}
  .btn-danger{background:linear-gradient(135deg,#F87171,#DC2626)}
  table{width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;border-collapse:collapse;overflow:hidden;font-size:12px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}
  th{background:rgba(255,255,255,.03);color:var(--mute);text-transform:uppercase;letter-spacing:.06em;font-size:10px;position:sticky;top:0}
  tr:last-child td{border-bottom:none}
  tr:hover{background:rgba(255,255,255,.02)}
  .grids{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:24px}
  .small-list{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .small-list h3{font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px}
  .small-list .row-item{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid var(--line)}
  .small-list .row-item:last-child{border-bottom:none}
  .small-list .k{color:var(--off)}
  .small-list .v{color:var(--mute);font-family:ui-monospace,monospace}
  .scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .badge-bot{background:rgba(248,113,113,.15);color:#F87171}
  .badge-ok{background:rgba(74,222,128,.15);color:#4ADE80}
  .delete-btn{background:transparent;border:1px solid rgba(248,113,113,.3);color:#F87171;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit}
  .delete-btn:hover{background:rgba(248,113,113,.1)}
  .filter{margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .filter input{background:var(--card);border:1px solid var(--line);color:#fff;padding:8px 12px;border-radius:8px;font-family:inherit;font-size:13px;min-width:240px}
  .filter input:focus{outline:none;border-color:var(--accent)}
  .empty{padding:24px;text-align:center;color:var(--mute);font-size:13px}
</style></head><body>
<h1>Ñande · Admin</h1>
<div class="sub">Panel de suscriptores · ${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</div>

<div class="stats">
  <div class="stat"><div class="label">Total</div><div class="value">${total}</div></div>
  <div class="stat"><div class="label">Últimas 24h</div><div class="value">${last24h.length}</div></div>
  <div class="stat"><div class="label">Países</div><div class="value">${Object.keys(countryCount).length}</div></div>
  <div class="stat"><div class="label">Idiomas</div><div class="value">${Object.keys(langCount).length}</div></div>
</div>

<div class="row">
  <a href="/api/admin/csv" class="btn">⬇ Exportar CSV</a>
  <a href="/api/admin/list" class="btn btn-sec">Ver JSON</a>
  <a href="/admin" class="btn btn-sec">Refrescar</a>
  <button class="btn btn-danger" onclick="bulkDelete()">🗑 Limpiar tests</button>
</div>

<div class="grids">
  <div class="small-list">
    <h3>Por fuente</h3>
    ${sortDesc(sourceCount).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
  <div class="small-list">
    <h3>Por país</h3>
    ${sortDesc(countryCount).slice(0,8).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
  <div class="small-list">
    <h3>Por dispositivo</h3>
    ${sortDesc(deviceCount).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
  <div class="small-list">
    <h3>Por SO</h3>
    ${sortDesc(osCount).slice(0,8).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
  <div class="small-list">
    <h3>Por browser</h3>
    ${sortDesc(browserCount).slice(0,8).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
  <div class="small-list">
    <h3>Por idioma</h3>
    ${sortDesc(langCount).slice(0,8).map(([k,v])=>`<div class="row-item"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}
  </div>
</div>

<h2>Suscriptores (${total})</h2>
<div class="filter">
  <input type="text" id="filter" placeholder="Filtrar por email, país, ciudad…" oninput="filterTable()">
  <span class="v" style="color:var(--mute);font-size:12px" id="filter-count"></span>
</div>

${list.length ? `
<div class="scroll-x">
<table id="subs-table">
<thead><tr>
  <th>Email</th>
  <th>Cuándo</th>
  <th>País / Ciudad</th>
  <th>ISP (ASN)</th>
  <th>Dispositivo</th>
  <th>Browser</th>
  <th>SO</th>
  <th>Idioma</th>
  <th>IP</th>
  <th>Bot</th>
  <th>Fuente</th>
  <th></th>
</tr></thead>
<tbody>
${list.map(r => {
  const when = new Date(r.timestamp).toLocaleString('es-PY', { timeZone: 'America/Asuncion', dateStyle: 'short', timeStyle: 'short' });
  const geo = [r.country, r.city].filter(Boolean).join(' / ') || '—';
  const isp = r.asOrganization ? `${escapeHtml(r.asOrganization)} (${r.asn || '?'})` : '—';
  const dev = [r.device, r.model].filter(Boolean).join(' · ') || '—';
  const br = [r.browser, r.browserVersion].filter(Boolean).join(' ') || '—';
  const os = [r.os, r.osVersion].filter(Boolean).join(' ') || '—';
  return `<tr>
    <td title="${escapeHtml(r.email)}">${escapeHtml(r.email)}</td>
    <td>${escapeHtml(when)}</td>
    <td>${escapeHtml(geo)}</td>
    <td title="${escapeHtml(r.asOrganization || '')}">${isp}</td>
    <td>${escapeHtml(dev)}</td>
    <td>${escapeHtml(br)}</td>
    <td>${escapeHtml(os)}</td>
    <td>${escapeHtml(r.primaryLanguage || '—')}</td>
    <td>${escapeHtml(r.ip || '—')}</td>
    <td>${r.isBot ? '<span class="badge badge-bot">bot</span>' : '<span class="badge badge-ok">ok</span>'}</td>
    <td>${escapeHtml(r.source || '—')}</td>
    <td><button class="delete-btn" onclick="delOne('${escapeHtml(r.email)}')">×</button></td>
  </tr>`;
}).join('')}
</tbody>
</table>
</div>` : '<div class="empty" style="background:var(--card);border:1px solid var(--line);border-radius:12px">Sin suscriptores aún</div>'}

<script>
function filterTable() {
  const q = document.getElementById('filter').value.toLowerCase();
  const rows = document.querySelectorAll('#subs-table tbody tr');
  let visible = 0;
  rows.forEach(r => {
    const match = r.textContent.toLowerCase().includes(q);
    r.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  document.getElementById('filter-count').textContent = q ? visible + ' de ' + rows.length : '';
}

async function delOne(email) {
  if (!confirm('Borrar ' + email + '?')) return;
  const res = await fetch('/api/admin/delete', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email })
  });
  if (res.ok) location.reload();
  else alert('Error: ' + (await res.text()));
}

async function bulkDelete() {
  const pattern = prompt('Borrar emails con sufijo (ej: *@nande-test.local, *@nande-diagnostico.local):');
  if (!pattern) return;
  if (!pattern.startsWith('*@')) {
    alert('Patrón debe empezar con *@');
    return;
  }
  if (!confirm('Borrar TODOS los emails con sufijo "' + pattern + '"? Esta acción no se puede deshacer.')) return;
  const res = await fetch('/api/admin/delete', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email: pattern })
  });
  const data = await res.json();
  if (data.ok) {
    alert('Borrados: ' + data.deleted);
    location.reload();
  } else {
    alert('Error: ' + (data.message || 'desconocido'));
  }
}
</script>

</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health')        return json({ ok: true, version: '3.0.0', ts: Date.now() });
    if (path === '/api/subscribe')     return handleSubscribe(request, env);
    if (path === '/api/admin/count')   return handleCount(env);
    if (path === '/api/admin/list')    return handleAdminList(request, env);
    if (path === '/api/admin/csv')     return handleAdminCSV(request, env);
    if (path === '/api/admin/delete')  return handleAdminDelete(request, env);
    if (path === '/admin' || path === '/admin/') return handleAdminPanel(request, env);

    return env.ASSETS.fetch(request);
  }
};
