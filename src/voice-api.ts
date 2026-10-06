import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { parseConversationUrl, type RalphRegistry, type SupportCommandBus } from "./chatgpt-support.js";

export function createVoiceApi(input: { token: string; registry: RalphRegistry; commands: SupportCommandBus }) {
	const router = Router();
	let busy = false;
	router.use((req, res, next) => {
		const provided = Buffer.from(req.get("authorization") ?? "");
		const expected = Buffer.from(`Bearer ${input.token}`);
		if (req.get("origin") || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
			res.status(401).json({ error: "Local API bearer token required. Browser-origin requests are not accepted." });
			return;
		}
		res.setHeader("Cache-Control", "no-store");
		next();
	});

	const execute = async (action: "status" | "start" | "stop" | "mute" | "unmute" | "toggle_mute", targetUrl: string) => {
		const result = await input.commands.execute({ feature: "voice", kind: `voice_${action}`, targetUrl }, action === "status" ? 5_000 : 90_000);
		if (!result.ok) throw new Error(result.error);
		if ((result.kind !== "voice_status" && result.kind !== "voice_start" && result.kind !== "voice_stop" && result.kind !== "voice_mute" && result.kind !== "voice_unmute" && result.kind !== "voice_toggle_mute") || result.kind !== `voice_${action}`) {
			throw new Error("Voice received the wrong support command result.");
		}
		if (parseConversationUrl(result.result.conversationUrl).conversationUrl !== targetUrl) {
			throw new Error("Voice command returned a different conversation.");
		}
		if (action !== "status" && result.result.status !== (action === "stop" ? "closed" : "active")) {
			throw new Error("ChatGPT did not confirm the requested Voice state.");
		}
		if ((action === "mute" && result.result.muted !== true) || (action === "unmute" && result.result.muted !== false)
			|| (action === "toggle_mute" && typeof result.result.muted !== "boolean")) throw new Error("ChatGPT did not confirm the requested microphone state.");
		return result.result;
	};

	router.get("/", (_req, res) => res.json({ conversationUrl: input.registry.voiceConversationUrl() ?? null }));
	router.put("/", async (req, res) => {
		const parsed = z.object({ conversationUrl: z.string().url() }).strict().safeParse(req.body);
		if (!parsed.success) { res.status(400).json({ error: "Expected a saved regular ChatGPT conversation URL." }); return; }
		if (busy) { res.status(409).json({ error: "A Voice operation is already in progress." }); return; }
		busy = true;
		let releaseProtection: (() => void) | undefined;
		try {
			const previous = input.registry.voiceConversationUrl();
			const next = await input.registry.validateVoiceConversation(parsed.data.conversationUrl);
			try { releaseProtection = input.commands.protectVoiceConfiguration(next.conversationUrl); }
			catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); return; }
			if (previous && previous !== next.conversationUrl && (await execute("status", previous)).status !== "closed") {
				res.status(409).json({ error: "End the current Voice call before changing its conversation." });
				return;
			}
			await execute("status", next.conversationUrl);
			const conversationUrl = await input.registry.setVoiceConversation(parsed.data.conversationUrl);
			input.commands.cancelThreadChecks(next.threadId);
			res.json({ conversationUrl });
		} catch (error) {
			res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		} finally { releaseProtection?.(); busy = false; }
	});
	router.post("/:action", async (req, res) => {
		const parsed = z.enum(["status", "start", "stop", "mute", "unmute", "toggle_mute"]).safeParse(req.params.action);
		if (!parsed.success) { res.status(400).json({ error: "Unknown Voice action." }); return; }
		if (!z.object({}).strict().safeParse(req.body ?? {}).success) { res.status(400).json({ error: "Voice actions do not accept a request body." }); return; }
		const targetUrl = input.registry.voiceConversationUrl();
		if (!targetUrl) { res.status(409).json({ error: "Configure the Voice conversation first." }); return; }
		if (busy) { res.status(409).json({ error: "A Voice operation is already in progress." }); return; }
		busy = true;
		try { res.json(await execute(parsed.data, targetUrl)); }
		catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : String(error) }); }
		finally { busy = false; }
	});
	return router;
}
