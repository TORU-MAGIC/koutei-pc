"use strict";

const STORE_KEY = "magic-show-cue.v1";
const SFX_STORE_KEY = "magic-show-cue.sfx.v1";
const SFX_SLOT_COUNT = 3;
const SFX_DEBOUNCE_MS = 100;

const defaultCueSettings = {
  fadeOut: 4,
  gapAfter: 1.5,
  finishAction: "autoNext",
  endAction: "wait",
  volume: 100,
};

const state = {
  cues: [],
  currentIndex: 0,
  loadedIndex: -1,
  audio: new Audio(),
  isPlaying: false,
  isFading: false,
  isWaiting: false,
  pendingIndex: -1,
  pendingAutoStart: false,
  countdownUntil: 0,
  waitTimer: 0,
  fadeToken: 0,
  fadeTimer: 0,
  fadeInterval: 0,
  fadeResolve: null,
  audioContext: null,
  audioSource: null,
  fadeGain: null,
  masterVolume: 1,
  showMode: false,
  wakeLock: null,
  fileMode: "add",
  status: "音源を追加してください",
  remoteStatus: "待機中",
  remoteLastAt: 0,
  remoteLastKey: "",
  remoteActionLastAt: 0,
  remoteActionLastLabel: "",
  remoteBridgeLastId: 0,
};

const sfxState = {
  audioContext: null,
  contextError: "",
  captureIndex: -1,
  lastInputKey: "",
  lastInputAt: 0,
  lastTriggerAtByKey: new Map(),
  slots: Array.from({ length: SFX_SLOT_COUNT }, (_, index) => ({
    name: "効果音" + (index + 1),
    volume: 100,
    key: "",
    fileName: "",
    buffer: null,
    gainNode: null,
    activeSources: new Set(),
    loadToken: 0,
    loadStatus: "empty",
    warning: "",
  })),
};

const REMOTE_CONTROL_COOLDOWN_MS = 700;
const REMOTE_DUPLICATE_SUPPRESS_MS = 1800;
const REMOTE_HELPER_URL = "http://127.0.0.1:8765/commands";
const REMOTE_HELPER_FAST_POLL_MS = 120;
const REMOTE_HELPER_SLOW_POLL_MS = 1200;

const REMOTE_CONTROL_ACTIONS = {
  F8: {
    label: "リモコン− → フェードして次曲待機",
    run: () => fadeOutAndStandbyNextFromRemote(),
  },
  F9: {
    label: "リモコン＋ → 次曲スタート",
    run: () => startNextCueFromRemote(),
  },
  AudioVolumeDown: {
    label: "音量− → フェードして次曲待機",
    run: () => fadeOutAndStandbyNextFromRemote(),
  },
  VolumeDown: {
    label: "音量− → フェードして次曲待機",
    run: () => fadeOutAndStandbyNextFromRemote(),
  },
  MediaTrackNext: {
    label: "次曲キー → 次曲スタート",
    run: () => startNextCueFromRemote(),
  },
  MediaNextTrack: {
    label: "次曲キー → 次曲スタート",
    run: () => startNextCueFromRemote(),
  },
  AudioVolumeUp: {
    label: "音量＋ → 次曲スタート",
    run: () => startNextCueFromRemote(),
  },
  VolumeUp: {
    label: "音量＋ → 次曲スタート",
    run: () => startNextCueFromRemote(),
  },
  MediaTrackPrevious: {
    label: "前曲キー → 前曲待機",
    run: () => standbyRelative(-1),
  },
  MediaPreviousTrack: {
    label: "前曲キー → 前曲待機",
    run: () => standbyRelative(-1),
  },
  MediaPlayPause: {
    label: "再生/一時停止キー",
    run: () => togglePlayPause(),
  },
  MediaPlay: {
    label: "再生キー",
    run: () => playCurrent(),
  },
  MediaPause: {
    label: "一時停止キー",
    run: () => {
      if (state.isPlaying) {
        togglePlayPause();
      }
    },
  },
  MediaStop: {
    label: "停止キー",
    run: () => stopNow(),
  },
};

const BGM_SHORTCUT_KEYS = new Set([
  ...Object.keys(REMOTE_CONTROL_ACTIONS),
  " ",
  "Space",
  "Spacebar",
  "Enter",
  "f",
  "F",
  "KeyF",
  "s",
  "S",
  "KeyS",
  "ArrowRight",
  "ArrowLeft",
]);

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  state.audio.preload = "auto";
  state.audio.addEventListener("ended", handleNaturalEnd);
  state.audio.addEventListener("timeupdate", updateStage);
  state.audio.addEventListener("loadedmetadata", updateStage);
  state.audio.addEventListener("error", () => {
    state.isPlaying = false;
    setStatus("音源を読み込めませんでした");
    updateStage();
  });

  mountApp();
  bindEvents();
  setupMediaSessionHandlers();
  setupRemoteHelperBridge();
  loadLocalSetlist();
  loadSoundEffectSettings();
  renderCueList();
  renderDefaultSettings();
  renderSoundEffects();
  updateStage();
  window.setInterval(updateStage, 120);
});

