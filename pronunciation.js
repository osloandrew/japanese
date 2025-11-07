function buildPronAudioUrl(sentenceText) {
  const base =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? "" // local dev server
      : "/japanese"; // GitHub Pages repo name

  return `${base}/Resources/Sentences/${sentenceText
    .trim()
    .replace(/\?$/, "")}.m4a`;
}

function buildWordAudioUrl(wordText) {
  const base =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? "" // local dev server
      : "/japanese"; // GitHub Pages repo name

  return `${base}/Resources/Words/${wordText.trim()}.m4a`;
}

async function computeSimilarity(nativeUrl, userUrl) {
  const [nativeBuf, userBuf] = await Promise.all([
    fetch(nativeUrl).then((r) => r.arrayBuffer()),
    fetch(userUrl).then((r) => r.arrayBuffer()),
  ]);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const [nativeAudio, userAudio] = await Promise.all([
    ctx.decodeAudioData(nativeBuf),
    ctx.decodeAudioData(userBuf),
  ]);

  function extractMFCCSequence(audioBuffer, hopSize = 1024) {
    const channel = audioBuffer.getChannelData(0);
    const seq = [];
    for (let i = 0; i < channel.length - hopSize; i += hopSize) {
      const frame = channel.slice(i, i + hopSize);
      const features = Meyda.extract("mfcc", frame);
      if (features) {
        const energy = frame.reduce((s, v) => s + v * v, 0) / hopSize;
        if (energy > 1e-6) seq.push(features);
      }
    }
    return seq;
  }

  function dtwMFCC(a, b) {
    const n = a.length,
      m = b.length;
    const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
    dp[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const vecA = a[i - 1],
          vecB = b[j - 1];
        let dot = 0,
          na = 0,
          nb = 0;
        for (let k = 0; k < vecA.length; k++) {
          dot += vecA[k] * vecB[k];
          na += vecA[k] * vecA[k];
          nb += vecB[k] * vecB[k];
        }
        const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1); // -1..1
        const cost = 1 - (sim + 1) / 2; // 0=identical, 1=opposite
        dp[i][j] =
          cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[n][m] / (n + m);
  }

  const mfccN = extractMFCCSequence(nativeAudio);
  const mfccU = extractMFCCSequence(userAudio);

  if (!mfccN.length || !mfccU.length) {
    console.log("No voiced frames — returning 0");
    return 0;
  }

  const dist = dtwMFCC(mfccN, mfccU);

  // Softer slope than before: 12 instead of 20
  let raw = Math.exp(-dist * 12);

  // Softer nonlinearity: sqrt instead of square
  raw = Math.sqrt(raw);

  const normalized = Math.min(Math.max(raw, 0), 1);
  const score = Math.round(normalized * 100);

  console.log("DTW-MFCC similarity:", { dist, raw, score });
  return score;
}

// Entry point: called when Pronunciation tab is activated
function initPronunciation() {
  showLandingCard(false);
  console.log("Pronunciation module loaded");

  if (!results.length) {
    console.warn("No dictionary data loaded yet");
    return;
  }

  // Show a random sentence on entry
  showRandomPronunciation();
}

