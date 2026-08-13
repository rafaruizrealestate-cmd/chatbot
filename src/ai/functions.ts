import type OpenAI from "openai";

export const searchPropertiesTool: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_properties",
    description:
      "Buscar inmuebles publicados por Inmobiliaria Bazán. Usa esta herramienta cuando el usuario pida propiedades, precios, zonas, habitaciones, tipo de inmueble, alquiler o venta. Los valores de transaction_type deben ser exactamente: Venta, Alquiler, Traspaso, Alquiler Vacacional o Reformas (como en la web).",
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
          description: "Texto que debe aparecer en la zona o ubicación (ej: Centro, Soho, Perchel)",
        },
        features_any: {
          type: "array",
          items: { type: "string" },
          description:
            "Lista de características; se busca si la propiedad incluye alguna (ej: terraza, piscina, garaje)",
        },
        ref: {
          description:
            "Referencia exacta del anuncio (ej: 1616). Usa solo este campo para consultar una ref concreta; no mezcles otros filtros.",
          oneOf: [{ type: "string" }, { type: "integer" }],
        },
        limit: { type: "number", description: "Máximo de resultados (por defecto 10, máx 25)" },
      },
    },
  },
};