function mountApp() {
  document.getElementById("app").innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true"></div>
          <div>
            <h1>Magic Show Cue</h1>
            <p id="statusText">音源を追加してください</p>
          </div>
        </div>
        <div class="top-actions">
          <button id="addAudioBtn" type="button" title="音源を追加">＋ 音源</button>
          <button id="relinkAudioBtn" type="button" title="保存済みセットリストに音源を再接続">↺ 再接続</button>
          <button id="showModeBtn" type="button" title="本番用の大画面に切り替え">本番</button>
          <button id="wakeLockBtn" type="button" title="対応ブラウザで画面スリープを抑止">画面維持</button>
        </div>
      </header>

      <main class="workspace">
        <section class="stage" aria-label="ショー操作">
          <div class="stage-top">
            <div class="cue-meta" id="cueMeta">0 / 0</div>
            <button id="fullscreenBtn" class="icon-button" type="button" title="全画面">⛶</button>
          </div>

          <div>
            <h2 class="current-title" id="currentTitle">音源なし</h2>
            <p class="current-file" id="currentFile">右側の音源ボタンから曲を追加します</p>
          </div>

          <div class="stage-center">
            <div class="progress-shell" aria-label="再生位置">
              <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="time-row">
              <span id="elapsedTime">0:00</span>
              <span id="remainingTime">-0:00</span>
            </div>
          </div>

          <div class="next-panel">
            <div>
              <span class="next-label">次</span>
              <strong class="next-title" id="nextTitle">なし</strong>
            </div>
            <div class="countdown" id="countdownText"></div>
          </div>

          <div>
            <div class="transport">
              <button id="playPauseBtn" class="primary" type="button">▶ 開始</button>
              <button id="finishActBtn" class="danger" type="button">演技終了</button>
              <button id="fadeStopBtn" class="gold" type="button">フェード停止</button>
            </div>
            <div class="secondary-controls">
              <button id="prevCueBtn" type="button" title="前の曲を待機">⏮ 前へ</button>
              <button id="nextCueBtn" type="button" title="次の曲を待機">⏭ 次へ</button>
              <button id="restartBtn" type="button" title="現在の曲を先頭へ">↺ 頭出し</button>
              <button id="stopNowBtn" type="button" title="今すぐ停止">■ 停止</button>
              <button id="saveLocalBtn" type="button" title="現在の設定をこのブラウザに保存">保存</button>
            </div>
            <div class="master-strip">
              <span>マスター音量</span>
              <input id="masterVolume" type="range" min="0" max="100" value="100">
              <strong id="masterVolumeText">100%</strong>
            </div>
            <div class="remote-strip">
              <span>Bluetoothリモコン</span>
              <strong id="remoteStatusText">待機中</strong>
            </div>
          </div>
        </section>

        <aside class="side" aria-label="セットリスト編集">
          <section class="panel">
            <div class="panel-header">
              <h2>セットリスト</h2>
              <span id="preflightText">0曲</span>
            </div>
            <div class="setup-grid">
              <button id="exportBtn" type="button">書き出し</button>
              <button id="importBtn" type="button">読み込み</button>
              <button id="clearBtn" type="button">全消去</button>
              <button id="duplicateBtn" type="button">複製</button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2>新規曲の初期値</h2>
              <span>演目ごとに上書き可</span>
            </div>
            <div class="default-grid">
              <label>
                フェード秒
                <input id="defaultFade" type="number" min="0" max="30" step="0.1">
              </label>
              <label>
                次曲まで
                <input id="defaultGap" type="number" min="0" max="60" step="0.1">
              </label>
              <label>
                演技終了時
                <select id="defaultFinishAction">
                  <option value="autoNext">次曲を自動開始</option>
                  <option value="standbyNext">次曲を待機</option>
                  <option value="stop">停止のみ</option>
                </select>
              </label>
              <label>
                曲終了時
                <select id="defaultEndAction">
                  <option value="wait">待機</option>
                  <option value="standbyNext">次曲を待機</option>
                  <option value="autoNext">次曲を自動開始</option>
                </select>
              </label>
            </div>
          </section>

          <section class="panel sfx-panel" id="sfxPanel" aria-label="効果音設定">
            <div class="panel-header">
              <h2>効果音</h2>
              <span id="sfxReadyStatus" class="status-pill warn" aria-live="polite">効果音：画面をクリックして準備</span>
            </div>
            <div class="sfx-slots" id="sfxSlots"></div>
            <div class="remote-input-test" aria-label="リモコン入力テスト">
              <strong>リモコン入力テスト</strong>
              <div class="remote-input-value">
                <span>最後に受信したキー</span>
                <code id="lastRemoteKey" aria-live="polite">未受信</code>
              </div>
              <span id="lastRemoteTime" class="remote-input-time">受信時刻：—</span>
            </div>
          </section>

          <section class="panel cue-list" id="cueList" aria-label="曲一覧"></section>
        </aside>
      </main>

      <input id="audioInput" class="hidden" type="file" accept="audio/*" multiple>
      <input id="setlistInput" class="hidden" type="file" accept="application/json,.json">
      <input id="sfxFileInput0" class="hidden" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg">
      <input id="sfxFileInput1" class="hidden" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg">
      <input id="sfxFileInput2" class="hidden" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg">
    </div>
  `;

  [
    "statusText",
    "addAudioBtn",
    "relinkAudioBtn",
    "showModeBtn",
    "wakeLockBtn",
    "fullscreenBtn",
    "cueMeta",
    "currentTitle",
    "currentFile",
    "progressFill",
    "elapsedTime",
    "remainingTime",
    "nextTitle",
    "countdownText",
    "playPauseBtn",
    "finishActBtn",
    "fadeStopBtn",
    "prevCueBtn",
    "nextCueBtn",
    "restartBtn",
    "stopNowBtn",
    "saveLocalBtn",
    "masterVolume",
    "masterVolumeText",
    "remoteStatusText",
    "preflightText",
    "exportBtn",
    "importBtn",
    "clearBtn",
    "duplicateBtn",
    "defaultFade",
    "defaultGap",
    "defaultFinishAction",
    "defaultEndAction",
    "sfxPanel",
    "sfxReadyStatus",
    "sfxSlots",
    "lastRemoteKey",
    "lastRemoteTime",
    "cueList",
    "audioInput",
    "setlistInput",
    "sfxFileInput0",
    "sfxFileInput1",
    "sfxFileInput2",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  els.addAudioBtn.addEventListener("click", () => {
    state.fileMode = "add";
    els.audioInput.click();
  });

  els.relinkAudioBtn.addEventListener("click", () => {
    state.fileMode = "relink";
    els.audioInput.click();
  });

  els.audioInput.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    if (state.fileMode === "relink") {
      relinkAudioFiles(files);
    } else {
      addAudioFiles(files);
    }
    event.target.value = "";
  });

  els.importBtn.addEventListener("click", () => els.setlistInput.click());
  els.setlistInput.addEventListener("change", importSetlist);
  els.exportBtn.addEventListener("click", exportSetlist);
  els.clearBtn.addEventListener("click", clearSetlist);
  els.duplicateBtn.addEventListener("click", duplicateCurrentCue);
  els.saveLocalBtn.addEventListener("click", () => {
    saveLocalSetlist();
    saveSoundEffectSettings();
    setStatus("保存しました");
  });

  els.playPauseBtn.addEventListener("click", togglePlayPause);
  els.finishActBtn.addEventListener("click", finishAct);
  els.fadeStopBtn.addEventListener("click", fadeAndStop);
  els.stopNowBtn.addEventListener("click", stopNow);
  els.restartBtn.addEventListener("click", restartCurrent);
  els.nextCueBtn.addEventListener("click", () => standbyRelative(1));
  els.prevCueBtn.addEventListener("click", () => standbyRelative(-1));
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  els.showModeBtn.addEventListener("click", toggleShowMode);
  els.wakeLockBtn.addEventListener("click", toggleWakeLock);

  els.masterVolume.addEventListener("input", () => {
    state.masterVolume = Number(els.masterVolume.value) / 100;
    applyCurrentVolume();
    saveLocalSetlist();
    updateStage();
  });

  els.defaultFade.addEventListener("input", () => {
    defaultCueSettings.fadeOut = clampNumber(els.defaultFade.value, 0, 30, 4);
    saveLocalSetlist();
  });

  els.defaultGap.addEventListener("input", () => {
    defaultCueSettings.gapAfter = clampNumber(els.defaultGap.value, 0, 60, 1.5);
    saveLocalSetlist();
  });

  els.defaultFinishAction.addEventListener("change", () => {
    defaultCueSettings.finishAction = els.defaultFinishAction.value;
    saveLocalSetlist();
  });

  els.defaultEndAction.addEventListener("change", () => {
    defaultCueSettings.endAction = els.defaultEndAction.value;
    saveLocalSetlist();
  });

  els.cueList.addEventListener("click", handleCueListClick);
  els.cueList.addEventListener("input", handleCueFieldInput);
  els.cueList.addEventListener("change", handleCueFieldInput);
  els.sfxSlots.addEventListener("click", handleSoundEffectPanelClick);
  els.sfxSlots.addEventListener("input", handleSoundEffectFieldInput);

  sfxState.slots.forEach((slot, index) => {
    els["sfxFileInput" + index].addEventListener("change", (event) => {
      loadSoundEffectFile(index, event.target.files && event.target.files[0]);
      event.target.value = "";
    });
  });

  document.addEventListener("pointerdown", () => {
    prepareSoundEffectOutput();
  }, { capture: true, passive: true });
  document.addEventListener("keydown", () => {
    prepareSoundEffectOutput();
  }, { capture: true });
  document.addEventListener("keydown", handleKeys);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.wakeLock) {
      requestWakeLock();
    }
  });
}

function addAudioFiles(files) {
  const audioFiles = files.filter((file) => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name));
  if (!audioFiles.length) {
    setStatus("音声ファイルが選択されていません");
    return;
  }

  const startLength = state.cues.length;
  audioFiles.forEach((file) => {
    const cue = createCueFromFile(file);
    state.cues.push(cue);
    probeDuration(cue);
  });

  if (startLength === 0) {
    state.currentIndex = 0;
    state.loadedIndex = -1;
  }

  saveLocalSetlist();
  renderCueList();
  setStatus(`${audioFiles.length}曲追加しました`);
  updateStage();
}

function relinkAudioFiles(files) {
  if (!files.length) {
    return;
  }

  cancelWait();
  cancelFade();
  stopAudio({ reset: true });

  const byName = new Map(files.map((file) => [file.name, file]));
  let linkedCount = 0;

  state.cues.forEach((cue) => {
    const file = byName.get(cue.fileName);
    if (!file) {
      return;
    }

    revokeCueObjectUrl(cue);

    cue.objectUrl = URL.createObjectURL(file);
    cue.connected = true;
    cue.duration = null;
    linkedCount += 1;
    probeDuration(cue);
  });

  state.loadedIndex = -1;
  saveLocalSetlist();
  renderCueList();
  setStatus(`${linkedCount}曲を再接続しました`);
  updateStage();
}

function createCueFromFile(file) {
  return {
    id: makeId(),
    title: stripExtension(file.name),
    fileName: file.name,
    duration: null,
    objectUrl: URL.createObjectURL(file),
    connected: true,
    fadeOut: defaultCueSettings.fadeOut,
    gapAfter: defaultCueSettings.gapAfter,
    finishAction: defaultCueSettings.finishAction,
    endAction: defaultCueSettings.endAction,
    volume: defaultCueSettings.volume,
  };
}

function probeDuration(cue) {
  if (!cue.objectUrl) {
    return;
  }

  const probe = new Audio();
  probe.preload = "metadata";
  probe.src = cue.objectUrl;
  probe.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(probe.duration)) {
      cue.duration = probe.duration;
      renderCueList();
      updateStage();
      saveLocalSetlist();
    }
  }, { once: true });
}

function togglePlayPause() {
  if (state.isWaiting) {
    runPendingNow();
    return;
  }

  if (state.isPlaying) {
    state.audio.pause();
    state.isPlaying = false;
    setStatus("一時停止中");
    updateStage();
    return;
  }

  playCurrent({ resetIfEnded: true });
}

async function playCurrent(options = {}) {
  const cue = currentCue();
  if (!cue) {
    setStatus("音源を追加してください");
    updateStage();
    return false;
  }

  if (!cue.objectUrl) {
    setStatus("この曲は音源が未接続です");
    updateStage();
    return false;
  }

  cancelWait();
  cancelFade();

  if (!ensureAudioLoaded(state.currentIndex)) {
    return false;
  }

  await prepareAudioOutput();

  const duration = state.audio.duration;
  if (options.reset || (options.resetIfEnded && Number.isFinite(duration) && state.audio.currentTime >= duration - 0.05)) {
    state.audio.currentTime = 0;
  }

  applyCurrentVolume();

  try {
    await state.audio.play();
    state.isPlaying = true;
    setStatus("再生中");
    updateStage();
    return true;
  } catch (error) {
    state.isPlaying = false;
    setStatus("ブラウザが再生を止めました。開始ボタンを押してください");
    updateStage();
    return false;
  }
}

async function finishAct() {
  const cue = currentCue();
  if (!cue || state.isFading) {
    return;
  }

  cancelWait();
  const action = cue.finishAction;
  const gap = cue.gapAfter;

  if (state.loadedIndex === state.currentIndex && !state.audio.paused && !hasAudioEnded()) {
    state.isFading = true;
    setStatus("フェードアウト中");
    updateStage();
    const fadeCompleted = await fadeOutCurrent(cue.fadeOut);
    state.isFading = false;
    if (!fadeCompleted) {
      return;
    }
  } else {
    stopAudio({ reset: false });
  }

  runCueAction(action, gap, "演技終了");
}

async function fadeAndStop() {
  const cue = currentCue();
  if (!cue || state.isFading) {
    return;
  }

  cancelWait();
  if (state.loadedIndex === state.currentIndex && !state.audio.paused && !hasAudioEnded()) {
    state.isFading = true;
    setStatus("フェード停止中");
    updateStage();
    const fadeCompleted = await fadeOutCurrent(cue.fadeOut);
    state.isFading = false;
    if (!fadeCompleted) {
      return;
    }
  } else {
    stopAudio({ reset: false });
  }

  stopAudio({ reset: true });
  setStatus("停止しました");
  updateStage();
}

async function fadeOutAndStandbyNextFromRemote() {
  const cue = currentCue();
  if (!cue || state.isFading) {
    return;
  }

  cancelWait();

  const currentIsActive = state.loadedIndex === state.currentIndex
    && (!state.audio.paused || state.audio.currentTime > 0.05 || hasAudioEnded());
  if (!currentIsActive) {
    setStatus("再生中の曲がありません。音量＋で開始");
    updateStage();
    return;
  }

  if (state.loadedIndex === state.currentIndex && !state.audio.paused && !hasAudioEnded()) {
    state.isFading = true;
    setStatus("Bluetooth: フェードアウト中");
    updateStage();
    const fadeCompleted = await fadeOutCurrent(cue.fadeOut);
    state.isFading = false;
    if (!fadeCompleted) {
      return;
    }
  } else {
    stopAudio({ reset: false });
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.cues.length) {
    stopAudio({ reset: true });
    setStatus("最後の曲です");
    updateStage();
    return;
  }

  selectCue(nextIndex, { stop: true, announce: false });
  setStatus("次曲を待機中。音量＋でスタート");
  updateStage();
}

async function startNextCueFromRemote() {
  if (!state.cues.length || state.isFading) {
    return;
  }

  let targetIndex = state.currentIndex;
  if (state.isWaiting && state.pendingIndex >= 0) {
    targetIndex = state.pendingIndex;
    cancelWait();
  } else if (shouldRemotePlusAdvance()) {
    targetIndex = state.currentIndex + 1;
  }

  if (targetIndex >= state.cues.length) {
    setStatus("最後の曲です");
    updateStage();
    return;
  }

  if (targetIndex !== state.currentIndex) {
    selectCue(targetIndex, { stop: true, announce: false });
  } else {
    cancelWait();
    cancelFade();
  }

  await playCurrent({ reset: true });
}

function shouldRemotePlusAdvance() {
  if (state.isPlaying || hasAudioEnded()) {
    return true;
  }

  return state.loadedIndex === state.currentIndex
    && state.audio.paused
    && state.audio.currentTime > 0.05;
}

function runCueAction(action, gap, label) {
  if (action === "autoNext") {
    scheduleNext({ autoStart: true, gap, label });
    return;
  }

  if (action === "standbyNext") {
    scheduleNext({ autoStart: false, gap, label });
    return;
  }

  stopAudio({ reset: true });
  setStatus(`${label}後に停止`);
  updateStage();
}

function scheduleNext({ autoStart, gap, label }) {
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.cues.length) {
    setStatus("最後の曲です");
    updateStage();
    return;
  }

  state.isWaiting = true;
  state.pendingIndex = nextIndex;
  state.pendingAutoStart = autoStart;
  state.countdownUntil = Date.now() + Math.max(0, Number(gap) || 0) * 1000;
  setStatus(autoStart ? `${label}: 次曲まで待機中` : `${label}: 次曲を待機します`);
  updateStage();

  window.clearTimeout(state.waitTimer);
  state.waitTimer = window.setTimeout(runPendingNow, Math.max(0, Number(gap) || 0) * 1000);
}

function runPendingNow() {
  if (!state.isWaiting || state.pendingIndex < 0) {
    return;
  }

  const targetIndex = state.pendingIndex;
  const autoStart = state.pendingAutoStart;
  cancelWait();
  selectCue(targetIndex, { stop: true, announce: false });

  if (autoStart) {
    playCurrent({ reset: true });
  } else {
    setStatus("次曲を待機中");
    updateStage();
  }
}

function handleNaturalEnd() {
  state.isPlaying = false;

  if (state.isFading) {
    return;
  }

  state.isFading = false;
  cancelFade();
  const cue = currentCue();
  if (!cue) {
    updateStage();
    return;
  }

  if (cue.endAction === "wait") {
    setStatus("曲終了・待機中");
    updateStage();
    return;
  }

  runCueAction(cue.endAction, cue.gapAfter, "曲終了");
}

async function fadeOutCurrent(seconds) {
  const audio = state.audio;
  const requestedMs = Math.max(0, Number(seconds) || 0) * 1000;
  const remainingMs = Number.isFinite(audio.duration)
    ? Math.max(0, (audio.duration - audio.currentTime - 0.08) * 1000)
    : requestedMs;
  const durationMs = Math.min(requestedMs, remainingMs || requestedMs);
  const token = state.fadeToken + 1;
  state.fadeToken = token;

  const audioGraphReady = await prepareAudioOutput();
  if (state.fadeToken !== token) {
    resetFadeGain();
    return false;
  }

  return new Promise((resolve) => {
    if (durationMs <= 80 || audio.paused) {
      stopAudio({ reset: false });
      resolve(true);
      return;
    }

    const startVolume = audio.volume;
    const startTime = performance.now();
    let settled = false;

    const settle = (completed) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(state.fadeTimer);
      window.clearInterval(state.fadeInterval);
      state.fadeTimer = 0;
      state.fadeInterval = 0;
      if (state.fadeResolve === settle) {
        state.fadeResolve = null;
      }

      if (completed) {
        stopAudio({ reset: false });
      }

      resetFadeGain();
      if (!completed) {
        applyCurrentVolume();
      }

      resolve(completed);
    };

    state.fadeResolve = settle;

    if (audioGraphReady && state.fadeGain && state.audioContext) {
      const gain = state.fadeGain.gain;
      const now = state.audioContext.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(1, now);
      gain.linearRampToValueAtTime(0, now + durationMs / 1000);
      state.fadeTimer = window.setTimeout(() => settle(state.fadeToken === token), durationMs + 40);
      return;
    }

    state.fadeInterval = window.setInterval(() => {
      if (state.fadeToken !== token) {
        settle(false);
        return;
      }

      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - progress, 2);
      audio.volume = startVolume * (1 - eased);
      updateStage();

      if (progress >= 1) {
        settle(true);
      }
    }, 30);

    state.fadeTimer = window.setTimeout(() => settle(state.fadeToken === token), durationMs + 80);
  });
}

function stopNow() {
  cancelWait();
  cancelFade();
  stopAudio({ reset: true });
  setStatus("停止しました");
  updateStage();
}

function stopAudio({ reset }) {
  state.audio.pause();
  state.isPlaying = false;
  if (reset && Number.isFinite(state.audio.duration)) {
    state.audio.currentTime = 0;
  }
  applyCurrentVolume();
}

function restartCurrent() {
  const cue = currentCue();
  if (!cue) {
    return;
  }

  cancelWait();
  cancelFade();
  ensureAudioLoaded(state.currentIndex);
  state.audio.currentTime = 0;
  applyCurrentVolume();
  setStatus("頭出ししました");
  updateStage();
}

function standbyRelative(direction) {
  if (!state.cues.length) {
    return;
  }

  const nextIndex = clamp(state.currentIndex + direction, 0, state.cues.length - 1);
  selectCue(nextIndex, { stop: true, announce: true });
}

function selectCue(index, options = {}) {
  if (index < 0 || index >= state.cues.length) {
    return;
  }

  if (options.stop) {
    cancelWait();
    cancelFade();
    stopAudio({ reset: true });
    state.loadedIndex = -1;
  }

  state.currentIndex = index;
  ensureAudioLoaded(index);
  renderCueList();
  saveLocalSetlist();

  if (options.announce !== false) {
    setStatus("待機中");
  }

  updateStage();
}

function ensureAudioLoaded(index) {
  const cue = state.cues[index];
  if (!cue || !cue.objectUrl) {
    return false;
  }

  if (state.loadedIndex !== index || state.audio.src !== cue.objectUrl) {
    state.audio.pause();
    state.audio.src = cue.objectUrl;
    state.audio.load();
    state.loadedIndex = index;
  }

  applyCurrentVolume();
  return true;
}

function applyCurrentVolume() {
  const cue = currentCue();
  const cueVolume = cue ? Number(cue.volume) / 100 : 1;
  const volume = clamp(state.masterVolume * cueVolume, 0, 1);
  state.audio.volume = volume;
}

async function prepareAudioOutput() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return false;
  }

  try {
    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
      state.audioSource = state.audioContext.createMediaElementSource(state.audio);
      state.fadeGain = state.audioContext.createGain();
      state.fadeGain.gain.value = 1;
      state.audioSource.connect(state.fadeGain);
      state.fadeGain.connect(state.audioContext.destination);
    }

    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    return state.audioContext.state === "running";
  } catch (error) {
    return false;
  }
}

function resetFadeGain() {
  if (!state.fadeGain || !state.audioContext) {
    return;
  }

  const now = state.audioContext.currentTime;
  const gain = state.fadeGain.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(1, now);
}

function cancelWait() {
  window.clearTimeout(state.waitTimer);
  state.waitTimer = 0;
  state.isWaiting = false;
  state.pendingIndex = -1;
  state.pendingAutoStart = false;
  state.countdownUntil = 0;
}

function cancelFade() {
  state.fadeToken += 1;

  if (state.fadeResolve) {
    const settle = state.fadeResolve;
    settle(false);
    return;
  }

  window.clearTimeout(state.fadeTimer);
  window.clearInterval(state.fadeInterval);
  state.fadeTimer = 0;
  state.fadeInterval = 0;
  state.isFading = false;
  resetFadeGain();
  applyCurrentVolume();
}

function handleCueListClick(event) {
  const button = event.target.closest("button[data-action]");
  const item = event.target.closest(".cue-item");
  if (!item) {
    return;
  }

  const index = Number(item.dataset.index);
  const action = button ? button.dataset.action : "";

  if (!button) {
    if (!event.target.closest("input, select")) {
      selectCue(index, { stop: true, announce: true });
    }
    return;
  }

  if (action === "select") {
    selectCue(index, { stop: true, announce: true });
  } else if (action === "up") {
    moveCue(index, -1);
  } else if (action === "down") {
    moveCue(index, 1);
  } else if (action === "remove") {
    removeCue(index);
  }
}

function handleCueFieldInput(event) {
  const field = event.target.dataset.field;
  const item = event.target.closest(".cue-item");
  if (!field || !item) {
    return;
  }

  const cue = state.cues[Number(item.dataset.index)];
  if (!cue) {
    return;
  }

  if (field === "title") {
    cue.title = event.target.value.trimStart();
  } else if (field === "fadeOut") {
    cue.fadeOut = clampNumber(event.target.value, 0, 30, cue.fadeOut);
  } else if (field === "gapAfter") {
    cue.gapAfter = clampNumber(event.target.value, 0, 60, cue.gapAfter);
  } else if (field === "volume") {
    cue.volume = clampNumber(event.target.value, 0, 150, cue.volume);
    applyCurrentVolume();
  } else if (field === "finishAction") {
    cue.finishAction = event.target.value;
  } else if (field === "endAction") {
    cue.endAction = event.target.value;
  }

  saveLocalSetlist();
  updateStage();
}

function moveCue(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.cues.length) {
    return;
  }

  const [cue] = state.cues.splice(index, 1);
  state.cues.splice(target, 0, cue);

  if (state.currentIndex === index) {
    state.currentIndex = target;
  } else if (state.currentIndex === target) {
    state.currentIndex = index;
  }

  state.loadedIndex = -1;
  renderCueList();
  saveLocalSetlist();
  updateStage();
}

function removeCue(index) {
  const cue = state.cues[index];
  if (!cue) {
    return;
  }

  if (!window.confirm(`「${cue.title || cue.fileName}」を削除しますか？`)) {
    return;
  }

  revokeCueObjectUrl(cue);

  state.cues.splice(index, 1);
  if (state.currentIndex >= state.cues.length) {
    state.currentIndex = Math.max(0, state.cues.length - 1);
  }

  state.loadedIndex = -1;
  stopAudio({ reset: true });
  renderCueList();
  saveLocalSetlist();
  setStatus(state.cues.length ? "待機中" : "音源を追加してください");
  updateStage();
}

function duplicateCurrentCue() {
  const cue = currentCue();
  if (!cue) {
    return;
  }

  const copy = {
    ...cue,
    id: makeId(),
    title: `${cue.title} コピー`,
    objectUrl: cue.objectUrl,
    connected: cue.connected,
  };

  state.cues.splice(state.currentIndex + 1, 0, copy);
  renderCueList();
  saveLocalSetlist();
  setStatus("現在のキューを複製しました");
  updateStage();
}

function clearSetlist() {
  if (!state.cues.length) {
    return;
  }

  if (!window.confirm("セットリストを全て消去しますか？")) {
    return;
  }

  cancelWait();
  cancelFade();
  stopAudio({ reset: true });
  revokeAllObjectUrls();
  state.cues = [];
  state.currentIndex = 0;
  state.loadedIndex = -1;
  saveLocalSetlist();
  renderCueList();
  setStatus("音源を追加してください");
  updateStage();
}

function revokeCueObjectUrl(cue) {
  if (!cue.objectUrl) {
    return;
  }

  const usedElsewhere = state.cues.some((otherCue) => otherCue !== cue && otherCue.objectUrl === cue.objectUrl);
  if (!usedElsewhere) {
    URL.revokeObjectURL(cue.objectUrl);
  }
}

function revokeAllObjectUrls() {
  const urls = new Set(state.cues.map((cue) => cue.objectUrl).filter(Boolean));
  urls.forEach((url) => URL.revokeObjectURL(url));
}

function renderCueList() {
  if (!state.cues.length) {
    els.cueList.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>まだ曲がありません</strong>
          <p>音源を追加して、演目順に並べます。</p>
        </div>
      </div>
    `;
    return;
  }

  els.cueList.innerHTML = state.cues.map((cue, index) => {
    const active = index === state.currentIndex ? "active" : "";
    const disconnected = cue.objectUrl ? "" : "disconnected";
    const duration = cue.duration ? formatTime(cue.duration) : "--:--";
    const statusClass = cue.objectUrl ? "ok" : "warn";
    const statusText = cue.objectUrl ? "接続済み" : "未接続";

    return `
      <article class="cue-item ${active} ${disconnected}" data-index="${index}">
        <div class="cue-row">
          <button class="cue-number" type="button" data-action="select" title="この曲を待機">${index + 1}</button>
          <div class="cue-name">
            <strong>${escapeHtml(cue.title || cue.fileName || "無題")}</strong>
            <span>${escapeHtml(cue.fileName || "音源未接続")} ・ ${duration}</span>
          </div>
          <div class="cue-actions">
            <button type="button" data-action="up" title="上へ">↑</button>
            <button type="button" data-action="down" title="下へ">↓</button>
            <button type="button" data-action="remove" title="削除">×</button>
          </div>
        </div>
        <div class="cue-fields">
          <label>
            曲名
            <input data-field="title" type="text" value="${escapeAttr(cue.title || "")}">
          </label>
          <label>
            フェード
            <input data-field="fadeOut" type="number" min="0" max="30" step="0.1" value="${cue.fadeOut}">
          </label>
          <label>
            間隔
            <input data-field="gapAfter" type="number" min="0" max="60" step="0.1" value="${cue.gapAfter}">
          </label>
        </div>
        <div class="cue-selectors">
          <label>
            演技終了時
            <select data-field="finishAction">
              ${optionHtml("autoNext", "次曲を自動開始", cue.finishAction)}
              ${optionHtml("standbyNext", "次曲を待機", cue.finishAction)}
              ${optionHtml("stop", "停止のみ", cue.finishAction)}
            </select>
          </label>
          <label>
            曲終了時
            <select data-field="endAction">
              ${optionHtml("wait", "待機", cue.endAction)}
              ${optionHtml("standbyNext", "次曲を待機", cue.endAction)}
              ${optionHtml("autoNext", "次曲を自動開始", cue.endAction)}
            </select>
          </label>
          <label>
            音量
            <input data-field="volume" type="number" min="0" max="150" step="1" value="${cue.volume}">
          </label>
        </div>
        <span class="status-pill ${statusClass}">${statusText}</span>
      </article>
    `;
  }).join("");
}

