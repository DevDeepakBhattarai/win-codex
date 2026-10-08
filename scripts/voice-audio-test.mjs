import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const listeners = new Map();
const events = [];
let sample;
let captures = 0;
let stops = 0;
let closes = 0;
let inputLevel = 0;
let reports = [];
const stream = () => {
	const track = { readyState: "live", stop() { this.readyState = "ended"; stops++; } };
	return { getTracks: () => [track], getAudioTracks: () => [track] };
};
const window = {
	addEventListener(type, listener) { listeners.set(type, listener); },
	postMessage(event) { events.push(event); },
};
const context = vm.createContext({
	window, location: { origin: "https://chatgpt.com" }, Float32Array, Set, Map, Proxy, Reflect,
	navigator: { mediaDevices: { async getUserMedia() { captures++; return stream(); } } },
	AudioContext: class {
		state = "running";
		createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(samples) { samples.fill(inputLevel); } }; }
		createMediaStreamSource() { return { connect() {} }; }
		async resume() {}
		async close() { closes++; }
	},
	RTCPeerConnection: class {
		connectionState = "connected";
		async getStats() { return new Map(reports.map(report => [report.id, report])); }
	},
	setInterval(callback) { sample = callback; },
});
vm.runInContext(await readFile("support-extension/voice-audio.js", "utf8"), context);
const enable = active => listeners.get("message")({ source: window, data: { type: "local-codex-voice-monitor-v1", active } });
await sample();
assert.equal(captures, 0, "ordinary chats do not open a microphone");
enable(true);
await sample();
await Promise.resolve();
await sample();
assert.equal(captures, 1, "an existing call gets one local audio monitor");
assert.equal(events.at(-1).inputAvailable, true);
assert.equal(events.at(-1).userSpeaking, false);
inputLevel = 0.1;
await sample();
assert.equal(events.at(-1).userSpeaking, true, "local input energy identifies speech");
inputLevel = 0;
vm.runInContext("globalThis.peer = new RTCPeerConnection()", context);
reports = [{ id: "in", type: "inbound-rtp", kind: "audio", audioLevel: 0.1 }];
await sample();
assert.equal(events.at(-1).assistantSpeaking, true, "received audio energy identifies assistant playback");
reports = [{ id: "in", type: "inbound-rtp", kind: "audio", audioLevel: 0 }];
await sample();
assert.equal(events.at(-1).assistantSpeaking, false);
reports = [{ id: "in", type: "inbound-rtp", kind: "audio", totalAudioEnergy: 1, totalSamplesDuration: 1 }];
await sample();
reports = [{ id: "in", type: "inbound-rtp", kind: "audio", totalAudioEnergy: 1.01, totalSamplesDuration: 2 }];
await sample();
assert.equal(events.at(-1).assistantSpeaking, true, "stats without audioLevel use the energy delta");
enable(false);
await sample();
assert.equal(stops, 1, "ending Voice releases only the monitor-owned microphone");
assert.equal(closes, 1);
enable(true);
const callStream = await context.navigator.mediaDevices.getUserMedia({ audio: true });
await sample();
enable(false);
assert.equal(callStream.getAudioTracks()[0].readyState, "live", "monitor cleanup never stops ChatGPT's microphone");
assert.equal(stops, 1);
console.log("Voice audio passed: input and playback energy, stats fallback, idle capture exclusion, and stream ownership.");
