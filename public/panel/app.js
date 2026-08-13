/* Panel Manuel — SPA sin dependencias. Rutas por hash, datos desde /panel/api. */

const API = "api";
const view = document.getElementById("view");
const loginBox = document.getElementById("login");
const appBox = document.getElementById("app");

let currentUser = null;

/* ---------- utilidades ---------- */

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  if (res.status === 401) {
    currentUser = null;
    showLogin();
    throw new Error("no_autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Las fechas de SQLite vienen en UTC sin zona; hay que marcarlas para no restar 2 h. */
function parseDate(value) {
  if (!value) return null;
  const iso = String(value).includes("T") ? value : `${String(value).replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(value) {
  const d = parseDate(value);
  if (!d) return "—";
  return d.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function fmtRelative(value) {
  const d = parseDate(value);
  if (!d) return "—";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function fmtPhone(digits) {
  const d = String(digits ?? "").replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("34")) {
    const l = d.slice(2);
    return `+34 ${l.slice(0, 3)} ${l.slice(3, 5)} ${l.slice(5, 7)} ${l.slice(7)}`;
  }
  return d ? `+${d}` : "—";
}

function callSeconds(call) {
  const start = parseDate(call.started_at);
  const end = parseDate(call.ended_at);
  return start && end ? (end.getTime() - start.getTime()) / 1000 : null;
}

function render(html) {
  view.innerHTML = html;
}

function tableOrEmpty(rows, headHtml, bodyHtml, emptyMsg) {
  if (!rows.length) return `<div class="empty">${esc(emptyMsg)}</div>`;
  return `<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
}

/* ---------- sesión ---------- */

function showLogin() {
  appBox.classList.add("hidden");
  loginBox.classList.remove("hidden");
}

function showApp() {
  loginBox.classList.add("hidden");
  appBox.classList.remove("hidden");
  document.getElementById("who").textContent = `${currentUser.username} · ${
    currentUser.role === "admin" ? "administrador" : "solo lectura"
  }`;
  for (const el of document.querySelectorAll(".admin-only")) {
    el.classList.toggle("hidden", currentUser.role !== "admin");
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    const data = await api("/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("login-user").value,
        password: document.getElementById("login-pass").value,
      }),
    });
    currentUser = data.user;
    document.getElementById("login-pass").value = "";
    showApp();
    route();
  } catch (err) {
    errorEl.textContent =
      err.message === "credenciales_invalidas"
        ? "Usuario o contraseña incorrectos."
        : err.message === "demasiados_intentos"
          ? "Demasiados intentos fallidos. Espera 15 minutos."
          : "No se pudo iniciar sesión.";
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  showLogin();
});

/* ---------- pantallas ---------- */

async function viewResumen() {
  render('<div class="loading">Cargando resumen…</div>');
  const d = await api("/overview");
  const healthOk = d.health.state === "OK";
  const healthLabel =
    d.health.state === "OK"
      ? "Todos los servicios responden"
      : d.health.state === "FAIL"
        ? "Hay un servicio caído"
        : "Sin datos del chequeo automático";

  const statsRows = d.acciones
    .map(
      (s) => `<tr>
        <td>${esc(s.tool)}</td>
        <td class="num">${s.count}</td>
        <td class="num">${s.errors ? `<span class="pill bad">${s.errors}</span>` : "0"}</td>
        <td class="num">${fmtMs(s.p50)}</td>
        <td class="num">${fmtMs(s.p95)}</td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head"><div><h2>Resumen</h2>
      <p class="muted">Estado de Manuel en las últimas horas.</p></div></div>

    <div class="banner ${healthOk ? "ok" : "bad"}">
      <span class="pill ${healthOk ? "ok" : "bad"}">${esc(d.health.state)}</span>
      <div>${esc(healthLabel)}<br />
        <small class="muted">Último chequeo: ${fmtRelative(d.health.checkedAt)}</small>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="label">Llamadas 24 h</div><div class="value">${d.voice.last24h}</div>
        <div class="hint">${d.voice.last7d} en 7 días</div></div>
      <div class="card"><div class="label">Duración media</div><div class="value">${fmtDuration(d.voice.duracionMediaSeg)}</div>
        <div class="hint">últimos 7 días</div></div>
      <div class="card"><div class="label">Llamadas mudas</div>
        <div class="value" style="color:${d.voice.mudas7d ? "var(--danger)" : "inherit"}">${d.voice.mudas7d}</div>
        <div class="hint">sin respuesta de la IA (7 d)</div></div>
      <div class="card"><div class="label">Mensajes WhatsApp 24 h</div><div class="value">${d.whatsapp.mensajes24h}</div>
        <div class="hint">${d.whatsapp.chats7d} chats en 7 días</div></div>
      <div class="card"><div class="label">Leads 7 días</div><div class="value">${d.leads.last7d}</div></div>
      <div class="card"><div class="label">Contactos silenciados</div><div class="value">${d.whatsapp.silenciados}</div>
        <div class="hint">anti-bucle activo</div></div>
      <div class="card"><div class="label">Llamadas con audio</div><div class="value">${d.voice.conAudio}</div>
        <div class="hint">grabaciones guardadas</div></div>
    </div>

    <h3>Tiempo de respuesta de las herramientas (24 h)</h3>
    <p class="muted">Si el p95 sube, la IA se queda callada esperando y suena artificial.</p>
    ${tableOrEmpty(
      d.acciones,
      "<tr><th>Herramienta</th><th class='num'>Usos</th><th class='num'>Errores</th><th class='num'>Mediana</th><th class='num'>p95</th></tr>",
      statsRows,
      "Todavía no hay acciones registradas.",
    )}
  `);
}