function renderDefaultSettings() {
  els.defaultFade.value = defaultCueSettings.fadeOut;
  els.defaultGap.value = defaultCueSettings.gapAfter;
  els.defaultFinishAction.value = defaultCueSettings.finishAction;
  els.defaultEndAction.value = defaultCueSettings.endAction;
}

function renderSoundEffects() {
  els.sfxSlots.innerHTML = sfxState.slots.map((slot, index) => {
    const connected = Boolean(slot.buffer);
    const statusClass = connected ? "ok" : "warn";
    const statusText = connected
      ? "準備完了"
      : slot.loadStatus === "loading"
        ? "読込中"
        : slot.loadStatus === "error"
          ? "読込失敗"
          : slot.fileName
            ? "要再選択"
            : "未選択";
    const captureActive = sfxState.captureIndex === index;
    const disabled = connected ? "" : " disabled";

    return `
      <article class="sfx-slot" data-sfx-slot="${index}">
        <div class="sfx-slot-heading">
          <strong>効果音${index + 1}</strong>
          <span class="status-pill ${statusClass}">${statusText}</span>
        </div>
        <label>
          効果音名
          <input data-sfx-field="name" data-index="${index}" type="text" maxlength="80" value="${escapeAttr(slot.name)}" autocomplete="off">
        </label>
        <div class="sfx-file-row">
          <button type="button" data-sfx-action="choose-file" data-index="${index}">WAV / MP3を選択</button>
          <span title="${escapeAttr(slot.fileName || "")}">${escapeHtml(soundEffectFileText(slot))}</span>
        </div>
        <label>
          音量
          <span class="sfx-volume-row">
            <input data-sfx-field="volume" data-index="${index}" type="range" min="0" max="100" step="1" value="${slot.volume}">
            <strong data-sfx-volume-text="${index}">${slot.volume}%</strong>
          </span>
        </label>
        <div class="sfx-key-row">
          <span>Bluetoothキー</span>
          <code>${escapeHtml(slot.key || "未設定")}</code>
          <button class="${captureActive ? "gold" : ""}" type="button" data-sfx-action="capture-key" data-index="${index}">${captureActive ? "入力待ち…" : "割り当て"}</button>
          <button type="button" data-sfx-action="clear-key" data-index="${index}"${slot.key ? "" : " disabled"}>解除</button>
        </div>
        <div class="sfx-actions">
          <button class="primary" type="button" data-sfx-action="test" data-index="${index}"${disabled}>▶ テスト再生</button>
          <button type="button" data-sfx-action="stop" data-index="${index}"${disabled}>■ 停止</button>
        </div>
        <p class="sfx-warning${slot.warning ? "" : " hidden"}" role="status">${escapeHtml(slot.warning)}</p>
      </article>
    `;
  }).join("");

  updateSoundEffectReadiness();
  updateRemoteInputTest();
}

