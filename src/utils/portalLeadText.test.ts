import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdealistaContactPhone,
  extractPortalContactEmail,
  extractPortalContactName,
  extractPortalContactPhone,
  isGarbageCustomerEmail,
  sanitizeClientInfoForAgent,
  isGarbageClientInfo,
  isGarbageClientName,
} from "./portalLeadText.js";

test("isGarbageCustomerEmail rechaza logos Fotocasa y newsletters", () => {
  assert.equal(isGarbageCustomerEmail("fotocasa_pro_logo_blue_new@2x.png"), true);
  assert.equal(isGarbageCustomerEmail("imobiliario@newsletter.egorealestate.com"), true);
  assert.equal(isGarbageCustomerEmail("gautomarisa33@gmail.com"), false);
});

test("isGarbageClientName rechaza nombres de notificación portal", () => {
  assert.equal(isGarbageClientName("Capital Málaga"), true);
  assert.equal(isGarbageClientName("Llamada atendida de un"), true);
  assert.equal(isGarbageClientName("Marisa Gauto"), false);
});

test("sanitizeClientInfoForAgent extrae contraoferta Idealista con mensaje del cliente", () => {
  const email = [
    "Nueva oferta de Carlos Nava sobre tu inmueble, con ref: 1733, Piso en Calle Don Juan de Austria, La Trinidad, Málaga",
    "Tienes un nuevo mensaje que espera tu respuesta",
    "Tienes una oferta sobre uno de tus inmuebles",
    "Carlos Nava",
    "643 67 47 10",
    "clnava25@gmail.com",
    "Ha realizado una oferta",
    "Ha propuesto un precio de: 1.100 €Hola,",
    "me interesa este inmueble y me gustaría hacer una contraoferta.",
    "Responder desde idealista/tools",
  ].join("\n");

  const out = sanitizeClientInfoForAgent(email);
  assert.match(out, /Contraoferta:\s*1\.100\s*€/i);
  assert.match(out, /me interesa este inmueble y me gustaría hacer una contraoferta/i);
  assert.doesNotMatch(out, /espera tu respuesta/i);
  assert.doesNotMatch(out, /consultar si/i);
});

test("sanitizeClientInfoForAgent extrae mensaje de visita Idealista (Andrii)", () => {
  const email = [
    "🤩 Nuevo mensaje (con perfil) de Andrii sobre tu inmueble, con ref: 1732, Estudio en Calle Prim, Centro Histórico, Málaga",
    "Tienes un nuevo mensaje que espera tu respuesta",
    "Andrii",
    "Ver perfil",
    "613 19 82 39 [tel:+34613198239]",
    "ufh0y6evg77bymzy8mn8r4atnvdqogy8ehjoepkmttmw25pz62w@contacts.idealista.com",
    "Consultar si Andrii está en una lista de morosos",
    "Me gustaría hacer una visita",
    "Responder desde idealista/tools",
  ].join("\n");

  const out = sanitizeClientInfoForAgent(email);
  assert.match(out, /Me gustaría hacer una visita/i);
  assert.doesNotMatch(out, /Victoria Sanchez/i);
  assert.doesNotMatch(out, /espera tu respuesta/i);
});

test("extractIdealistaContactPhone usa enlace tel: del email", () => {
  const text = "Andrii 613 19 82 39 [tel:+34613198239] ufh0@contacts.idealista.com";
  assert.equal(extractIdealistaContactPhone(text), "34613198239");
});

test("extractPortalContactEmail ignora relay de Idealista", () => {
  const text =
    "clnava25@gmail.com [clnava25@gmail.com] ufh0y6evg77bymzy8mn8r4atnvdqogy8ehjoepkmttmw25pz62w@contacts.idealista.com";
  assert.equal(extractPortalContactEmail(text), "clnava25@gmail.com");
});

test("extractPortalContactEmail ignora assets .png de Fotocasa", () => {
  const text =
    "social_media_icons_on_dark_ic_facebook@2x.png sophie.otten@icloud.com [sophie.otten@icloud.com]";
  assert.equal(extractPortalContactEmail(text), "sophie.otten@icloud.com");
});

