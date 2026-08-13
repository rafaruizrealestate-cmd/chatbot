# Operativa de Leo — horario, emails, llamadas perdidas y comerciales

Documento de referencia para revisar **qué hace el bot y cuándo**. Código principal: `src/email/monitor.ts`, `src/whatsapp/processIncomingText.ts`, `src/agents/assignment.ts`, `src/utils/workSchedule.ts`.

---

## 1. Horario laboral (Europe/Madrid)

**Regla general:** de lunes a viernes, de **10:00 a 19:30**, Leo **no atiende automáticamente**. Durante ese tramo, la atención queda reservada al equipo humano.

En concreto:

- Leo **no responde** WhatsApp entrante.
- Leo **no lee ni procesa** emails (Idealista, Fotocasa, pisos.com, llamadas perdidas, etc.).
- Los emails **quedan pendientes** en el buzón hasta salir del horario.
- Los mensajes y emails se procesan **fuera de ese tramo** — a partir de las **19:31** o **antes de las 10:00** — cuando el cron vuelve a ejecutar el poll.

| Canal | Dentro de L–V 10:00–19:30 | Fuera de ese tramo |
|--------|---------------------------|---------------------|
| **WhatsApp entrante** | Leo **no responde** | Leo responde con normalidad |
| **Emails de portales** | **No se leen ni procesan** | Se leen, responden al cliente y avisan al comercial si toca |

Variable de entorno solo para pruebas: `BYPASS_WORK_SCHEDULE=1` desactiva **todo** el bloqueo horario.

---

## 2. Flujo: llamada perdida (Idealista / portales)

### Paso A — Llega el email

Asunto típico: *«Llamada no contestada de un interesado en tus anuncios»*.

El clasificador (`src/email/classifier.ts`):

- Detecta `isMissedCall = true`.
- Extrae el **teléfono del interesado** del cuerpo del email (p. ej. «llamó desde 34 6XX XXX XXX»).
- **No** responde por email al portal.
- **No** pasa por la IA larga del cuerpo del correo.

### Paso B — Leo escribe por WhatsApp (fuera de horario laboral)

Cuando el cron lee el email **fuera de L–V 10:00–19:30**, envía este mensaje fijo (`MISSED_CALL_OUTREACH_MESSAGE` en `src/email/monitor.ts`):

> Hola, has llamado a Inmobiliaria Bazán y no pudimos atenderte porque estamos fuera de nuestro horario de atención. Nuestro horario es de 10:00 a 19:30 de lunes a viernes. Soy Leo, IA de la inmobiliaria. ¿Me dices cómo te llamas y qué inmueble te interesa —referencia o enlace de la ficha—? Si no deseas que te contactemos por WhatsApp, indícanoslo y no volveremos a escribirte por aquí.

- Se marca en BD `missed_call_pending` para ese teléfono.
- **No se avisa al comercial todavía.**

### Paso C — El cliente responde por WhatsApp

Leo conversa **fuera de horario laboral** y pide lo que falte (nombre, referencia o enlace de ficha).

### Paso D — Lead al comercial (por inmueble)

**Condición para avisar al comercial:** el cliente ha respondido y se dispone de **nombre** y **referencia o enlace del inmueble actual**.

Un mismo cliente **puede preguntar por varios inmuebles** en la misma conversación. Cada inmueble distinto genera un **lead independiente** hacia el comercial de esa ficha.

**Primera consulta tras llamada perdida:** hace falta **nombre + ref** (o enlace de ficha) del inmueble que le interesa en ese momento.

**Consultas posteriores del mismo cliente:**

- Si ya consta su **nombre** (perfil o historial), solo hace falta la **nueva ref** o enlace.
- Leo resuelve la ref del **mensaje actual** — no se queda bloqueado en un piso anterior.
- Se avisa al comercial que corresponda según scrape/BD (ver §4).

**Normalización de referencia:** `1708`, `REF1708`, una URL de la web o un enlace de portal deben resolverse a la **misma referencia interna** cuando sea posible (`resolveLeadRef`, `extractPropertyRefFromText`).