function handleSoundEffectPanelClick(event) {
  const button = event.target.closest("button[data-sfx-action]");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  const slot = sfxState.slots[index];
  if (!slot) {
    return;
  }

  const action = button.dataset.sfxAction;
  if (action === "choose-file") {
    els["sfxFileInput" + index].click();
  } else if (action === "test") {
    playSoundEffect(index);
  } else if (action === "stop") {
    stopSoundEffect(index);
  } else if (action === "capture-key") {
    const wasCapturing = sfxState.captureIndex === index;
    sfxState.slots.forEach((item) => {
      if (item.warning === "次に押したキーを割り当てます") {
        item.warning = "";
      }
    });
    sfxState.captureIndex = wasCapturing ? -1 : index;
    slot.warning = wasCapturing ? "" : "次に押したキーを割り当てます";
    renderSoundEffects();
  } else if (action === "clear-key") {
    slot.key = "";
    slot.warning = "";
    sfxState.captureIndex = -1;
    saveSoundEffectSettings();
    renderSoundEffects();
  }
}

function handleSoundEffectFieldInput(event) {
  const field = event.target.dataset.sfxField;
  const index = Number(event.target.dataset.index);
  const slot = sfxState.slots[index];
  if (!field || !slot) {
    return;
  }

  if (field === "name") {
    slot.name = event.target.value.trimStart().slice(0, 80);
  } else if (field === "volume") {
    slot.volume = clampNumber(event.target.value, 0, 100, slot.volume);
    applySoundEffectVolume(slot);
    const output = els.sfxSlots.querySelector("[data-sfx-volume-text=\"" + index + "\"]");
    if (output) {
      output.textContent = slot.volume + "%";
    }
  }

  saveSoundEffectSettings();
}