test("extractPortalContactName y mensaje Fotocasa chat (Sophie 1721)", () => {
  const chatEmail = [
    "Contacto para Piso en Alquiler en Málaga Capital Málaga con referencia 1721 - De Fotocasa",
    "Buenas noticias, tienes un nuevo mensaje esperándote",
    "Foto del inmueble",
    "1.100 €",
    "NuevoSophie12/06/2026 - 22:26",
    "Somos dos estudiantes de Historia que vamos a realizar un intercambio académico.",
    "Venimos de los Países Bajos y tenemos 20 años.",
    "Teléfono de contacto: 0657727867",
    "Responder [contacto-3Rg1n71jM@chat.fotocasa.es]",
  ].join("\n");

  assert.equal(extractPortalContactName(chatEmail), "Sophie");
  assert.match(sanitizeClientInfoForAgent(chatEmail), /Somos dos estudiantes de Historia/i);
  assert.doesNotMatch(sanitizeClientInfoForAgent(chatEmail), /Foto del inmueble/i);
});

test("extractPortalContactName en bloque Fotocasa con campos pegados (Sophie)", () => {
  const leadEmail = [
    "Contacto para Piso en alquiler en Málaga Capital Málaga con referencia 1721 - De Fotocasa",
    "A Sophie le interesa tu anuncio Piso de alquiler en Málaga Capital Málaga, con referencia 1721",
    "Datos de la persona interesada",
    "Nombre:SophieTeléfono: +340657727867 [tel:+340657727867]Email: sophie.otten@icloud.com",
    "Mensaje: Estoy buscando en Fotocasa y me gustaría recibir más información sobre este inmueble Teléfono de contacto: 0657727867",
  ].join("\n");

  assert.equal(extractPortalContactName(leadEmail), "Sophie");
  assert.equal(extractPortalContactEmail(leadEmail), "sophie.otten@icloud.com");
  assert.equal(
    sanitizeClientInfoForAgent(leadEmail),
    "Estoy buscando en Fotocasa y me gustaría recibir más información sobre este inmueble"
  );
  assert.equal(extractPortalContactPhone(leadEmail), "657727867");
});

test("extractPortalContactPhone ignora 900 Fotocasa cuando el cliente no dio móvil (ljknapp)", () => {
  const email = [
    "Buenas noticias, tienes un nuevo mensaje esperándote",
    "Datos de la persona interesada",
    "Nombre:No especificado.Teléfono:No especificado.Email: ljknapp@knapp.com.mx",
    "Día y hora:2026-07-09 a las 17:02h.",
    "Mensaje: Estoy buscando en Fotocasa y me gustaría recibir más información sobre el inmueble. Referencia 1553",
    "¿Tienes dudas?",
    "Envíanos un email o llámanos al 900 823 825 [tel:+34900823825].",
  ].join("\n");

  assert.equal(extractPortalContactPhone(email), null);
  assert.equal(extractPortalContactName(email), null);
  assert.match(
    sanitizeClientInfoForAgent(email),
    /Estoy buscando en Fotocasa y me gustaría recibir más información/i,
  );
});

test("sanitizeClientInfoForAgent extrae Mensaje de Fotocasa (Azahara)", () => {
  const email = [
    "Datos de la persona interesada",
    "Nombre:\tAzahara",
    "Teléfono:\t+34744783106",
    "Email:\tazaharagarciamolero12@gmail.com",
    "Día y hora:\t2026-06-09 a las 19:42h.",
    "Mensaje:",
    "Hola buenas estaria interesada en verla Referencia 1720 Teléfono de contacto: 744783106",
  ].join("\n");

  const out = sanitizeClientInfoForAgent(email);
  assert.equal(out, "Hola buenas estaria interesada en verla");
});

test("sanitizeClientInfoForAgent extrae nombre y Mensaje completo Fotocasa (Andres)", () => {
  const email = [
    "Acceder a Fotocasa Pro",
    "Buenas noticias, tienes un nuevo contacto de Fotocasa",
    "A Andres le interesa tu anuncio Piso de alquiler en Málaga Capital Málaga, con referencia 1720",
    "Datos de la persona interesada",
    "Nombre: Andres",
    "Teléfono: +34602568111",
    "Email: lopezandy0206@gmail.com",
    "Día y hora: 2026-06-11 a las 22:07h.",
    "Mensaje:",
    "Estoy buscando en Fotocasa y me gustaría recibir más información sobre el inmueble con referencia 1720. Teléfono de contacto: 602568111",
    "WhatsApp Llamar Email Gestionar contacto",
  ].join("\n");

  assert.equal(extractPortalContactName(email), "Andres");
  assert.equal(
    sanitizeClientInfoForAgent(email),
    "Estoy buscando en Fotocasa y me gustaría recibir más información sobre el inmueble con referencia 1720."
  );
});