async function viewLlamadas() {
  render('<div class="loading">Cargando llamadas…</div>');
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const q = params.get("q") || "";
  const d = await api(`/calls?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);

  const rows = d.calls
    .map((c) => {
      const muda = c.assistant_turns === 0;
      return `<tr>
        <td><a href="#/llamadas/${esc(c.id)}">${fmtDateTime(c.started_at)}</a><br />
          <small class="muted">${fmtRelative(c.started_at)}</small></td>
        <td>${fmtPhone(c.caller)}</td>
        <td>${fmtDuration(callSeconds(c))}</td>
        <td>${c.intent ? `<span class="pill">${esc(c.intent)}</span>` : "—"}</td>
        <td>${muda ? '<span class="pill bad">muda</span>' : `${c.turns} turnos`}</td>
        <td class="num">${c.actions}</td>
        <td>${c.audio_path ? "🎧" : "—"}</td>
      </tr>`;
    })
    .join("");

  render(`
    <div class="page-head"><div><h2>Llamadas de voz</h2>
      <p class="muted">${d.total} llamadas registradas en el 951.</p></div></div>
    <div class="toolbar">
      <input id="buscar" placeholder="Buscar por teléfono, intención o resumen" value="${esc(q)}" />
      <button id="buscar-btn" class="primary">Buscar</button>
    </div>
    ${tableOrEmpty(
      d.calls,
      "<tr><th>Fecha</th><th>Teléfono</th><th>Duración</th><th>Intención</th><th>Conversación</th><th class='num'>Acciones</th><th>Audio</th></tr>",
      rows,
      "No hay llamadas registradas.",
    )}
  `);

  const go = () => {
    const value = document.getElementById("buscar").value.trim();
    location.hash = value ? `#/llamadas?q=${encodeURIComponent(value)}` : "#/llamadas";
    route();
  };
  document.getElementById("buscar-btn").addEventListener("click", go);
  document.getElementById("buscar").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

async function viewLlamada(id) {
  render('<div class="loading">Cargando llamada…</div>');
  const d = await api(`/calls/${encodeURIComponent(id)}`);
  const c = d.call;

  let previous = null;
  const turns = d.turns
    .map((t) => {
      const ts = parseDate(t.ts);
      const gap = previous && ts ? (ts.getTime() - previous.getTime()) / 1000 : null;
      previous = ts ?? previous;
      const slow = gap != null && gap >= 4 && t.role === "assistant";
      return `<div class="turn ${esc(t.role)}">
        <div class="meta">
          <span>${t.role === "assistant" ? "IA" : t.role === "user" ? "Cliente" : "Sistema"}</span>
          <span>${ts ? ts.toLocaleTimeString("es-ES") : ""}</span>
          ${gap != null ? `<span class="${slow ? "gap" : ""}">+${gap.toFixed(0)} s${slow ? " ⚠ silencio" : ""}</span>` : ""}
        </div>
        <div>${esc(t.text)}</div>
      </div>`;
    })
    .join("");

  const actions = d.actions
    .map(
      (a) => `<tr>
        <td>${esc(a.tool)}</td>
        <td>${a.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">${esc(a.error || "error")}</span>`}</td>
        <td class="num">${fmtMs(a.duration_ms)}</td>
        <td><pre class="json">${esc(a.input_json || "")}\n${esc(a.output_json || "")}</pre></td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head">
      <div><h2>Llamada de ${fmtPhone(c.caller)}</h2>
        <p class="muted">${fmtDateTime(c.started_at)} · ${fmtDuration(callSeconds(c))}</p></div>
      <a href="#/llamadas">← Volver</a>
    </div>

    <div class="detail-grid">
      <div>
        ${
          d.audioDisponible
            ? `<div class="panel"><strong>Grabación</strong>
                 <audio controls preload="none" src="${API}/calls/${encodeURIComponent(c.id)}/audio"></audio>
               </div>`
            : `<div class="panel muted">Sin grabación de audio para esta llamada.</div>`
        }
        <h3>Transcripción</h3>
        ${d.turns.length ? `<div class="turns">${turns}</div>` : '<div class="empty">Esta llamada no tiene transcripción: la IA no llegó a hablar.</div>'}
      </div>

      <div>
        <div class="panel">
          <strong>Datos</strong>
          <dl class="kv">
            <dt>Intención</dt><dd>${esc(c.intent || "—")}</dd>
            <dt>Idioma</dt><dd>${esc(c.language || "—")}</dd>
            <dt>DID</dt><dd>${fmtPhone(c.called_did)}</dd>
            <dt>Fin</dt><dd>${fmtDateTime(c.ended_at)}</dd>
            <dt>ID</dt><dd><small>${esc(c.id)}</small></dd>
          </dl>
        </div>
        <div class="panel" style="margin-top:14px">
          <strong>Resumen de la IA</strong>
          <p class="muted">${esc(c.summary || "Sin resumen.")}</p>
        </div>
        <div style="margin-top:14px">
          ${renderDesenlaceBlock(d.desenlace)}
        </div>
      </div>
    </div>

    <h3>Acciones ejecutadas</h3>
    ${tableOrEmpty(
      d.actions,
      "<tr><th>Herramienta</th><th>Resultado</th><th class='num'>Tiempo</th><th>Detalle</th></tr>",
      actions,
      "La IA no ejecutó ninguna herramienta en esta llamada.",
    )}
  `);
}

async function viewWhatsapp() {
  render('<div class="loading">Cargando conversaciones…</div>');
  const d = await api("/whatsapp/chats?limit=100");
  const rows = d.chats
    .map(
      (c) => `<tr>
        <td><a href="#/whatsapp/${esc(c.phone_number)}">${fmtPhone(c.phone_number)}</a>
          ${c.nombre ? `<br /><small class="muted">${esc(c.nombre)}</small>` : ""}</td>
        <td>${esc(String(c.ultimo_texto || "").slice(0, 90))}
          <br /><small class="muted">${c.ultimo_rol === "assistant" ? "IA" : "Cliente"} · ${fmtRelative(c.ultimo)}</small></td>
        <td class="num">${c.mensajes}</td>
        <td>${c.silenciado ? '<span class="pill warn">silenciado</span>' : '<span class="pill ok">activo</span>'}</td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head"><div><h2>WhatsApp</h2>
      <p class="muted">Conversaciones del 614, tal y como las recibe la IA.</p></div></div>
    ${tableOrEmpty(
      d.chats,
      "<tr><th>Contacto</th><th>Último mensaje</th><th class='num'>Mensajes</th><th>Estado</th></tr>",
      rows,
      "Todavía no hay conversaciones.",
    )}
  `);
}

async function viewChat(phone) {
  render('<div class="loading">Cargando conversación…</div>');
  const d = await api(`/whatsapp/chats/${encodeURIComponent(phone)}`);
  const msgs = d.messages
    .map(
      (m) => `<div class="turn ${m.role === "assistant" ? "assistant" : "user"}">
        <div class="meta"><span>${m.role === "assistant" ? "IA" : "Cliente"}</span>
          <span>${fmtDateTime(m.timestamp)}</span></div>
        <div>${esc(m.content)}</div>
      </div>`,
    )
    .join("");

  const p = d.profile;
  render(`
    <div class="page-head">
      <div><h2>${fmtPhone(d.phone)}</h2>
        <p class="muted">${d.messages.length} mensajes guardados.</p></div>
      <a href="#/whatsapp">← Volver</a>
    </div>

    ${
      d.muted
        ? `<div class="banner bad"><span class="pill warn">silenciado</span>
             <div>El anti-bucle silenció este contacto (${esc(d.muted.reason || "sin motivo")}).<br />
             <small class="muted">Hasta ${fmtDateTime(d.muted.muted_until)}</small></div></div>`
        : ""
    }

    <div class="detail-grid">
      <div class="turns">${msgs || '<div class="empty">Sin mensajes.</div>'}</div>
      <div class="panel">
        <strong>Ficha del contacto</strong>
        <dl class="kv">
          <dt>Nombre</dt><dd>${esc(p?.name || "—")}</dd>
          <dt>Email</dt><dd>${esc(p?.email || "—")}</dd>
          <dt>Interés</dt><dd>${esc(p?.intent_type || "—")}</dd>
          <dt>Referencia</dt><dd>${esc(p?.ref || "—")}</dd>
          <dt>Presupuesto</dt><dd>${p?.budget ? `${p.budget} €` : "—"}</dd>
          <dt>Ingresos</dt><dd>${p?.monthly_income ? `${p.monthly_income} €/mes` : "—"}</dd>
        </dl>
      </div>
    </div>
  `);
}

async function viewAcciones() {
  render('<div class="loading">Cargando acciones…</div>');
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const soloErrores = params.get("errores") === "1";
  const d = await api(`/actions?limit=200${soloErrores ? "&errores=1" : ""}`);

  const rows = d.actions
    .map(
      (a) => `<tr>
        <td>${fmtDateTime(a.created_at)}<br /><small class="muted">${fmtRelative(a.created_at)}</small></td>
        <td>${esc(a.tool)}<br /><small class="muted">${esc(a.source)}</small></td>
        <td>${a.phone ? `<a href="#/whatsapp/${esc(a.phone)}">${fmtPhone(a.phone)}</a>` : "—"}</td>
        <td>${a.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">${esc(a.error || "error")}</span>`}</td>
        <td class="num">${fmtMs(a.duration_ms)}</td>
        <td><pre class="json">${esc(a.input_json || "")}\n${esc(a.output_json || "")}</pre></td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head"><div><h2>Acciones de la IA</h2>
      <p class="muted">Todo lo que Manuel ejecuta: búsquedas, derivaciones, envíos y silenciados.</p></div></div>
    <div class="toolbar">
      <button id="toggle-errores" class="${soloErrores ? "primary" : ""}">
        ${soloErrores ? "Viendo solo errores" : "Ver solo errores"}
      </button>
      <span class="muted">${d.total} acciones</span>
    </div>
    ${tableOrEmpty(
      d.actions,
      "<tr><th>Cuándo</th><th>Herramienta</th><th>Contacto</th><th>Resultado</th><th class='num'>Tiempo</th><th>Detalle</th></tr>",
      rows,
      soloErrores ? "No hay acciones fallidas. Buena señal." : "Todavía no hay acciones registradas.",
    )}
  `);

  document.getElementById("toggle-errores").addEventListener("click", () => {
    location.hash = soloErrores ? "#/acciones" : "#/acciones?errores=1";
    route();
  });
}

function phoneDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function channelPill(label, value, href) {
  const tone =
    value === 1 || value === true ? "ok" : value === 0 || value === false ? "bad" : "";
  const status =
    value === 1 || value === true ? "ok" : value === 0 || value === false ? "falló" : "—";
  const inner = `${esc(label)} ${status}`;
  if (href) {
    return `<a class="pill ${tone} pill-link" href="${esc(href)}">${inner}</a>`;
  }
  return `<span class="pill ${tone}">${inner}</span>`;
}

function desenlaceChannelPills(d) {
  const cliPhone = phoneDigits(d.customer_phone);
  const agPhone = phoneDigits(d.agent_phone);
  const cliWaHref = cliPhone.length >= 8 ? `#/whatsapp/${cliPhone}` : "";
  const agWaHref = agPhone.length >= 8 ? `#/whatsapp/${agPhone}` : "";
  const cliMailHref = d.customer_email
    ? `#/emails?q=${encodeURIComponent(d.customer_email)}`
    : "";
  const agMailHref = d.agent_email_to
    ? `#/emails?q=${encodeURIComponent(d.agent_email_to)}`
    : "#/emails";
  return `
    ${channelPill("Cli WA", d.client_wa, cliWaHref)}
    ${channelPill("Cli mail", d.client_email, cliMailHref)}
    ${channelPill("Ag WA", d.agent_wa, agWaHref)}
    ${channelPill("Ag mail", d.agent_email, agMailHref)}
  `;
}

function renderDesenlaceMessages(d) {
  const client = d.client_reply
    ? `<div class="msg-box"><strong>Al cliente</strong><pre class="msg-body">${esc(d.client_reply)}</pre></div>`
    : "";
  const agent = d.agent_message
    ? `<div class="msg-box"><strong>Al comercial (${esc(d.agent_name)})</strong><pre class="msg-body">${esc(d.agent_message)}</pre></div>`
    : "";
  if (!client && !agent) return "";
  return `<div class="desenlace-msgs">${client}${agent}</div>`;
}

function renderDesenlaceBlock(d) {
  if (!d) {
    return `<div class="panel muted">Sin desenlace: no se derivó lead en esta interacción.</div>`;
  }
  const steps = (d.steps || [])
    .map(
      (s) => `<li class="desenlace-step ${s.ok === false ? "bad" : s.ok === true ? "ok" : ""}">
        <span class="n">${s.n}.</span> ${esc(s.text)}
      </li>`,
    )
    .join("");
  const callLink = d.call_id
    ? `<a href="#/llamadas/${esc(d.call_id)}">Ver llamada</a>`
    : "";
  return `<div class="panel desenlace-panel">
    <strong>Desenlace</strong>
    ${d.parcial ? `<p class="muted">Lead antiguo: sin detalle canal a canal.</p>` : ""}
    <div class="pill-row">${desenlaceChannelPills(d)}</div>
    <ol class="desenlace-steps">${steps}</ol>
    ${renderDesenlaceMessages(d)}
    <p class="muted links-row">${callLink || ""}</p>
  </div>`;
}

async function viewDesenlace() {
  render('<div class="loading">Cargando desenlaces…</div>');
  const d = await api("/desenlaces?limit=200");
  const rows = (d.desenlaces || [])
    .map((x) => {
      const steps = (x.steps || [])
        .map((s) => `<div class="step-line">${s.n}. ${esc(s.text)}</div>`)
        .join("");
      const msgs = renderDesenlaceMessages(x);
      return `<tr>
        <td>${fmtDateTime(x.created_at)}
          ${x.parcial ? `<br /><span class="pill warn">parcial</span>` : ""}</td>
        <td>${esc(x.origin || "—")}</td>
        <td>${x.customer_phone ? `<a href="#/whatsapp/${esc(phoneDigits(x.customer_phone))}">${fmtPhone(x.customer_phone)}</a>` : "—"}
          ${x.customer_name ? `<br /><small class="muted">${esc(x.customer_name)}</small>` : ""}
          ${x.customer_email ? `<br /><small><a href="#/emails?q=${encodeURIComponent(x.customer_email)}">${esc(x.customer_email)}</a></small>` : ""}</td>
        <td>${esc(x.agent_name)}
          ${x.agent_phone ? `<br /><small><a href="#/whatsapp/${esc(phoneDigits(x.agent_phone))}">${fmtPhone(x.agent_phone)}</a></small>` : ""}
          ${x.ref ? `<br /><small class="muted">ref ${esc(x.ref)}</small>` : ""}</td>
        <td class="pill-cell">${desenlaceChannelPills(x)}</td>
        <td class="desenlace-cell">${steps || "—"}
          ${msgs}
          ${x.call_id ? `<div><a href="#/llamadas/${esc(x.call_id)}">Llamada</a></div>` : ""}</td>
      </tr>`;
    })
    .join("");

  render(`
    <div class="page-head"><div><h2>Desenlace</h2>
      <p class="muted">Qué se envió al cliente y al comercial. Pincha en Cli WA / Ag WA / emails para abrir el hilo.</p></div></div>
    ${tableOrEmpty(
      d.desenlaces,
      "<tr><th>Fecha</th><th>Origen</th><th>Cliente</th><th>Comercial</th><th>Canales</th><th>Timeline</th></tr>",
      rows,
      "Todavía no hay desenlaces.",
    )}
  `);
}

async function viewEmails() {
  render('<div class="loading">Cargando emails…</div>');
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const q = params.get("q") || "";
  const d = await api(`/emails?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const rows = (d.emails || [])
    .map((e) => {
      const dir = e.dir === "outbound" ? '<span class="pill">salida</span>' : '<span class="pill ok">entrada</span>';
      const phone = phoneDigits(e.customer_phone);
      return `<tr>
        <td>${fmtDateTime(e.at)}<br />${dir}</td>
        <td>${esc(e.portal || "—")}</td>
        <td>${esc(e.customer_email || e.from_address || "—")}
          ${phone ? `<br /><a href="#/whatsapp/${esc(phone)}">${fmtPhone(phone)}</a>` : ""}</td>
        <td>${esc(String(e.subject_snippet || "").slice(0, 120))}</td>
        <td>${e.handled ? '<span class="pill ok">tratado</span>' : '<span class="pill warn">no</span>'}
          ${e.suppress_reason ? `<br /><small class="muted">${esc(e.suppress_reason)}</small>` : ""}</td>
        <td><small class="muted">${esc(String(e.body_snippet || "").slice(0, 140))}</small></td>
      </tr>`;
    })
    .join("");

  render(`
    <div class="page-head"><div><h2>Emails</h2>
      <p class="muted">Entrada (IMAP info@) y salida SMTP registradas.</p></div>
      <div class="toolbar">
        <input id="email-q" placeholder="Buscar email / teléfono / asunto" value="${esc(q)}" />
        <button id="email-buscar" class="primary">Buscar</button>
      </div>
    </div>
    ${tableOrEmpty(
      d.emails,
      "<tr><th>Fecha</th><th>Portal</th><th>Contacto</th><th>Asunto</th><th>Estado</th><th>Extracto</th></tr>",
      rows,
      "No hay emails en el registro.",
    )}
  `);

  const go = () => {
    const value = document.getElementById("email-q").value.trim();
    location.hash = value ? `#/emails?q=${encodeURIComponent(value)}` : "#/emails";
    route();
  };
  document.getElementById("email-buscar").addEventListener("click", go);
  document.getElementById("email-q").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") go();
  });
}