function isSoundEffectSupported() {
  return Boolean(window.AudioContext || window.webkitAudioContext);
}

function ensureSoundEffectContext() {
  if (sfxState.audioContext && sfxState.audioContext.state !== "closed") {
    return sfxState.audioContext;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    sfxState.contextError = "このブラウザはWeb Audio APIに対応していません";
    updateSoundEffectReadiness();
    return null;
  }

  try {
    try {
      sfxState.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    } catch (error) {
      sfxState.audioContext = new AudioContextClass();
    }

    sfxState.contextError = "";
    sfxState.slots.forEach((slot) => {
      slot.gainNode = null;
      ensureSoundEffectGain(slot, sfxState.audioContext);
    });
    sfxState.audioContext.addEventListener("statechange", updateSoundEffectReadiness);
    updateSoundEffectReadiness();
    return sfxState.audioContext;
  } catch (error) {
    sfxState.audioContext = null;
    sfxState.contextError = "効果音の出力を準備できませんでした";
    updateSoundEffectReadiness();
    return null;
  }
}

function ensureSoundEffectGain(slot, context = sfxState.audioContext) {
  if (!context || !slot) {
    return null;
  }

  if (!slot.gainNode || slot.gainNode.context !== context) {
    slot.gainNode = context.createGain();
    slot.gainNode.connect(context.destination);
  }

  applySoundEffectVolume(slot);
  return slot.gainNode;
}

async function prepareSoundEffectOutput() {
  const context = ensureSoundEffectContext();
  if (!context) {
    return false;
  }

  try {
    if (context.state === "suspended" || context.state === "interrupted") {
      await context.resume();
    }
    sfxState.contextError = "";
    updateSoundEffectReadiness();
    return context.state === "running";
  } catch (error) {
    sfxState.contextError = "画面をクリックして効果音を準備してください";
    updateSoundEffectReadiness();
    return false;
  }
}

async function loadSoundEffectFile(index, file) {
  const slot = sfxState.slots[index];
  if (!slot || !file) {
    return;
  }

  const supportedFile = /\.(wav|mp3)$/i.test(file.name)
    || ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].includes(file.type);
  if (!supportedFile) {
    slot.warning = "WAVまたはMP3ファイルを選択してください";
    slot.loadStatus = "error";
    renderSoundEffects();
    return;
  }

  const context = ensureSoundEffectContext();
  if (!context) {
    slot.warning = sfxState.contextError || "効果音を準備できませんでした";
    slot.loadStatus = "error";
    renderSoundEffects();
    return;
  }

  const previousFileName = slot.fileName;
  const previousName = slot.name;
  const token = slot.loadToken + 1;
  slot.loadToken = token;
  stopSoundEffect(index);
  slot.buffer = null;
  slot.fileName = file.name;
  slot.loadStatus = "loading";
  slot.warning = "";
  renderSoundEffects();
  prepareSoundEffectOutput();

  try {
    const bytes = await file.arrayBuffer();
    const decodedBuffer = await context.decodeAudioData(bytes);
    if (slot.loadToken !== token) {
      return;
    }

    slot.buffer = decodedBuffer;
    slot.loadStatus = "ready";
    if (!previousName
      || previousName === "効果音" + (index + 1)
      || previousName === stripExtension(previousFileName)) {
      slot.name = stripExtension(file.name);
    }
    ensureSoundEffectGain(slot, context);
    saveSoundEffectSettings();
  } catch (error) {
    if (slot.loadToken !== token) {
      return;
    }
    slot.buffer = null;
    slot.loadStatus = "error";
    slot.warning = "音声を読み込めませんでした。WAVまたはMP3を確認してください";
  }

  renderSoundEffects();
}

