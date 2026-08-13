import OpenAI from "openai";
import { config, assertOpenAiConfigured } from "../config.js";
import { searchPropertiesTool } from "./functions.js";
import { searchProperties, type PropertyRow } from "../knowledge/properties.js";
import { buildKnowledgeContext } from "./rag.js";
import { formatAgentPhoneEs } from "../leads/agentNotification.js";
import { buildPropertySearchPromptBlock, buildOngoingPropertyConversationBlock } from "../whatsapp/propertySearch.js";
import { BAZAN_SERVICES_PROMPT_BLOCK } from "../knowledge/services.js";
import { OFFICE_HOURS_LABEL, isWithinOfficeHours } from "../utils/workSchedule.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    assertOpenAiConfigured();
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return client;
}

function systemPrompt(knowledgeBlock: string, language: "es" | "en" = "es"): string {
  const bot = config.botName;
  const officeOpenNowLabel = isWithinOfficeHours()
    ? " (ahora mismo la oficina está abierta)"
    : " (ahora mismo la oficina está cerrada: le atenderá en cuanto abra)";
  const kb = knowledgeBlock.trim()
    ? `\n\n--- Información de la web y documentos internos (puede estar incompleta) ---\n${knowledgeBlock}\n--- Fin información ---`
    : "";

  const languageRule =
    language === "en"
      ? `- Language: English, professional and warm tone. Keep messages clear and relatively brief.\n- Do NOT switch to Spanish unless the user asks.\n- Present yourself as ${bot}, the AI assistant of Inmobiliaria Bazán (Málaga). When relevant (start of chat or if they seem unsure), clarify you are AI and often give the first reply outside office hours: Mon–Fri the human team is available 10:00–19:30 Spain (peninsula); outside that window, evenings, weekends and holidays, you reply first so no enquiry is left unanswered.\n- If they insist on a human: one empathetic sentence, repeat you are the out-of-hours AI assistant, reassure them a human advisor will follow up in office hours or that you are passing their details to the right agent.`
      : "- Idioma: español de España (castellano peninsular), registro natural de Madrid: tú/vosotros, móvil, ordenador, piso, garaje, vale, genial. NUNCA uses español latinoamericano (ustedes como norma, celular, computadora, departamento, plata, chevere, etc.). Tono cercano de WhatsApp. Frases cortas: 1-3 párrafos breves. Evita listas numeradas largas y interrogatorios encadenados (no hagas 'sota, caballo, rey'). Responde primero lo que preguntan; luego una sola pregunta si falta algo.";
  return `## IDENTIDAD DEL AGENTE

Preséntate como ${bot}, IA de Inmobiliaria Bazán en Málaga. Usa "IA", no "inteligencia artificial".

NO escribas frases genéricas del tipo "Estoy aquí para ayudarte con tus consultas sobre propiedades".

Solo si el cliente pregunta por horario, humanos o muestra frustración por hablar con un bot: aclara en una frase breve que eres IA y que fuera del horario de oficina (lunes a viernes 10:00–19:30, hora peninsular) sueles responder primero; un asesor humano le contactará cuando corresponda. No repitas esto en cada mensaje.

Si pide hablar con una persona y es urgente (o insiste tras esa aclaración), dale el contacto de ${config.voiceAdminName}, de administración: ${formatAgentPhoneEs(config.voiceAdminPhone)}, que atiende ${OFFICE_HOURS_LABEL}. Di SIEMPRE ese horario al dar el teléfono, para que no llame cuando no hay nadie${officeOpenNowLabel}. Es la persona de contacto para clientes que necesitan un humano ya. No la ofrezcas en asuntos de compra/alquiler que ya lleva un comercial asignado, ni a quien llama para vender publicidad o servicios a la agencia.

## OBJETIVOS DE LA CONVERSACIÓN

1. **Resolver consultas inmobiliarias** con datos reales (search_properties): compra, alquiler, zona, precio, visitas. Habla con naturalidad.

2. **Comprador o inquilino**: si le gusta una ficha, anima a visitarla y pide su nombre para pasarlo al comercial (sin presionar).

3. **Propietario que quiere vender o alquilar SU inmueble** (TIPO C): deriva SIEMPRE a **Álvaro** (WhatsApp +34 646 424 563) e invita al formulario https://www.inmobiliariabazan.com/registro-vendedor.php — no uses otro comercial para esto.

4. **Derivar al agente humano** (compradores/inquilinos): el sistema notifica al comercial. Solo menciona nombre y teléfono del asesor cuando el bloque interno "Asesor asignado" esté presente.

Clasificación interna (NO mostrar al cliente):

- TIPO A — busca alquiler (inquilino).
- TIPO B — busca compra.
- TIPO C — propietario (vender, alquilar su inmueble o traspaso) → solo Álvaro + formulario web.

Para TIPO C, pregunta con naturalidad (zona, m², venta o alquiler) sin interrogatorio. Usa el bloque "Servicios Inmobiliaria Bazán" para explicar qué ofrecéis.

## RESOLVER DUDAS

Responde primero la pregunta del cliente. Sé breve y coloquial. Una pregunta de seguimiento como máximo si falta un dato clave.

## REGLAS IMPORTANTES

${languageRule}

- Interpreta sinónimos comunes:
  - "solar", "terreno", "parcela" → trátalos como lo mismo (suelo/terreno).
  - "piso", "departamento", "apartamento" → trátalos como lo mismo (vivienda tipo piso).

- Usa SIEMPRE la herramienta search_properties cuando el usuario mencione una referencia (ref), pida una ficha, busque inmuebles, precio, zona, habitaciones o disponibilidad. Si dan un número de referencia, llama primero a search_properties solo con ref (número o texto).

- Si falta un dato para buscar, haz UNA pregunta corta (referencia, zona, tipo o compra/alquiler). No des por perdida la conversación con textos largos.

- Si no hay resultados tras buscar: pregunta un dato más o, si ya hay varios datos y la ref no existe, di brevemente que no tenéis esa propiedad e invita a www.inmobiliariabazan.com. No inventes fichas ni des párrafos de "no he encontrado en nuestra base de datos".

- Cuando cites propiedades, sé breve: título, ref, precio, m², habitaciones, zona y enlace. NO listes todas las características ni pegues la descripción completa (máx. 4-5 líneas).

- Si el cliente busca **piso, estudio o vivienda** en alquiler/compra: NO mezcles Oficina, Local, Garaje, Nave, Terreno ni habitaciones en piso compartido. Solo viviendas (Piso, Estudio, Ático, Chalet, Adosado, Dúplex…).
- Si el cliente pide **local, local comercial, oficina, nave, traspaso o negocio**: SÍ los gestionáis. Usa search_properties con property_type Local u Oficina, o transaction_type Traspaso. NUNCA digas que no tenéis locales u oficinas: buscad primero en cartera y, si no hay resultados, dilo tras buscar e invita a la web.
- Bazán también hace traspaso de locales comerciales y reformas; no digas que solo hacéis viviendas.

- El comercial de cada inmueble es el **agent_name** y **agent_phone** que devuelve search_properties para esa ref. NUNCA inventes ni reutilices un comercial de otra ficha anterior.

- No prometas fecha/hora de visita concretas: el agente humano la coordinará.

- CONVERSACIÓN ABIERTA: no despidas ni des por cerrada la conversación (evita "un saludo", "quedo a tu disposición", "nada más" como cierre). El cliente decide cuándo parar; sigue respondiendo mientras pregunte. Tras pasar el contacto del comercial, quedas disponible por aquí por si surgen más dudas.

- Notas de voz: SÍ puedes responder por nota de voz (el sistema la envía). Si preguntan, confirma que sí. NUNCA digas que no puedes enviar notas de voz ni que eres una IA sin capacidad de audio.

- No inventes propiedades ni precios.

- No des direcciones exactas, SOLO zona, ciudad, barrio o calles cercanas.

- PROHIBIDO recomendar otras agencias, portales o webs de terceros (incluyendo Idealista, Fotocasa o cualquier inmobiliaria externa). Solo ofrece inmuebles y contactos de Inmobiliaria Bazán.

- NO filtres al cliente por ingresos, avalista ni documentación: eso lo gestiona el agente humano después.

- Teléfono del cliente: úsalo desde WhatsApp (o CLI en voz). NO lo pidas de nuevo salvo que quiera otro número.

- Si el bloque interno "Asesor asignado" está presente: incluye su nombre y teléfono y di que se pondrá en contacto. Si NO está presente: responde la consulta sin inventar comercial ni teléfono de asesor.

## DATOS DEL CLIENTE

- WhatsApp/voz: si no conoces el nombre, puedes preguntarlo al final con una frase breve ("¿Me dices tu nombre?"). Responde la consulta; el contacto del comercial solo si el bloque interno lo indica.
- Email/portal: no insistas en el nombre si no viene en el mensaje; el lead se envía al agente con o sin nombre.
- El teléfono del cliente en WhatsApp ya lo tienes; no lo pidas de nuevo.

=== CONTACTO DEL AGENTE (sin cerrar la conversación) ===

Solo si el bloque interno "Asesor asignado" está presente: incluye nombre y teléfono del asesor e indica que se pondrá en contacto. NO despidas ni des por terminado el chat; invita a escribir aquí si le surge otra duda.

${BAZAN_SERVICES_PROMPT_BLOCK}${kb}`;
}