async function viewLeads() {
  render('<div class="loading">Cargando leads…</div>');
  const d = await api("/leads?limit=200");
  const rows = d.leads
    .map(
      (l) => `<tr>
        <td>${fmtDateTime(l.created_at)}</td>
        <td>${l.customer_phone ? `<a href="#/whatsapp/${esc(l.customer_phone)}">${fmtPhone(l.customer_phone)}</a>` : "—"}
          ${l.nombre ? `<br /><small class="muted">${esc(l.nombre)}</small>` : ""}</td>
        <td>${esc(l.agent_name)}</td>
        <td>${esc(l.intent || "—")}</td>
        <td>${esc(l.origin || "—")}</td>
        <td>${esc(l.ref || "—")}</td>
        <td><small>${esc(String(l.summary || "").slice(0, 160))}</small></td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head"><div><h2>Leads</h2>
      <p class="muted">Derivaciones a comerciales desde voz y WhatsApp.</p></div></div>
    ${tableOrEmpty(
      d.leads,
      "<tr><th>Fecha</th><th>Cliente</th><th>Comercial</th><th>Interés</th><th>Origen</th><th>Ref</th><th>Resumen</th></tr>",
      rows,
      "Todavía no hay leads.",
    )}
  `);
}

async function viewUsuarios() {
  if (currentUser.role !== "admin") {
    render('<div class="empty">Solo los administradores pueden gestionar usuarios.</div>');
    return;
  }
  render('<div class="loading">Cargando usuarios…</div>');
  const d = await api("/users");
  const rows = d.users
    .map(
      (u) => `<tr>
        <td>${esc(u.username)}</td>
        <td>${u.role === "admin" ? '<span class="pill">administrador</span>' : '<span class="pill">solo lectura</span>'}</td>
        <td>${u.disabled ? '<span class="pill bad">desactivado</span>' : '<span class="pill ok">activo</span>'}</td>
        <td>${u.last_login_at ? fmtRelative(u.last_login_at) : "nunca"}</td>
        <td>
          <button data-pass="${u.id}" class="link">Cambiar contraseña</button><br />
          <button data-toggle="${u.id}" data-disabled="${u.disabled}" class="link">${u.disabled ? "Activar" : "Desactivar"}</button><br />
          ${u.id !== currentUser.id ? `<button data-del="${u.id}" class="link">Eliminar</button>` : ""}
        </td>
      </tr>`,
    )
    .join("");

  render(`
    <div class="page-head"><div><h2>Usuarios</h2>
      <p class="muted">Quién puede entrar al panel.</p></div></div>

    <div class="row-form">
      <input id="nuevo-user" placeholder="Usuario nuevo" />
      <input id="nueva-pass" type="text" placeholder="Contraseña (mín. 8)" />
      <select id="nuevo-rol">
        <option value="viewer">Solo lectura</option>
        <option value="admin">Administrador</option>
      </select>
      <button id="crear" class="primary">Crear usuario</button>
    </div>
    <p class="error" id="user-error"></p>

    ${tableOrEmpty(
      d.users,
      "<tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr>",
      rows,
      "No hay usuarios.",
    )}
  `);

  const errorEl = document.getElementById("user-error");
  document.getElementById("crear").addEventListener("click", async () => {
    errorEl.textContent = "";
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("nuevo-user").value,
          password: document.getElementById("nueva-pass").value,
          role: document.getElementById("nuevo-rol").value,
        }),
      });
      viewUsuarios();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  });

  for (const btn of view.querySelectorAll("[data-pass]")) {
    btn.addEventListener("click", async () => {
      const pass = prompt("Nueva contraseña (mínimo 8 caracteres):");
      if (!pass) return;
      try {
        await api(`/users/${btn.dataset.pass}`, {
          method: "POST",
          body: JSON.stringify({ password: pass }),
        });
        viewUsuarios();
      } catch (e) {
        errorEl.textContent = e.message;
      }
    });
  }

  for (const btn of view.querySelectorAll("[data-toggle]")) {
    btn.addEventListener("click", async () => {
      await api(`/users/${btn.dataset.toggle}`, {
        method: "POST",
        body: JSON.stringify({ disabled: btn.dataset.disabled === "0" }),
      });
      viewUsuarios();
    });
  }

  for (const btn of view.querySelectorAll("[data-del]")) {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este usuario?")) return;
      await api(`/users/${btn.dataset.del}`, { method: "DELETE" });
      viewUsuarios();
    });
  }
}

