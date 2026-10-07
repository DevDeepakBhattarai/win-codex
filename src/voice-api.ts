import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseConversationUrl, type RalphRegistry, type SupportCommandBus } from "./chatgpt-support.js";

const voiceAction = z.enum(["status", "start", "stop", "mute", "unmute"]);
type VoiceAction = z.infer<typeof voiceAction>;
const newChatUrl = "https://chatgpt.com/";

export function createVoiceApi(input: { token: string; registry: RalphRegistry; commands: SupportCommandBus; observeAudio?: (tabId: number, conversationUrl: string) => Promise<void> }) {
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

	const execute = async (action: VoiceAction, targetUrl: string, discover = false) => {
		const result = await input.commands.execute({ feature: "voice", kind: `voice_${action}`, targetUrl, discover }, action === "status" ? 5_000 : 90_000);
		if (!result.ok) throw new Error(result.error);
		if ((result.kind !== "voice_status" && result.kind !== "voice_start" && result.kind !== "voice_stop" && result.kind !== "voice_mute" && result.kind !== "voice_unmute") || result.kind !== `voice_${action}`) {
			throw new Error("Voice received the wrong support command result.");
		}
		const observedUrl = result.result.conversationUrl;
		const provisional = /^https:\/\/chatgpt\.com\/c\/local-chatgpt%3A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(observedUrl);
		if (observedUrl !== newChatUrl && !provisional) await input.registry.validateVoiceConversation(observedUrl);
		if (!discover && observedUrl !== targetUrl) {
			throw new Error("Voice command returned a different conversation.");
		}
		if (action !== "status" && result.result.status !== (action === "stop" ? "closed" : "active")) {
			throw new Error("ChatGPT did not confirm the requested Voice state.");
		}
		if ((action === "start" || action === "mute" || action === "unmute") && result.result.microphone !== (action === "mute" ? "muted" : "unmuted")) {
			throw new Error("ChatGPT did not confirm the requested microphone state.");
		}
		if ((action === "start" || action === "unmute") && input.observeAudio) {
			if (result.result.tabId === undefined) throw new Error("Reload Local Codex Support to enable Voice audio monitoring.");
			await input.observeAudio(result.result.tabId, observedUrl);
		}
		if (discover && observedUrl !== newChatUrl && !provisional && input.registry.voiceConversationUrl() !== observedUrl) {
			await input.registry.setVoiceConversation(observedUrl);
			input.commands.cancelThreadChecks(parseConversationUrl(observedUrl).threadId);
		}
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
	const control = async (action: VoiceAction) => {
		if (busy) return { ok: false, status: 409, error: "A Voice operation is already in progress." } as const;
		busy = true;
		try { return { ok: true, result: await execute(action, newChatUrl, true) } as const; }
		catch (error) { return { ok: false, status: 503, error: error instanceof Error ? error.message : String(error) } as const; }
		finally { busy = false; }
	};
	router.post("/:action", async (req, res) => {
		const parsed = voiceAction.safeParse(req.params.action);
		if (!parsed.success) { res.status(400).json({ error: "Expected status, start, stop, mute, or unmute." }); return; }
		if (!z.object({}).strict().safeParse(req.body ?? {}).success) { res.status(400).json({ error: "Voice actions do not accept a request body." }); return; }
		const result = await control(parsed.data);
		if (result.ok) res.json(result.result);
		else res.status(result.status).json({ error: result.error });
	});
	return { router, control };
}

export function registerVoiceTool(server: McpServer, voice: ReturnType<typeof createVoiceApi>) {
	server.registerTool("chatgpt_voice", {
		title: "Control ChatGPT Voice call",
		description: "Control ChatGPT Voice in Chrome. Start reuses an open Voice tab and unmutes an active call, or opens a fresh chat if no Voice tab remains. Mute and unmute change the microphone without ending the call. Stop ends the call only when the user asks to disconnect. Status inspects the current call. All changes require browser confirmation. Say the local Jarvis or Nova wake word, or use Start Voice in Super App, to resume after muting or disconnecting.",
		inputSchema: { action: voiceAction },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, async ({ action }) => {
		const result = await voice.control(action);
		if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
		return { content: [{ type: "text", text: JSON.stringify(result.result) }], structuredContent: result.result };
	});
}