function showRandomPronunciation() {
  const selectedCEFR = document.getElementById("cefr-select")
    ? document.getElementById("cefr-select").value.toUpperCase()
    : "";
  // Filter by audio + CEFR
  const sentenceEntries = results.filter(
    (r) =>
      r.eksempel &&
      r.sentenceAudio === "X" &&
      (!selectedCEFR || (r.CEFR && r.CEFR.toUpperCase() === selectedCEFR))
  );
  if (!sentenceEntries.length) {
    resultsContainer.innerHTML = "<p>No sentences available.</p>";
    return;
  }

  const randomEntry =
    sentenceEntries[Math.floor(Math.random() * sentenceEntries.length)];

  // Generate CEFR badge
  let cefrLabel = "";
  switch (randomEntry.CEFR) {
    case "A1":
      cefrLabel = '<div class="sentence-cefr-label easy">A1</div>';
      break;
    case "A2":
      cefrLabel = '<div class="sentence-cefr-label easy">A2</div>';
      break;
    case "B1":
      cefrLabel = '<div class="sentence-cefr-label medium">B1</div>';
      break;
    case "B2":
      cefrLabel = '<div class="sentence-cefr-label medium">B2</div>';
      break;
    case "C":
      cefrLabel = '<div class="sentence-cefr-label hard">C</div>';
      break;
  }

  // Clean sentence (strip old highlights if any)
  const cleanedEksempel = randomEntry.eksempel.replace(
    /<span[^>]*>(.*?)<\/span>/gi,
    "$1"
  );

  const selectedJapanese = cleanedEksempel.trim();
  const selectedTranslation = randomEntry.sentenceTranslation || "";

  // Build audio URL using the whole sentence
  const audioFile = buildPronAudioUrl(selectedJapanese);
  console.log("Pronunciation audio src →", audioFile);

  // Build sentence HTML
  let sentenceHTML = `
  <button class="sentence-btn english-toggle-btn" onclick="toggleEnglishTranslations(this)">
    ${isEnglishVisible ? "Hide English" : "Show English"}
  </button>
  <div class="sentence-container">
    <div class="sentence-box-norwegian ${
      !isEnglishVisible ? "sentence-box-norwegian-hidden" : ""
    }">
      <div class="sentence-content">
        ${cefrLabel}
        <p class="sentence">${selectedJapanese}</p>
      </div>
    </div>
`;

  // English translation box if available
  if (selectedTranslation) {
    sentenceHTML += `
    <div class="sentence-box-english ${isEnglishVisible ? "" : "hidden"}">
      <p class="sentence">${selectedTranslation}</p>
    </div>
  `;
  }

  sentenceHTML += "</div>"; // close .sentence-container

  // 🔹 New dedicated practice box
  sentenceHTML += `
<div class="sentence-box-practice">
    <div class="practice-row">
      <div class="native-col">
        <p class="practice-row-header">Native</p>
        <div id="waveform"></div>
        <div class="native-controls">
          <button class="button-pron" id="native-play">▶️ Play</button>
          <button class="button-pron" id="native-pause">⏸️ Pause</button>
        </div>
      </div>
      <div class="user-col">
        <p class="practice-row-header">You</p>
        <div id="user-waveform"></div>
        <div class="user-controls">
        <button class="button-pron" id="user-play">▶️ Play</button>
        <button class="button-pron" id="user-pause">⏸️ Pause</button>
        <button class="button-pron" id="start-recording">🎙️ Record</button>
        <button 
          class="button-pron" 
          id="stop-recording"
          style="
            background-color: #e9a895;
            border-color: #4f4f4f;
            color: #4f4f4f"
        >⏹️ Stop Recording</button> 
  </div>
      </div>
    </div>
      <div id="comparison-score" style="text-align:center; margin-top:10px;">
  </div>
</div>
`;

  resultsContainer.innerHTML = sentenceHTML;

  let mediaRecorder;
  let recordedChunks = [];

  const startBtn = document.getElementById("start-recording");
  const stopBtn = document.getElementById("stop-recording");
  const playBtn = document.getElementById("user-play");
  const pauseBtn = document.getElementById("user-pause");

  // initial state
  stopBtn.style.display = "none";
  playBtn.style.display = "none";
  pauseBtn.style.display = "none";

  startBtn.addEventListener("click", async () => {
    recordedChunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let options = { mimeType: "audio/mp4" };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: "audio/webm" }; // desktop fallback
    }
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || "audio/webm";
      const blob = new Blob(recordedChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);

      if (window.wavesurferUser && window.wavesurferUser.destroy) {
        window.wavesurferUser.destroy();
      }

      window.wavesurferUser = WaveSurfer.create({
        container: "#user-waveform",
        waveColor: "#ccc",
        progressColor: "#28a745",
        height: 80,
        cursorColor: "#28a745",
      });
      window.wavesurferUser.load(url);

      computeSimilarity(audioFile, url).then((score) => {
        document.getElementById(
          "comparison-score"
        ).textContent = `🎯 Similarity Score: ${score}%`;
      });

      // after recording finishes
      playBtn.style.display = "inline-block";
      pauseBtn.style.display = "inline-block";
      startBtn.style.display = "inline-block"; // 👈 bring back Start

      playBtn.onclick = () => window.wavesurferUser.play();
      pauseBtn.onclick = () => window.wavesurferUser.pause();
    };

    mediaRecorder.start();

    // button states while recording
    startBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
    playBtn.style.display = "none";
    pauseBtn.style.display = "none";
  });

  stopBtn.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
    // Instead of disabling, hide Stop after use
    stopBtn.style.display = "none";
  });

  // Native waveform
  if (window.wavesurferNative && window.wavesurferNative.destroy) {
    window.wavesurferNative.destroy();
  }
  window.wavesurferNative = WaveSurfer.create({
    container: "#waveform",
    waveColor: "#ccc",
    progressColor: "#007bff",
    height: 80,
    cursorColor: "#007bff",
  });
  window.wavesurferNative.load(audioFile);

  // Auto-play as soon as the audio is ready
  window.wavesurferNative.on("ready", () => {
    window.wavesurferNative.play();
  });

  // Hook up buttons
  document.getElementById("native-play").onclick = () =>
    window.wavesurferNative.play();
  document.getElementById("native-pause").onclick = () =>
    window.wavesurferNative.pause();

  // Dummy "You" waveform so layout always matches
  if (window.wavesurferUser && window.wavesurferUser.destroy) {
    window.wavesurferUser.destroy();
  }

  const silenceBlob = new Blob([new Uint8Array([0])], { type: "audio/webm" });
  const silenceUrl = URL.createObjectURL(silenceBlob);

  window.wavesurferUser = WaveSurfer.create({
    container: "#user-waveform",
    waveColor: "#ccc",
    progressColor: "#28a745",
    height: 80,
    cursorColor: "#28a745",
  });
  window.wavesurferUser.load(silenceUrl);
}