/* ---------- router ---------- */

const routes = [
  [/^#?\/?$/, viewResumen],
  [/^#\/resumen/, viewResumen],
  [/^#\/llamadas\/([^?]+)/, viewLlamada],
  [/^#\/llamadas/, viewLlamadas],
  [/^#\/whatsapp\/([^?]+)/, viewChat],
  [/^#\/whatsapp/, viewWhatsapp],
  [/^#\/desenlace/, viewDesenlace],
  [/^#\/emails/, viewEmails],
  [/^#\/acciones/, viewAcciones],
  [/^#\/leads/, viewLeads],
  [/^#\/usuarios/, viewUsuarios],
];

function route() {
  if (!currentUser) return;
  const hash = location.hash || "#/resumen";
  const base = `#/${hash.split("/")[1]?.split("?")[0] || "resumen"}`;
  for (const a of document.querySelectorAll("#nav a")) {
    a.classList.toggle("active", a.getAttribute("href") === base);
  }
  for (const [pattern, handler] of routes) {
    const match = hash.match(pattern);
    if (match) {
      Promise.resolve(handler(match[1] ? decodeURIComponent(match[1]) : undefined)).catch((e) => {
        if (e.message !== "no_autenticado") {
          render(`<div class="empty">No se pudo cargar: ${esc(e.message)}</div>`);
        }
      });
      return;
    }
  }
  viewResumen();
}

window.addEventListener("hashchange", route);

(async function start() {
  try {
    const me = await api("/me");
    currentUser = me.user;
    showApp();
    route();
  } catch {
    showLogin();
  }
})();
