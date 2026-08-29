"use strict";

(() => {
  const STORAGE_KEY = "magic-show-cue.effect-remote.v1";
  const REMOTE_DEBOUNCE_MS = 100;
  const RESUME_PLAY_WINDOW_MS = 500;
  const KEY_LEARNING_TIMEOUT_MS = 10000;
  const MAX_ACTIVE_SOURCES_PER_SLOT = 12;

  const BUILTIN_EFFECTS = [
    { id: "correct", name: "当たり（ピンポーン）", file: "./sound-effects/sfx_correct_pingpong.wav" },
    { id: "wrong", name: "はずれ（ブザー）", file: "./sound-effects/sfx_wrong_buzzer.wav" },
    { id: "sparkle", name: "マジックスパークル", file: "./sound-effects/sfx_magic_sparkle_reveal.wav" },
    { id: "whoosh", name: "出現（ヒューン）", file: "./sound-effects/sfx_magic_whoosh_appear.wav" },
    { id: "vanish", name: "消失（ポン）", file: "./sound-effects/sfx_magic_vanish_poof.wav" },
    { id: "tada", name: "決め（ジャーン）", file: "./sound-effects/sfx_magic_tada_sting.wav" },
    { id: "drumroll", name: "ドラムロール", file: "./sound-effects/sfx_drum_roll.wav" },
    { id: "cymbal", name: "シンバル（ジャーン！）", file: "./sound-effects/sfx_cymbal_crash.wav" },
    { id: "suspense", name: "サスペンス上昇", file: "./sound-effects/sfx_suspense_rise.wav" },
    { id: "mystery", name: "謎のチャイム", file: "./sound-effects/sfx_mystery_chime.wav" },
    { id: "wand", name: "魔法の杖（キラリン）", file: "./sound-effects/sfx_magic_wand_twinkle.wav" },
    { id: "levitate", name: "浮遊（ふわふわ）", file: "./sound-effects/sfx_levitation_float.wav" },
    { id: "teleport", name: "テレポート（シュパッ）", file: "./sound-effects/sfx_teleport_zap.wav" },
    { id: "transform", name: "大変身（モーフ）", file: "./sound-effects/sfx_transformation_morph.wav" },
    { id: "cards", name: "カードシャッフル", file: "./sound-effects/sfx_card_shuffle.wav" },
    { id: "coin", name: "コイン（チャリーン）", file: "./sound-effects/sfx_coin_chime.wav" },
    { id: "boing", name: "コミカル（ボヨーン）", file: "./sound-effects/sfx_comedy_boing.wav" },
    { id: "whistleup", name: "上昇ホイッスル", file: "./sound-effects/sfx_whistle_up.wav" },
    { id: "whistledown", name: "下降ホイッスル", file: "./sound-effects/sfx_whistle_down.wav" },
    { id: "applause", name: "拍手", file: "./sound-effects/sfx_applause.wav" },
  ];
  const DEFAULT_SLOT_EFFECT_IDS = ["correct", "wrong", "sparkle", "whoosh", "vanish", "tada"];

  const dom = {
    audioReadyStatus: document.getElementById("audioReadyStatus"),
    lastRemoteKey: document.getElementById("lastRemoteKey"),
    lastRemoteTime: document.getElementById("lastRemoteTime"),
    lastPlayedEffect: document.getElementById("lastPlayedEffect"),
    stopAllButton: document.getElementById("stopAllButton"),
    keyLearningBanner: document.getElementById("keyLearningBanner"),
    keyLearningSlot: document.getElementById("keyLearningSlot"),
    cancelKeyLearning: document.getElementById("cancelKeyLearning"),
    effectSlotGrid: document.getElementById("effectSlotGrid"),
    audioGate: document.getElementById("audioGate"),
    audioGateHelp: document.getElementById("audioGateHelp"),
    enableAudioButton: document.getElementById("enableAudioButton"),
    effectToast: document.getElementById("effectToast"),
  };

  const state = {
    audioContext: null,
    masterGain: null,
    audioEnabled: false,
    preloadPromise: null,
    preparePromise: null,
    builtinBytes: new Map(),
    builtinBuffers: new Map(),
    builtinErrors: new Map(),
    learningIndex: null,
    learningTimer: null,
    keyLastPlayedAt: new Map(),
    toastTimer: null,
    saveTimer: null,
    slots: [],
  };

  function createDefaultSlot(index, sourceId) {
    const builtin = builtinById(sourceId) || BUILTIN_EFFECTS[0];
    return {
      index,
      sourceId: builtin.id,
      name: builtin.name,
      volume: 100,
      key: index === 0 ? "VolumeUp" : index === 1 ? "VolumeDown" : "",
      fileName: builtin.file.split("/").pop(),
      buffer: null,
      gainNode: null,
      activeSources: new Set(),
      loadToken: 0,
      resumePlayToken: 0,
      loadStatus: "waiting",
      warning: "",
      playCount: 0,
    };
  }

  function clampVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 100;
    return Math.min(100, Math.max(0, Math.round(number)));
  }

  function builtinById(id) {
    return BUILTIN_EFFECTS.find((effect) => effect.id === id) || null;
  }

  function sourceExists(sourceId) {
    return sourceId === "custom" || Boolean(builtinById(sourceId));
  }

  function loadSettings() {
    const defaults = DEFAULT_SLOT_EFFECT_IDS.map((sourceId, index) => createDefaultSlot(index, sourceId));
    let savedSlots = [];

    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed && Array.isArray(parsed.slots)) savedSlots = parsed.slots;
    } catch (error) {
      console.warn("効果音設定を読み込めませんでした。", error);
    }

    state.slots = defaults.map((slot, index) => {
      const saved = savedSlots[index];
      if (!saved || typeof saved !== "object") return slot;

      const sourceId = sourceExists(saved.sourceId) ? saved.sourceId : slot.sourceId;
      const builtin = builtinById(sourceId);
      const savedName = typeof saved.name === "string" ? saved.name.trim() : "";
      const savedKey = typeof saved.key === "string" ? saved.key.trim() : "";
      const savedFileName = typeof saved.fileName === "string" ? saved.fileName.trim() : "";

      return {
        ...slot,
        sourceId,
        name: savedName || (builtin ? builtin.name : `効果音${index + 1}`),
        volume: saved.volume === undefined ? slot.volume : clampVolume(saved.volume),
        key: savedKey,
        fileName: builtin ? builtin.file.split("/").pop() : savedFileName,
        loadStatus: sourceId === "custom" ? "waiting" : "waiting",
        warning:
          sourceId === "custom"
            ? savedFileName
              ? `「${savedFileName}」をもう一度選択してください。`
              : "WAVまたはMP3ファイルを選択してください。"
            : "",
      };
    });

    const assignedSlots = [];
    let duplicateSettingsRemoved = false;
    state.slots.forEach((slot) => {
      if (!slot.key) return;
      const duplicate = assignedSlots.find((assigned) => keysOverlap(assigned.key, slot.key));
      if (!duplicate) {
        assignedSlots.push(slot);
        return;
      }
      slot.key = "";
      duplicateSettingsRemoved = true;
      const message = `保存済みキーが効果音${duplicate.index + 1}と重複したため解除しました。`;
      slot.warning = slot.warning ? `${slot.warning} ${message}` : message;
    });
    if (duplicateSettingsRemoved) saveSettings();
  }

  function saveSettings() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const value = {
      version: 1,
      slots: state.slots.map((slot) => ({
        sourceId: slot.sourceId,
        name: slot.name,
        volume: slot.volume,
        key: slot.key,
        fileName: slot.fileName,
      })),
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      console.warn("効果音設定を保存できませんでした。", error);
      showToast("設定をブラウザに保存できませんでした。", 3600);
    }
  }

  function scheduleSaveSettings() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveSettings, 180);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function sourceOptions(selectedId) {
    const builtinOptions = BUILTIN_EFFECTS.map((effect) => {
      const selected = effect.id === selectedId ? " selected" : "";
      return `<option value="${effect.id}"${selected}>内蔵：${escapeHtml(effect.name)}</option>`;
    }).join("");
    const customSelected = selectedId === "custom" ? " selected" : "";
    return `${builtinOptions}<option value="custom"${customSelected}>カスタム音源を選択…</option>`;
  }

  function slotStatus(slot) {
    if (slot.loadStatus === "loading") return { text: "読み込み中…", className: "is-loading" };
    if (slot.loadStatus === "error") return { text: "読込エラー", className: "is-error" };
    if (slot.buffer) return { text: "準備完了", className: "is-ready" };
    if (slot.sourceId === "custom") return { text: "再接続待ち", className: "is-loading" };
    return { text: "音の準備待ち", className: "is-loading" };
  }

  function renderSlots() {
    dom.effectSlotGrid.innerHTML = state.slots
      .map((slot) => {
        const status = slotStatus(slot);
        const isLearning = state.learningIndex === slot.index;
        const customRow =
          slot.sourceId === "custom"
            ? `<div class="custom-file-row">
                <button class="choose-file-button" type="button">ファイル選択</button>
                <span>${escapeHtml(slot.fileName || "未選択")}</span>
                <input class="hidden-file-input" type="file" accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg">
              </div>`
            : `<input class="hidden-file-input" type="file" accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg">`;

        return `<article class="effect-slot-card${isLearning ? " is-learning" : ""}" data-slot-index="${slot.index}" data-play-count="${slot.playCount}">
          <header class="effect-slot-header">
            <h2>効果音${slot.index + 1}</h2>
            <span class="slot-status ${status.className}">${status.text}</span>
          </header>

          <div class="effect-slot-fields">
            <label>
              <span>音源</span>
              <select class="source-select" aria-label="効果音${slot.index + 1}の音源">
                ${sourceOptions(slot.sourceId)}
              </select>
            </label>

            <label>
              <span>効果音名</span>
              <input class="effect-name-input" type="text" maxlength="40" value="${escapeHtml(slot.name)}" aria-label="効果音${slot.index + 1}の名前">
            </label>

            ${customRow}

            <label class="volume-field">
              <span>音量 <output>${slot.volume}%</output></span>
              <input class="volume-input" type="range" min="0" max="100" step="1" value="${slot.volume}" aria-label="効果音${slot.index + 1}の音量">
            </label>

            <div class="key-field">
              <span class="field-label">リモコンキー</span>
              <kbd>${escapeHtml(slot.key || "未設定")}</kbd>
              <button class="learn-key-button${isLearning ? " is-active" : ""}" type="button" aria-pressed="${isLearning}">${isLearning ? "入力待ち…" : "キーを登録"}</button>
              <button class="clear-key-button" type="button"${slot.key ? "" : " disabled"}>解除</button>
            </div>
          </div>

          <p class="slot-warning" role="alert"${slot.warning ? "" : " hidden"}>${escapeHtml(slot.warning)}</p>

          <div class="slot-actions">
            <button class="test-effect-button" type="button"${slot.buffer ? "" : " disabled"}>▶ テスト再生</button>
            <button class="stop-effect-button" type="button"${slot.activeSources.size ? "" : " disabled"}>■ 停止</button>
          </div>
        </article>`;
      })
      .join("");

    updateLearningBanner();
    updateStopAllButton();
  }

  function updateSlotCard(index) {
    const slot = state.slots[index];
    const card = dom.effectSlotGrid.querySelector(`[data-slot-index="${index}"]`);
    if (!slot || !card) return;

    const status = slotStatus(slot);
    const statusElement = card.querySelector(".slot-status");
    statusElement.textContent = status.text;
    statusElement.className = `slot-status ${status.className}`;
    card.classList.toggle("is-playing", slot.activeSources.size > 0);
    card.dataset.playCount = String(slot.playCount);

    const warning = card.querySelector(".slot-warning");
    warning.textContent = slot.warning;
    warning.hidden = !slot.warning;

    const testButton = card.querySelector(".test-effect-button");
    const stopButton = card.querySelector(".stop-effect-button");
    if (testButton) testButton.disabled = !slot.buffer;
    if (stopButton) stopButton.disabled = slot.activeSources.size === 0;
    updateStopAllButton();
  }

  function updateLearningBanner() {
    const index = state.learningIndex;
    const active = Number.isInteger(index);
    dom.keyLearningBanner.hidden = !active;
    if (active) dom.keyLearningSlot.textContent = `効果音${index + 1}`;
  }

  function updateStopAllButton() {
    dom.stopAllButton.disabled = !state.slots.some((slot) => slot.activeSources.size > 0);
  }

  function updateOverallStatus() {
    const readyCount = state.slots.filter((slot) => Boolean(slot.buffer)).length;
    const hasErrors = state.slots.some((slot) => slot.loadStatus === "error");
    const isLoading = state.slots.some((slot) => slot.loadStatus === "loading");
    const contextState = state.audioContext ? state.audioContext.state : "uninitialized";
    const outputRunning = contextState === "running" && state.audioEnabled;

    dom.audioReadyStatus.className = "effect-status";
    dom.audioReadyStatus.dataset.readyCount = String(readyCount);
    dom.audioReadyStatus.dataset.contextState = contextState;

    if (readyCount === state.slots.length && outputRunning) {
      dom.audioReadyStatus.classList.add("is-ready");
      dom.audioReadyStatus.textContent = "効果音：準備完了";
      document.body.dataset.effectRemoteReady = "true";
      return;
    }

    document.body.dataset.effectRemoteReady = "false";
    if (contextState === "closed") {
      dom.audioReadyStatus.classList.add("is-error");
      dom.audioReadyStatus.textContent = "効果音：再読み込みが必要";
    } else if (hasErrors && readyCount === 0) {
      dom.audioReadyStatus.classList.add("is-error");
      dom.audioReadyStatus.textContent = "効果音：音源を確認";
    } else if (state.audioContext && readyCount > 0 && !outputRunning) {
      dom.audioReadyStatus.classList.add("is-loading");
      dom.audioReadyStatus.textContent = "効果音：再開待ち（ボタンを押してください）";
    } else if (outputRunning || isLoading) {
      dom.audioReadyStatus.classList.add(isLoading ? "is-loading" : "is-ready");
      dom.audioReadyStatus.textContent = `効果音：${readyCount}/${state.slots.length} 準備完了`;
    } else {
      dom.audioReadyStatus.classList.add("is-waiting");
      dom.audioReadyStatus.textContent = "効果音：有効化待ち";
    }
  }

  function showToast(message, duration = 2400) {
    window.clearTimeout(state.toastTimer);
    dom.effectToast.textContent = message;
    dom.effectToast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      dom.effectToast.hidden = true;
    }, duration);
  }

  function isAudioSupported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  function syncAudioContextState(context = state.audioContext) {
    if (!context || context !== state.audioContext) return;
    state.audioEnabled = context.state === "running";
    updateOverallStatus();
  }

  function ensureAudioContext() {
    if (state.audioContext) return state.audioContext;
    if (!isAudioSupported()) throw new Error("このブラウザはWeb Audio APIに対応していません。");

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let context;
    try {
      context = new AudioContextClass({ latencyHint: "interactive" });
    } catch (_error) {
      context = new AudioContextClass();
    }
    state.audioContext = context;
    context.addEventListener("statechange", () => syncAudioContextState(context));
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = 1;
    state.masterGain.connect(state.audioContext.destination);
    return state.audioContext;
  }

  function ensureSlotGain(slot) {
    const context = ensureAudioContext();
    if (!slot.gainNode) {
      slot.gainNode = context.createGain();
      slot.gainNode.connect(state.masterGain);
    }
    slot.gainNode.gain.setValueAtTime(slot.volume / 100, context.currentTime);
    return slot.gainNode;
  }

  async function resumeAudioOutput() {
    const context = ensureAudioContext();
    if (context.state === "closed") throw new Error("音声出力が終了しています。ページを再読み込みしてください。");
    if (context.state !== "running") await context.resume();
    syncAudioContextState(context);
    if (context.state !== "running") throw new Error("音声出力を再開できませんでした。もう一度タップしてください。");
    return context;
  }

  function decodeAudioData(context, bytes) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onSuccess = (buffer) => {
        if (settled) return;
        settled = true;
        resolve(buffer);
      };
      const onFailure = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error("音声をデコードできませんでした。"));
      };

      try {
        const result = context.decodeAudioData(bytes.slice(0), onSuccess, onFailure);
        if (result && typeof result.then === "function") result.then(onSuccess, onFailure);
      } catch (error) {
        onFailure(error);
      }
    });
  }

  function looksLikeWav(bytes) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12) return false;
    const header = new Uint8Array(bytes, 0, 12);
    return (
      String.fromCharCode(...header.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...header.slice(8, 12)) === "WAVE"
    );
  }

  function preloadBuiltins() {
    if (state.preloadPromise) return state.preloadPromise;

    state.preloadPromise = Promise.allSettled(
      BUILTIN_EFFECTS.map(async (effect) => {
        if (location.protocol === "file:") {
          throw new Error("内蔵音源は起動用ファイルから開いてください。");
        }

        const response = await fetch(effect.file, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (!looksLikeWav(bytes)) throw new Error("WAVデータではありません。");
        state.builtinBytes.set(effect.id, bytes);
        state.builtinErrors.delete(effect.id);
      })
    ).then((results) => {
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          state.builtinErrors.set(BUILTIN_EFFECTS[index].id, result.reason);
        }
      });

      state.slots.forEach((slot) => {
        if (slot.sourceId === "custom") return;
        if (state.builtinErrors.has(slot.sourceId)) {
          slot.loadStatus = "error";
          slot.warning =
            location.protocol === "file:"
              ? "内蔵音源を使うには start-effect-remote.cmd から起動してください。"
              : "内蔵音源を読み込めませんでした。ページを再読み込みしてください。";
        } else if (!slot.buffer) {
          slot.loadStatus = "waiting";
        }
      });
      renderSlots();
      updateOverallStatus();
    });

    return state.preloadPromise;
  }

  async function ensureBuiltinDecoded(sourceId) {
    if (state.builtinBuffers.has(sourceId)) return state.builtinBuffers.get(sourceId);
    await preloadBuiltins();
    const bytes = state.builtinBytes.get(sourceId);
    if (!bytes) throw state.builtinErrors.get(sourceId) || new Error("内蔵音源がありません。");
    const buffer = await decodeAudioData(ensureAudioContext(), bytes);
    state.builtinBuffers.set(sourceId, buffer);
    return buffer;
  }

  async function prepareAudio() {
    if (state.preparePromise) return state.preparePromise;

    state.preparePromise = (async () => {
      dom.enableAudioButton.disabled = true;
      dom.enableAudioButton.querySelector("strong").textContent = "準備中…";
      dom.audioGateHelp.textContent = "内蔵効果音をメモリへ読み込んでいます。";
      dom.audioReadyStatus.className = "effect-status is-loading";
      dom.audioReadyStatus.textContent = "効果音：準備中…";

      const context = await resumeAudioOutput();
      await preloadBuiltins();
      if (state.builtinErrors.size > 0 && location.protocol !== "file:") {
        state.preloadPromise = null;
        state.builtinErrors.clear();
        await preloadBuiltins();
      }

      await Promise.allSettled(
        BUILTIN_EFFECTS.map(async (effect) => {
          try {
            await ensureBuiltinDecoded(effect.id);
          } catch (error) {
            state.builtinErrors.set(effect.id, error);
          }
        })
      );

      state.slots.forEach((slot) => {
        ensureSlotGain(slot);
        if (slot.sourceId === "custom") {
          if (!slot.buffer) slot.loadStatus = "waiting";
          return;
        }

        const buffer = state.builtinBuffers.get(slot.sourceId);
        if (buffer) {
          slot.buffer = buffer;
          slot.loadStatus = "ready";
          slot.warning = "";
        } else {
          slot.loadStatus = "error";
          slot.warning = "内蔵音源を準備できませんでした。";
        }
      });

      state.audioEnabled = context.state === "running";
      renderSlots();
      updateOverallStatus();
      dom.audioGate.hidden = true;

      const readyCount = state.slots.filter((slot) => slot.buffer).length;
      if (readyCount === state.slots.length) {
        showToast("効果音の準備が完了しました。");
      } else if (readyCount > 0) {
        showToast(`${readyCount}/${state.slots.length}個の効果音を準備しました。`, 3200);
      } else {
        showToast("内蔵音源を読み込めません。カスタム音源は選択できます。", 4800);
      }
    })().catch((error) => {
      console.error("効果音の準備に失敗しました。", error);
      state.preparePromise = null;
      state.audioEnabled = false;
      dom.enableAudioButton.disabled = false;
      dom.enableAudioButton.querySelector("strong").textContent = "もう一度準備する";
      dom.audioGateHelp.textContent = error.message || "音声を有効化できませんでした。";
      dom.audioReadyStatus.className = "effect-status is-error";
      dom.audioReadyStatus.textContent = "効果音：準備エラー";
    });

    return state.preparePromise;
  }

  function applySlotVolume(slot) {
    if (!slot.gainNode || !state.audioContext) return;
    slot.gainNode.gain.setValueAtTime(slot.volume / 100, state.audioContext.currentTime);
  }

  function removeSource(slot, source) {
    slot.activeSources.delete(source);
    try {
      source.disconnect();
    } catch (_error) {
      // Disconnection is best effort.
    }
    updateSlotCard(slot.index);
  }

  function stopOldestSourceIfNeeded(slot) {
    if (slot.activeSources.size < MAX_ACTIVE_SOURCES_PER_SLOT) return;
    const oldest = slot.activeSources.values().next().value;
    if (!oldest) return;
    slot.activeSources.delete(oldest);
    oldest.onended = null;
    try {
      oldest.stop();
    } catch (_error) {
      // Already stopped sources are harmless.
    }
    try {
      oldest.disconnect();
    } catch (_error) {
      // Disconnection is best effort.
    }
  }

  function startSlotBuffer(slot, triggerName) {
    if (!slot.buffer) {
      showToast(`効果音${slot.index + 1}の音源が準備されていません。`);
      return false;
    }

    let context;
    try {
      context = ensureAudioContext();
      if (context.state === "closed") throw new Error("音声出力が終了しています。");
      if (context.state !== "running") {
        const resumeToken = ++slot.resumePlayToken;
        const resumeRequestedAt = performance.now();
        Promise.resolve(context.resume())
          .then(() => {
            syncAudioContextState(context);
            if (slot.resumePlayToken !== resumeToken) return;
            if (performance.now() - resumeRequestedAt > RESUME_PLAY_WINDOW_MS) return;
            if (context.state !== "running") throw new Error("音声出力がrunning状態になりませんでした。");
            startSlotBuffer(slot, triggerName);
          })
          .catch((error) => {
            if (slot.resumePlayToken !== resumeToken) return;
            console.warn("音声出力を再開できませんでした。", error);
            state.audioEnabled = false;
            slot.warning = "音声出力を再開できません。画面をタップしてもう一度お試しください。";
            updateOverallStatus();
            updateSlotCard(slot.index);
            showToast(slot.warning, 3600);
          });
        return true;
      }
      slot.resumePlayToken += 1;
      const gainNode = ensureSlotGain(slot);
      stopOldestSourceIfNeeded(slot);

      const source = context.createBufferSource();
      source.buffer = slot.buffer;
      source.connect(gainNode);
      source.onended = () => removeSource(slot, source);
      slot.activeSources.add(source);
      source.start(0);

      slot.playCount += 1;
      dom.lastPlayedEffect.textContent = slot.name || `効果音${slot.index + 1}`;
      dom.lastPlayedEffect.title = triggerName ? `${triggerName}で再生` : "テスト再生";
      updateSlotCard(slot.index);
      return true;
    } catch (error) {
      console.error("効果音を再生できませんでした。", error);
      slot.warning = "再生できませんでした。「音を準備する」を押し直してください。";
      updateSlotCard(slot.index);
      return false;
    }
  }

  function stopSlot(index) {
    const slot = state.slots[index];
    if (!slot) return;
    slot.resumePlayToken += 1;
    const sources = Array.from(slot.activeSources);
    slot.activeSources.clear();
    sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch (_error) {
        // Already stopped sources are harmless.
      }
      try {
        source.disconnect();
      } catch (_error) {
        // Disconnection is best effort.
      }
    });
    updateSlotCard(index);
  }

  function stopAll() {
    state.slots.forEach((slot) => stopSlot(slot.index));
    dom.lastPlayedEffect.textContent = "全停止";
  }

  function isAcceptedAudioFile(file) {
    if (!file) return false;
    const extensionOkay = /\.(wav|mp3)$/i.test(file.name);
    const typeOkay = ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3"].includes(file.type);
    return extensionOkay || typeOkay;
  }

  async function loadCustomFile(index, file) {
    const slot = state.slots[index];
    if (!slot || !file) return;
    if (!isAcceptedAudioFile(file)) {
      slot.warning = "WAVまたはMP3ファイルを選択してください。";
      updateSlotCard(index);
      showToast(slot.warning);
      return;
    }

    const token = ++slot.loadToken;
    const previous = {
      sourceId: slot.sourceId,
      buffer: slot.buffer,
      fileName: slot.fileName,
      loadStatus: slot.buffer ? "ready" : slot.loadStatus === "error" ? "error" : "waiting",
      warning: slot.loadStatus === "loading" ? "" : slot.warning,
    };
    slot.loadStatus = "loading";
    slot.warning = "音声をメモリへ読み込んでいます。";
    updateSlotCard(index);

    try {
      const context = await resumeAudioOutput();
      const bytes = await file.arrayBuffer();
      const buffer = await decodeAudioData(context, bytes);
      if (slot.loadToken !== token) return;

      stopSlot(index);
      slot.sourceId = "custom";
      slot.buffer = buffer;
      slot.fileName = file.name;
      slot.loadStatus = "ready";
      slot.warning = "";
      if (!slot.name || slot.name === `効果音${index + 1}` || builtinById(previous.sourceId)?.name === slot.name) {
        slot.name = file.name.replace(/\.[^.]+$/, "") || `効果音${index + 1}`;
      }
      state.audioEnabled = context.state === "running";
      saveSettings();
      renderSlots();
      updateOverallStatus();
      showToast(`${file.name}を準備しました。`);
    } catch (error) {
      if (slot.loadToken !== token) return;
      console.error("カスタム効果音を読み込めませんでした。", error);
      Object.assign(slot, previous);
      slot.warning = "この音声を読み込めませんでした。別のWAV/MP3を選択してください。";
      renderSlots();
      updateOverallStatus();
      showToast("音声ファイルを読み込めませんでした。", 3600);
    }
  }

  async function selectBuiltin(index, sourceId) {
    const slot = state.slots[index];
    const builtin = builtinById(sourceId);
    if (!slot || !builtin) return;
    const token = ++slot.loadToken;

    const previousName = slot.name;
    const previousBuiltin = builtinById(slot.sourceId);
    slot.loadStatus = "loading";
    slot.warning = "";
    updateSlotCard(index);

    try {
      const buffer = await ensureBuiltinDecoded(sourceId);
      if (slot.loadToken !== token) return;
      stopSlot(index);
      slot.sourceId = sourceId;
      slot.buffer = buffer;
      slot.fileName = builtin.file.split("/").pop();
      slot.loadStatus = "ready";
      slot.warning = "";
      if (!previousName || previousName === `効果音${index + 1}` || previousBuiltin?.name === previousName) {
        slot.name = builtin.name;
      }
      saveSettings();
      renderSlots();
      updateOverallStatus();
    } catch (error) {
      if (slot.loadToken !== token) return;
      console.error("内蔵効果音を切り替えられませんでした。", error);
      slot.loadStatus = slot.buffer ? "ready" : "error";
      slot.warning = "内蔵音源を読み込めませんでした。";
      renderSlots();
      updateOverallStatus();
    }
  }

  function beginKeyLearning(index) {
    cancelKeyLearning(false);
    state.learningIndex = index;
    state.slots[index].warning = "次に押したキーを登録します（10秒で自動終了）。";
    state.learningTimer = window.setTimeout(() => {
      cancelKeyLearning(false);
      showToast("キー登録を時間切れで終了しました。");
    }, KEY_LEARNING_TIMEOUT_MS);
    renderSlots();
  }

  function cancelKeyLearning(showMessage = true) {
    window.clearTimeout(state.learningTimer);
    state.learningTimer = null;
    const previousIndex = state.learningIndex;
    state.learningIndex = null;
    if (Number.isInteger(previousIndex)) {
      const slot = state.slots[previousIndex];
      if (slot.warning.includes("次に押したキー")) slot.warning = "";
      renderSlots();
      if (showMessage) showToast("キー登録をキャンセルしました。");
    } else {
      updateLearningBanner();
    }
  }

  function keyNameForEvent(event) {
    const code = typeof event.code === "string" ? event.code : "";
    const key = typeof event.key === "string" ? event.key : "";
    if (/^(Key[A-Z]|Digit[0-9]|Numpad\w+)$/i.test(code)) return code;
    if (key === " " || key === "Spacebar") return "Space";
    if (key && key !== "Unidentified") return key;
    return code || "Unidentified";
  }

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function keyIdentities(value) {
    const normalized = normalizeKey(value);
    const identities = new Set();
    if (!normalized) return identities;
    identities.add(normalized);

    const letterCode = normalized.match(/^key([a-z])$/);
    if (letterCode) identities.add(letterCode[1]);
    else if (/^[a-z]$/.test(normalized)) identities.add(`key${normalized}`);

    const digitCode = normalized.match(/^digit([0-9])$/);
    if (digitCode) identities.add(digitCode[1]);
    else if (/^[0-9]$/.test(normalized)) identities.add(`digit${normalized}`);

    const aliases = {
      audiovolumeup: "volumeup",
      volumeup: "audiovolumeup",
      audiovolumedown: "volumedown",
      volumedown: "audiovolumedown",
      audiovolumemute: "volumemute",
      volumemute: "audiovolumemute",
      spacebar: "space",
    };
    if (aliases[normalized]) identities.add(aliases[normalized]);
    return identities;
  }

  function keysOverlap(first, second) {
    const left = keyIdentities(first);
    const right = keyIdentities(second);
    return Array.from(left).some((identity) => right.has(identity));
  }

  function keyCandidatesForEvent(event) {
    const names = [keyNameForEvent(event), event.code, event.key === " " ? "Space" : event.key];
    return Array.from(new Set(names.map(normalizeKey).filter(Boolean)));
  }

  function recordRemoteInput(name) {
    dom.lastRemoteKey.textContent = name || "Unidentified";
    dom.lastRemoteTime.textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    dom.lastRemoteTime.dateTime = new Date().toISOString();
  }

  function deferRemoteInput(name) {
    window.requestAnimationFrame(() => recordRemoteInput(name));
  }

  function isTextEditingEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const input = target.closest("input");
    const textControl = target.closest("textarea, [contenteditable='true']") ||
      (input && ["text", "search", "email", "url", "tel", "password", "number"].includes(input.type));
    if (!textControl) return false;
    if (event.isComposing) return true;
    const key = typeof event.key === "string" ? event.key : "";
    if (key.length === 1) return true;
    return [
      "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab"
    ].includes(key);
  }

  function assignLearnedKey(name) {
    const index = state.learningIndex;
    if (!Number.isInteger(index)) return false;

    if (!name || name === "Unidentified") {
      state.slots[index].warning = "キー名を取得できませんでした。別のボタンを押してください。";
      updateSlotCard(index);
      return true;
    }

    const duplicate = state.slots.find(
      (slot) => slot.index !== index && slot.key && keysOverlap(slot.key, name)
    );
    if (duplicate) {
      state.slots[index].warning = `このキーは効果音${duplicate.index + 1}で使用されています。上書きしませんでした。`;
      window.clearTimeout(state.learningTimer);
      state.learningTimer = window.setTimeout(() => cancelKeyLearning(false), KEY_LEARNING_TIMEOUT_MS);
      renderSlots();
      showToast(`「${name}」は効果音${duplicate.index + 1}で使用中です。`, 3600);
      return true;
    }

    const slot = state.slots[index];
    slot.key = name;
    slot.warning = "";
    window.clearTimeout(state.learningTimer);
    state.learningTimer = null;
    state.learningIndex = null;
    saveSettings();
    renderSlots();
    showToast(`効果音${index + 1}に「${name}」を登録しました。`);
    return true;
  }

  function playAssignedKey(keyCandidates, repeat, displayName) {
    const slot = state.slots.find(
      (candidate) => candidate.key && keyCandidates.some((key) => keysOverlap(candidate.key, key))
    );
    if (!slot) return false;
    if (repeat) return true;

    const debounceKey = normalizeKey(slot.key);
    const now = performance.now();
    const previous = state.keyLastPlayedAt.get(debounceKey) || -Infinity;
    if (now - previous < REMOTE_DEBOUNCE_MS) return true;
    state.keyLastPlayedAt.set(debounceKey, now);

    startSlotBuffer(slot, displayName);
    return true;
  }

  function handleKeyDown(event) {
    const name = keyNameForEvent(event);

    if (Number.isInteger(state.learningIndex)) {
      deferRemoteInput(name);
      event.preventDefault();
      event.stopPropagation();
      if (name === "Escape") {
        cancelKeyLearning();
        return;
      }
      if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(name)) return;
      assignLearnedKey(name);
      return;
    }

    if (name === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stopAll();
      deferRemoteInput(name);
      return;
    }

    if (isTextEditingEvent(event)) {
      deferRemoteInput(name);
      return;
    }

    const handled = playAssignedKey(keyCandidatesForEvent(event), event.repeat, name);
    deferRemoteInput(name);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleNamedRemoteInput(name) {
    if (Number.isInteger(state.learningIndex)) {
      deferRemoteInput(name);
      assignLearnedKey(name);
      return;
    }
    playAssignedKey([normalizeKey(name)], false, name);
    deferRemoteInput(name);
  }

  function installMediaSessionHandlers() {
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setActionHandler !== "function") return;
    const actions = {
      play: "MediaPlayPause",
      pause: "MediaPlayPause",
      nexttrack: "MediaTrackNext",
      previoustrack: "MediaTrackPrevious",
      stop: "MediaStop",
    };
    Object.entries(actions).forEach(([action, keyName]) => {
      try {
        navigator.mediaSession.setActionHandler(action, () => handleNamedRemoteInput(keyName));
      } catch (_error) {
        // Some browsers expose Media Session but not every action.
      }
    });
  }

  function slotIndexFromTarget(target) {
    const card = target.closest("[data-slot-index]");
    return card ? Number(card.dataset.slotIndex) : -1;
  }

  function handleGridClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const index = slotIndexFromTarget(button);
    if (!Number.isInteger(index) || index < 0) return;

    if (button.classList.contains("test-effect-button")) {
      startSlotBuffer(state.slots[index], "テスト");
    } else if (button.classList.contains("stop-effect-button")) {
      stopSlot(index);
    } else if (button.classList.contains("learn-key-button")) {
      if (state.learningIndex === index) cancelKeyLearning();
      else beginKeyLearning(index);
    } else if (button.classList.contains("clear-key-button")) {
      state.slots[index].key = "";
      state.slots[index].warning = "";
      saveSettings();
      renderSlots();
      showToast(`効果音${index + 1}のキー割り当てを解除しました。`);
    } else if (button.classList.contains("choose-file-button")) {
      button.closest(".effect-slot-card").querySelector(".hidden-file-input").click();
    }
  }

  function handleGridInput(event) {
    const index = slotIndexFromTarget(event.target);
    if (!Number.isInteger(index) || index < 0) return;
    const slot = state.slots[index];

    if (event.target.classList.contains("volume-input")) {
      slot.volume = clampVolume(event.target.value);
      event.target.closest(".volume-field").querySelector("output").textContent = `${slot.volume}%`;
      applySlotVolume(slot);
      scheduleSaveSettings();
    } else if (event.target.classList.contains("effect-name-input")) {
      slot.name = event.target.value;
      scheduleSaveSettings();
    }
  }

  function handleGridChange(event) {
    const index = slotIndexFromTarget(event.target);
    if (!Number.isInteger(index) || index < 0) return;
    const slot = state.slots[index];

    if (event.target.classList.contains("source-select")) {
      const sourceId = event.target.value;
      if (sourceId === "custom") {
        event.target.value = slot.sourceId;
        event.target.closest(".effect-slot-card").querySelector(".hidden-file-input").click();
      } else if (sourceId !== slot.sourceId) {
        selectBuiltin(index, sourceId);
      }
    } else if (event.target.classList.contains("hidden-file-input")) {
      const file = event.target.files && event.target.files[0];
      if (file) loadCustomFile(index, file);
      event.target.value = "";
    } else if (event.target.classList.contains("effect-name-input")) {
      slot.name = event.target.value.trim() || `効果音${index + 1}`;
      event.target.value = slot.name;
      saveSettings();
    } else if (event.target.classList.contains("volume-input")) {
      slot.volume = clampVolume(event.target.value);
      applySlotVolume(slot);
      saveSettings();
    }
  }

  function invalidatePendingResumePlays() {
    state.slots.forEach((slot) => {
      slot.resumePlayToken += 1;
    });
  }

  function tryResumeAudioOutput() {
    const context = state.audioContext;
    if (!context || context.state === "running" || context.state === "closed") return;
    invalidatePendingResumePlays();
    try {
      Promise.resolve(context.resume())
        .then(() => syncAudioContextState(context))
        .catch(() => syncAudioContextState(context));
    } catch (_error) {
      syncAudioContextState(context);
    }
  }

  function bindEvents() {
    dom.enableAudioButton.addEventListener("click", prepareAudio);
    dom.stopAllButton.addEventListener("click", stopAll);
    dom.cancelKeyLearning.addEventListener("click", () => cancelKeyLearning());
    dom.effectSlotGrid.addEventListener("click", handleGridClick);
    dom.effectSlotGrid.addEventListener("input", handleGridInput);
    dom.effectSlotGrid.addEventListener("change", handleGridChange);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", tryResumeAudioOutput, true);

    window.addEventListener("pagehide", () => {
      saveSettings();
      stopAll();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tryResumeAudioOutput();
    });
  }

  function initialize() {
    loadSettings();
    renderSlots();
    updateOverallStatus();
    bindEvents();
    installMediaSessionHandlers();

    if (!isAudioSupported()) {
      dom.enableAudioButton.disabled = true;
      dom.audioGateHelp.textContent = "このブラウザはWeb Audio APIに対応していません。";
      dom.audioReadyStatus.className = "effect-status is-error";
      dom.audioReadyStatus.textContent = "効果音：非対応";
      return;
    }

    preloadBuiltins();
  }

  initialize();
})();