**Deduplicación (7 días):** solo evita repetir aviso por la **misma combinación teléfono + ref**. Si pregunta por la ref 1708 y luego por la 1733, se generan **dos avisos** distintos (cada uno al comercial de su ficha).

Si falta nombre o ref del inmueble **actual** → no avisa al comercial; sigue hablando con el cliente.

---

## 3. Flujo: lead normal (email de portal o WhatsApp directo)

1. Entra un email mediante el poll del cron (aproximadamente cada **2 minutos**) o entra un mensaje por webhook de WhatsApp.
2. Leo extrae **teléfono**, **nombre**, **referencia** y contexto del inmueble cuando existan en el mensaje. En emails de portal, el teléfono del cliente sale del campo etiquetado del cuerpo (p. ej. «TELÉFONO» en pisos.com), no de números sueltos ni URLs de tracking.
3. Leo responde al **cliente**:
   - Por **WhatsApp**, si hay móvil español válido.
   - Por **email**, si no hay móvil válido.
4. Si existe contexto claro de inmueble o intención comercial real, Leo avisa al comercial asignado.
5. Cada **referencia distinta** cuenta como lead separado.
6. La deduplicación solo bloquea avisos repetidos para la **misma combinación teléfono + referencia** durante **7 días**.
7. Leo **no** avisa al comercial por mensajes sueltos de papeleo, avalista, fianza, incidencias, recibos o administración si no existe una intención comercial nueva.

---

## 3b. Temas de administración (Mariana)

Son temas de **gestión ya existente**, no leads de captación:

- Contrato en curso
- Fianza
- Incidencia en una vivienda alquilada
- Recibos
- Suministros
- Conversación previa con Mariana o administración
- Papeleo de un alquiler ya formalizado

| Qué hace Leo fuera de horario | Qué no hace Leo |
|---|---|
| Ayuda de forma general si puede | No avisa al comercial de captación |
| Indica que el cliente escriba **aquí mismo**, en **este WhatsApp**, en horario laboral **L–V 10:00–19:30** | No da teléfonos de comerciales |
| Explica que **Mariana** continuará el caso en horario laboral | No promete que un agente llamará |

Si en el mismo chat el cliente **cambia de tema** y busca un inmueble nuevo (ref, visita, «me interesa alquilar…»), vuelve al flujo comercial normal (§3).

Palabras clave detectadas en código: `src/whatsapp/administrativeTopics.ts`.

---

## 4. Asignación de comerciales por inmueble

**Fuente única de asignación:** la asignación del comercial procede de la ficha web mediante la meta `bazan:agent-*`.

**Flujo técnico:**

```
Ficha web → npm run scrape → SQLite → agent_name / agent_phone
```

**Orden de decisión en `pickAgent()`** (`src/agents/assignment.ts`):

1. Usar el agente de la propiedad ya cargada.
2. Buscar la referencia en la tabla `properties`.
3. Si la ficha no tiene agente en BD, hacer scrape en caliente de esa referencia mediante `enrichPropertyWithAgent`.
4. Si no hay agente en BD, usar fallback opcional en `.env`:
   - `LEAD_FALLBACK_AGENT_NAME` / `LEAD_FALLBACK_AGENT_PHONE`
   - `LEAD_OWNER_AGENT_NAME` / `LEAD_OWNER_AGENT_PHONE` (consultas de propietarios, intent C)
5. Si no hay agente ni fallback → error en log indicando que debe ejecutarse el scrape.

**Reglas:**

- Leo **no inventa** comerciales.
- Leo **no usa** listas hardcodeadas tipo `DAVID_REFS`, `MIGUEL_REFS`, etc.
- Los comerciales **sin propiedades asignadas** no aparecerán en el scrape.
- Para que un comercial reciba leads, debe estar **asignado en la intranet** a sus fichas correspondientes.

Detalle técnico web/intranet: [docs/AGENTE_DESDE_INTRANET_webBazanAbril.md](./docs/AGENTE_DESDE_INTRANET_webBazanAbril.md)

---

## 5. Qué no debe hacer Leo

Leo no debe:

- Responder dentro del horario laboral bloqueado.
- Inventar comerciales.
- Usar listas hardcodeadas de referencias por comercial.
- Avisar a un comercial sin nombre y referencia suficientes.
- Prometer que un agente llamará.
- Confirmar disponibilidad, precio definitivo o reserva si no consta en la BD o ficha.
- Tramitar reservas, pagos o señales.
- Derivar a comerciales asuntos puramente administrativos.
- Quedarse anclado a una referencia anterior si el cliente pregunta por otra.
- Contestar por email al portal en casos de llamada perdida si el flujo correcto es WhatsApp.

---

## 6. Decisiones técnicas relevantes y problemas ya corregidos

| Decisión actual | Motivo |
|---|---|
| Guardar el estado en BD antes de marcar un email como leído | Evita perder emails si IMAP falla después del procesamiento |
| Caducidad del lock del cron tras más de 10 minutos | Evita que un lock huérfano bloquee el poll indefinidamente |
| No usar listas hardcodeadas de referencias por comercial | La asignación debe venir siempre de la ficha web/intranet mediante scrape |
| No avisar al comercial en llamada perdida hasta tener nombre + ref | Evita enviar leads incompletos o asignarlos a un inmueble incorrecto |
| Deduplicar por teléfono + ref durante 7 días | Evita avisos repetidos sin bloquear consultas sobre otros inmuebles |
| No procesar emails ni WhatsApp en horario laboral | Regla de negocio: la atención queda reservada al equipo humano |
| Extraer teléfono y nombre del bloque etiquetado del email de portal | Evita usar números corporativos o de tracking embebidos en URLs |

Histórico detallado de incidencias: [docs/incidencias/](./docs/incidencias/)

---

## 7. Cron y logs en VPS

```bash
# Email (cada 2 min)
*/2 * * * * flock -n /tmp/chatbot-email.lock ... npm run email:poll >> /var/log/email-poll.log

# Auto-deploy desde origin/main (cada 2 min)
*/2 * * * * root flock -n /var/lock/whatsapp-chatbot-deploy-cron.lock /opt/whatsapp-chatbot/scripts/deploy-if-changed.sh >> /var/log/whatsapp-chatbot-deploy.log 2>&1

# Auditoría manual
HOURS=48 bash /opt/whatsapp-chatbot/scripts/audit-vps.sh
```

Deploy manual inmediato: `bash /opt/whatsapp-chatbot/scripts/deploy-vps-remote.sh`

GitHub Actions verifica el despliegue por HTTP (`/health` devuelve el commit desplegado); no usa SSH al VPS.

**Nota:** los runners de GitHub no pueden alcanzar el VPS (firewall del hosting). El deploy real lo hace el cron `deploy-if-changed.sh`. El workflow de GitHub solo compila y prueba el código; un check al VPS es informativo y no bloquea el pipeline.

---

## 8. Checklist de revisión manual

- [ ] ¿Llegó email de llamada perdida? Debe aparecer en `email_state` con `handled=1`.
- [ ] ¿Hay fila en `conversations` con rol `assistant` para el teléfono del interesado?
- [ ] ¿El mensaje de outreach se envió al **teléfono correcto**?
- [ ] ¿`lead_profiles.extra_notes` contiene `missed_call_pending` hasta que el cliente facilite nombre + ref?
- [ ] Cuando el cliente responde, ¿se ha resuelto correctamente la **referencia actual**?
- [ ] ¿`lead_notifications` contiene la referencia correcta y el comercial de la ficha scrapeada?
- [ ] Si el cliente pregunta por otra referencia, ¿se genera un lead nuevo para esa nueva ref?
- [ ] Si el mensaje es administrativo, ¿se evita avisar al comercial?

---

## 9. Variables `.env` relevantes

| Variable | Uso |
|---|---|
| `EMAIL_ENABLED=1` | Activa poll IMAP |
| `BYPASS_WORK_SCHEDULE=1` | Desactiva bloqueo horario; solo para pruebas |
| `LEAD_FALLBACK_AGENT_*` | Comercial fallback si una ref no tiene agente en BD |
| `LEAD_OWNER_AGENT_*` | Comercial fallback para propietarios que quieren vender o alquilar su piso |
