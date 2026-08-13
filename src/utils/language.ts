function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function scoreByWords(input: string, words: string[]): number {
  const t = ` ${normalize(input)} `;
  let score = 0;
  for (const w of words) {
    if (t.includes(` ${w} `)) score++;
  }
  return score;
}

// Heurística simple: suficiente para ES/EN en chats/email.
export function detectLanguage(input: string): "es" | "en" {
  const t = normalize(input);
  if (!t.trim()) return "es";

  const esWords = [
    "hola",
    "buenos",
    "buenas",
    "gracias",
    "por",
    "para",
    "quiero",
    "busco",
    "alquiler",
    "comprar",
    "piso",
    "apartamento",
    "departamento",
    "parcela",
    "terreno",
    "solar",
    "casa",
    "zona",
    "precio",
    "habitaciones",
    "visita",
    "cuando",
    "cuanto",
    "madrid",
    "malaga",
    "telefono",
    "correo",
  ];
  const enWords = [
    "hello",
    "hi",
    "thanks",
    "thank",
    "please",
    "i",
    "we",
    "need",
    "looking",
    "rent",
    "rental",
    "buy",
    "apartment",
    "house",
    "bedroom",
    "area",
    "price",
    "visit",
    "when",
    "how",
    "much",
    "phone",
    "email",
  ];

  const esScore = scoreByWords(t, esWords) + (/[ñ¿¡]/.test(input) ? 2 : 0);
  const enScore = scoreByWords(t, enWords);

  return enScore > esScore ? "en" : "es";
}

