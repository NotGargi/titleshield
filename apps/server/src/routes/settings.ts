import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireActor } from "../http/auth.ts";
import { getSecret, mask, setSecret } from "../settings.ts";
import { testTinyFish, usageToday } from "../tinyfish/client.ts";
import { testGemini } from "../docai/gemini.ts";
import { config } from "../config.ts";

/**
 * Settings: save the free API keys from the browser. Admins can always change them;
 * while no TinyFish key exists yet, any signed-in user may add one (first-run setup).
 */
export async function settingsRoutes(app: FastifyInstance) {
  const view = async () => {
    const tf = await getSecret("TINYFISH_API_KEY"), gm = await getSecret("GEMINI_API_KEY");
    return {
      tinyfish: { configured: !!tf.value, source: tf.source, masked: mask(tf.value), getKeyUrl: "https://agent.tinyfish.ai/api-keys", usage: await usageToday().catch(() => null),
        limits: { searchPerMinute: config.TINYFISH_SEARCH_PER_MIN, searchPerHour: config.TINYFISH_SEARCH_PER_HOUR, fetchPerMinute: config.TINYFISH_FETCH_PER_MIN, fetchPerDay: config.TINYFISH_FETCH_PER_DAY } },
      gemini: { configured: !!gm.value, source: gm.source, masked: mask(gm.value), model: config.GEMINI_MODEL, getKeyUrl: "https://aistudio.google.com/apikey" }
    };
  };

  async function canEdit(req: any) {
    const actor = requireActor(req);
    if (actor.role === "ADMIN") return actor;
    if (!(await getSecret("TINYFISH_API_KEY")).value) return actor;
    throw new HttpError(403, "Only an admin can change the API keys. Sign in as admin@demo.in.");
  }

  app.get("/api/v1/settings", async (req) => { requireActor(req); return view(); });

  app.put("/api/v1/settings", async (req) => {
    const actor = await canEdit(req);
    const b = z.object({ tinyfishApiKey: z.string().max(400).optional(), geminiApiKey: z.string().max(400).optional() }).parse(req.body);
    if (b.tinyfishApiKey !== undefined) await setSecret("TINYFISH_API_KEY", b.tinyfishApiKey.trim(), actor.userId);
    if (b.geminiApiKey !== undefined) await setSecret("GEMINI_API_KEY", b.geminiApiKey.trim(), actor.userId);
    return view();
  });

  app.post("/api/v1/settings/test", async (req) => {
    requireActor(req);
    const { service } = z.object({ service: z.enum(["tinyfish", "gemini"]) }).parse(req.body);
    try {
      return service === "tinyfish" ? await testTinyFish() : await testGemini();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