function includesExternalAgencyContent(reply: string): boolean {
  const t = reply.toLowerCase();
  const knownExternalMentions = [
    "idealista",
    "fotocasa",
    "habitaclia",
    "pisos.com",
    "indomio",
    "otras agencias",
    "otra agencia",
    "te recomiendo contactar",
  ];
  if (knownExternalMentions.some((needle) => t.includes(needle))) return true;
  // "agencia inmobiliaria" genérico suele ser la nuestra; solo bloquear si recomienda terceros.
  if (/\b(otra|otras|diferente|externa)\s+agencia\b/.test(t)) return true;

  const domainRegex = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/gi;
  const allowedDomains = new Set([
    "inmobiliariabazan.com",
    "www.inmobiliariabazan.com",
  ]);
  let match: RegExpExecArray | null;
  while ((match = domainRegex.exec(reply)) !== null) {
    const host = (match[1] ?? "").toLowerCase();
    if (!host) continue;
    if (allowedDomains.has(host)) continue;
    // Exclude common sentence artifacts that look like domains.
    if (host.endsWith(".png") || host.endsWith(".jpg")) continue;
    return true;
  }
  return false;
}

function safeBazanOnlyFallback(): string {
  return [
    "Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.",
    "",
    "Si me indicas zona, presupuesto y número de habitaciones, te paso opciones disponibles de nuestra cartera y te ayudo con la visita.",
    "",
    "Un saludo,",
    `${config.botName}, IA de Inmobiliaria Bazán.`,
  ].join("\n");
}

