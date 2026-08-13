import { config } from "../config.js";
import { pickAgent, type AgentContact } from "../agents/assignment.js";
import {
  searchProperties,
  updatePropertyAgentMeta,
  type PropertyRow,
} from "./properties.js";
import { scrapePropertyPage } from "../scraper/propertyPage.js";

function hasAgentMeta(property: PropertyRow): boolean {
  return Boolean(property.agent_name?.trim() && property.agent_phone?.trim());
}

/** Rellena agente desde meta bazan:agent-* de la ficha si falta en BD (scrape desactualizado). */
export async function enrichPropertyWithAgent(property: PropertyRow): Promise<PropertyRow> {
  if (hasAgentMeta(property)) return property;
  try {
    const scraped = await scrapePropertyPage(config.scrapeTargetUrl, property.ref);
    if (scraped?.agent_name?.trim() && scraped.agent_phone?.trim()) {
      updatePropertyAgentMeta(
        property.ref,
        scraped.agent_name.trim(),
        scraped.agent_phone.replace(/\D+/g, ""),
        scraped.agent_user_id ?? null
      );
      return {
        ...property,
        agent_name: scraped.agent_name.trim(),
        agent_phone: scraped.agent_phone.replace(/\D+/g, ""),
        agent_user_id: scraped.agent_user_id ?? null,
      };
    }
  } catch (e) {
    console.warn("[property] No se pudo refrescar agente de ficha", { ref: property.ref, error: e });
  }
  return property;
}

export async function loadPropertyByRef(ref: string): Promise<PropertyRow | undefined> {
  const row = searchProperties({ ref, limit: 1 })[0];
  if (!row) return undefined;
  return enrichPropertyWithAgent(row);
}

/** Comercial según ficha scrapeada en BD (meta bazan:agent-*). */
export async function resolveAssignedAgent(
  intent: "A" | "B" | "C",
  ref: string | null,
  property?: PropertyRow | null
): Promise<AgentContact> {
  if (property) {
    const enriched = await enrichPropertyWithAgent(property);
    const agent = pickAgent(intent, ref ?? enriched.ref, enriched);
    console.log("[agent] Comercial desde ficha/BD", {
      ref: ref ?? enriched.ref,
      agent: agent.name,
      phone: agent.phone,
      scrapedName: enriched.agent_name ?? null,
      scrapedPhone: enriched.agent_phone ?? null,
    });
    return agent;
  }
  if (ref) {
    const loaded = await loadPropertyByRef(ref);
    if (loaded) {
      const agent = pickAgent(intent, ref, loaded);
      console.log("[agent] Comercial desde ficha/BD (por ref)", {
        ref,
        agent: agent.name,
        scrapedName: loaded.agent_name ?? null,
      });
      return agent;
    }
  }
  const agent = pickAgent(intent, ref, null);
  console.warn("[agent] Comercial sin ficha (fallback .env o BD)", { ref, intent, agent: agent.name });
  return agent;
}
