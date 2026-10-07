(() => {
  if (globalThis.__localCodexVoiceAudio) return;
  const peers = new Set();
  const Peer = globalThis.RTCPeerConnection;
  globalThis.__localCodexVoiceAudio = {
    registerPeers(existing) {
      for (const peer of existing) if (peer instanceof Peer && peer.connectionState !== "closed") peers.add(peer);
      return peers.size;
    },
  };
  if (Peer) globalThis.RTCPeerConnection = new Proxy(Peer, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peers.add(peer);
      return peer;
    },
  });

  let enabled = false;
  let stream;
  let context;
  let analyser;
  let samples;
  let opening = false;
  let sampling = false;
  let generation = 0;
  const energy = new Map();
  const getUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
  // Use the call's echo-cancelled input when it becomes available.
  if (getUserMedia) navigator.mediaDevices.getUserMedia = async (...args) => {
    const captured = await getUserMedia(...args);
    if (enabled && args[0]?.audio && captured.getAudioTracks().length) {
      try { attach(captured, false); } catch { detach(); }
    }
    return captured;
  };
  let ownsStream = false;
  function detach() {
    if (ownsStream) stream?.getTracks().forEach(track => track.stop());
    void context?.close().catch(() => {});
    stream = context = analyser = samples = undefined;
    ownsStream = false;
  }
  function attach(captured, owned) {
    detach();
    stream = captured;
    ownsStream = owned;
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    samples = new Float32Array(analyser.fftSize);
    void context.resume().catch(() => {});
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "local-codex-voice-monitor-v1" || typeof event.data.active !== "boolean") return;
    if (enabled === event.data.active) return;
    enabled = event.data.active;
    generation++;
    if (!enabled) { detach(); energy.clear(); }
  });

  function speaking(report) {
    if (typeof report.audioLevel === "number") return report.audioLevel >= 0.015;
    const previous = energy.get(report.id);
    energy.set(report.id, { energy: report.totalAudioEnergy, duration: report.totalSamplesDuration });
    const duration = report.totalSamplesDuration - previous?.duration;
    return duration > 0 && Math.sqrt(Math.max(0, report.totalAudioEnergy - previous.energy) / duration) >= 0.015;
  }
  setInterval(async () => {
    if (!enabled || sampling) return;
    sampling = true;
    const currentGeneration = generation;
    try {
      // An already-open call predates this script. Its separate local monitor never sends audio anywhere.
      if (!stream && !opening && getUserMedia) {
        opening = true;
        void getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
          .then(captured => {
            if (enabled && generation === currentGeneration && !stream) {
              try { attach(captured, true); } catch { detach(); }
            }
            else captured.getTracks().forEach(track => track.stop());
          }).catch(() => {}).finally(() => { opening = false; });
      }
      let inputAvailable = Boolean(analyser && context.state === "running" && stream.getAudioTracks().some(track => track.readyState === "live"));
      let userSpeaking = false;
      let assistantSpeaking = false;
      if (inputAvailable) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        userSpeaking = Math.sqrt(sum / samples.length) >= 0.015;
      }
      for (const peer of peers) {
        if (peer.connectionState === "closed") { peers.delete(peer); continue; }
        if (peer.connectionState !== "connected") continue;
        const stats = await peer.getStats();
        stats.forEach(report => {
          if (report.kind !== "audio" && report.mediaType !== "audio") return;
          if (report.type === "media-source") {
            inputAvailable = true;
            userSpeaking ||= speaking(report);
          }
          if (report.type === "inbound-rtp") assistantSpeaking ||= speaking(report);
        });
      }
      if (enabled && generation === currentGeneration) window.postMessage({
        type: "local-codex-voice-activity-v1", inputAvailable, userSpeaking, assistantSpeaking,
      }, location.origin);
    } catch {
      // Missing measurements must never count as silence.
    } finally { sampling = false; }
  }, 100);
})();