function sanitizeExternalMentions(reply: string): string {
  // 1) Elimina URLs externas (muchos leads pegados desde portales vienen con links de tracking).
  const urlRegex = /https?:\/\/[^\s)>\]]+/gi;
  let out = reply.replace(urlRegex, (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (host === "inmobiliariabazan.com" || host === "www.inmobiliariabazan.com") return u;
      return "";
    } catch {
      return "";
    }
  });

  // 2) Evita mencionar portales externos por nombre (mantiene la respuesta útil).
  out = out
    .replace(/\bidealista\b/gi, "el portal")
    .replace(/\bfotocasa\b/gi, "el portal")
    .replace(/\bpisos\.com\b/gi, "el portal")
    .replace(/\bindomio\b/gi, "el portal")
    .replace(/\bhabitaclia\b/gi, "el portal");

  // Limpieza de espacios
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

function enforceBazanOnlyPolicy(reply: string): string {
  if (!reply) return reply;
  if (!includesExternalAgencyContent(reply)) return reply;
  const sanitized = sanitizeExternalMentions(reply);
  if (sanitized && !includesExternalAgencyContent(sanitized)) {
    console.warn("[ai] respuesta saneada (URLs/portales externos eliminados)");
    return sanitized;
  }
  console.warn("[ai] respuesta bloqueada por contenido de agencias/portales externos");
  return safeBazanOnlyFallback();
}

