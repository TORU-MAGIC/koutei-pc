"use strict";

(() => {
  const offlineStatus = document.getElementById("offlineStatus");
  const enableAudioButton = document.getElementById("enableAudioButton");
  let wakeLock = null;

  function setOfflineStatus(message, state = "waiting") {
    if (!offlineStatus) return;
    offlineStatus.textContent = message;
    offlineStatus.dataset.state = state;
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (_error) {
      wakeLock = null;
    }
  }

  async function registerOfflineApp() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      setOfflineStatus("オフライン保存：この開き方では利用できません", "error");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", {
        scope: "./",
        updateViaCache: "none",
      });

      const showUpdateNotice = () => {
        setOfflineStatus("更新があります。本番後にアプリを完全に閉じて再起動してください", "update");
      };

      if (registration.waiting) showUpdateNotice();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateNotice();
        });
      });

      await navigator.serviceWorker.ready;
      if (!registration.waiting) setOfflineStatus("オフライン保存：準備完了", "ready");
    } catch (_error) {
      setOfflineStatus("オフライン保存に失敗しました。通信を確認して再読み込みしてください", "error");
    }
  }

  enableAudioButton?.addEventListener("click", requestWakeLock);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  window.addEventListener("load", registerOfflineApp);
})();
