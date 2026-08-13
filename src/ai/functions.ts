import type OpenAI from "openai";

export const searchPropertiesTool: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_properties",
    description:
      "Buscar inmuebles publicados por Mambo Inmobiliaria (catálogo Idealista: Vélez-Málaga, Torre del Mar y Costa del Sol Oriental). Úsala cuando el usuario pida propiedades, las más baratas, precios, zonas, habitaciones, tipo, alquiler o venta. transaction_type: Venta, Alquiler, Traspaso, Alquiler Vacacional o Reformas.",
    parameters: {
      type: "object",
      properties: {
        transaction_type: {
          type: "string",
          description: "Tipo de operación",
          enum: ["Venta", "Alquiler", "Traspaso", "Alquiler Vacacional", "Reformas"],
        },
        property_type: {
          type: "string",
          description:
            "Tipo de inmueble en español (ej: Piso, Chalet, Local, Garaje, Terreno). Coincidencia parcial.",
        },
        max_price: { type: "number", description: "Precio máximo (número, sin símbolos)" },
        min_price: { type: "number", description: "Precio mínimo" },
        min_bedrooms: { type: "number", description: "Mínimo de dormitorios/habitaciones (no usar para excluir estudios; preferir property_type Estudio)" },
        location_contains: {
          type: "string",
          description:
            "Texto de zona (ej: Vélez-Málaga, Torre del Mar, Almayate, Periana). Si pide las más baratas sin zona, omite este campo.",
        },
        features_any: {
          type: "array",
          items: { type: "string" },
          description:
            "Lista de características; se busca si la propiedad incluye alguna (ej: terraza, piscina, garaje)",
        },
        ref: {
          description:
            "Referencia exacta del anuncio (Idealista, 6–12 dígitos, ej: 111673415). Usa solo este campo para una ref concreta; no mezcles otros filtros.",
          oneOf: [{ type: "string" }, { type: "integer" }],
        },
        limit: { type: "number", description: "Máximo de resultados (por defecto 10, máx 25)" },
      },
    },
  },
};