function playSoundEffect(index) {
  const slot = sfxState.slots[index];
  if (!slot || !slot.buffer) {
    if (slot) {
      slot.warning = slot.fileName
        ? "音声ファイルを再選択してください"
        : "先にWAVまたはMP3ファイルを選択してください";
      renderSoundEffects();
    }
    return false;
  }

  const context = ensureSoundEffectContext();
  if (!context) {
    slot.warning = sfxState.contextError || "効果音を準備できませんでした";
    renderSoundEffects();
    return false;
  }

  if (context.state !== "running") {
    prepareSoundEffectOutput().then((ready) => {
      if (ready && slot.buffer) {
        startSoundEffectBuffer(slot);
      }
    });
    return true;
  }

  return startSoundEffectBuffer(slot);
}

function startSoundEffectBuffer(slot) {
  const context = sfxState.audioContext;
  if (!context || context.state !== "running" || !slot.buffer) {
    return false;
  }

  try {
    const source = context.createBufferSource();
    source.buffer = slot.buffer;
    source.connect(ensureSoundEffectGain(slot, context));
    slot.activeSources.add(source);
    source.addEventListener("ended", () => {
      slot.activeSources.delete(source);
      try {
        source.disconnect();
      } catch (error) {
        // The source may already be disconnected after a manual stop.
      }
    }, { once: true });
    source.start();
    return true;
  } catch (error) {
    slot.warning = "効果音を再生できませんでした";
    renderSoundEffects();
    return false;
  }
}

function stopSoundEffect(index) {
  const slot = sfxState.slots[index];
  if (!slot) {
    return;
  }

  slot.activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (error) {
      // A source that has already ended can be ignored.
    }
  });
  slot.activeSources.clear();
}

function applySoundEffectVolume(slot) {
  if (!slot || !slot.gainNode || !sfxState.audioContext) {
    return;
  }

  const now = sfxState.audioContext.currentTime;
  const value = clampNumber(slot.volume, 0, 100, 100) / 100;
  slot.gainNode.gain.cancelScheduledValues(now);
  slot.gainNode.gain.setValueAtTime(value, now);
}

function soundEffectFileText(slot) {
  if (!slot.fileName) {
    return "ファイル未選択";
  }
  if (slot.loadStatus === "loading") {
    return slot.fileName + "（読込中）";
  }
  if (slot.buffer) {
    return slot.fileName;
  }
  return slot.fileName + "（再選択）";
}

function updateSoundEffectReadiness() {
  if (!els.sfxReadyStatus) {
    return;
  }

  const context = sfxState.audioContext;
  const loadedCount = sfxState.slots.filter((slot) => slot.buffer).length;
  const expectedCount = sfxState.slots.filter((slot) => slot.fileName).length;
  const loadingCount = sfxState.slots.filter((slot) => slot.loadStatus === "loading").length;
  const errorCount = sfxState.slots.filter((slot) => slot.loadStatus === "error").length;
  let text = "効果音：画面をクリックして準備";
  let statusClass = "warn";

  if (!isSoundEffectSupported() || sfxState.contextError) {
    text = "効果音：" + (sfxState.contextError || "このブラウザは未対応です");
  } else if (loadingCount) {
    text = "効果音：読み込み中";
  } else if (!context || context.state !== "running") {
    text = "効果音：画面をクリックして準備";
  } else if (errorCount) {
    text = "効果音：読込エラー";
  } else if (expectedCount > loadedCount) {
    text = "効果音：音源を再選択してください";
  } else {
    text = loadedCount
      ? "効果音：準備完了（" + loadedCount + "/" + SFX_SLOT_COUNT + "）"
      : "効果音：準備完了（音源未選択）";
    statusClass = "ok";
  }

  els.sfxReadyStatus.textContent = text;
  els.sfxReadyStatus.className = "status-pill " + statusClass;
}

function updateRemoteInputTest() {
  if (!els.lastRemoteKey || !els.lastRemoteTime) {
    return;
  }
  els.lastRemoteKey.textContent = sfxState.lastInputKey || "未受信";
  els.lastRemoteTime.textContent = sfxState.lastInputAt
    ? "受信時刻：" + new Date(sfxState.lastInputAt).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    })
    : "受信時刻：—";
}

function saveSoundEffectSettings() {
  const data = {
    version: 1,
    savedAt: new Date().toISOString(),
    slots: sfxState.slots.map((slot) => ({
      name: slot.name,
      volume: slot.volume,
      key: slot.key,
      fileName: slot.fileName,
    })),
  };

  try {
    window.localStorage.setItem(SFX_STORE_KEY, JSON.stringify(data));
  } catch (error) {
    // Playback remains available even when browser storage is disabled.
  }
}

function loadSoundEffectSettings() {
  let raw = "";
  try {
    raw = window.localStorage.getItem(SFX_STORE_KEY) || "";
  } catch (error) {
    return;
  }

  if (!raw) {
    return;
  }

  try {
    const data = JSON.parse(raw);
    const savedSlots = Array.isArray(data.slots) ? data.slots : [];
    sfxState.slots.forEach((slot, index) => {
      const saved = savedSlots[index];
      if (!saved || typeof saved !== "object") {
        return;
      }

      slot.name = typeof saved.name === "string"
        ? saved.name.slice(0, 80)
        : "効果音" + (index + 1);
      slot.volume = clampNumber(saved.volume, 0, 100, 100);
      slot.key = typeof saved.key === "string" ? saved.key.trim().slice(0, 80) : "";
      slot.fileName = typeof saved.fileName === "string" ? saved.fileName.slice(0, 260) : "";
      slot.buffer = null;
      slot.loadStatus = slot.fileName ? "reconnect" : "empty";
      slot.warning = slot.key && isBgmReservedKeyName(slot.key)
        ? "このキーはBGM操作で使用されています（効果音は作動しません）"
        : "";
    });
  } catch (error) {
    // Invalid effect settings do not affect the existing setlist.
  }
}

function soundEffectKeyNameForEvent(event) {
  const key = event.key && event.key !== "Unidentified" ? event.key : "";
  const code = event.code && event.code !== "Unidentified" ? event.code : "";
  if (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(code)) {
    return code;
  }
  if (key) {
    return key === " " ? "Space" : key;
  }
  return code || "不明";
}

function soundEffectKeyCandidates(event) {
  const values = [soundEffectKeyNameForEvent(event), event.key, event.code]
    .filter((value) => value && value !== "Unidentified")
    .map((value) => value === " " ? "Space" : value);
  return [...new Set(values)];
}

function isBgmReservedKeyName(keyName) {
  return BGM_SHORTCUT_KEYS.has(keyName);
}

function recordRemoteKeyInput(event) {
  recordRemoteInputName(soundEffectKeyNameForEvent(event));
}

function recordRemoteInputName(keyName) {
  sfxState.lastInputKey = keyName || "不明";
  sfxState.lastInputAt = Date.now();
  updateRemoteInputTest();
}

function captureSoundEffectKey(event) {
  const index = sfxState.captureIndex;
  const slot = sfxState.slots[index];
  if (!slot) {
    sfxState.captureIndex = -1;
    return false;
  }

  event.preventDefault();
  if (event.repeat) {
    return true;
  }

  const keyName = soundEffectKeyNameForEvent(event);
  if (keyName === "Escape") {
    slot.warning = "割り当てをキャンセルしました";
    sfxState.captureIndex = -1;
    renderSoundEffects();
    return true;
  }

  if (["Shift", "Control", "Alt", "Meta", "不明"].includes(keyName)) {
    slot.warning = "修飾キー以外のボタンを押してください";
    renderSoundEffects();
    return true;
  }

  if (isBgmReservedKeyName(keyName)) {
    slot.warning = "このキーはBGM操作で使用されています（割り当てませんでした）";
    sfxState.captureIndex = -1;
    renderSoundEffects();
    return true;
  }

  const duplicateIndex = sfxState.slots.findIndex((item, itemIndex) => itemIndex !== index && item.key === keyName);
  if (duplicateIndex >= 0) {
    slot.warning = "このキーは効果音" + (duplicateIndex + 1) + "で使用されています";
    sfxState.captureIndex = -1;
    renderSoundEffects();
    return true;
  }

  slot.key = keyName;
  slot.warning = keyName + " を割り当てました";
  sfxState.captureIndex = -1;
  saveSoundEffectSettings();
  renderSoundEffects();
  return true;
}

function handleSoundEffectKey(event) {
  const candidates = soundEffectKeyCandidates(event);
  const index = sfxState.slots.findIndex((slot) => slot.key && candidates.includes(slot.key));
  if (index < 0) {
    return false;
  }

  event.preventDefault();
  const assignedKey = sfxState.slots[index].key;
  const now = performance.now();
  const lastAt = sfxState.lastTriggerAtByKey.get(assignedKey);
  if (event.repeat || (lastAt !== undefined && now - lastAt < SFX_DEBOUNCE_MS)) {
    return true;
  }

  sfxState.lastTriggerAtByKey.set(assignedKey, now);
  playSoundEffect(index);
  return true;
}

