(function () {
  const CONFIG = {
    containerId: "cati-precall-check",
    pingUrl: window.location.origin + "/favicon.ico",
    pingIntervalMs: 4000,
    pingTimeoutMs: 2500,
    timeWindowMinutes: 10,
    severeLatencyMs: 600,
    warningLatencyMs: 250,
    severeLossPercent: 15,
    warningLossPercent: 5,
    micRecordSeconds: 4
  };

  const state = {
    history: [],
    intervalId: null,
    mediaRecorder: null,
    mediaStream: null,
    audioChunks: [],
    lastAudioUrl: null,
    micSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)
  };

  function init() {
    const container = document.getElementById(CONFIG.containerId);
    if (!container) {
      console.warn("[CATI Check] Container not found:", CONFIG.containerId);
      return;
    }

    container.innerHTML = renderWidget();
    bindEvents();
    updateNetworkUI();
    runPing();
    state.intervalId = setInterval(runPing, CONFIG.pingIntervalMs);
  }

  function renderWidget() {
    return `
      <section class="cati-check" aria-label="CATI pre-call check">
        <div class="cati-check__header">
          <div>
            <div class="cati-check__title">Oppstartssjekk</div>
            <div class="cati-check__subtitle">Tilkobling og mikrofon</div>
          </div>
          <button type="button" class="cati-check__refresh" id="catiCheckRefreshBtn">
            Kjør test på nytt
          </button>
        </div>

        <div class="cati-check__grid">
          <div class="cati-card">
            <div class="cati-card__top">
              <div class="cati-card__label">Tilkobling</div>
              <span id="catiNetworkBadge" class="cati-badge cati-badge--neutral">Ukjent</span>
            </div>

            <div id="catiNetworkStatus" class="cati-card__status">Måler tilkobling…</div>
            <div id="catiNetworkDetails" class="cati-card__details">
              Ingen data tilgjengelig ennå.
            </div>

            <div class="cati-meter" aria-hidden="true">
              <div id="catiNetworkBar" class="cati-meter__bar" style="width: 8%"></div>
            </div>
          </div>

          <div class="cati-card">
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

        <div class="cati-check__footer">
          <span id="catiOverallMessage">Systemet gjør en kort oppstartssjekk.</span>
          <span id="catiLastUpdated">Sist oppdatert: –</span>
        </div>
      </section>
    `;
  }

  function bindEvents() {
    const refreshBtn = document.getElementById("catiCheckRefreshBtn");
    const micBtn = document.getElementById("catiMicTestBtn");

    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        runPing();
      });
    }

    if (micBtn) {
      micBtn.addEventListener("click", function () {
        startMicTest();
      });
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
    const footerEl = document.getElementById("catiOverallMessage");
    const updatedEl = document.getElementById("catiLastUpdated");

    if (!statusEl || !detailsEl || !badgeEl || !barEl || !footerEl || !updatedEl) return;

    const info = calculateNetworkStatus();

    const latencyText = info.avgLatency != null ? `${info.avgLatency.toFixed(0)} ms` : "–";
    const lossText = info.lossPercent != null ? `${info.lossPercent.toFixed(1)} %` : "–";

    detailsEl.textContent =
      `Gj.snittlig forsinkelse: ${latencyText} | Estimert pakketap: ${lossText} | Alvorlige avvik (${CONFIG.timeWindowMinutes} min): ${info.severeCount}`;

    barEl.style.width = `${info.score}%`;

    const root = statusEl.closest(".cati-card");
    if (root) {
      root.classList.remove("is-good", "is-warning", "is-bad", "is-neutral");
    }

    badgeEl.className = "cati-badge";
    barEl.className = "cati-meter__bar";

    if (info.status === "good") {
      statusEl.textContent = "Stabil tilkobling";
      badgeEl.textContent = "God";
      badgeEl.classList.add("cati-badge--good");
      barEl.classList.add("cati-meter__bar--good");
      root && root.classList.add("is-good");
      footerEl.textContent = "Du er klar til å starte intervju.";
    } else if (info.status === "warning") {
      statusEl.textContent = "Ustabil tilkobling";
      badgeEl.textContent = "Ustabil";
      badgeEl.classList.add("cati-badge--warning");
      barEl.classList.add("cati-meter__bar--warning");
      root && root.classList.add("is-warning");
      footerEl.textContent = "Du kan oppleve problemer. Følg med på lyd og stabilitet.";
    } else if (info.status === "bad") {
      statusEl.textContent = "Kritisk tilkobling";
      badgeEl.textContent = "Kritisk";
      badgeEl.classList.add("cati-badge--bad");
      barEl.classList.add("cati-meter__bar--bad");
      root && root.classList.add("is-bad");
      footerEl.textContent = "Anbefalt å sjekke nettverk før du starter intervju.";
    } else {
      statusEl.textContent = "Måler tilkobling…";
      badgeEl.textContent = "Ukjent";
      badgeEl.classList.add("cati-badge--neutral");
      barEl.classList.add("cati-meter__bar--neutral");
      root && root.classList.add("is-neutral");
      footerEl.textContent = "Systemet gjør en kort oppstartssjekk.";
    }

    updatedEl.textContent = `Sist oppdatert: ${formatTime(new Date())}`;
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

        state.history.push({
          ok: response.ok,
          latencyMs: response.ok ? latency : null,
          ts: Date.now()
        });

        updateNetworkUI();
      })
      .catch(() => {
        clearTimeout(timeoutId);

        state.history.push({
          ok: false,
          latencyMs: null,
          ts: Date.now()
        });

        updateNetworkUI();
      });
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
        micBadge.className = "cati-badge cati-badge--good";
        micBadge.textContent = "OK";

        cleanupMedia(false);

        audioEl.play().catch(() => {
          // Avspilling kan kreve nytt brukerklikk i noen nettlesere.
        });

        micBtn.disabled = false;
        micBtn.textContent = "Test mikrofon på nytt";
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
      minute: "2-digit",
      second: "2-digit"
    });
  }

  init();
})();