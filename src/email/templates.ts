function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parte líneas largas para evitar rebotes SMTP por límites de longitud.
 * Mantiene cortes preferibles cerca de '>' cuando es posible.
 */
export function breakLongLines(html: string, maxLen = 1000): string {
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const chunk = html.slice(pos, pos + maxLen);
    if (chunk.length < maxLen) {
      out += chunk;
      break;
    }
    const lastGt = chunk.lastIndexOf(">");
    if (lastGt !== -1 && lastGt > maxLen - 200) {
      out += chunk.slice(0, lastGt + 1) + "\r\n";
      pos += lastGt + 1;
    } else {
      out += chunk + "\r\n";
      pos += maxLen;
    }
  }
  return out;
}

/** CID del logo embebido en el correo (smtpSender adjunta el fichero). */
export const EMAIL_LOGO_CID = "logo@inmobiliariabazan.com";

/**
 * Cabecera ligera: logo pequeño + «Inmobiliaria Bazán».
 * Por defecto usa CID (adjunto inline); se puede pasar URL pública como fallback.
 */
export function emailBrandHeaderHtml(logoSrc = `cid:${EMAIL_LOGO_CID}`): string {
  return (
    `<div style="margin:0 0 18px;padding:0 0 14px;border-bottom:1px solid #ececec">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
    `<tr>` +
    `<td style="vertical-align:middle;padding:0 14px 0 0">` +
    `<img src="${escapeHtml(logoSrc)}" alt="Inmobiliaria Bazán" width="56" height="56" ` +
    `style="width:56px;height:56px;border:0;display:block;border-radius:8px" />` +
    `</td>` +
    `<td style="vertical-align:middle;padding:0">` +
    `<div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:600;` +
    `color:#1a1a1a;line-height:1.15">Inmobiliaria Bazán</div>` +
    `</td>` +
    `</tr>` +
    `</table>` +
    `</div>`
  );
}

/** @deprecated Usar emailBrandHeaderHtml */
export function emailHeaderImageHtml(url?: string): string {
  return emailBrandHeaderHtml(url ?? `cid:${EMAIL_LOGO_CID}`);
}

export function emailH(title: string): string {
  return `<h2 style="margin:0 0 14px;font-size:17px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:8px">${escapeHtml(
    title
  )}</h2>`;
}

export function emailP(html: string): string {
  return `<p style="margin:0 0 12px">${html}</p>`;
}

export function emailWrapHtml(contentHtml: string): string {
  const clausula =
    `<div style="max-width:580px;margin:0 auto;padding:20px 24px 16px;font-size:11px;line-height:1.4;color:#777;border-top:1px solid #eee">` +
    `<p style="margin:0 0 8px;font-weight:600;color:#555">CLÁUSULA DE CONFIDENCIALIDAD</p>` +
    `<p style="margin:0">Este mensaje y sus anexos pueden contener información confidencial, por lo que se informa de que su uso no autorizado está prohibido por la ley. Si Vd. considera que no es el destinatario pretendido por el remitente, por favor póngalo en su conocimiento por esta misma vía o por cualquier otro medio y elimine esta comunicación y los anexos de su sistema, sin copiar, remitir o revelar los contenidos del mismo a cualquier otra persona. Cualquier información, opinión, conclusión, recomendación, etc. contenida en el presente mensaje no relacionada con la actividad comercial de Inmobiliaria Bazán y/o emitida por persona sin capacidad para ello, deberá considerarse como no proporcionada ni aprobada por Inmobiliaria Bazán.</p>` +
    `</div>`;

  const full =
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>` +
    `<body style="margin:0;padding:0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;background:#f5f5f5">` +
    `<div style="max-width:580px;margin:0 auto;padding:28px 24px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.08)">${contentHtml}</div>` +
    `${clausula}` +
    `<p style="max-width:580px;margin:0 auto;padding:8px 24px 16px;font-size:12px;color:#888">Inmobiliaria Bazán</p>` +
    `</body></html>`;

  return breakLongLines(full, 1000);
}

export function plainTextToEmailHtml(
  text: string,
  opts?: { title?: string; headerImageUrl?: string | null; includeHeaderImage?: boolean }
): string {
  const safe = escapeHtml(text).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
  // Enlaces clicables en HTML (el texto plano ya lleva la URL).
  const withLinks = safe.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" style="color:#1a5f7a;word-break:break-all">$1</a>'
  );
  const blocks: string[] = [];
  const includeHeader = opts?.includeHeaderImage !== false && opts?.headerImageUrl !== null;
  if (includeHeader) {
    blocks.push(
      opts?.headerImageUrl
        ? emailBrandHeaderHtml(opts.headerImageUrl)
        : emailBrandHeaderHtml()
    );
  }
  if (opts?.title) blocks.push(emailH(opts.title));
  blocks.push(emailP(withLinks));
  return emailWrapHtml(blocks.join(""));
}