function updateStage() {
  document.body.classList.toggle("show-mode", state.showMode);

  const cue = currentCue();
  const nextCue = state.isWaiting ? state.cues[state.pendingIndex] : state.cues[state.currentIndex + 1];
  const cueCount = state.cues.length;
  const missingCount = state.cues.filter((item) => !item.objectUrl).length;

  els.statusText.textContent = state.status;
  els.remoteStatusText.textContent = state.remoteStatus;
  els.preflightText.textContent = cueCount ? `${cueCount}曲 / 未接続${missingCount}` : "0曲";
  els.cueMeta.textContent = cue ? `${state.currentIndex + 1} / ${cueCount}` : "0 / 0";
  els.currentTitle.textContent = cue ? (cue.title || cue.fileName || "無題") : "音源なし";
  els.currentFile.textContent = cue ? cueFileText(cue) : "右側の音源ボタンから曲を追加します";
  els.nextTitle.textContent = nextCue ? (nextCue.title || nextCue.fileName || "無題") : "なし";

  const audioIsCurrent = state.loadedIndex === state.currentIndex;
  const currentTime = audioIsCurrent ? state.audio.currentTime || 0 : 0;
  const duration = audioIsCurrent && Number.isFinite(state.audio.duration)
    ? state.audio.duration
    : cue && cue.duration
      ? cue.duration
      : 0;

  const progress = duration ? clamp((currentTime / duration) * 100, 0, 100) : 0;
  els.progressFill.style.width = `${progress}%`;
  els.elapsedTime.textContent = formatTime(currentTime);
  els.remainingTime.textContent = duration ? `-${formatTime(Math.max(0, duration - currentTime))}` : "-0:00";

  if (state.isWaiting) {
    const remaining = Math.max(0, (state.countdownUntil - Date.now()) / 1000);
    els.countdownText.textContent = state.pendingAutoStart
      ? `${remaining.toFixed(1)} 秒`
      : "待機へ";
  } else if (state.isFading) {
    els.countdownText.textContent = "フェード中";
  } else {
    els.countdownText.textContent = "";
  }

  els.playPauseBtn.textContent = state.isWaiting
    ? "▶ 今すぐ開始"
    : state.isPlaying
      ? "⏸ 一時停止"
      : "▶ 開始";

  els.finishActBtn.textContent = finishButtonLabel(cue);
  els.masterVolume.value = Math.round(state.masterVolume * 100);
  els.masterVolumeText.textContent = `${Math.round(state.masterVolume * 100)}%`;
  els.showModeBtn.textContent = state.showMode ? "編集" : "本番";
  els.wakeLockBtn.textContent = state.wakeLock ? "維持中" : "画面維持";

  const hasCue = Boolean(cue);
  els.playPauseBtn.disabled = !hasCue || (!cue.objectUrl && !state.isWaiting);
  els.finishActBtn.disabled = !hasCue || state.isFading;
  els.fadeStopBtn.disabled = !hasCue || state.isFading;
  els.stopNowBtn.disabled = !hasCue && !state.isWaiting;
  els.restartBtn.disabled = !hasCue;
  els.nextCueBtn.disabled = !hasCue || state.currentIndex >= state.cues.length - 1;
  els.prevCueBtn.disabled = !hasCue || state.currentIndex <= 0;
  els.relinkAudioBtn.disabled = !state.cues.length;
  els.exportBtn.disabled = !state.cues.length;
  els.clearBtn.disabled = !state.cues.length;
  els.duplicateBtn.disabled = !state.cues.length;
}

function finishButtonLabel(cue) {
  if (!cue) {
    return "演技終了";
  }

  if (cue.finishAction === "autoNext") {
    return "演技終了 → 次へ";
  }

  if (cue.finishAction === "standbyNext") {
    return "演技終了 → 待機";
  }

  return "演技終了 → 停止";
}

function cueFileText(cue) {
  const connected = cue.objectUrl ? "接続済み" : "音源未接続";
  const action = cue.endAction === "wait"
    ? "曲終了時: 待機"
    : cue.endAction === "autoNext"
      ? "曲終了時: 自動で次へ"
      : "曲終了時: 次曲待機";
  return `${cue.fileName || "ファイルなし"} / ${connected} / ${action}`;
}

