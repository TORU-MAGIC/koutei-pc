(() => {
  "use strict";

  const STORAGE_KEY = "magic-show-cue.soundpad.v1";
  const PAD_DEBOUNCE_MS = 90;
  const MAX_ACTIVE_SOURCES = 18;
  const SOUND_EFFECTS = [
    {
      id: "correct",
      filename: "./sound-effects/sfx_correct_pingpong.wav",
      name: "ピンポーン",
      volume: 0.90,
    },
    {
      id: "wrong",
      filename: "./sound-effects/sfx_wrong_buzzer.wav",
      name: "ブザー",
      volume: 0.75,
    },
    {
      id: "sparkle",
      filename: "./sound-effects/sfx_magic_sparkle_reveal.wav",
      name: "キラキラ",
      volume: 0.85,
    },
    {
      id: "whoosh",
      filename: "./sound-effects/sfx_magic_whoosh_appear.wav",
      name: "ワープ",
      volume: 0.75,
    },
    {
      id: "vanish",
      filename: "./sound-effects/sfx_magic_vanish_poof.wav",
      name: "ポフッ",
      volume: 0.75,
    },
    {
      id: "tada",
      filename: "./sound-effects/sfx_magic_tada_sting.wav",
      name: "ジャーン",
      volume: 0.80,
    },
  ];

  const state = {
    audioContext: null,
    masterGain: null,
    limiter: null,
    fileBytes: new Map(),
    buffers: new Map(),
    loadErrors: new Map(),
    activeSources: new Set(),
    lastPlayedAt: new Map(),
    preloadPromise: null,
    preparePromise: null,
    userPrepared: false,
    wakeLock: null,
    wakeLockRequested: false,
    toastTimer: 0,
    masterVolume: 0.85,
  };

  const els = {};

  function cacheElements() {
    [
      "soundpadStatus",
      "soundpadStatusText",
      "soundpadReadyCount",
      "stopAllSounds",
      "soundpadGrid",
      "soundpadVolume",
      "soundpadVolumeText",
      "soundpadAudioGate",
      "soundpadGateHelp",
      "enableSoundpadAudio",
      "soundpadToast",
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
    els.pads = Array.from(document.querySelectorAll(".soundpad-pad[data-sound-id]"));
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      const hasStoredVolume = stored && stored.masterVolume !== null
        && typeof stored.masterVolume !== "undefined";
      const volume = hasStoredVolume ? Number(stored.masterVolume) : NaN;
      if (hasStoredVolume && Number.isFinite(volume)) {
        state.masterVolume = Math.max(0, Math.min(1, volume));
      }
    } catch (error) {
      console.warn("効果音パッドの保存設定を読み込めませんでした", error);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        masterVolume: state.masterVolume,
      }));
    } catch (error) {
      console.warn("効果音パッドの設定を保存できませんでした", error);
    }
  }

  function bindEvents() {
    els.enableSoundpadAudio.addEventListener("pointerdown", beginAudioGesture, { passive: true });
    els.enableSoundpadAudio.addEventListener("click", prepareAudio);
    els.stopAllSounds.addEventListener("click", () => {
      stopAllSounds();
      showToast("すべての効果音を停止しました");
    });

    els.soundpadVolume.addEventListener("input", () => {
      state.masterVolume = Number(els.soundpadVolume.value) / 100;
      applyMasterVolume();
      renderVolume();
      saveSettings();
    });

    els.pads.forEach((pad) => {
      pad.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        event.preventDefault();
        playSoundEffect(pad.dataset.soundId);
      });

      pad.addEventListener("keydown", (event) => {
        if (event.repeat || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        playSoundEffect(pad.dataset.soundId);
      });
    });

    els.soundpadGrid.addEventListener("contextmenu", (event) => event.preventDefault());

    document.addEventListener("keydown", (event) => {
      if (event.repeat) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        stopAllSounds();
        return;
      }
      const number = Number(event.key);
      if (Number.isInteger(number) && number >= 1 && number <= SOUND_EFFECTS.length) {
        event.preventDefault();
        playSoundEffect(SOUND_EFFECTS[number - 1].id);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.userPrepared) {
        resumeAudioContext();
        requestWakeLock();
      }
    });

    window.addEventListener("pagehide", () => {
      stopAllSounds();
      releaseWakeLock();
    });
  }

  function setStatus(kind, title, detail) {
    els.soundpadStatus.className = "soundpad-status " + kind;
    els.soundpadStatusText.textContent = title;
    els.soundpadReadyCount.textContent = detail;
  }

  function renderVolume() {
    const percent = Math.round(state.masterVolume * 100);
    els.soundpadVolume.value = String(percent);
    els.soundpadVolumeText.textContent = percent + "%";
  }

  function setPadEnabled(id, enabled) {
    const pad = els.pads.find((item) => item.dataset.soundId === id);
    if (pad) {
      pad.disabled = !enabled;
    }
  }

  function startFilePreload() {
    setStatus("is-loading", "効果音：ファイル先読み中", "0 / " + SOUND_EFFECTS.length + " 先読み");

    state.preloadPromise = Promise.allSettled(SOUND_EFFECTS.map(async (effect) => {
      try {
        const response = await fetch(effect.filename, { cache: "no-cache" });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const bytes = await response.arrayBuffer();
        validateWavBytes(bytes);
        state.fileBytes.set(effect.id, bytes);
        updatePreloadCount();
      } catch (error) {
        state.loadErrors.set(effect.id, error);
        console.error(effect.filename + " を先読みできませんでした", error);
        updatePreloadCount();
        throw error;
      }
    }));

    return state.preloadPromise;
  }

  function validateWavBytes(bytes) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 44) {
      throw new Error("WAVデータが短すぎます");
    }
    const header = new Uint8Array(bytes, 0, 12);
    const riff = String.fromCharCode(header[0], header[1], header[2], header[3]);
    const waveName = String.fromCharCode(header[8], header[9], header[10], header[11]);
    if (riff !== "RIFF" || waveName !== "WAVE") {
      throw new Error("有効なWAVではありません");
    }
  }

  function updatePreloadCount() {
    if (state.userPrepared) {
      return;
    }
    const completed = state.fileBytes.size + state.loadErrors.size;
    const detail = state.fileBytes.size + " / " + SOUND_EFFECTS.length + " 先読み";
    if (completed < SOUND_EFFECTS.length) {
      setStatus("is-loading", "効果音：ファイル先読み中", detail);
    } else if (state.fileBytes.size > 0) {
      setStatus("is-locked", "効果音：有効化待ち", detail);
    } else {
      setStatus("is-error", "効果音：読込エラー", "配信を確認してください");
    }
  }

  function getAudioContextConstructor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function ensureAudioContext() {
    if (state.audioContext) {
      return state.audioContext;
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      throw new Error("このブラウザはWeb Audio APIに対応していません");
    }

    try {
      state.audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
    } catch (error) {
      state.audioContext = new AudioContextConstructor();
    }

    state.masterGain = state.audioContext.createGain();
    state.limiter = state.audioContext.createDynamicsCompressor();
    state.limiter.threshold.value = -7;
    state.limiter.knee.value = 8;
    state.limiter.ratio.value = 12;
    state.limiter.attack.value = 0.002;
    state.limiter.release.value = 0.14;
    state.masterGain.connect(state.limiter);
    state.limiter.connect(state.audioContext.destination);
    applyMasterVolume();

    state.audioContext.addEventListener("statechange", renderContextState);
    return state.audioContext;
  }

  function beginAudioGesture() {
    try {
      const context = ensureAudioContext();
      playSilentUnlockBuffer(context);
      context.resume().catch(() => {});
    } catch (error) {
      console.error("音声出力を開始できませんでした", error);
    }
  }

  function playSilentUnlockBuffer(context) {
    try {
      const silentBuffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(state.masterGain);
      source.start(0);
    } catch (error) {
      console.warn("無音バッファによる音声解除を実行できませんでした", error);
    }
  }

  async function prepareAudio() {
    if (state.preparePromise) {
      return state.preparePromise;
    }

    if (state.fileBytes.size === 0 && state.loadErrors.size > 0) {
      state.loadErrors.clear();
      state.preloadPromise = startFilePreload();
    }

    state.userPrepared = true;
    state.wakeLockRequested = true;
    els.enableSoundpadAudio.disabled = true;
    els.enableSoundpadAudio.querySelector("strong").textContent = "準備しています…";
    setStatus("is-loading", "効果音：デコード中", "0 / " + SOUND_EFFECTS.length + " 準備");

    state.preparePromise = (async () => {
      try {
        const context = ensureAudioContext();
        await Promise.all([resumeAudioContext(), state.preloadPromise]);

        for (const effect of SOUND_EFFECTS) {
          const bytes = state.fileBytes.get(effect.id);
          if (!bytes || state.buffers.has(effect.id)) {
            continue;
          }
          try {
            const audioBuffer = await decodeAudioBytes(context, bytes);
            state.buffers.set(effect.id, audioBuffer);
            setPadEnabled(effect.id, true);
            setStatus(
              "is-loading",
              "効果音：デコード中",
              state.buffers.size + " / " + SOUND_EFFECTS.length + " 準備"
            );
          } catch (error) {
            state.loadErrors.set(effect.id, error);
            console.error(effect.name + " をデコードできませんでした", error);
          }
        }

        if (state.buffers.size === 0) {
          throw new Error("効果音を1つも準備できませんでした");
        }

        els.stopAllSounds.disabled = false;
        els.soundpadAudioGate.hidden = true;
        renderContextState();
        requestWakeLock();
        showToast("効果音の準備が完了しました");
      } catch (error) {
        console.error("効果音を準備できませんでした", error);
        setStatus("is-error", "効果音：準備エラー", "サーバーと音量を確認してください");
        els.soundpadGateHelp.textContent = "準備できませんでした。start-mobile-server.cmdを確認して、もう一度お試しください。";
        els.enableSoundpadAudio.disabled = false;
        els.enableSoundpadAudio.querySelector("strong").textContent = "もう一度試す";
        state.preparePromise = null;
      }
    })();

    return state.preparePromise;
  }

  function decodeAudioBytes(context, bytes) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (buffer) => {
        if (!settled) {
          settled = true;
          resolve(buffer);
        }
      };
      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      try {
        const result = context.decodeAudioData(bytes.slice(0), resolveOnce, rejectOnce);
        if (result && typeof result.then === "function") {
          result.then(resolveOnce, rejectOnce);
        }
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async function resumeAudioContext() {
    const context = ensureAudioContext();
    if (context.state !== "running") {
      await context.resume();
    }
    return context;
  }

  function renderContextState() {
    if (!state.audioContext || state.buffers.size === 0) {
      return;
    }

    const loaded = state.buffers.size;
    const detail = loaded + " / " + SOUND_EFFECTS.length + " 準備";
    if (state.audioContext.state === "running") {
      const title = loaded === SOUND_EFFECTS.length
        ? "効果音：準備完了"
        : "効果音：一部のみ準備完了";
      setStatus(loaded === SOUND_EFFECTS.length ? "is-ready" : "is-error", title, detail);
    } else {
      setStatus("is-locked", "効果音：画面をタップして再開", detail);
    }
  }

  function playSoundEffect(id) {
    const effect = SOUND_EFFECTS.find((item) => item.id === id);
    const buffer = state.buffers.get(id);
    if (!effect || !buffer || !state.audioContext) {
      showToast("先に「音を準備する」を押してください");
      return false;
    }

    const now = performance.now();
    const previous = state.lastPlayedAt.get(id) || 0;
    if (now - previous < PAD_DEBOUNCE_MS) {
      return false;
    }
    state.lastPlayedAt.set(id, now);

    if (state.audioContext.state !== "running") {
      resumeAudioContext()
        .then(() => startSoundEffect(effect, buffer))
        .catch((error) => {
          console.error("音声出力を再開できませんでした", error);
          showToast("画面を一度タップして音声を再開してください");
        });
      return true;
    }

    startSoundEffect(effect, buffer);
    return true;
  }

  function startSoundEffect(effect, buffer) {
    while (state.activeSources.size >= MAX_ACTIVE_SOURCES) {
      const oldest = state.activeSources.values().next().value;
      stopSource(oldest);
    }

    const context = state.audioContext;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(effect.volume, context.currentTime);
    source.connect(gain);
    gain.connect(state.masterGain);

    const active = { source, gain, id: effect.id };
    state.activeSources.add(active);
    source.addEventListener("ended", () => cleanupSource(active), { once: true });
    source.start(0);
    animatePad(effect.id);
  }

  function animatePad(id) {
    const pad = els.pads.find((item) => item.dataset.soundId === id);
    if (!pad) {
      return;
    }
    pad.classList.remove("is-playing");
    void pad.offsetWidth;
    pad.classList.add("is-playing");
    window.setTimeout(() => pad.classList.remove("is-playing"), 150);
  }

  function cleanupSource(active) {
    state.activeSources.delete(active);
    try {
      active.source.disconnect();
      active.gain.disconnect();
    } catch (error) {
      // The source may already have been disconnected by an immediate stop.
    }
  }

  function stopSource(active) {
    if (!active) {
      return;
    }
    try {
      active.source.stop(0);
    } catch (error) {
      // An already-ended AudioBufferSourceNode cannot be stopped again.
    }
    cleanupSource(active);
  }

  function stopAllSounds() {
    Array.from(state.activeSources).forEach(stopSource);
  }

  function applyMasterVolume() {
    if (!state.masterGain || !state.audioContext) {
      return;
    }
    state.masterGain.gain.setValueAtTime(state.masterVolume, state.audioContext.currentTime);
  }

  async function requestWakeLock() {
    if (!state.wakeLockRequested || state.wakeLock || !navigator.wakeLock || document.visibilityState !== "visible") {
      return;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    } catch (error) {
      console.info("この接続では画面維持機能を使用できません", error);
    }
  }

  async function releaseWakeLock() {
    if (!state.wakeLock) {
      return;
    }
    try {
      await state.wakeLock.release();
    } catch (error) {
      console.info("画面維持を解除できませんでした", error);
    } finally {
      state.wakeLock = null;
    }
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    els.soundpadToast.textContent = message;
    els.soundpadToast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      els.soundpadToast.hidden = true;
    }, 1700);
  }

  function showFileProtocolHelp() {
    setStatus("is-error", "効果音：スマホ配信が必要です", "start-mobile-server.cmd を起動");
    els.soundpadGateHelp.textContent = "この画面はファイルを直接開かず、start-mobile-server.cmdを起動して表示されたURLから開いてください。";
    els.enableSoundpadAudio.disabled = true;
    els.enableSoundpadAudio.querySelector("strong").textContent = "サーバーを起動してください";
  }

  function exposeTestApi() {
    window.magicSoundPad = {
      prepare: prepareAudio,
      play: playSoundEffect,
      stopAll: stopAllSounds,
      getStatus() {
        return {
          protocol: window.location.protocol,
          contextState: state.audioContext ? state.audioContext.state : "not-created",
          preloadedCount: state.fileBytes.size,
          bufferCount: state.buffers.size,
          errorCount: state.loadErrors.size,
          activeSourceCount: state.activeSources.size,
          masterVolume: state.masterVolume,
          debounceMs: PAD_DEBOUNCE_MS,
        };
      },
    };
  }

  function initialize() {
    cacheElements();
    loadSettings();
    renderVolume();
    bindEvents();
    exposeTestApi();

    if (window.location.protocol === "file:") {
      showFileProtocolHelp();
      return;
    }

    startFilePreload();
  }

  initialize();
})();
