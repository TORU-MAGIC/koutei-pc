"use strict";

const CACHE_NAME = "magic-effect-remote-v1";
const APP_PATHS = [
  "./",
  "./index.html",
  "./effect-remote.css",
  "./effect-remote.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./sound-effects/sfx_correct_pingpong.wav",
  "./sound-effects/sfx_wrong_buzzer.wav",
  "./sound-effects/sfx_magic_sparkle_reveal.wav",
  "./sound-effects/sfx_magic_whoosh_appear.wav",
  "./sound-effects/sfx_magic_vanish_poof.wav",
  "./sound-effects/sfx_magic_tada_sting.wav",
  "./sound-effects/sfx_drum_roll.wav",
  "./sound-effects/sfx_cymbal_crash.wav",
  "./sound-effects/sfx_suspense_rise.wav",
  "./sound-effects/sfx_mystery_chime.wav",
  "./sound-effects/sfx_magic_wand_twinkle.wav",
  "./sound-effects/sfx_levitation_float.wav",
  "./sound-effects/sfx_teleport_zap.wav",
  "./sound-effects/sfx_transformation_morph.wav",
  "./sound-effects/sfx_card_shuffle.wav",
  "./sound-effects/sfx_coin_chime.wav",
  "./sound-effects/sfx_comedy_boing.wav",
  "./sound-effects/sfx_whistle_up.wav",
  "./sound-effects/sfx_whistle_down.wav",
  "./sound-effects/sfx_applause.wav"
];
const APP_ASSETS = APP_PATHS.map((path) => new URL(path, self.location.href).href);
const OFFLINE_URL = new URL("./index.html", self.location.href).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => {
        if (request.mode === "navigate") return caches.match(OFFLINE_URL);
        throw new Error("Offline asset is not cached.");
      });
    })
  );
});