function serializePropertyRows(rows: PropertyRow[]): unknown[] {
  return rows.map((r) => {
    let features: unknown[] = [];
    if (r.features) {
      try {
        features = JSON.parse(r.features) as unknown[];
      } catch {
        features = [];
      }
    }
    return {
      ref: r.ref,
      title: r.title,
      property_type: r.property_type,
      transaction_type: r.transaction_type,
      price: r.price,
      area_m2: r.area_m2,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      location: r.location,
      features,
      description: r.description ? r.description.slice(0, 800) : null,
      url: r.url,
      agent_name: r.agent_name ?? null,
      agent_phone: r.agent_phone ?? null,
    };
  });
}

function normalizeRef(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
  return undefined;
}

function runSearchTool(args: Record<string, unknown>): unknown {
  const limit = typeof args.limit === "number" ? args.limit : 10;
  const features_any = Array.isArray(args.features_any)
    ? (args.features_any as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  const propertyType = typeof args.property_type === "string" ? args.property_type.trim() : undefined;
  const transactionType =
    typeof args.transaction_type === "string" ? args.transaction_type.trim() : undefined;
  const nonResidential = new Set(["oficina", "local", "garaje", "nave", "terreno", "parcela"]);
  const typeLower = (propertyType ?? "").toLowerCase();
  const wantsNonResidential =
    Boolean(typeLower && [...nonResidential].some((t) => typeLower.includes(t))) ||
    /^traspaso$/i.test(transactionType ?? "");
  // Por defecto filtramos a vivienda; si piden local/oficina/traspaso, no.
  const residentialOnly = !wantsNonResidential && !propertyType;
  const excludeSharedRooms =
    residentialOnly ||
    Boolean(propertyType && /piso|estudio|ático|atico|chalet|vivienda|duplex|dúplex|adosado/i.test(propertyType));

  return serializePropertyRows(
    searchProperties({
      transaction_type: transactionType,
      property_type: propertyType,
      max_price: typeof args.max_price === "number" ? args.max_price : undefined,
      min_price: typeof args.min_price === "number" ? args.min_price : undefined,
      min_bedrooms: typeof args.min_bedrooms === "number" ? args.min_bedrooms : undefined,
      location_contains:
        typeof args.location_contains === "string" ? args.location_contains : undefined,
      features_any,
      ref: normalizeRef(args.ref),
      limit,
      residential_only: residentialOnly,
      exclude_shared_rooms: excludeSharedRooms,
    })
  );
}

export type ContactChannelHint =
  | "whatsapp"
  | "voice"
  | "messenger"
  | "instagram_dm"
  | "facebook_comment"
  | "instagram_comment"
  | "other";

function buildContactHintBlock(customerKey: string | undefined, contactChannel?: ContactChannelHint): string {
  if (!customerKey?.trim()) return "";
  const ck = customerKey.trim();
  const ch: ContactChannelHint = contactChannel ?? "whatsapp";
  if (ch === "whatsapp") {
    return `\n\n--- Contexto interno de contacto ---\nTeléfono del cliente (WhatsApp): ${ck}.\nUsa este número como teléfono del lead cuando aplique.\n--- Fin contexto ---`;
  }
  if (ch === "voice") {
    return `\n\n--- Contexto interno de contacto ---\nEl cliente habla por una llamada de voz telefónica (PSTN). Teléfono del llamante (CLI): ${ck}.\nUsa este número como teléfono del lead. Las respuestas serán leídas en voz alta: sé breve y claro, evita listas muy largas y URLs largas (puedes dictar solo el dominio o ofrecer envío por WhatsApp).\n--- Fin contexto ---`;
  }
  const labels: Record<Exclude<ContactChannelHint, "whatsapp" | "voice">, string> = {
    messenger: "Facebook Messenger",
    instagram_dm: "Instagram (mensaje directo)",
    facebook_comment: "Facebook (comentario en publicación)",
    instagram_comment: "Instagram (comentario)",
    other: "Otro canal (email/portal)",
  };
  const label = labels[ch] ?? labels.other;
  return `\n\n--- Contexto interno de contacto ---\nCanal: ${label}.\nIdentificador de conversación: ${ck}.\nNo asumas teléfono del cliente salvo que lo indique explícitamente.\n--- Fin contexto ---`;
}

/** Agente resuelto por pickAgent() (scrape BD → listas legacy → default); se inyecta en el system prompt. */
export type AssignedAgentHint = {
  name: string;
  phone: string;
  ref?: string | null;
};

function buildNameHintBlock(
  customerName: string | null | undefined,
  channel?: ContactChannelHint,
  mentionAgent?: boolean
): string {
  if (customerName?.trim()) {
    return `\n\n--- Contexto interno ---\nNombre del cliente: ${customerName.trim()}.\n--- Fin contexto ---`;
  }
  if (channel === "whatsapp" || channel === "voice") {
    const agentNote = mentionAgent
      ? " Si procede, facilita el contacto del comercial asignado."
      : " NO menciones comercial ni teléfono de asesor todavía.";
    return `\n\n--- Contexto interno ---\nNo conoces el nombre del cliente. Puedes preguntar cómo se llama (una frase corta) sin dejar de responder su consulta.${agentNote}\n--- Fin contexto ---`;
  }
  return "";
}

function buildFirstWhatsAppTurnBlock(): string {
  return `\n\n--- Primer mensaje WhatsApp ---
El cliente ya escribió con una consulta (no solo hola). Responde directo, en tono cercano y breve.
NO repitas un saludo largo ni pidas referencia si ya dio zona, tipo o compra/alquiler.
NO menciones comercial ni teléfono de asesor todavía.
--- Fin primer mensaje ---`;
}

function buildDirectWhatsappStyleBlock(): string {
  return `\n\n--- Estilo WhatsApp directo ---
Habla como en un chat: natural, cercano, respuestas cortas (2-4 líneas suele bastar).
No hagas cuestionario en cadena; resuelve y pregunta solo lo imprescindible.
Si busca compra o alquiler, no confundas "en venta/en alquiler" del anuncio con que él quiera vender su piso.
Objetivo comprador/inquilino: ayudar a encontrar y, si le encaja una ficha, animar a visita y pedir nombre.
Objetivo propietario (vender/alquilar su inmueble): Álvaro +34 646 424 563 y https://www.inmobiliariabazan.com/registro-vendedor.php
No cierres la conversación: el cliente marca el final; sigue disponible mientras escriba.
--- Fin estilo ---`;
}

function buildOwnerListingBlock(): string {
  return `\n\n--- Propietario (vender/alquilar SU inmueble) ---
El cliente quiere que gestionéis la venta o alquiler de su propiedad (TIPO C).
Menciona a Álvaro (WhatsApp +34 646 424 563) y el formulario https://www.inmobiliariabazan.com/registro-vendedor.php
Ofrece tasación gratuita. No derives a otros comerciales.
--- Fin propietario ---`;
}

function buildMissedCallFollowUpBlock(): string {
  return `\n\n--- Contexto: llamada perdida ---
El cliente llamó y no se pudo atender; ya recibió un WhatsApp pidiendo su nombre y el inmueble de interés.
Pregunta de forma breve lo que aún falte (nombre y/o referencia o enlace de la ficha).
Cuando tengas nombre y referencia del inmueble, facilita también el contacto del comercial asignado.
--- Fin contexto ---`;
}

function buildAdministrativeConversationBlock(): string {
  return `\n\n--- Contexto: administración (NO es lead comercial) ---
El cliente habla de un tema de administración o gestión ya existente (contrato, fianza, incidencia en su vivienda alquilada, recibos, secretario/administrativo de la oficina, etc.), no de buscar un inmueble nuevo.
Responde breve y ayuda en lo general que puedas.
NO des teléfono de comerciales ni digas que un agente comercial le contactará.
NO menciones a Mariana (ya no está en la empresa).
Quien lleva administración es ${config.voiceAdminName}: nómbrala al indicar quién le atenderá.
Indica que para seguir con este asunto escriba aquí mismo (este WhatsApp) en horario de oficina, ${OFFICE_HOURS_LABEL}; ${config.voiceAdminName} se encargará y le atenderá por este mismo número.
Si el cliente dice que es urgente o insiste en hablar con una persona, dale el teléfono de ${config.voiceAdminName}: ${formatAgentPhoneEs(config.voiceAdminPhone)}, indicando siempre que atiende ${OFFICE_HOURS_LABEL}.
--- Fin contexto ---`;
}

function buildPortalCustomerReplyBlock(channel: "whatsapp" | "email"): string {
  const delivery =
    channel === "whatsapp"
      ? "La respuesta se enviará al cliente únicamente por WhatsApp (no por email)."
      : "La respuesta se enviará al cliente por email (no tiene WhatsApp válido).";
  return `\n\n--- Formato de respuesta (lead email/portal) ---
${delivery}
NO uses el párrafo largo sobre ser IA ni horario fuera de oficina.
Preséntate en una frase breve como ${config.botName} de Inmobiliaria Bazán o ve directo a la consulta.
Responde la consulta y deja la puerta abierta (sin despedida larga ni dar por cerrada la conversación).
--- Fin formato ---`;
}

function buildAssignedAgentBlock(agent: AssignedAgentHint): string {
  const phone = formatAgentPhoneEs(agent.phone);
  const refLine = agent.ref ? `Referencia detectada: ${agent.ref}.\n` : "";
  return `\n\n--- Asesor asignado (incluir cuando proceda el handoff) ---
${refLine}Comercial: ${agent.name}, teléfono ${phone} (viene del scrape de la web).
OBLIGATORIO: cuando menciones al comercial, escribe SIEMPRE el nombre ${agent.name} Y el teléfono ${phone} en la misma frase (ej.: "Tu comercial es ${agent.name}, Telf: ${phone}").
PROHIBIDO decir solo el nombre sin el teléfono.
Indica que se pondrá en contacto.
NO despidas ni des por cerrada la conversación: quedas disponible por aquí si el cliente tiene más dudas.
--- Fin asesor asignado ---`;
}

export async function generateAssistantReply(
  userMessage: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  customerPhone?: string,
  opts?: {
    language?: "es" | "en";
    contactChannel?: ContactChannelHint;
    assignedAgent?: AssignedAgentHint;
    customerName?: string | null;
    /** Si ya tenemos ficha en contexto, omitir embedding RAG (más rápido). */
    skipRag?: boolean;
    /** Lead de portal: respuesta breve; el cierre lo añade el sistema según el canal. */
    portalCustomerReply?: "whatsapp" | "email";
    /** Seguimiento tras llamada perdida: pedir nombre + inmueble antes de pasar lead al agente. */
    missedCallFollowUp?: boolean;
    /** Tema administración (oficina): no comercial, remitir a horario laboral en este WhatsApp. */
    administrativeConversation?: boolean;
    /** Incluir comercial asignado en la respuesta al cliente (no en el primer contacto sin contexto). */
    mentionAgentToCustomer?: boolean;
    /** Primer turno en WhatsApp con consulta concreta (no saludo genérico). */
    firstWhatsAppTurn?: boolean;
    /** Búsqueda de inmueble aún sin ficha identificada. */
    propertySearchPending?: boolean;
    /** Ficha ya enviada: conversar sin repetir el anuncio. */
    ongoingPropertyConversation?: boolean;
    ongoingPropertyRef?: string | null;
    /** WhatsApp directo: tono coloquial y breve. */
    directWhatsappColloquial?: boolean;
    /** Propietario que quiere vender/alquilar su inmueble. */
    ownerListingIntent?: boolean;
  }
): Promise<string> {
  const knowledgeBlock = opts?.skipRag ? "" : await buildKnowledgeContext(userMessage);
  const tools: OpenAI.Chat.ChatCompletionTool[] = [searchPropertiesTool];

  const inferredChannel: ContactChannelHint | undefined =
    opts?.contactChannel ??
    (typeof customerPhone === "string" && /^\d{8,20}$/.test(customerPhone.trim())
      ? "whatsapp"
      : customerPhone?.trim()
        ? "other"
        : undefined);

  const contactHint =
    typeof customerPhone === "string" && customerPhone.trim()
      ? buildContactHintBlock(customerPhone, inferredChannel)
      : "";

  const mentionAgent = opts?.mentionAgentToCustomer !== false;
  const assignedHint =
    mentionAgent && opts?.assignedAgent ? buildAssignedAgentBlock(opts.assignedAgent) : "";
  const nameHint = buildNameHintBlock(opts?.customerName, inferredChannel, mentionAgent);
  const portalReplyHint = opts?.portalCustomerReply
    ? buildPortalCustomerReplyBlock(opts.portalCustomerReply)
    : "";
  const missedCallHint = opts?.missedCallFollowUp ? buildMissedCallFollowUpBlock() : "";
  const administrativeHint = opts?.administrativeConversation
    ? buildAdministrativeConversationBlock()
    : "";
  const firstWhatsAppHint =
    opts?.firstWhatsAppTurn && inferredChannel === "whatsapp" ? buildFirstWhatsAppTurnBlock() : "";
  const propertySearchHint = opts?.propertySearchPending ? buildPropertySearchPromptBlock() : "";
  const ongoingPropertyHint =
    opts?.ongoingPropertyConversation && opts.ongoingPropertyRef
      ? buildOngoingPropertyConversationBlock(opts.ongoingPropertyRef)
      : "";
  const directWhatsappHint =
    opts?.directWhatsappColloquial && inferredChannel === "whatsapp"
      ? buildDirectWhatsappStyleBlock()
      : "";
  const ownerListingHint = opts?.ownerListingIntent ? buildOwnerListingBlock() : "";

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        systemPrompt(knowledgeBlock, opts?.language ?? "es") +
        contactHint +
        nameHint +
        assignedHint +
        portalReplyHint +
        missedCallHint +
        administrativeHint +
        firstWhatsAppHint +
        directWhatsappHint +
        ownerListingHint +
        propertySearchHint +
        ongoingPropertyHint,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const openai = getClient();
  let response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.4,
  });

  for (let step = 0; step < 6; step++) {
    const choice = response.choices[0];
    if (!choice?.message) break;
    const msg = choice.message;
    const toolCalls = msg.tool_calls;
    if (!toolCalls?.length) {
      const text = msg.content?.trim();
      const safeText = enforceBazanOnlyPolicy(text ?? "");
      return safeText || "En este momento no puedo generar una respuesta. Prueba de nuevo en unos minutos.";
    }

    messages.push(msg);

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let payload: unknown = { error: "unknown_tool" };
      if (call.function.name === "search_properties") {
        try {
          const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          payload = runSearchTool(args);
        } catch {
          payload = { error: "invalid_arguments" };
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(payload),
      });
    }

    response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.4,
    });
  }

  const final = response.choices[0]?.message?.content?.trim();
  const safeFinal = enforceBazanOnlyPolicy(final ?? "");
  return safeFinal || "No he podido completar la consulta. ¿Puedes reformular la pregunta?";
}
