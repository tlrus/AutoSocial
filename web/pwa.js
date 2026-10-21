(() => {
  let installPrompt = null, installed = false, generation = 0, controller = null, pollTimer = null;
  let panel, installButton, statusLabel, statusDetail, dialog, dialogBody, nativeInstallButton, previousFocus;
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isInstalled = () => installed || standalone.matches || window.navigator.standalone === true;
  const secureAddress = () => window.isSecureContext && (location.protocol === "https:" || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".localhost"));

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function updateInstallButton() {
    if (!installButton) return;
    installButton.textContent = isInstalled() ? "Приложение установлено" : "Установить приложение";
    installButton.disabled = isInstalled();
    if (nativeInstallButton) nativeInstallButton.hidden = !installPrompt || isInstalled();
  }

  function setConnection(state, label, detail) {
    if (!panel) return;
    panel.dataset.connection = state;
    if (statusLabel.textContent !== label) statusLabel.textContent = label;
    statusDetail.textContent = detail;
  }

  async function checkConnection() {
    clearTimeout(pollTimer);
    const version = ++generation;
    controller?.abort();
    if (document.visibilityState === "hidden") return;
    if (!navigator.onLine) {
      setConnection("offline", "Нет интернета", "Подключите устройство к сети.");
      pollTimer = setTimeout(checkConnection, 30000);
      return;
    }
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 6000);
    const options = { cache: "no-store", credentials: "same-origin", redirect: "error", signal: requestController.signal };
    try {
      const [health, authentication] = await Promise.all([fetch("/healthz", options), fetch("/api/auth/status", options)]);
      const healthData = await health.json();
      if (!health.ok || healthData.ok !== true) throw new Error("unavailable");
      const authenticationData = await authentication.json().catch(() => ({}));
      if (version !== generation) return;
      const checked = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      if (authentication.status === 401 || authenticationData.authenticated === false) {
        setConnection("signed-out", "Сервис доступен · войдите", "Войдите, чтобы открыть свои аккаунты.");
      } else if (!authentication.ok || authenticationData.authenticated !== true) {
        setConnection("unverified", "Сервис отвечает", "Не удалось проверить вход. Обновите страницу.");
      } else {
        setConnection("online", "Сервис доступен", `Вход выполнен · проверено в ${checked}`);
      }
    } catch {
      if (version !== generation) return;
      setConnection(navigator.onLine ? "unavailable" : "offline", navigator.onLine ? "Нет связи с сервисом" : "Нет интернета", "Проверим подключение автоматически.");
    } finally {
      clearTimeout(timeout);
      if (version === generation && document.visibilityState !== "hidden") pollTimer = setTimeout(checkConnection, 30000);
    }
  }

  function closeDialog() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    previousFocus?.focus();
  }

  function installInstructions() {
    dialogBody.replaceChildren();
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const steps = element("ol", "pwa-install-steps");
    let instructions;
    if (!secureAddress()) {
      instructions = ["Откройте AutoSocial по HTTPS-адресу сервиса.", "Нажмите «Установить приложение» ещё раз."];
    } else if (ios) {
      instructions = ["Откройте этот адрес в Safari.", "Нажмите «Поделиться», затем «На экран “Домой”».", "Нажмите «Добавить». AutoSocial появится на главном экране."];
    } else if (installPrompt) {
      instructions = ["Нажмите «Установить» ниже и подтвердите установку в браузере.", "Открывайте AutoSocial с главного экрана или из списка приложений."];
    } else {
      instructions = ["Откройте этот адрес в Chrome или Edge.", "В меню браузера выберите «Установить приложение» или нажмите значок установки рядом с адресом.", "Открывайте AutoSocial с главного экрана или из списка приложений."];
    }
    for (const instruction of instructions) steps.append(element("li", "", instruction));
    dialogBody.append(steps, element("p", "pwa-dialog-note", "Для обновления аккаунтов и постов нужны интернет и работающий сервис AutoSocial. После установки используется тот же адрес и вход."));
    updateInstallButton();
  }

  function openDialog() {
    previousFocus = document.activeElement;
    installInstructions();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else { dialog.setAttribute("open", ""); dialog.classList.add("pwa-dialog-fallback"); }
    dialog.querySelector("button").focus();
  }

  async function install() {
    if (!installPrompt) return;
    const pending = installPrompt;
    installPrompt = null;
    nativeInstallButton.disabled = true;
    try {
      await pending.prompt();
      const result = await pending.userChoice;
      if (result.outcome === "accepted") closeDialog();
      else installInstructions();
    } catch {
      installInstructions();
    } finally {
      nativeInstallButton.disabled = false;
      updateInstallButton();
    }
  }

  function buildDialog() {
    dialog = element("dialog", "pwa-install-dialog");
    dialog.id = "pwaInstallDialog";
    dialog.setAttribute("aria-labelledby", "pwaInstallTitle");
    dialog.setAttribute("aria-modal", "true");
    const heading = element("div", "pwa-dialog-heading");
    const title = element("h2", "", "AutoSocial как приложение"); title.id = "pwaInstallTitle";
    const close = element("button", "pwa-dialog-close", "Закрыть"); close.type = "button";
    close.addEventListener("click", closeDialog);
    heading.append(title, close);
    dialogBody = element("div", "pwa-dialog-body");
    nativeInstallButton = element("button", "pwa-install-native", "Установить");
    nativeInstallButton.type = "button";
    nativeInstallButton.hidden = true;
    nativeInstallButton.addEventListener("click", install);
    dialog.append(heading, dialogBody, nativeInstallButton);
    dialog.addEventListener("close", () => previousFocus?.focus());
    dialog.addEventListener("keydown", (event) => {
      if (!dialog.classList.contains("pwa-dialog-fallback")) return;
      if (event.key === "Escape") { event.preventDefault(); closeDialog(); }
      if (event.key === "Tab") {
        const buttons = [...dialog.querySelectorAll("button:not([hidden]):not(:disabled)")];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.body.append(dialog);
  }

  function init() {
    const footer = document.querySelector(".sidebar-footer");
    const login = document.querySelector("#loginForm")?.closest("main");
    const host = footer || login;
    if (!host) return;
    host.classList.add("pwa-host");
    if (footer) document.querySelector(".sidebar")?.classList.add("pwa-enabled");
    panel = element("section", "pwa-app-panel" + (login ? " pwa-login-panel" : ""));
    panel.setAttribute("aria-label", "Приложение и подключение");
    const state = element("div", "pwa-connection");
    const line = element("div", "pwa-connection-line");
    const dot = element("span", "pwa-connection-dot"); dot.setAttribute("aria-hidden", "true");
    statusLabel = element("span", "", "Проверяем связь…"); statusLabel.id = "pwaConnectionStatus";
    statusLabel.setAttribute("role", "status"); statusLabel.setAttribute("aria-live", "polite");
    statusDetail = element("span", "pwa-connection-detail", "Проверяем доступ к AutoSocial.");
    line.append(dot, statusLabel); state.append(line, statusDetail);
    installButton = element("button", "pwa-install-button", "Установить приложение");
    installButton.id = "pwaInstallButton"; installButton.type = "button";
    installButton.addEventListener("click", openDialog);
    panel.append(state, installButton); host.append(panel);
    buildDialog(); updateInstallButton(); checkConnection();
    for (const event of ["online", "offline"]) window.addEventListener(event, checkConnection);
    document.addEventListener("visibilitychange", checkConnection);
    standalone.addEventListener?.("change", updateInstallButton);
    if (secureAddress() && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
    }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); installPrompt = event;
    if (dialog?.open) installInstructions(); else updateInstallButton();
  });
  window.addEventListener("appinstalled", () => { installed = true; installPrompt = null; updateInstallButton(); if (dialog?.open) closeDialog(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
