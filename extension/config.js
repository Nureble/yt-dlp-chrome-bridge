// extension/config.js — единый источник правды для адреса сервера.
// Если поменяешь host/port в config.json сервера, поменяй и здесь.
//
// Это плейн-объект на window/globalThis, потому что MV3 service worker
// и popup-страницы шарят глобал через importScripts/<script src>.
//
// Если планируешь публиковать своё расширение в Chrome Web Store —
// замени дефолтные значения на твои.

(function () {
  const cfg = {
    SERVER_URL: "http://127.0.0.1:5000",
  };
  if (typeof globalThis !== "undefined") globalThis.YTDLP_BRIDGE_CONFIG = cfg;
  if (typeof self !== "undefined") self.YTDLP_BRIDGE_CONFIG = cfg;
})();
