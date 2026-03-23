(function () {
  const CONFIG = {
    containerId: "cati-precall-check",
    pingUrl: window.location.origin + "/favicon.ico",
    pingIntervalMs: 5000,
    pingTimeoutMs: 2500,
    timeWindowMinutes: 30,
    severeLatencyMs: 600,
    warningLatencyMs: 250,
    severeLossPercent: 15,
    warningLossPercent: 5,
    micRecordSeconds: 7,
    notifyCooldownMs: 3 * 60 * 1000,
    minConsecutiveIssuesBeforeNotify: 2,
    titleAlertPrefix: "⚠ ",
    autoAskNotificationPermission: true,
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
    audioUnlocked: false
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
              <div class="cati-card__label">Tilkobling</div>
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
              Ta opp en kort lydtest og lytt til avspillingen.
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
        severeCount: 0,
        score: 8
      };
    }

    let okCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let severeCount = 0;

    for (const item of state.history) {
      const isSevere = !item.ok || (item.latencyMs != null && item.latencyMs > CONFIG.severeLatencyMs);
      if (isSevere) severeCount++;

      if (item.ok) {
        okCount++;
        if (item.latencyMs != null) {
          latencySum += item.latencyMs;
          latencyCount++;
        }
      }
    }

    const sampleCount = state.history.length;
    const lossPercent = 100 - (okCount / sampleCount) * 100;
    const avgLatency = latencyCount ? latencySum / latencyCount : null;

    let status = "good";
    if (avgLatency == null) {
      status = "unknown";
    } else if (lossPercent > CONFIG.severeLossPercent || avgLatency > CONFIG.severeLatencyMs) {
      status = "bad";
    } else if (lossPercent > CONFIG.warningLossPercent || avgLatency > CONFIG.warningLatencyMs) {
      status = "warning";
    }

    let score = 100;
    if (lossPercent != null) score -= Math.min(50, lossPercent * 3);
    if (avgLatency != null) score -= Math.min(50, (avgLatency / 1000) * 50);
    score = Math.max(0, Math.min(100, score));

    return {
      status,
      avgLatency,
      lossPercent,
      severeCount,
      score
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
      info.avgLatency != null
        ? `${info.avgLatency.toFixed(0)} ms`
        : "–";

    const lossText = info.lossPercent != null ? `${info.lossPercent.toFixed(1)} %` : "–";

    detailsEl.textContent =
      `Forsinkelse: ${latencyText} | Estimert pakketap: ${lossText} | Alvorlige avvik (${CONFIG.timeWindowMinutes} min): ${info.severeCount}`;

    barEl.style.width = `${info.score}%`;
    badgeEl.className = "cati-badge";
    barEl.className = "cati-meter__bar";
    pauseBtn.textContent = "×";
    pauseBtn.title = "Pause nettverkssjekk";

    if (info.status === "good") {
      statusEl.textContent = "Stabil tilkobling";
      badgeEl.textContent = "God";
      badgeEl.classList.add("cati-badge--good");
      barEl.classList.add("cati-meter__bar--good");
      clearTitleAlert();
    } else if (info.status === "warning") {
      statusEl.textContent = "Ustabil tilkobling";
      badgeEl.textContent = "Ustabil";
      badgeEl.classList.add("cati-badge--warning");
      barEl.classList.add("cati-meter__bar--warning");
    } else if (info.status === "bad") {
      statusEl.textContent = "Kritisk tilkobling";
      badgeEl.textContent = "Kritisk";
      badgeEl.classList.add("cati-badge--bad");
      barEl.classList.add("cati-meter__bar--bad");
    } else {
      statusEl.textContent = "Måler tilkobling…";
      badgeEl.textContent = "Ukjent";
      badgeEl.classList.add("cati-badge--neutral");
      barEl.classList.add("cati-meter__bar--neutral");
      clearTitleAlert();
    }

    metaEl.textContent = `Sist oppdatert: ${formatTime(new Date())}`;
  }

  function runPing() {
    const start = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.pingTimeoutMs);

    fetch(`${CONFIG.pingUrl}?_catiCheck=${Date.now()}`, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal
    })
      .then(response => {
        clearTimeout(timeoutId);
        const latency = performance.now() - start;

        const measurement = {
          ok: response.ok,
          latencyMs: response.ok ? latency : null,
          ts: Date.now()
        };

        state.lastMeasurement = measurement;
        state.history.push(measurement);

        afterNetworkMeasurement();
      })
      .catch(() => {
        clearTimeout(timeoutId);

        const measurement = {
          ok: false,
          latencyMs: null,
          ts: Date.now()
        };

        state.lastMeasurement = measurement;
        state.history.push(measurement);

        afterNetworkMeasurement();
      });
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
      ? "Tilkoblingen virker kritisk. Sjekk nettverk eller flytt til mer stabil forbindelse."
      : "Tilkoblingen virker ustabil. Du kan oppleve lydproblemer.";

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
      const ctx = state.audioContext;
      if (!ctx || ctx.state !== "running") return;

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

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaStream = stream;
      state.audioChunks = [];

      micStatus.textContent = "Tar opp testlyd…";
      micDetails.textContent = `Snakk normalt i cirka ${CONFIG.micRecordSeconds} sekunder.`;

      const recorder = new MediaRecorder(stream);
      state.mediaRecorder = recorder;

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) {
          state.audioChunks.push(event.data);
        }
      };

      recorder.onstop = function () {
        const blob = new Blob(state.audioChunks, { type: recorder.mimeType || "audio/webm" });

        if (state.lastAudioUrl) {
          URL.revokeObjectURL(state.lastAudioUrl);
        }

        state.lastAudioUrl = URL.createObjectURL(blob);
        audioEl.src = state.lastAudioUrl;
        audioEl.hidden = false;

        micStatus.textContent = "Testopptak klart";
        micDetails.textContent = "Lytt gjennom avspillingen og kontroller at lydnivå og kvalitet er god.";
        micBadge.className = "cati-badge cati-badge--neutral";
        micBadge.textContent = "Testet";

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
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
    if (resetRecorder) {
      state.mediaRecorder = null;
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
    tryAutoRequestNotificationPermission();
  }

  init();
})();
