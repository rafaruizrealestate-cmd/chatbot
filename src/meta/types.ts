export type MetaInboundChannel =
  | "whatsapp_cloud"
  | "messenger"
  | "instagram_dm"
  | "facebook_comment"
  | "instagram_comment";

/** Evento normalizado listo para dedup + processIncomingText + envío. */
export type NormalizedMetaInbound = {
  channel: MetaInboundChannel;
  /** Clave única para deduplicación (mid, wa msg id, comment id…). */
  dedupKey: string;
  /** Clave de conversación en SQLite (namespaced salvo WhatsApp dígitos). */
  conversationKey: string;
  /** Texto del usuario; vacío si solo hay audio (Cloud API). */
  text: string;
  /** WhatsApp Cloud: id de media para descargar nota de voz (type audio). */
  whatsappAudioMediaId?: string;
  customerDisplayId: string;
  /** URL o texto corto para avisos a agentes */
  threadHint?: string;
  /** Datos mínimos para el sender Graph API */
  sendTarget:
    | { kind: "whatsapp_cloud"; waId: string }
    | { kind: "messenger"; psid: string }
    | { kind: "instagram_dm"; igsid: string }
    | { kind: "facebook_comment"; commentId: string }
    | { kind: "instagram_comment"; commentId: string };
};
