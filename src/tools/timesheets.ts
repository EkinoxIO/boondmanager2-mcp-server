import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ResourceTimesheetSchema,
  TimesheetSearchSchema,
  TimesheetGetSchema,
  TimesReportUpdateSchema,
} from "../schemas/index.js";
import type { ResourceTimesheetInput, TimesheetSearchInput, TimesheetGetInput } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody, MutationOutputSchema } from "./crud-factory.js";
import {
  buildExceptionalTimesPayload,
  buildRegularTimesPayload,
  existingCollection,
  requiresReadBeforeWrite,
} from "./timesheet-merge.js";
import { logger } from "../services/logger.js";
import { CHARACTER_LIMIT } from "../constants.js";
import type { JsonApiResponse } from "../types.js";
import { z } from "zod";

const TimesheetCreateSchema = z
  .object({
    resourceId: z.string().min(1).describe("ID de la ressource"),
    projectId: z.string().optional().describe("ID du projet"),
    term: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Mois au format YYYY-MM"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    totalDays: z.number().optional().describe("Total jours"),
    totalHours: z.number().optional().describe("Total heures"),
    state: z.string().optional().describe("État de la feuille de temps"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

/**
 * Build the PUT attributes for a timesheet update.
 *
 * `regularTimes` / `exceptionalTimes` / `workplaceTimes` **replace** their
 * collection server-side, so an update that sends only the caller's entries
 * deletes every other day on the timesheet. This reads the timesheet and sends
 * the union: all stored entries, plus the caller's changes merged on top (same
 * activity → existing `row`; same activity and day → existing entry id, so the
 * incoming duration replaces the stored one).
 *
 * The read is mandatory. If it fails we must NOT fall through to a raw
 * passthrough — that would wipe the timesheet — so the error propagates.
 */
async function buildTimesReportAttributes(
  id: string,
  attrs: Record<string, unknown>
): Promise<{ attrs: Record<string, unknown>; notes: string[] }> {
  if (!requiresReadBeforeWrite(attrs)) return { attrs, notes: [] };

  let current;
  try {
    current = await apiRequest(`/times-reports/${id}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err: reason, timesReportId: id }, "Aborting timesheet update: could not read current state");
    throw new Error(
      `Impossible de lire la feuille de temps #${id} avant modification : ${reason}\n` +
        "Mise à jour annulée — l'API BoondManager remplace la collection de temps, " +
        "écrire sans relire supprimerait les temps existants.",
      { cause: err }
    );
  }

  const notes: string[] = [];
  const resolved = { ...attrs };

  if (Array.isArray(attrs.regularTimes)) {
    const { entries, stats } = buildRegularTimesPayload(current, attrs.regularTimes);
    resolved.regularTimes = entries;
    notes.push(`${stats.preserved} temps existant(s) conservé(s)`);
    if (stats.appended > 0) notes.push(`${stats.appended} journée(s) ajoutée(s)`);
    if (stats.reusedRows > 0) notes.push(`${stats.reusedRows} temps rattaché(s) à une activité existante`);
    if (stats.newRows > 0) notes.push(`${stats.newRows} nouvelle(s) ligne(s) d'activité`);
    if (stats.replaced > 0) notes.push(`${stats.replaced} journée(s) déjà saisie(s) remplacée(s)`);
    if (stats.dropped > 0) {
      notes.push(`⚠️ ${stats.dropped} temps existant(s) non réémis (ligne non identifiable) — vérifier le CRA`);
    }
  }

  if (Array.isArray(attrs.exceptionalTimes)) {
    const { entries, replaced, preserved } = buildExceptionalTimesPayload(current, attrs.exceptionalTimes);
    resolved.exceptionalTimes = entries;
    notes.push(`${preserved} temps exceptionnel(s) conservé(s)`);
    if (replaced > 0) notes.push(`${replaced} temps exceptionnel(s) mis à jour`);
  } else {
    // Echo the untouched collections: only `regularTimes` is proven to be left
    // alone when absent, so don't gamble with the others.
    const kept = existingCollection(current, "exceptionalTimes");
    if (kept.length > 0) resolved.exceptionalTimes = kept;
  }

  if (!Array.isArray(attrs.workplaceTimes)) {
    const kept = existingCollection(current, "workplaceTimes");
    if (kept.length > 0) resolved.workplaceTimes = kept;
  }

  return { attrs: resolved, notes };
}

function formatTimesheetSummary(response: JsonApiResponse): string {
  const data = Array.isArray(response.data) ? response.data : [response.data];

  if (data.length === 0) {
    return "Aucune feuille de temps trouvée.";
  }

  const lines = data.map((item) => {
    const attrs = item.attributes;
    const parts: string[] = [`[timesreport #${item.id}]`];

    if (attrs.startDate) parts.push(`Du: ${attrs.startDate}`);
    if (attrs.endDate) parts.push(`Au: ${attrs.endDate}`);
    if (attrs.state !== undefined) parts.push(`Statut: ${attrs.state}`);
    if (attrs.totalDays !== undefined) parts.push(`Jours: ${attrs.totalDays}`);
    if (attrs.totalHours !== undefined) parts.push(`Heures: ${attrs.totalHours}`);

    return parts.join(" | ");
  });

  const total = response.meta?.totals?.rows;
  let result = lines.join("\n");

  if (total !== undefined) {
    result = `Total: ${total} feuille(s) de temps\n\n${result}`;
  }

  if (result.length > CHARACTER_LIMIT) {
    result = result.substring(0, CHARACTER_LIMIT) + "\n\n[Résultats tronqués...]";
  }

  return result;
}

export function registerTimesheetTools(server: McpServer): void {
  server.registerTool(
    "boond_timesheets_create",
    {
      title: "Créer une feuille de temps",
      description: "Crée une feuille de temps mensuelle liée à une ressource.",
      inputSchema: TimesheetCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { resourceId, projectId, ...attrs } = params;
      const body = buildJsonApiBody("timesreport", attrs);
      const relationships: Record<string, unknown> = {};
      if (resourceId) relationships.resource = { data: { id: resourceId, type: "resource" } };
      if (projectId) relationships.project = { data: { id: projectId, type: "project" } };
      if (Object.keys(relationships).length > 0) {
        (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
      }
      const response = await apiRequest("/times-reports", "POST", body);
      const text = formatDetailResponse(response);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          { type: "text" as const, text: `✅ Feuille de temps créée avec succès.\nID: ${entity?.id}\n\n${text}` },
        ],
      };
    }
  );

  // Get timesheets for a specific resource
  server.registerTool(
    "boond_resources_timesheets",
    {
      title: "Feuilles de temps d'une ressource",
      description: `Récupère les feuilles de temps (times reports) d'une ressource par son ID, avec filtre optionnel par mois/année.

Args:
  - resourceId (string): ID de la ressource
  - month (number, optional): Mois (1-12), défaut: mois courant
  - year (number, optional): Année (ex: 2025), défaut: année courante

Returns: Liste des feuilles de temps de la ressource avec jours/heures et statut.`,
      inputSchema: ResourceTimesheetSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ResourceTimesheetInput) => {
      const queryParams: Record<string, string | number | undefined> = {};
      if (params.month !== undefined) queryParams["month"] = params.month;
      if (params.year !== undefined) queryParams["year"] = params.year;

      const response = await apiRequest(`/resources/${params.resourceId}/times-reports`, "GET", undefined, queryParams);
      const text = formatTimesheetSummary(response);
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  // Search all timesheets
  server.registerTool(
    "boond_timesheets_search",
    {
      title: "Rechercher des feuilles de temps",
      description: `Recherche des feuilles de temps (CRA mensuels) dans BoondManager.

⚠️ \`startMonth\` et \`endMonth\` (format YYYY-MM) sont requis par l'API — passer YYYY-MM-DD ou les omettre renvoie un 422.

Args:
  - startMonth (string, requis): Mois de début YYYY-MM (ex: '2025-01')
  - endMonth (string, requis): Mois de fin YYYY-MM (ex: '2025-03')
  - keywords (string, optional): Mots-clés
  - page (number): Numéro de page (défaut: 1)
  - pageSize (number): Résultats par page (défaut: 30)

Returns: Liste des feuilles de temps correspondantes.`,
      inputSchema: TimesheetSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: TimesheetSearchInput) => {
      const query = buildSearchQuery(params);
      const response = await apiRequest("/times-reports", "GET", undefined, query);
      const text = formatTimesheetSummary(response);
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  // Get a specific timesheet by ID
  server.registerTool(
    "boond_timesheets_get",
    {
      title: "Détails d'une feuille de temps",
      description: `Récupère les informations détaillées d'une feuille de temps par son ID.

Args:
  - id (string): Identifiant unique de la feuille de temps

Returns: Données JSON complètes de la feuille de temps (jours, heures, statut, détails).`,
      inputSchema: TimesheetGetSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: TimesheetGetInput) => {
      const response = await apiRequest(`/times-reports/${params.id}`);
      const text = formatDetailResponse(response);
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  // Not registered through the crud factory: the body must be reconciled with
  // the timesheet's existing activity lines (async) before the PUT, which the
  // factory's synchronous `buildBody` hook cannot do. BoondManager expects PUT
  // (not PATCH) on /times-reports.
  server.registerTool(
    "boond_timesheets_update",
    {
      title: "Modifier une feuille de temps",
      description: `Met à jour une feuille de temps (CRA) existante. Seuls les champs fournis sont modifiés.

⚠️ L'API remplace la collection \`regularTimes\` : n'envoyer que ses propres temps supprimerait tous les autres. L'outil relit donc la feuille et renvoie l'union (temps existants + modifications demandées) — ne pas contourner en réémettant soi-même toute la feuille.

Une activité identique (même \`workUnitType.reference\` + \`delivery\` + \`batch\` + \`project\`) réutilise sa ligne existante au lieu d'en créer une nouvelle : laisser \`row\` vide, le serveur le résout ; \`row >= 1\` force une ligne précise. Si la journée est déjà saisie sur cette ligne, la durée fournie remplace celle enregistrée.

Returns: Données mises à jour de la feuille de temps.`,
      inputSchema: TimesReportUpdateSchema,
      outputSchema: MutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { id, ...rawAttrs } = params;
      const { attrs, notes } = await buildTimesReportAttributes(id, rawAttrs as Record<string, unknown>);
      const body = buildJsonApiBody("timesreport", attrs, id);
      const response = await apiRequest(`/times-reports/${id}`, "PUT", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      const summary = notes.length > 0 ? `\n${notes.join("\n")}\n` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ feuille de temps #${id} mise à jour.\n${summary}\n${formatDetailResponse(response)}`,
          },
        ],
        structuredContent: { id, ...(entity?.type !== undefined ? { type: String(entity.type) } : {}) },
      };
    }
  );
}
