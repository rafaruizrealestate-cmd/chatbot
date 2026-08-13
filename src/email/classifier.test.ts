import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOwnMailboxAddress,
  isOwnMailboxFromHeader,
  suppressAutoReplyReason,
  classifyEmail,
} from "./classifier.js";
import type { FetchedEmail } from "./imapClient.js";

describe("isOwnMailboxAddress", () => {
  it("detecta buzón propio", () => {
    assert.equal(isOwnMailboxAddress("info@inmobiliariabazan.com"), true);
    assert.equal(isOwnMailboxAddress("alvaro@inmobiliariabazan.es"), true);
  });

  it("no marca portales ni clientes", () => {
    assert.equal(isOwnMailboxAddress("cliente@gmail.com"), false);
    assert.equal(isOwnMailboxAddress("noreply@idealista.com"), false);
  });
});

describe("suppressAutoReplyReason — bucle propio", () => {
  it("suprime si el remitente es el buzón de la inmobiliaria", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"Leo - Inmobiliaria Bazán" <info@inmobiliariabazan.com>',
        "Re: Comentarios a contratos",
        "Hola, gracias por escribir",
      ),
      "own_mailbox_loop",
    );
  });

  it("suprime eco de auto-respuesta de Leo en hilo Re:", () => {
    assert.equal(
      suppressAutoReplyReason(
        "cliente@gmail.com",
        "Re: Consulta piso",
        "Hola, soy Leo de Inmobiliaria Bazán. ¿En qué puedo ayudarte?",
      ),
      "own_auto_reply_echo",
    );
  });

  it("no suprime lead legítimo de cliente", () => {
    assert.equal(
      suppressAutoReplyReason(
        "cliente@gmail.com",
        "Consulta ref 1720",
        "Hola, me interesa el piso",
      ),
      null,
    );
  });

  it("suprime informes Control de Duplicados de Idealista", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"idealista" <noresponder@idealista.com>',
        "Control de Duplicados: resumen semanal",
        "Ver informe en http://col.idealista.com/toto",
      ),
      "non_lead_idealista_duplicate_control",
    );
  });

  it("suprime captación B2B inmobiliaria", () => {
    assert.equal(
      suppressAutoReplyReason(
        "info@vipsocial.es",
        "Buenas viviendas con altas comisiones te esperan",
        "No te ayudamos a captar, te damos las viviendas",
      ),
      "advertisement_b2b",
    );
  });

  it("suprime newsletter eGO Real Estate", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"Inmofocus - eGO Real Estate" <noreply@newsletter.egorealestate.com>',
        "¡Nunca más pierdas un lead de tus campañas!",
        "Agendar una demostración",
      ),
      "non_lead_egorealestate_newsletter",
    );
  });

  it("suprime Idealista llamada atendida (no es lead de mensaje)", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"idealista" <noresponder@idealista.com>',
        "Llamada atendida de un interesado en tus anuncios",
        "Teléfono del interesado 600 574 395",
      ),
      "non_lead_idealista_call_attended",
    );
  });

  it("suprime Idealista cambio de precio en favoritos", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"idealista" <noresponder@idealista.com>',
        "Cambio de precio en tus favoritos",
        "Tu favorito ha bajado de precio",
      ),
      "non_lead_idealista_favorites",
    );
  });

  it("suprime Fotocasa inicio de sesión fallido", () => {
    assert.equal(
      suppressAutoReplyReason(
        '"Fotocasa Pro Soporte" <cliente@fotocasa.pro>',
        "Inicio de sesión fallido",
        "Alguien intentó acceder a tu cuenta",
      ),
      "non_lead_fotocasa_login",
    );
  });
});

describe("classifyEmail — extracción cliente", () => {
  it("no usa email logo .png de Fotocasa", () => {
    const email: FetchedEmail = {
      from: '"Fotocasa Pro" <cliente@fotocasa.pro>',
      subject: "Contacto para Piso en alquiler en Málaga Capital Málaga con referencia 1595",
      text: [
        "logo [https://frtassets.fotocasa.es/statics/img/fotocasa_pro_logo_blue_new@2x.png]",
        "Buenas noticias, tienes un nuevo mensaje esperándote",
        "Datos de la persona interesada",
        "Nombre: Marisa",
        "Teléfono: +34632210125",
        "Email: gautomarisa33@gmail.com",
      ].join("\n"),
      html: "",
      messageId: "test-fotocasa-1",
      uid: 1,
      date: null,
      parsed: {
        attachments: [],
        headers: new Map(),
        headerLines: [],
        html: false,
      },
    };
    const c = classifyEmail(email);
    assert.equal(c.customerEmail, "gautomarisa33@gmail.com");
    assert.equal(c.customerName, "Marisa");
    assert.equal(c.customerPhone, "34632210125");
  });

  it("no usa el 900 de atención Fotocasa si el cliente no dio teléfono", () => {
    const email: FetchedEmail = {
      from: '"Fotocasa Pro" <cliente@fotocasa.pro>',
      subject: "Contacto para Piso en alquiler en Málaga Capital Málaga con referencia 1553 - De Fotocasa",
      text: [
        "Datos de la persona interesada",
        "Nombre:No especificado.Teléfono:No especificado.Email: ljknapp@knapp.com.mx",
        "Mensaje: Estoy buscando en Fotocasa y me gustaría recibir más información sobre el inmueble. Referencia 1553",
        "llámanos al 900 823 825 [tel:+34900823825]",
      ].join("\n"),
      html: "",
      messageId: "test-fotocasa-no-phone",
      uid: 2,
      date: null,
      parsed: { attachments: [], headers: new Map(), headerLines: [], html: false },
    };
    const c = classifyEmail(email);
    assert.equal(c.customerPhone, null);
    assert.equal(c.customerEmail, "ljknapp@knapp.com.mx");
    assert.equal(c.customerName, null);
  });
});

describe("isOwnMailboxFromHeader", () => {
  it("extrae dirección entre corchetes", () => {
    assert.equal(
      isOwnMailboxFromHeader('"Leo" <info@inmobiliariabazan.com>'),
      true,
    );
    assert.equal(isOwnMailboxFromHeader("cliente@gmail.com"), false);
  });
});
