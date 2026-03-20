(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});

  // =========================
  // Detection patterns
  // =========================
  const DETECTION_PATTERNS = {
    ja: {
      generatedImagePrefixes: [
        /^画像が作成されました/,
        /^生成された画像[:：]?/,
      ],
    },
    en: {
      generatedImagePrefixes: [
        /^Image created/i,
        /^Generated image[:：]?/i,
      ],
    },
  };

  function getDetectionLanguage() {
    const lang = (
      chrome?.i18n?.getUILanguage?.() ||
      document.documentElement.lang ||
      navigator.language ||
      "en"
    ).toLowerCase();

    if (lang.startsWith("ja")) return "ja";
    return "en";
  }

  const DETECTION_LANG = getDetectionLanguage();

  function getDetectionPatternSet() {
    return (
      DETECTION_PATTERNS[DETECTION_LANG] ||
      DETECTION_PATTERNS.en
    );
  }

  function matchesAnyPattern(text, patterns) {
    if (!text || !Array.isArray(patterns)) return false;
    return patterns.some((pattern) => pattern.test(text));
  }

  function matchesGeneratedImagePrefix(text) {
    const patterns = getDetectionPatternSet().generatedImagePrefixes;
    return matchesAnyPattern(text, patterns);
  }

  // =========================
  // Config / State
  // =========================
  CGO.CONFIG = {
    keepDomMessages: 20,
    domTrimDelayMs: 1200,
    debug: true,
  };

  CGO.STATE = {
    trimScheduled: false,
    lastStopVisible: false,
  };

  // =========================
  // Utils
  // =========================
  CGO.log = function (...args) {
    if (!CGO.CONFIG.debug) return;
    console.log("[CGO]", ...args);
  };

  CGO.t = function (key, substitutions = []) {
    if (!Array.isArray(substitutions)) {
      substitutions = [substitutions];
    }
    try {
      return chrome.i18n.getMessage(key, substitutions) || key;
    } catch {
      return key;
    }
  };

  CGO.sleep = function (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  CGO.unescapeHtml = function (str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(str || "");
    return textarea.value;
  };

  CGO.escapeHtml = function (str) {
    return String(str || "").replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return ch;
      }
    });
  };

  CGO.formatBytes = function (bytes) {
    if (!bytes || isNaN(bytes)) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let value = Number(bytes);

    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }

    if (i === 0) return `${Math.round(value)} B`;
    if (value >= 100) return `${Math.round(value)} ${units[i]}`;
    if (value >= 10) return `${value.toFixed(1)} ${units[i]}`;
    return `${value.toFixed(2)} ${units[i]}`;
  };

  // =========================
  // Detection export
  // =========================
  CGO.matchesGeneratedImagePrefix = matchesGeneratedImagePrefix;
  CGO.getDetectionLanguage = getDetectionLanguage;
})();