test("extractPortalContactName extrae nombre compuesto Idealista (Sheena Sharne)", () => {
  const subject =
    "🤩 Nuevo mensaje (con perfil) de Sheena Sharne sobre tu inmueble, con ref: 1731, Piso en Calle Martínez Maldonado";
  assert.equal(extractPortalContactName(subject), "Sheena Sharne");
  assert.equal(extractPortalContactName("Respuesta de Carlos Tapias sobre tu inmueble, Piso en Calle Arango"), "Carlos Tapias");
  assert.equal(extractPortalContactName("🤩 Nuevo mensaje (con perfil) de Leonardo sobre tu inmueble, con ref: 1732"), "Leonardo");
  assert.equal(extractPortalContactName("Nuevo mensaje de angelica sobre tu inmueble, con ref: 1721"), "angelica");
});

test("extractPortalContactName en email Idealista completo (asunto + cuerpo tipo Sheena)", () => {
  const combined = [
    "🤩 Nuevo mensaje (con perfil) de Sheena Sharne sobre tu inmueble, con ref: 1731",
    "idealista.com",
    "Tienes un nuevo mensaje que espera tu respuesta",
    "Sheena Sharne",
    "Ver perfil",
    "603 99 29 69 [tel:+34603992969]",
    "sheenasharne@gmail.com",
    "Hi, I'm interested in this flat and would like to arrange a viewing",
    "Responder desde idealista",
  ].join("\n");
  assert.equal(extractPortalContactName(combined), "Sheena Sharne");
});

test("sanitizeClientInfoForAgent extrae bloque MENSAJE de pisos.com (Abdorrahman 1720)", () => {
  const email = [
    "Un interesado te ha contactado por WhatsApp por tu Estudio en Calle de Casarabonela, Ref: 1720",
    "Si, por causas ajenas a pisos.com, no has recibido ningún mensaje de WhatsApp en el número 672 594 724",
    "Datos del interesado/a",
    "NOMBRE Abdorrahman EMAIL locacasanouvaloca1234@gmail.com TELÉFONO 722 268 774",
    "MENSAJE",
    "“Estoy interesado/a en su Estudio de 42 m², 1 habitación y 900€/mes en San Rafael-Tiro de Pichón (Distrito Cruz de Humilladero. Málaga Capital).”",
    "GESTIONAR LA SOLICITUD",
  ].join("\n");

  const out = sanitizeClientInfoForAgent(email);
  assert.match(out, /Estoy interesado\/a en su Estudio de 42 m²/i);
  assert.doesNotMatch(out, /672 594 724/i);
  assert.doesNotMatch(out, /mensaje de WhatsApp/i);
});

test("sanitizeClientInfoForAgent sigue extrayendo mensaje etiquetado en pisos.com", () => {
  const text =
    "Datos del interesado Nombre: Ana Pérez Teléfono: 612345678 Mensaje: Quiero visitar el piso el sábado por la mañana Referencia: 1234";
  const out = sanitizeClientInfoForAgent(text);
  assert.match(out, /Quiero visitar el piso el sábado/i);
});

test("isGarbageClientInfo rechaza texto del bot y boilerplate de portales", () => {
  assert.equal(
    isGarbageClientInfo("He encontrado estas opciones: • Piso (ref. 1720) ¿Cuál te interesa?"),
    true
  );
  assert.equal(isGarbageClientName("He encontrado estas"), true);
  assert.equal(isGarbageClientInfo("Hoy me llamas"), true);
  assert.equal(isGarbageClientInfo("Tienes un nuevo mensaje que espera tu respuesta Andrii Ver perfil"), true);
  assert.equal(isGarbageClientInfo("Me gustaría hacer una visita"), false);
});

test("sanitizeClientInfoForAgent no devuelve boilerplate sin mensaje real", () => {
  const email =
    "Tienes un nuevo mensaje que espera tu respuesta Nuevo mensaje de Juan sobre tu inmueble Ver perfil Responder desde idealista";
  const out = sanitizeClientInfoForAgent(email);
  assert.equal(out, "");
});