function exportSetlist() {
  if (!state.cues.length) {
    return;
  }

  const data = JSON.stringify(serializeSetlist(), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `magic-show-cue-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus("セットリストを書き出しました");
}

async function importSetlist(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) {
    return;
  }

  try {
    const data = JSON.parse(await file.text());
    const cues = Array.isArray(data.cues) ? data.cues : [];
    cancelWait();
    cancelFade();
    stopAudio({ reset: true });
    revokeAllObjectUrls();

    state.cues = cues.map((cue) => ({
      id: cue.id || makeId(),
      title: cue.title || stripExtension(cue.fileName || "無題"),
      fileName: cue.fileName || "",
      duration: Number.isFinite(cue.duration) ? cue.duration : null,
      objectUrl: null,
      connected: false,
      fadeOut: clampNumber(cue.fadeOut, 0, 30, defaultCueSettings.fadeOut),
      gapAfter: clampNumber(cue.gapAfter, 0, 60, defaultCueSettings.gapAfter),
      finishAction: normalizeAction(cue.finishAction, "autoNext"),
      endAction: normalizeAction(cue.endAction, "wait"),
      volume: clampNumber(cue.volume, 0, 150, 100),
    }));

    if (data.defaults) {
      defaultCueSettings.fadeOut = clampNumber(data.defaults.fadeOut, 0, 30, defaultCueSettings.fadeOut);
      defaultCueSettings.gapAfter = clampNumber(data.defaults.gapAfter, 0, 60, defaultCueSettings.gapAfter);
      defaultCueSettings.finishAction = normalizeAction(data.defaults.finishAction, "autoNext");
      defaultCueSettings.endAction = normalizeAction(data.defaults.endAction, "wait");
    }

    state.currentIndex = clamp(Number(data.currentIndex) || 0, 0, Math.max(0, state.cues.length - 1));
    state.loadedIndex = -1;
    renderDefaultSettings();
    renderCueList();
    saveLocalSetlist();
    setStatus("読み込み完了。音源を再接続してください");
    updateStage();
  } catch (error) {
    setStatus("セットリストを読み込めませんでした");
    updateStage();
  }
}

function saveLocalSetlist() {
  const data = serializeSetlist();
  window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function loadLocalSetlist() {
  const raw = window.localStorage.getItem(STORE_KEY);
  if (!raw) {
    return;
  }

  try {
    const data = JSON.parse(raw);
    const cues = Array.isArray(data.cues) ? data.cues : [];
    state.cues = cues.map((cue) => ({
      id: cue.id || makeId(),
      title: cue.title || stripExtension(cue.fileName || "無題"),
      fileName: cue.fileName || "",
      duration: Number.isFinite(cue.duration) ? cue.duration : null,
      objectUrl: null,
      connected: false,
      fadeOut: clampNumber(cue.fadeOut, 0, 30, defaultCueSettings.fadeOut),
      gapAfter: clampNumber(cue.gapAfter, 0, 60, defaultCueSettings.gapAfter),
      finishAction: normalizeAction(cue.finishAction, "autoNext"),
      endAction: normalizeAction(cue.endAction, "wait"),
      volume: clampNumber(cue.volume, 0, 150, 100),
    }));

    if (data.defaults) {
      defaultCueSettings.fadeOut = clampNumber(data.defaults.fadeOut, 0, 30, defaultCueSettings.fadeOut);
      defaultCueSettings.gapAfter = clampNumber(data.defaults.gapAfter, 0, 60, defaultCueSettings.gapAfter);
      defaultCueSettings.finishAction = normalizeAction(data.defaults.finishAction, "autoNext");
      defaultCueSettings.endAction = normalizeAction(data.defaults.endAction, "wait");
    }

    state.currentIndex = clamp(Number(data.currentIndex) || 0, 0, Math.max(0, state.cues.length - 1));
    state.masterVolume = clampNumber(data.masterVolume, 0, 1, 1);
    state.status = state.cues.length ? "保存済みセットリストを復元。音源を再接続してください" : "音源を追加してください";
  } catch (error) {
    state.status = "保存データを読み込めませんでした";
  }
}

function serializeSetlist() {
  return {
    app: "Magic Show Cue",
    version: 1,
    savedAt: new Date().toISOString(),
    currentIndex: state.currentIndex,
    masterVolume: state.masterVolume,
    defaults: {
      fadeOut: defaultCueSettings.fadeOut,
      gapAfter: defaultCueSettings.gapAfter,
      finishAction: defaultCueSettings.finishAction,
      endAction: defaultCueSettings.endAction,
    },
    cues: state.cues.map((cue) => ({
      id: cue.id,
      title: cue.title,
      fileName: cue.fileName,
      duration: cue.duration,
      fadeOut: cue.fadeOut,
      gapAfter: cue.gapAfter,
      finishAction: cue.finishAction,
      endAction: cue.endAction,
      volume: cue.volume,
    })),
  };
}

function toggleShowMode() {
  state.showMode = !state.showMode;
  updateStage();
}

async function startFirstCueFromShowFlow() {
  prepareSoundEffectOutput();
  if (!state.cues.length) {
    state.showMode = true;
    setStatus("音楽準備が必要です。音源を追加してください");
    updateStage();
    return false;
  }

  cancelWait();
  cancelFade();
  selectCue(0, { stop: true, announce: false });
  state.showMode = true;
  updateStage();
  return playCurrent({ reset: true });
}

function showMusicSetupFromShowFlow() {
  prepareSoundEffectOutput();
  state.showMode = false;
  setStatus(state.cues.length ? "音楽準備中" : "音源を追加してください");
  updateStage();
}

function stopForBingoReturnFromShowFlow() {
  cancelWait();
  cancelFade();
  stopAudio({ reset: true });
  state.showMode = false;
  setStatus(state.cues.length ? "待機中" : "音源を追加してください");
  updateStage();
  return true;
}

window.magicShowCue = {
  startFirstCue: startFirstCueFromShowFlow,
  showSetup: showMusicSetupFromShowFlow,
  stopForBingoReturn: stopForBingoReturnFromShowFlow,
  getStatus() {
    const cue = currentCue();
    return {
      cueCount: state.cues.length,
      currentIndex: state.currentIndex,
      currentTitle: cue ? cue.title || cue.fileName || "" : "",
      hasCurrentAudio: Boolean(cue && cue.objectUrl),
      isPlaying: state.isPlaying,
      currentTime: state.audio.currentTime || 0,
      bgmVolume: state.audio.volume,
      isFading: state.isFading,
      isWaiting: state.isWaiting,
      status: state.status,
      soundEffects: {
        contextState: sfxState.audioContext ? sfxState.audioContext.state : "not-created",
        loadedSlots: sfxState.slots.filter((slot) => slot.buffer).length,
        activeSources: sfxState.slots.map((slot) => slot.activeSources.size),
        assignedKeys: sfxState.slots.map((slot) => slot.key),
      },
    };
  },
};

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    setStatus("全画面にできませんでした");
  }
}

async function toggleWakeLock() {
  if (state.wakeLock) {
    await state.wakeLock.release();
    state.wakeLock = null;
    setStatus("画面維持を解除しました");
    updateStage();
    return;
  }

  await requestWakeLock();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    setStatus("このブラウザは画面維持に未対応です");
    updateStage();
    return;
  }

  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
      updateStage();
    }, { once: true });
    setStatus("画面維持中");
    updateStage();
  } catch (error) {
    setStatus("画面維持を開始できませんでした");
    updateStage();
  }
}

function handleKeys(event) {
  recordRemoteKeyInput(event);

  if (sfxState.captureIndex >= 0 && captureSoundEffectKey(event)) {
    return;
  }

  if (handleRemoteControlKey(event)) {
    return;
  }

  const targetIsFormField = event.target instanceof Element
    && event.target.closest("input, select, textarea");
  if (targetIsFormField) {
    return;
  }

  if (handleSoundEffectKey(event)) {
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    togglePlayPause();
  } else if (event.code === "Enter" || event.key.toLowerCase() === "f") {
    event.preventDefault();
    finishAct();
  } else if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    stopNow();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    standbyRelative(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    standbyRelative(-1);
  }
}

function handleRemoteControlKey(event) {
  const action = remoteControlActionForEvent(event);
  if (!action) {
    return false;
  }

  event.preventDefault();
  const keyName = event.key || event.code || action.label;
  const now = Date.now();
  if (event.repeat || (state.remoteLastKey === keyName && now - state.remoteLastAt < REMOTE_CONTROL_COOLDOWN_MS)) {
    return true;
  }

  state.remoteLastAt = now;
  state.remoteLastKey = keyName;
  runRemoteControlAction(action);
  return true;
}

function remoteControlActionForEvent(event) {
  return REMOTE_CONTROL_ACTIONS[event.key] || REMOTE_CONTROL_ACTIONS[event.code] || null;
}

function runRemoteControlAction(action) {
  const now = Date.now();
  const actionLabel = action.label || "";
  if (state.remoteActionLastLabel === actionLabel && now - state.remoteActionLastAt < REMOTE_DUPLICATE_SUPPRESS_MS) {
    return;
  }

  state.remoteActionLastAt = now;
  state.remoteActionLastLabel = actionLabel;
  state.remoteStatus = `${remoteTime()} ${action.label}`;
  setStatus(`Bluetooth: ${action.label}`);
  updateStage();

  try {
    const result = action.run();
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        setStatus("Bluetooth操作を実行できませんでした");
        updateStage();
      });
    }
  } catch (error) {
    setStatus("Bluetooth操作を実行できませんでした");
    updateStage();
  }
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setActionHandler !== "function") {
    return;
  }

  const handlers = {
    play: {
      label: "再生キー",
      run: () => playCurrent({ resetIfEnded: true }),
    },
    pause: {
      label: "一時停止キー",
      run: () => {
        if (state.isPlaying) {
          togglePlayPause();
        }
      },
    },
    nexttrack: {
      label: "次曲キー → 次曲スタート",
      run: () => startNextCueFromRemote(),
    },
    previoustrack: {
      label: "前曲キー → 前曲待機",
      run: () => standbyRelative(-1),
    },
    stop: {
      label: "停止キー",
      run: () => stopNow(),
    },
  };

  const mediaKeyNames = {
    play: "MediaPlay",
    pause: "MediaPause",
    nexttrack: "MediaTrackNext",
    previoustrack: "MediaTrackPrevious",
    stop: "MediaStop",
  };

  Object.entries(handlers).forEach(([name, action]) => {
    try {
      navigator.mediaSession.setActionHandler(name, () => {
        recordRemoteInputName(mediaKeyNames[name] || name);
        runRemoteControlAction(action);
      });
    } catch (error) {
      // Unsupported actions are simply ignored by the browser.
    }
  });
}

function setupRemoteHelperBridge() {
  if (!window.fetch) {
    return;
  }

  window.setTimeout(pollRemoteHelperBridge, 500);
}

async function pollRemoteHelperBridge() {
  let nextDelay = REMOTE_HELPER_SLOW_POLL_MS;
  try {
    const response = await fetch(`${REMOTE_HELPER_URL}?since=${state.remoteBridgeLastId}&t=${Date.now()}`, {
      cache: "no-store",
      mode: "cors",
    });

    if (response.ok) {
      const payload = await response.json();
      const commands = Array.isArray(payload.commands) ? payload.commands : [];
      let latestSeen = Number.isFinite(Number(payload.latestId)) ? Number(payload.latestId) : state.remoteBridgeLastId;

      commands.forEach((command) => {
        const commandId = Number(command.id) || 0;
        latestSeen = Math.max(latestSeen, commandId);
        runRemoteHelperCommand(command);
      });

      state.remoteBridgeLastId = Math.max(state.remoteBridgeLastId, latestSeen);
      nextDelay = REMOTE_HELPER_FAST_POLL_MS;
    }
  } catch (error) {
    nextDelay = REMOTE_HELPER_SLOW_POLL_MS;
  } finally {
    window.setTimeout(pollRemoteHelperBridge, nextDelay);
  }
}

function runRemoteHelperCommand(command) {
  const action = command && command.action === "minus"
    ? REMOTE_CONTROL_ACTIONS.F8
    : command && command.action === "plus"
      ? REMOTE_CONTROL_ACTIONS.F9
      : null;

  if (action) {
    recordRemoteInputName(command.action === "minus" ? "F8" : "F9");
    runRemoteControlAction(action);
  }
}

function remoteTime() {
  return new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function currentCue() {
  return state.cues[state.currentIndex] || null;
}

function hasAudioEnded() {
  return Number.isFinite(state.audio.duration) && state.audio.currentTime >= state.audio.duration - 0.05;
}

function setStatus(text) {
  state.status = text;
}

function normalizeAction(action, fallback) {
  return ["autoNext", "standbyNext", "stop", "wait"].includes(action) ? action : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return clamp(number, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function stripExtension(fileName) {
  return String(fileName || "").replace(/\.[^/.]+$/, "");
}

function makeId() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function optionHtml(value, label, currentValue) {
  const selected = value === currentValue ? " selected" : "";
  return `<option value="${value}"${selected}>${label}</option>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
