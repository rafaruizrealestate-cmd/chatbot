/** Propietario que quiere que la inmobiliaria gestione SU inmueble (no comprador/inquilino). */
export function isOwnerListingIntent(input: string): boolean {
  const t = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // "sin/con exclusiva": solo lo pregunta quien quiere poner su inmueble a la venta/alquiler.
  if (/\b(con o sin|sin|con)\s+exclusiva\b/.test(t)) return true;

  if (/\b(venta|alquiler) de mi\b/.test(t)) return true;
  if (/\b(mi|su|nuestra?) (piso|casa|chalet|local|inmueble|propiedad|vivienda|nave|parcela|terreno)\b/.test(t) &&
    /\b(vend|alquil|arrend|traspas|gestion|poner|pongo|tasa|valora)\w*/.test(t)) {
    return true;
  }
  // Verbos de venta/traspaso: casi siempre propietario (el comprador dice "comprar").
  if (
    /\b(vendo|vender|traspas\w*|propietari[oa]|arrendar mi|alquilar mi|alquilo mi|poner en (venta|alquiler))\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "se puede / quiero / cómo / me gustaría ... vender|alquilar (con vosotros)"
  if (
    /\b(se puede|puedo|podria|quiero|querria|me gustaria|deseo|necesito|como|interesad[oa] en)\b[^.?!]{0,40}\b(vend\w*|traspas\w*)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "vender/alquilar con vosotros / con la inmobiliaria / con bazan"
  if (
    /\b(vend\w*|alquil\w*|traspas\w*|gestion\w*)\b[^.?!]{0,40}\b(con (vosotros|ustedes|usted|la inmobiliaria|inmobiliaria|bazan))\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(tengo|teng[oa]) .{0,50}\b(para|que) (vender|alquilar|traspasar)\b/.test(t)) {
    return true;
  }
  if (/\b(gestion(ar|a|amos|en)|poner|pongo) (la |el )?(venta|alquiler|piso|casa)\b/.test(t)) {
    return true;
  }
  return false;
}

export type LeadIntent = "A" | "B" | "C";

/**
 * Intent de lead para asignación de comercial: A=alquiler, B=venta, C=propietario.
 * La operación de la ficha (si existe) prevalece sobre heurísticas del texto.
 */
export function resolveLeadIntent(
  property: { transaction_type?: string | null } | undefined,
  text: string,
): LeadIntent {
  const tx = (property?.transaction_type ?? "").toLowerCase();
  if (tx.includes("alquiler")) return "A";
  if (tx.includes("venta")) return "B";

  if (/€\s*\/\s*mes\b/i.test(text) || /\d{1,3}(?:[.\s]\d{3})?\s*€\s*\/\s*mes/i.test(text)) {
    return "A";
  }

  if (/\b(habitaci[oó]n|estudio)\b/i.test(text) && !isOwnerListingIntent(text)) {
    return "A";
  }

  const buyer = guessBuyerTransactionType(text);
  if (buyer === "Alquiler") return "A";
  if (buyer === "Venta") return "B";

  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /\b(alquiler|alquilar|arrendatario|inquilino|alquila|inquilin|arrendad|compartir)\b/.test(t) ||
    /\b(for rent|to rent|rental|tenant|looking for a flat)\b/.test(t)
  ) {
    return "A";
  }

  if (isOwnerListingIntent(text)) return "C";
  return "B";
}

/** Operación que busca el cliente (comprar vs alquilar), no confundir con "en venta" del anuncio. */
export function guessBuyerTransactionType(text: string): "Venta" | "Alquiler" | null {
  if (isOwnerListingIntent(text)) return null;
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\b(en venta|para comprar|comprar|compra|quiero comprar)\b/.test(t)) return "Venta";
  if (/\b(en alquiler|para alquilar|busco alquiler|alquilar|alquiler)\b/.test(t)) return "Alquiler";
  return null;
}
