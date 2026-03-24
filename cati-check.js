(function () {
  const CONFIG = {
    containerId: "cati-precall-check",
  
    pingUrls: [
      "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png", // primær
      "https://www.cloudflare.com/favicon.ico", // fallback 1
      "https://upload.wikimedia.org/favicon.ico" // fallback 2
    ],
  
    pingIntervalMs: 10000,
    pingTimeoutMs: 2500,
    timeWindowMinutes: 30,
  
    warningLatencyMs: 250,
    severeLatencyMs: 600,
  
    warningJitterMs: 80,
    severeJitterMs: 150,
    jitterSampleSize: 10,
  
    warningLossPercent: 5,
    severeLossPercent: 15,
  
    micRecordSeconds: 7,
    micMinVoiceRms: 0.02,
    micGoodVoiceRms: 0.05,
    micHighVoiceRms: 0.18,
    micNoiseWarnRms: 0.015,
    micNoiseBadRms: 0.03,
    micClipThreshold: 0.98,
    micClipWarnRatio: 0.02,
    notifyCooldownMs: 3 * 60 * 1000,
    minConsecutiveIssuesBeforeNotify: 2,
    titleAlertPrefix: "⚠ ",
    autoAskNotificationPermission: false,
    storageKeys: {
      networkPaused: "catiCheck.networkPaused"
    }
  };

  const state = {
    history: [],
    intervalId: null,
    mediaRecorder: null,
    mediaStream: null,
    audioChunks: [],
    lastAudioUrl: null,
    micSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
    networkPaused: readBool(CONFIG.storageKeys.networkPaused, false),
    lastNotificationAt: 0,
    lastNetworkStatus: "unknown",
    consecutiveIssueCount: 0,
    originalTitle: document.title,
    titleAlertActive: false,
    lastMeasurement: null,
    audioContext: null,
    audioUnlocked: false,
    pingInFlight: false,
    micAnalyser: null,
    micAnalysisFrameId: null,
    micAnalysis: null
  };

  function init() {
    const container = document.getElementById(CONFIG.containerId);
    if (!container) {
      console.warn("[CATI Check] Container not found:", CONFIG.containerId);
      return;
    }

    container.innerHTML = renderWidget();
    bindEvents();

    if (CONFIG.autoAskNotificationPermission) {
      tryAutoRequestNotificationPermission();
    }

    updateNetworkUI();

    if (!state.networkPaused) {
      runPing();
      startNetworkInterval();
    }
  }

  function renderWidget() {
    return `
      <div class="cati-check-minimal">
        <div class="cati-check__grid">
          <div class="cati-card cati-card--network">
            <div class="cati-card__top">
              <div class="cati-card__label">Internettilkobling</div>
              <div class="cati-card__top-right">
                <span id="catiNetworkBadge" class="cati-badge cati-badge--neutral">Ukjent</span>
                <button type="button" id="catiNetworkPauseBtn" class="cati-iconbtn" title="Pause nettverkssjekk" aria-label="Pause nettverkssjekk">×</button>
              </div>
            </div>

            <div id="catiNetworkStatus" class="cati-card__status">Måler tilkobling…</div>
            <div id="catiNetworkDetails" class="cati-card__details">
              Ingen data tilgjengelig ennå.
            </div>

            <div class="cati-meter" aria-hidden="true">
              <div id="catiNetworkBar" class="cati-meter__bar cati-meter__bar--neutral" style="width: 8%"></div>
            </div>

            <div id="catiNetworkMeta" class="cati-card__meta">Sist oppdatert: –</div>
          </div>

          <div class="cati-card cati-card--mic">
            <div class="cati-card__top">
              <div class="cati-card__label">Mikrofon</div>
              <span id="catiMicBadge" class="cati-badge cati-badge--neutral">Ikke testet</span>
            </div>

            <div id="catiMicStatus" class="cati-card__status">Klar for test</div>
            <div id="catiMicDetails" class="cati-card__details">
              Ta opp en kort lydtest. Systemet sjekker nivå og bakgrunnsstøy automatisk.
            </div>

            <div class="cati-mic-actions">
              <button type="button" id="catiMicTestBtn" class="cati-btn">
                Test mikrofon
              </button>

              <audio id="catiMicPlayback" controls class="cati-audio" hidden></audio>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    const micBtn = document.getElementById("catiMicTestBtn");
    const pauseBtn = document.getElementById("catiNetworkPauseBtn");
    const startInterviewBtn = document.getElementById("startInterview");

    if (micBtn) {
      micBtn.addEventListener("click", function () {
        startMicTest();
      });
    }

    if (pauseBtn) {
      pauseBtn.addEventListener("click", function () {
        state.networkPaused = !state.networkPaused;
        writeBool(CONFIG.storageKeys.networkPaused, state.networkPaused);

          if (state.networkPaused) {
            stopNetworkInterval();
          } else {
            runPing();
            startNetworkInterval();
          }

        updateNetworkUI();
      });
    }

    if (startInterviewBtn) {
      startInterviewBtn.addEventListener("click", function () {
        unlockAudio();
        primeInteractionFeatures();
      }, { once: true });
    }
  }

  function startNetworkInterval() {
    stopNetworkInterval();
    state.intervalId = setInterval(runPing, CONFIG.pingIntervalMs);
  }

  function stopNetworkInterval() {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  function trimHistory() {
    const cutoff = Date.now() - CONFIG.timeWindowMinutes * 60 * 1000;
    state.history = state.history.filter(entry => entry.ts >= cutoff);
  }

function calculateNetworkStatus() {
  trimHistory();

  if (!state.history.length) {
    return {
      status: "unknown",
      avgLatency: null,
      lossPercent: null,
      jitterMs: null,
      severeCount: 0,
      score: 8,
      effectiveUrl: null,
      lastMeasurementWasSevere: false
    };
  }

  let okCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let severeCount = 0;

  const successfulMeasurements = [];

  for (const item of state.history) {
    if (item.ok && item.latencyMs != null) {
      okCount++;
      latencySum += item.latencyMs;
      latencyCount++;

      successfulMeasurements.push({
        latencyMs: item.latencyMs,
        effectiveUrl: item.effectiveUrl || null
      });
    }

    const isSevere =
      !item.ok ||
      item.timedOut ||
      (item.latencyMs != null && item.latencyMs > CONFIG.severeLatencyMs);

    if (isSevere) severeCount++;
  }

  const sampleCount = state.history.length;
  const lossPercent = sampleCount ? 100 - (okCount / sampleCount) * 100 : null;
  const avgLatency = latencyCount ? latencySum / latencyCount : null;

  const jitterSource = successfulMeasurements.slice(-CONFIG.jitterSampleSize);

  let jitterMs = null;
  if (jitterSource.length >= 2) {
    let diffSum = 0;
    let diffCount = 0;

    for (let i = 1; i < jitterSource.length; i++) {
      const prev = jitterSource[i - 1];
      const curr = jitterSource[i];

      const sameSource = prev.effectiveUrl && curr.effectiveUrl && prev.effectiveUrl === curr.effectiveUrl;

      if (sameSource) {
        diffSum += Math.abs(curr.latencyMs - prev.latencyMs);
        diffCount++;
      }
    }

    if (diffCount >= 1) {
      jitterMs = diffSum / diffCount;
    }
  }

  const last = state.lastMeasurement;
  const lastMeasurementWasSevere = !!(
    last && (
      !last.ok ||
      last.timedOut ||
      (last.latencyMs != null && last.latencyMs > CONFIG.severeLatencyMs)
    )
  );

  let status = "good";

  if (avgLatency == null) {
    status = "unknown";
  } else if (
    lastMeasurementWasSevere ||
    (lossPercent != null && lossPercent > CONFIG.severeLossPercent) ||
    avgLatency > CONFIG.severeLatencyMs ||
    (jitterMs != null && jitterMs > CONFIG.severeJitterMs)
  ) {
    status = "bad";
  } else if (
    (lossPercent != null && lossPercent > CONFIG.warningLossPercent) ||
    avgLatency > CONFIG.warningLatencyMs ||
    (jitterMs != null && jitterMs > CONFIG.warningJitterMs)
  ) {
    status = "warning";
  }

  let score = 100;
  if (lossPercent != null) score -= Math.min(50, lossPercent * 3);
  if (avgLatency != null) score -= Math.min(30, (avgLatency / 1000) * 30);
  if (jitterMs != null) score -= Math.min(20, (jitterMs / 200) * 20);

  if (lastMeasurementWasSevere) {
    score -= 15;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    status,
    avgLatency,
    lossPercent,
    jitterMs,
    severeCount,
    score,
    effectiveUrl: last?.effectiveUrl || null,
    lastMeasurementWasSevere
  };
}

function updateNetworkUI() {
  const statusEl = document.getElementById("catiNetworkStatus");
  const detailsEl = document.getElementById("catiNetworkDetails");
  const badgeEl = document.getElementById("catiNetworkBadge");
  const barEl = document.getElementById("catiNetworkBar");
  const metaEl = document.getElementById("catiNetworkMeta");
  const pauseBtn = document.getElementById("catiNetworkPauseBtn");

  if (!statusEl || !detailsEl || !badgeEl || !barEl || !metaEl || !pauseBtn) return;

  if (state.networkPaused) {
    statusEl.textContent = "Nettverkssjekk er satt på pause";
    detailsEl.textContent = "Automatiske målinger er stoppet.";
    badgeEl.textContent = "Pause";
    badgeEl.className = "cati-badge cati-badge--neutral";
    barEl.className = "cati-meter__bar cati-meter__bar--neutral";
    barEl.style.width = "0%";
    metaEl.textContent = `Sist oppdatert: ${formatTime(new Date())}`;
    pauseBtn.textContent = "↻";
    pauseBtn.title = "Start nettverkssjekk igjen";
    clearTitleAlert();
    return;
  }

  const info = calculateNetworkStatus();

  const latencyText =
    info.avgLatency != null ? `${info.avgLatency.toFixed(0)} ms` : "–";

  const jitterText =
    info.jitterMs != null ? `${info.jitterMs.toFixed(0)} ms` : "–";

  const lossText =
    info.lossPercent != null ? `${info.lossPercent.toFixed(1)} %` : "–";

  const lastText = state.lastMeasurement
    ? (
        state.lastMeasurement.ok
          ? `Siste måling: ${Math.round(state.lastMeasurement.latencyMs)} ms`
          : state.lastMeasurement.timedOut
            ? "Siste måling: timeout"
            : "Siste måling: mislyktes"
      )
    : "Siste måling: –";

  detailsEl.textContent =
    `Forsinkelse: ${latencyText} | Jitter: ${jitterText} | Estimert pakketap: ${lossText} | Alvorlige avvik (${CONFIG.timeWindowMinutes} min): ${info.severeCount} | ${lastText}`;

  barEl.style.width = `${info.score}%`;
  badgeEl.className = "cati-badge";
  barEl.className = "cati-meter__bar";
  pauseBtn.textContent = "×";
  pauseBtn.title = "Pause nettverkssjekk";

  if (info.status === "good") {
    statusEl.textContent = "Stabil internettilkobling";
    badgeEl.textContent = "God";
    badgeEl.classList.add("cati-badge--good");
    barEl.classList.add("cati-meter__bar--good");
    clearTitleAlert();
  } else if (info.status === "warning") {
    statusEl.textContent = "Ustabil internettilkobling";
    badgeEl.textContent = "Ustabil";
    badgeEl.classList.add("cati-badge--warning");
    barEl.classList.add("cati-meter__bar--warning");
  } else if (info.status === "bad") {
    statusEl.textContent = "Kritisk internettilkobling";
    badgeEl.textContent = "Kritisk";
    badgeEl.classList.add("cati-badge--bad");
    barEl.classList.add("cati-meter__bar--bad");
  } else {
    statusEl.textContent = "Måler internettilkobling…";
    badgeEl.textContent = "Ukjent";
    badgeEl.classList.add("cati-badge--neutral");
    barEl.classList.add("cati-meter__bar--neutral");
    clearTitleAlert();
  }

  metaEl.textContent = `Sist oppdatert: ${formatTime(new Date())}`;
}

async function runPing() {
  if (state.networkPaused) return;
  if (state.pingInFlight) return;

  state.pingInFlight = true;

  try {
    const urls = Array.isArray(CONFIG.pingUrls) ? CONFIG.pingUrls : [];
    if (!urls.length) {
      throw new Error("No ping URLs configured");
    }

    const results = [];
    let firstSuccess = null;

    for (const url of urls) {
      const result = await loadImageWithTimeout(url, CONFIG.pingTimeoutMs);
      results.push(result);

      if (result.ok) {
        firstSuccess = result;
        break;
      }
    }

    const measurement = {
      ok: !!firstSuccess,
      latencyMs: firstSuccess ? firstSuccess.latencyMs : null,
      ts: Date.now(),
      timedOut: !firstSuccess && results.length > 0 && results.every(r => r.timedOut),
      effectiveUrl: firstSuccess ? firstSuccess.url : null,
      checkedUrls: results.map(r => ({
        url: r.url,
        ok: r.ok,
        timedOut: r.timedOut
      }))
    };

    state.lastMeasurement = measurement;
    state.history.push(measurement);
    afterNetworkMeasurement();

  } catch (err) {
    console.warn("[CATI Check] External connectivity check failed:", err);

    const measurement = {
      ok: false,
      latencyMs: null,
      ts: Date.now(),
      timedOut: false,
      effectiveUrl: null,
      checkedUrls: []
    };

    state.lastMeasurement = measurement;
    state.history.push(measurement);
    afterNetworkMeasurement();

  } finally {
    state.pingInFlight = false;
  }
}

  function afterNetworkMeasurement() {
    const info = calculateNetworkStatus();

    if (info.status === "warning" || info.status === "bad") {
      state.consecutiveIssueCount += 1;
    } else {
      state.consecutiveIssueCount = 0;
    }

    updateNetworkUI();
    maybeNotifyNetworkIssue(info);

    state.lastNetworkStatus = info.status;
  }

  function maybeNotifyNetworkIssue(info) {
    if (state.networkPaused) return;
    if (!(info.status === "warning" || info.status === "bad")) return;
    if (state.consecutiveIssueCount < CONFIG.minConsecutiveIssuesBeforeNotify) return;

    const now = Date.now();
    if (now - state.lastNotificationAt < CONFIG.notifyCooldownMs) return;

    const title = info.status === "bad"
      ? "Kritisk nettverksproblem"
      : "Ustabil tilkobling oppdaget";

    const body = info.status === "bad"
      ? "Internettilkoblingen virker kritisk. Sjekk nettverk eller flytt til mer stabil forbindelse."
      : "Internettilkoblingen virker ustabil. Du kan oppleve lydproblemer.";

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, { body });
      } catch (err) {
        console.warn("[CATI Check] Notification failed:", err);
      }
    }

    triggerTitleAlert(title);
    playWarningTone();
    state.lastNotificationAt = now;
  }

  function tryAutoRequestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") return;

    try {
      Notification.requestPermission().catch(() => {});
    } catch (_) {}
  }

  function triggerTitleAlert(text) {
    if (document.hidden) {
      document.title = `${CONFIG.titleAlertPrefix}${text}`;
      state.titleAlertActive = true;
    }
  }

  function clearTitleAlert() {
    if (state.titleAlertActive) {
      document.title = state.originalTitle;
      state.titleAlertActive = false;
    }
  }

  function playWarningTone() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      if (!state.audioContext && AudioContextClass) {
        state.audioContext = new AudioContextClass();
      }

      const ctx = state.audioContext;
      console.log("[CATI Check] playWarningTone called. Audio state:", ctx?.state);

      if (ctx && ctx.state === "suspended") {
        ctx.resume();
      }

      if (!ctx || ctx.state !== "running") {
        console.warn("[CATI Check] Audio not unlocked yet");
        return;
      }

      const now = ctx.currentTime;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.03, now + 0.03);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
      master.connect(ctx.destination);

      const osc1 = ctx.createOscillator();
      osc1.type = "triangle";
      osc1.frequency.setValueAtTime(392, now);
      osc1.frequency.exponentialRampToValueAtTime(340, now + 0.24);

      const osc2 = ctx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(294, now + 0.30);
      osc2.frequency.exponentialRampToValueAtTime(247, now + 0.62);

      const gain1 = ctx.createGain();
      gain1.gain.setValueAtTime(0.0001, now);
      gain1.gain.exponentialRampToValueAtTime(1, now + 0.03);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);

      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0.0001, now);
      gain2.gain.setValueAtTime(0.0001, now + 0.28);
      gain2.gain.exponentialRampToValueAtTime(1, now + 0.34);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.68);

      osc1.connect(gain1);
      gain1.connect(master);

      osc2.connect(gain2);
      gain2.connect(master);

      osc1.start(now);
      osc1.stop(now + 0.32);

      osc2.start(now);
      osc2.stop(now + 0.72);

      setTimeout(() => {
        try { master.disconnect(); } catch (_) {}
      }, 1200);
    } catch (err) {
      console.warn("[CATI Check] Warning tone failed:", err);
    }
  }

  function createEmptyMicAnalysis() {
  return {
    samples: 0,
    voiceSamples: 0,
    silentSamples: 0,
    rmsSum: 0,
    voiceRmsSum: 0,
    silentRmsSum: 0,
    peak: 0,
    clipCount: 0
  };
}

function analyseMicFrame(dataArray) {
  let sumSquares = 0;
  let peak = 0;
  let clipCount = 0;

  for (let i = 0; i < dataArray.length; i++) {
    const sample = dataArray[i];
    sumSquares += sample * sample;

    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    if (abs >= CONFIG.micClipThreshold) clipCount++;
  }

  const rms = Math.sqrt(sumSquares / dataArray.length);

  return {
    rms,
    peak,
    clipCount,
    totalSamples: dataArray.length
  };
}

function startMicAnalysis(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
  }

  const ctx = state.audioContext;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();

  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  const analysis = createEmptyMicAnalysis();

  state.micAnalyser = analyser;
  state.micAnalysis = analysis;

  function tick() {
    if (!state.micAnalyser || !state.micAnalysis) return;

    analyser.getFloatTimeDomainData(buffer);
    const frame = analyseMicFrame(buffer);

    analysis.samples++;
    analysis.rmsSum += frame.rms;
    if (frame.peak > analysis.peak) analysis.peak = frame.peak;
    analysis.clipCount += frame.clipCount;

    const isVoiceLike = frame.rms >= CONFIG.micMinVoiceRms;

    if (isVoiceLike) {
      analysis.voiceSamples++;
      analysis.voiceRmsSum += frame.rms;
    } else {
      analysis.silentSamples++;
      analysis.silentRmsSum += frame.rms;
    }

    state.micAnalysisFrameId = requestAnimationFrame(tick);
  }

  tick();
  return true;
}

function stopMicAnalysis() {
  if (state.micAnalysisFrameId) {
    cancelAnimationFrame(state.micAnalysisFrameId);
    state.micAnalysisFrameId = null;
  }
  state.micAnalyser = null;
}

function summarizeMicAnalysis(analysis) {
  if (!analysis || !analysis.samples) {
    return {
      speechDetected: false,
      levelLabel: "Ukjent",
      noiseLabel: "Ukjent",
      status: "neutral",
      summary: "Kunne ikke analysere lydnivået."
    };
  }

  const avgRms = analysis.samples ? analysis.rmsSum / analysis.samples : 0;
  const avgVoiceRms = analysis.voiceSamples ? analysis.voiceRmsSum / analysis.voiceSamples : 0;
  const avgSilentRms = analysis.silentSamples ? analysis.silentRmsSum / analysis.silentSamples : 0;
  const clipRatio = analysis.samples ? analysis.clipCount / (analysis.samples * 2048) : 0;
  const speechDetected = analysis.voiceSamples >= Math.max(4, Math.round(analysis.samples * 0.15));

  let levelLabel = "Bra";
  if (!speechDetected) {
    levelLabel = "Ingen tale";
  } else if (avgVoiceRms < CONFIG.micGoodVoiceRms) {
    levelLabel = "Lavt";
  } else if (avgVoiceRms > CONFIG.micHighVoiceRms || clipRatio > CONFIG.micClipWarnRatio) {
    levelLabel = "For høyt";
  }

  let noiseLabel = "Lav";
  if (avgSilentRms >= CONFIG.micNoiseBadRms) {
    noiseLabel = "Høy";
  } else if (avgSilentRms >= CONFIG.micNoiseWarnRms) {
    noiseLabel = "Noe";
  }

  let status = "good";
  let summary = "Mikrofon virker og lydnivået ser bra ut.";

  if (!speechDetected) {
    status = "bad";
    summary = "Ingen tydelig tale registrert. Sjekk at riktig mikrofon er valgt og at du snakker under testen.";
  } else if (levelLabel === "For høyt") {
    status = "warning";
    summary = "Mikrofon virker, men lydnivået er høyt. Prøv å snakke litt lenger fra mikrofonen.";
  } else if (levelLabel === "Lavt" && noiseLabel === "Høy") {
    status = "bad";
    summary = "Lyden er svak og bakgrunnsstøyen er høy. Sjekk mikrofonplassering eller bytt til roligere omgivelser.";
  } else if (levelLabel === "Lavt") {
    status = "warning";
    summary = "Mikrofon virker, men lydnivået er lavt. Prøv å snakke nærmere mikrofonen.";
  } else if (noiseLabel === "Høy") {
    status = "warning";
    summary = "Mikrofon virker, men det er mye bakgrunnsstøy.";
  } else if (noiseLabel === "Noe") {
    status = "warning";
    summary = "Mikrofon virker, men noe bakgrunnsstøy ble registrert.";
  }

  return {
    speechDetected,
    levelLabel,
    noiseLabel,
    status,
    summary,
    avgRms,
    avgVoiceRms,
    avgSilentRms,
    peak: analysis.peak,
    clipRatio
  };
}

  async function startMicTest() {
    const micBtn = document.getElementById("catiMicTestBtn");
    const micStatus = document.getElementById("catiMicStatus");
    const micDetails = document.getElementById("catiMicDetails");
    const micBadge = document.getElementById("catiMicBadge");
    const audioEl = document.getElementById("catiMicPlayback");
  
    if (!micBtn || !micStatus || !micDetails || !micBadge || !audioEl) return;
  
    if (!state.micSupported) {
      micStatus.textContent = "Mikrofontest støttes ikke";
      micDetails.textContent = "Nettleseren støtter ikke nødvendig lydopptak.";
      micBadge.className = "cati-badge cati-badge--bad";
      micBadge.textContent = "Ikke støttet";
      return;
    }
  
    micBtn.disabled = true;
    micBtn.textContent = "Tester…";
    micStatus.textContent = "Ber om tilgang til mikrofon…";
    micDetails.textContent = "Tillat mikrofontilgang hvis nettleseren spør.";
    micBadge.className = "cati-badge cati-badge--neutral";
    micBadge.textContent = "Pågår";
  
    try {
      cleanupMedia();
  
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
  
      state.mediaStream = stream;
      state.audioChunks = [];
      state.micAnalysis = createEmptyMicAnalysis();
  
      micStatus.textContent = "Tar opp testlyd…";
      micDetails.textContent = `Snakk normalt i cirka ${CONFIG.micRecordSeconds} sekunder. Hold gjerne et kort øyeblikk stille mot slutten.`;
  
      startMicAnalysis(stream);
  
      const recorder = new MediaRecorder(stream);
      state.mediaRecorder = recorder;
  
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) {
          state.audioChunks.push(event.data);
        }
      };
  
      recorder.onstop = function () {
        const analysisSummary = summarizeMicAnalysis(state.micAnalysis);
  
        const blob = new Blob(state.audioChunks, {
          type: recorder.mimeType || "audio/webm"
        });
  
        if (state.lastAudioUrl) {
          URL.revokeObjectURL(state.lastAudioUrl);
        }
  
        state.lastAudioUrl = URL.createObjectURL(blob);
        audioEl.src = state.lastAudioUrl;
        audioEl.hidden = false;
  
        if (analysisSummary.status === "good") {
          micStatus.textContent = "Mikrofon virker";
          micBadge.className = "cati-badge cati-badge--good";
          micBadge.textContent = "God";
        } else if (analysisSummary.status === "warning") {
          micStatus.textContent = "Mikrofon virker, men bør sjekkes";
          micBadge.className = "cati-badge cati-badge--warning";
          micBadge.textContent = "Ustabil";
        } else {
          micStatus.textContent = "Mulig mikrofonproblem";
          micBadge.className = "cati-badge cati-badge--bad";
          micBadge.textContent = "Problem";
        }
  
        micDetails.textContent =
          `${analysisSummary.summary} Nivå: ${analysisSummary.levelLabel}. Bakgrunnsstøy: ${analysisSummary.noiseLabel}.`;
  
        cleanupMedia(false);
  
        audioEl.play().catch(() => {});
  
        micBtn.disabled = false;
        micBtn.textContent = "Test på nytt";
      };
  
      recorder.start();
  
      setTimeout(() => {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }, CONFIG.micRecordSeconds * 1000);
  
    } catch (err) {
      cleanupMedia();
  
      micStatus.textContent = "Mikrofontest mislyktes";
      micDetails.textContent = "Kunne ikke få tilgang til mikrofon. Kontroller tillatelser og valgt enhet.";
      micBadge.className = "cati-badge cati-badge--bad";
      micBadge.textContent = "Feil";
      micBtn.disabled = false;
      micBtn.textContent = "Test mikrofon";
      console.warn("[CATI Check] Microphone test failed:", err);
    }
  }

  function cleanupMedia(resetRecorder = true) {
    stopMicAnalysis();
  
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
  
    if (resetRecorder) {
      state.mediaRecorder = null;
      state.micAnalysis = null;
    }
  }

  function formatTime(date) {
    return date.toLocaleTimeString("no-NO", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function readBool(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return fallback;
      return value === "true";
    } catch {
      return fallback;
    }
  }

  function writeBool(key, value) {
    try {
      localStorage.setItem(key, String(!!value));
    } catch (_) {}
  }

  function buildPingUrl(baseUrl) {
  const separator = baseUrl.indexOf("?") >= 0 ? "&" : "?";
  return `${baseUrl}${separator}_catiCheck=${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function loadImageWithTimeout(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    let finished = false;

    const startedAt = performance.now();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({
        ok: false,
        timedOut: true,
        latencyMs: null,
        url
      });
    }, timeoutMs);

    img.onload = function () {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        ok: true,
        timedOut: false,
        latencyMs: performance.now() - startedAt,
        url
      });
    };

    img.onerror = function () {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        ok: false,
        timedOut: false,
        latencyMs: null,
        url
      });
    };

    img.referrerPolicy = "no-referrer";
    img.src = buildPingUrl(url);
  });
}

  async function unlockAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;

      if (!state.audioContext) {
        state.audioContext = new AudioContextClass();
      }

      if (state.audioContext.state === "suspended") {
        await state.audioContext.resume();
      }

      state.audioUnlocked = state.audioContext.state === "running";
      return state.audioUnlocked;
    } catch (err) {
      console.warn("[CATI Check] Audio unlock failed:", err);
      return false;
    }
  }

  async function primeInteractionFeatures() {
    await unlockAudio();

    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (err) {
        console.warn("[CATI Check] Notification permission request failed:", err);
      }
    }

    console.log("[CATI Check] Audio + notifications primed from Start interviewing.");
  }

  init();
})();
