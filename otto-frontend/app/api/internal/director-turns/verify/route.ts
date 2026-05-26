import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import {
  readDirectorSessionVerification,
  resolveDirectorSessionContext,
} from "@/lib/interview/director/turn-transaction";
import { apiError, apiJson, readJsonWithHash } from "@/lib/http/json";

export const runtime = "nodejs";

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
}).strict();

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const { json } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveDirectorSessionContext(body.capture_session_id);
    return apiJson({
      verification: await readDirectorSessionVerification(context),
    });
  } catch (error) {
    return apiError(error);
  }
}
