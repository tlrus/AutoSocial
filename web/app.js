const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
  if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith("/api/")) location.replace("/login" + location.hash);
  return response;
};

const API = {
  async get(endpoint) {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },
  async post(endpoint, body) {
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const res = await fetch(endpoint, options);
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },
  async delete(endpoint) {
    const res = await fetch(endpoint, { method: "DELETE" });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },
};

API.get("/api/auth/status").then(({ enabled }) => {
  document.getElementById("dashboardLogoutBtn").classList.toggle("hidden", !enabled);
}).catch(() => {});
document.getElementById("dashboardLogoutBtn").addEventListener("click", async () => {
  await API.post("/api/auth/logout");
  location.replace("/login");
});
document.getElementById("igImportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("igImportSubmit");
  const result = document.getElementById("igImportResult");
  button.disabled = true;
  result.textContent = "Checking your Instagram session...";
  try {
    const json = document.getElementById("igCookiesJson").value.trim();
    const payload = json ? { cookies: JSON.parse(json) } : {
      sessionid: document.getElementById("igSessionId").value.trim(),
      ds_user_id: document.getElementById("igUserId").value.trim(),
    };
    const response = await fetch("/api/instagram/session/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not import the session.");
    document.getElementById("igImportForm").reset();
    result.textContent = "Instagram confirmed the session. It has been saved.";
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const Router = {
  isKnownView(viewName) {
    return Boolean(viewName && document.getElementById("view-" + viewName)?.classList.contains("view-section"));
  },

  init() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        this.navigate(view);
      });
    });
    const restoreView = () => {
      const requested = location.hash.slice(1);
      this.navigate(this.isKnownView(requested) ? requested : "connections", { syncHash: false });
    };
    window.addEventListener("hashchange", restoreView);
    restoreView();
  },

  navigate(viewName, { syncHash = true } = {}) {
    if (!this.isKnownView(viewName)) viewName = "connections";
    if (syncHash && location.hash !== "#" + viewName) history.pushState(null, "", "#" + viewName);
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.toggle("active", sec.id === "view-" + viewName);
    });
    document.dispatchEvent(new CustomEvent("autosocial:viewchange", { detail: { viewName } }));
  },
};

const UI = {
  accountState: {
    tiktok: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    instagram: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    youtube: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    telegram: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    x: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    brands: [],
    activeBrandId: null,
    activeBrandName: "",
  },
  scheduleDraftDirty: {
    tiktok: false,
    instagram: false,
    youtube: false,
    telegram: false,
    x: false,
  },

  currentCalendarDate: new Date(),
  calendarPosts: [],
  calendarViewMode: "grid",
  selectedPostForDetail: null,
  selectedVideoFile: null,
  selectedMediaFiles: [],

  els: {
    calPrevMonthBtn: document.getElementById("calPrevMonthBtn"),
    calNextMonthBtn: document.getElementById("calNextMonthBtn"),
    calTodayBtn: document.getElementById("calTodayBtn"),
    calMonthYearLabel: document.getElementById("calMonthYearLabel"),
    calViewGridBtn: document.getElementById("calViewGridBtn"),
    calViewListBtn: document.getElementById("calViewListBtn"),
    calNewPostBtn: document.getElementById("calNewPostBtn"),
    calScheduledCount: document.getElementById("calScheduledCount"),
    calPublishedCount: document.getElementById("calPublishedCount"),
    calFailedCount: document.getElementById("calFailedCount"),
    calNextPostTime: document.getElementById("calNextPostTime"),
    calMonthGridWrapper: document.getElementById("calMonthGridWrapper"),
    calListWrapper: document.getElementById("calListWrapper"),
    calDaysGrid: document.getElementById("calDaysGrid"),
    calPostsListContainer: document.getElementById("calPostsListContainer"),

    calNewPostModal: document.getElementById("calNewPostModal"),
    calModalCloseBtn: document.getElementById("calModalCloseBtn"),
    calModalCancelBtn: document.getElementById("calModalCancelBtn"),
    calModalSubmitBtn: document.getElementById("calModalSubmitBtn"),
    calDropzone: document.getElementById("calDropzone"),
    calMediaFileInput: document.getElementById("calMediaFileInput"),
    calDropzoneText: document.getElementById("calDropzoneText"),
    calSelectedFilesContainer: document.getElementById("calSelectedFilesContainer"),
    calSelectedFilesList: document.getElementById("calSelectedFilesList"),
    calSelectedFilePreview: document.getElementById("calSelectedFilePreview"),
    calSelectedFileName: document.getElementById("calSelectedFileName"),
    calSelectedFileSize: document.getElementById("calSelectedFileSize"),
    calRemoveFileBtn: document.getElementById("calRemoveFileBtn"),
    calDayExistingPostsBanner: document.getElementById("calDayExistingPostsBanner"),
    calTimeRecommendation: document.getElementById("calTimeRecommendation"),
    calBatchOptionsWrapper: document.getElementById("calBatchOptionsWrapper"),
    calBatchCountLabel: document.getElementById("calBatchCountLabel"),
    calBatchIntervalSelect: document.getElementById("calBatchIntervalSelect"),
    calBatchTimelinePreview: document.getElementById("calBatchTimelinePreview"),
    calCaptionInput: document.getElementById("calCaptionInput"),
    calScheduleTimeInput: document.getElementById("calScheduleTimeInput"),
    calSelectAllPlatsBtn: document.getElementById("calSelectAllPlatsBtn"),
    calUploadProgressWrapper: document.getElementById("calUploadProgressWrapper"),
    calUploadProgressBar: document.getElementById("calUploadProgressBar"),
    calUploadProgressLabel: document.getElementById("calUploadProgressLabel"),

    calDetailModal: document.getElementById("calDetailModal"),
    calDetailCloseBtn: document.getElementById("calDetailCloseBtn"),
    calDetailBody: document.getElementById("calDetailBody"),
    calDetailDeleteBtn: document.getElementById("calDetailDeleteBtn"),
    calDetailPublishNowBtn: document.getElementById("calDetailPublishNowBtn"),

    brandSelect: document.getElementById("brandSelect"),
    addBrandBtn: document.getElementById("addBrandBtn"),
    brandCreateRow: document.getElementById("brandCreateRow"),
    brandNameInput: document.getElementById("brandNameInput"),
    saveBrandBtn: document.getElementById("saveBrandBtn"),
    cancelBrandBtn: document.getElementById("cancelBrandBtn"),
    activeBrandLabel: document.getElementById("activeBrandLabel"),
    statusBadge: document.getElementById("statusBadge"),
    setupRefreshBtn: document.getElementById("setupRefreshBtn"),
    setupSummaryIcon: document.getElementById("setupSummaryIcon"),
    setupSummaryTitle: document.getElementById("setupSummaryTitle"),
    setupSummaryMeta: document.getElementById("setupSummaryMeta"),
    setupMetrics: document.getElementById("setupMetrics"),
    setupChecksList: document.getElementById("setupChecksList"),
    setupSessionsList: document.getElementById("setupSessionsList"),
    setupFoldersList: document.getElementById("setupFoldersList"),
    setupNextSteps: document.getElementById("setupNextSteps"),

    pendingCount: document.getElementById("pendingCount"),
    successCount: document.getElementById("successCount"),
    failedCount: document.getElementById("failedCount"),
    activeAccountsCount: document.getElementById("activeAccountsCount"),
    overviewProfilesContainer: document.getElementById("overviewProfilesContainer"),

    ttQueueList: document.getElementById("ttQueueList"),
    logsContainer: document.getElementById("logsContainer"),
    ttLogsContainer: document.getElementById("ttLogsContainer"),
    accountsTableBody: document.getElementById("accountsTableBody"),

    ttRunBtn: document.getElementById("ttRunBtn"),
    ttStartBtn: document.getElementById("ttStartBtn"),
    ttStopBtn: document.getElementById("ttStopBtn"),
    ttCronInput: document.getElementById("ttCronInput"),
    ttUpdateScheduleBtn: document.getElementById("ttUpdateScheduleBtn"),
    ttPlanType: document.getElementById("ttPlanType"),
    ttPlanTime: document.getElementById("ttPlanTime"),
    ttPlanTimes: document.getElementById("ttPlanTimes"),
    ttPlanWeekday: document.getElementById("ttPlanWeekday"),
    ttPlanApplyBtn: document.getElementById("ttPlanApplyBtn"),
    ttPendingCount: document.getElementById("ttPendingCount"),
    ttPostedCount: document.getElementById("ttPostedCount"),
    ttFailedCount: document.getElementById("ttFailedCount"),
    ttSchedulerState: document.getElementById("ttSchedulerState"),
    ttTimezoneLabel: document.getElementById("ttTimezoneLabel"),
    ttLastRunLabel: document.getElementById("ttLastRunLabel"),
    ttInstantPostToggle: document.getElementById("ttInstantPostToggle"),
    ttAutoAddSoundToggle: document.getElementById("ttAutoAddSoundToggle"),
    ttSoundQueryInput: document.getElementById("ttSoundQueryInput"),
    ttSoundQuerySaveBtn: document.getElementById("ttSoundQuerySaveBtn"),
    ttRandomQueueToggle: document.getElementById("ttRandomQueueToggle"),
    igRunBtn: document.getElementById("igRunBtn"),
    igStartBtn: document.getElementById("igStartBtn"),
    igStopBtn: document.getElementById("igStopBtn"),
    igCronInput: document.getElementById("igCronInput"),
    igUpdateScheduleBtn: document.getElementById("igUpdateScheduleBtn"),
    igPlanType: document.getElementById("igPlanType"),
    igPlanTime: document.getElementById("igPlanTime"),
    igPlanTimes: document.getElementById("igPlanTimes"),
    igPlanWeekday: document.getElementById("igPlanWeekday"),
    igPlanApplyBtn: document.getElementById("igPlanApplyBtn"),
    igPendingCount: document.getElementById("igPendingCount"),
    igPostedCount: document.getElementById("igPostedCount"),
    igFailedCount: document.getElementById("igFailedCount"),
    igSchedulerState: document.getElementById("igSchedulerState"),
    igTimezoneLabel: document.getElementById("igTimezoneLabel"),
    igLastRunLabel: document.getElementById("igLastRunLabel"),
    igInstantPostToggle: document.getElementById("igInstantPostToggle"),
    igRandomQueueToggle: document.getElementById("igRandomQueueToggle"),
    igQueueList: document.getElementById("igQueueList"),
    igLogsContainer: document.getElementById("igLogsContainer"),
    ytRunBtn: document.getElementById("ytRunBtn"),
    ytStartBtn: document.getElementById("ytStartBtn"),
    ytStopBtn: document.getElementById("ytStopBtn"),
    ytCronInput: document.getElementById("ytCronInput"),
    ytUpdateScheduleBtn: document.getElementById("ytUpdateScheduleBtn"),
    ytPlanType: document.getElementById("ytPlanType"),
    ytPlanTime: document.getElementById("ytPlanTime"),
    ytPlanTimes: document.getElementById("ytPlanTimes"),
    ytPlanWeekday: document.getElementById("ytPlanWeekday"),
    ytPlanApplyBtn: document.getElementById("ytPlanApplyBtn"),
    ytPendingCount: document.getElementById("ytPendingCount"),
    ytPostedCount: document.getElementById("ytPostedCount"),
    ytFailedCount: document.getElementById("ytFailedCount"),
    ytSchedulerState: document.getElementById("ytSchedulerState"),
    ytTimezoneLabel: document.getElementById("ytTimezoneLabel"),
    ytLastRunLabel: document.getElementById("ytLastRunLabel"),
    ytInstantPostToggle: document.getElementById("ytInstantPostToggle"),
    ytRandomQueueToggle: document.getElementById("ytRandomQueueToggle"),
    ytQueueList: document.getElementById("ytQueueList"),
    ytLogsContainer: document.getElementById("ytLogsContainer"),

    tgRunBtn: document.getElementById("tgRunBtn"),
    tgStartBtn: document.getElementById("tgStartBtn"),
    tgStopBtn: document.getElementById("tgStopBtn"),
    tgCronInput: document.getElementById("tgCronInput"),
    tgUpdateScheduleBtn: document.getElementById("tgUpdateScheduleBtn"),
    tgPlanType: document.getElementById("tgPlanType"),
    tgPlanTime: document.getElementById("tgPlanTime"),
    tgPlanTimes: document.getElementById("tgPlanTimes"),
    tgPlanWeekday: document.getElementById("tgPlanWeekday"),
    tgPlanApplyBtn: document.getElementById("tgPlanApplyBtn"),
    tgPendingCount: document.getElementById("tgPendingCount"),
    tgPostedCount: document.getElementById("tgPostedCount"),
    tgFailedCount: document.getElementById("tgFailedCount"),
    tgSchedulerState: document.getElementById("tgSchedulerState"),
    tgTimezoneLabel: document.getElementById("tgTimezoneLabel"),
    tgLastRunLabel: document.getElementById("tgLastRunLabel"),
    tgInstantPostToggle: document.getElementById("tgInstantPostToggle"),
    tgRandomQueueToggle: document.getElementById("tgRandomQueueToggle"),
    tgQueueList: document.getElementById("tgQueueList"),
    tgLogsContainer: document.getElementById("tgLogsContainer"),
    tgBotTokenInput: document.getElementById("tgBotTokenInput"),
    tgChatIdInput: document.getElementById("tgChatIdInput"),
    tgSaveConfigBtn: document.getElementById("tgSaveConfigBtn"),

    xRunBtn: document.getElementById("xRunBtn"),
    xStartBtn: document.getElementById("xStartBtn"),
    xStopBtn: document.getElementById("xStopBtn"),
    xCronInput: document.getElementById("xCronInput"),
    xUpdateScheduleBtn: document.getElementById("xUpdateScheduleBtn"),
    xPlanType: document.getElementById("xPlanType"),
    xPlanTime: document.getElementById("xPlanTime"),
    xPlanTimes: document.getElementById("xPlanTimes"),
    xPlanWeekday: document.getElementById("xPlanWeekday"),
    xPlanApplyBtn: document.getElementById("xPlanApplyBtn"),
    xPendingCount: document.getElementById("xPendingCount"),
    xPostedCount: document.getElementById("xPostedCount"),
    xFailedCount: document.getElementById("xFailedCount"),
    xSchedulerState: document.getElementById("xSchedulerState"),
    xTimezoneLabel: document.getElementById("xTimezoneLabel"),
    xLastRunLabel: document.getElementById("xLastRunLabel"),
    xInstantPostToggle: document.getElementById("xInstantPostToggle"),
    xRandomQueueToggle: document.getElementById("xRandomQueueToggle"),
    xQueueList: document.getElementById("xQueueList"),
    xLogsContainer: document.getElementById("xLogsContainer"),

    ttSessionStatusBadge: document.getElementById("ttSessionStatusBadge"),
    igSessionStatusBadge: document.getElementById("igSessionStatusBadge"),
    ytSessionStatusBadge: document.getElementById("ytSessionStatusBadge"),
    tgSessionStatusBadge: document.getElementById("tgSessionStatusBadge"),
    xSessionStatusBadge: document.getElementById("xSessionStatusBadge"),

    uniqStartBtn: document.getElementById("uniqStartBtn"),
    uniqStopBtn: document.getElementById("uniqStopBtn"),
    uniqOpenInputBtn: document.getElementById("uniqOpenInputBtn"),
    uniqOpenOutputBtn: document.getElementById("uniqOpenOutputBtn"),
    uniqInputDir: document.getElementById("uniqInputDir"),
    uniqOutputDir: document.getElementById("uniqOutputDir"),
    uniqLogoImage: document.getElementById("uniqLogoImage"),
    uniqState: document.getElementById("uniqState"),
    uniqProgress: document.getElementById("uniqProgress"),
    uniqSucceeded: document.getElementById("uniqSucceeded"),
    uniqFailed: document.getElementById("uniqFailed"),
    uniqInputFiles: document.getElementById("uniqInputFiles"),
    uniqOutputFiles: document.getElementById("uniqOutputFiles"),
    uniqLogs: document.getElementById("uniqLogs"),

    adStartBtn: document.getElementById("adStartBtn"),
    adStopBtn: document.getElementById("adStopBtn"),
    adChannel: document.getElementById("adChannel"),
    adInterval: document.getElementById("adInterval"),
    adMaxVideos: document.getElementById('adMaxVideos'),
    adPlatTiktok: document.getElementById('adPlatTiktok'),
    adPlatInstagram: document.getElementById("adPlatInstagram"),
    adPlatYoutube: document.getElementById("adPlatYoutube"),
    adPlatTelegram: document.getElementById("adPlatTelegram"),
    adPlatX: document.getElementById("adPlatX"),
    adSaveSettingsBtn: document.getElementById("adSaveSettingsBtn"),
    adWatcherState: document.getElementById("adWatcherState"),
    adTotalDownloaded: document.getElementById("adTotalDownloaded"),
    adLastCheck: document.getElementById("adLastCheck"),
    adLogsContainer: document.getElementById("adLogsContainer"),
    defaultCaptionInput: document.getElementById("defaultCaptionInput"),
    defaultCaptionSaveBtn: document.getElementById("defaultCaptionSaveBtn"),

    // Profile Downloader
    pdChannel: document.getElementById("pdChannel"),
    pdMaxVideos: document.getElementById("pdMaxVideos"),
    pdMinViews: document.getElementById("pdMinViews"),
    pdStartBtn: document.getElementById("pdStartBtn"),
    pdScanBtn: document.getElementById("pdScanBtn"),
    pdOpenFolderBtn: document.getElementById("pdOpenFolderBtn"),
    pdLogsContainer: document.getElementById("pdLogsContainer"),
    pdStatusBadge: document.getElementById("pdStatusBadge"),
  },

  init() {
    Router.init();
    this.bindEvents();
    this.bindCalendarEvents();
    this.bindSkillsEvents();
    this.bindCanvasEvents();
    this.updateFriendlyScheduleVisibility("tiktok");
    this.updateFriendlyScheduleVisibility("instagram");
    this.updateFriendlyScheduleVisibility("youtube");
    this.startPolling();
    this.renderAccounts();
    this.fetchCalendarPosts();
  },

  bindSkillsEvents() {
    window.AutoSocialAgents.init({
      toCalendar: ({ postText, platform }) => {
        Router.navigate("calendar");
        this.openNewPostModal();
        this.els.calCaptionInput.value = postText;
        document.querySelectorAll('input[name="calPlatform"]').forEach((cb) => { cb.checked = cb.value === platform; });
        this.els.calSelectAllPlatsBtn.textContent = "Select All";
      },
    });
  },

  canvasState: {
    creative: null,
    references: [],
    history: [],
    timelineMode: true,
  },

  bindCanvasEvents() {
    const topicInput = document.getElementById("canvasTopicInput");
    const formatSelect = document.getElementById("canvasFormatSelect");
    const agentSelect = document.getElementById("canvasAgentSelect");
    const generateBtn = document.getElementById("canvasGenerateBtn");
    const chatInput = document.getElementById("canvasChatInput");
    const sendChatBtn = document.getElementById("canvasSendChatBtn");
    const chatMessages = document.getElementById("canvasChatMessages");
    const refDropzone = document.getElementById("canvasRefDropzone");
    const refFileInput = document.getElementById("canvasRefFileInput");
    const refGallery = document.getElementById("canvasRefGallery");
    const refCount = document.getElementById("canvasRefCount");
    const hookSelect = document.getElementById("canvasHookVariantSelect");
    const hookText = document.getElementById("canvasHookText");
    const scriptText = document.getElementById("canvasScriptText");
    const timelineView = document.getElementById("canvasTimelineView");
    const rawScriptView = document.getElementById("canvasRawScriptView");
    const switchTimelineBtn = document.getElementById("canvasSwitchTimelineModeBtn");
    const ctaText = document.getElementById("canvasCtaText");
    const visualPromptText = document.getElementById("canvasVisualPromptText");
    const tagsText = document.getElementById("canvasTagsText");
    const scoreCircle = document.getElementById("canvasScoreCircle");
    const scoreNotes = document.getElementById("canvasScoreNotes");
    const copyAllBtn = document.getElementById("canvasCopyAllBtn");
    const copyPromptBtn = document.getElementById("canvasCopyPromptBtn");
    const saveDraftBtn = document.getElementById("canvasSaveDraftBtn");
    const sendToCalBtn = document.getElementById("canvasSendToCalendarBtn");
    const bottomSendToCalBtn = document.getElementById("canvasBottomSendToCalBtn");
    const quickChips = document.querySelectorAll(".canvas-quick-chips .chip-btn");

    if (!generateBtn) return;

    this.loadCanvasReferences();

    const renderCreative = (creative) => {
      this.canvasState.creative = creative;

      // Hook
      if (creative.hookVariations && creative.hookVariations.length) {
        hookSelect.innerHTML = creative.hookVariations
          .map((h, i) => `<option value="${i}">Вариант ${i + 1}: ${escapeHtml(h.slice(0, 35))}...</option>`)
          .join("");
        hookSelect.value = "0";
      }
      if (hookText) hookText.value = creative.hook || "";

      // Script / Timeline
      if (scriptText) scriptText.value = creative.script || "";
      if (timelineView) {
        if (creative.timeline && creative.timeline.length) {
          timelineView.innerHTML = creative.timeline
            .map(
              (step) => `
            <div class="timeline-step-card">
              <div class="timeline-step-header">
                <span class="timeline-step-time"><i class="ph ph-clock"></i> ${escapeHtml(step.time)}</span>
              </div>
              <div class="timeline-step-visual">
                <i class="ph ph-eye" style="color:#a5b4fc; flex-shrink:0; margin-top:2px;"></i>
                <span>${escapeHtml(step.visual)}</span>
              </div>
              <div class="timeline-step-voice">
                <i class="ph ph-microphone" style="color:var(--accent-color); flex-shrink:0; margin-top:2px;"></i>
                <span>${escapeHtml(step.voice)}</span>
              </div>
            </div>
          `
            )
            .join("");
        } else {
          timelineView.innerHTML = `<div style="padding:15px; color:var(--text-muted); font-size:13px; line-height:1.5; white-space:pre-wrap;">${escapeHtml(creative.script || "Нет данных")}</div>`;
        }
      }

      // CTA, Visual Prompt, Tags
      if (ctaText) ctaText.value = creative.cta || "";
      if (visualPromptText) visualPromptText.value = creative.visualPrompt || "";
      if (tagsText) tagsText.value = creative.tags || "";

      // Score
      if (scoreCircle) scoreCircle.textContent = creative.score || 88;
      if (scoreNotes) scoreNotes.textContent = creative.scoreNotes || "Высокая виральность";
    };

    const appendChatMsg = (sender, text) => {
      if (!chatMessages) return;
      const isUser = sender === "user";
      const msgDiv = document.createElement("div");
      msgDiv.className = isUser ? "user-chat-msg" : "agent-chat-msg";
      const icon = isUser ? "ph-user" : "ph-sparkle";
      msgDiv.innerHTML = `
        <div class="agent-avatar"><i class="ph ${icon}"></i></div>
        <div class="agent-bubble">${escapeHtml(text)}</div>
      `;
      chatMessages.appendChild(msgDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    generateBtn.addEventListener("click", async () => {
      const topic = topicInput?.value?.trim();
      if (!topic) {
        alert("Пожалуйста, введите тему или ключевой смысл контента в поле сверху.");
        topicInput?.focus();
        return;
      }

      generateBtn.disabled = true;
      generateBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Создаем...';

      try {
        const payload = {
          topic,
          format: formatSelect?.value || "video",
          agentMode: agentSelect?.value || "reels-scripting",
          references: this.canvasState.references,
        };

        const res = await API.post("/api/canvas/generate", payload);
        if (res && res.ok && res.creative) {
          renderCreative(res.creative);
          if (res.agentReply) {
            appendChatMsg("agent", res.agentReply);
          }
        } else {
          alert(res?.error || "Не удалось сгенерировать контент.");
        }
      } catch (err) {
        alert(`Ошибка генерации: ${err.message}`);
      } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<i class="ph ph-sparkle"></i> Создать креатив';
      }
    });

    if (hookSelect) {
      hookSelect.addEventListener("change", (e) => {
        const idx = parseInt(e.target.value, 10);
        if (this.canvasState.creative?.hookVariations?.[idx]) {
          hookText.value = this.canvasState.creative.hookVariations[idx];
          this.canvasState.creative.hook = hookText.value;
        }
      });
    }

    if (switchTimelineBtn) {
      switchTimelineBtn.addEventListener("click", () => {
        this.canvasState.timelineMode = !this.canvasState.timelineMode;
        if (this.canvasState.timelineMode) {
          timelineView?.classList.remove("hidden");
          rawScriptView?.classList.add("hidden");
          switchTimelineBtn.textContent = "Режим: Таймлайн";
        } else {
          timelineView?.classList.add("hidden");
          rawScriptView?.classList.remove("hidden");
          switchTimelineBtn.textContent = "Режим: Текст";
        }
      });
    }

    const sendChatMessage = async (customMsg) => {
      const msg = customMsg || chatInput?.value?.trim();
      if (!msg) return;

      if (!customMsg && chatInput) chatInput.value = "";
      appendChatMsg("user", msg);

      const currentCreative = this.canvasState.creative || {};
      if (hookText) currentCreative.hook = hookText.value;
      if (scriptText) currentCreative.script = scriptText.value;
      if (ctaText) currentCreative.cta = ctaText.value;
      if (visualPromptText) currentCreative.visualPrompt = visualPromptText.value;
      if (tagsText) currentCreative.tags = tagsText.value;

      try {
        const payload = {
          message: msg,
          currentCreative,
          agentMode: agentSelect?.value || "reels-scripting",
          references: this.canvasState.references,
        };

        const res = await API.post("/api/canvas/chat", payload);
        if (res && res.ok) {
          if (res.reply) {
            appendChatMsg("agent", res.reply);
          }
          if (res.updatedCreative) {
            renderCreative(res.updatedCreative);
          }
        } else {
          appendChatMsg("agent", `⚠️ Ошибка: ${res?.error || "не удалось получить ответ"}`);
        }
      } catch (err) {
        appendChatMsg("agent", `⚠️ Ошибка соединения: ${err.message}`);
      }
    };

    if (sendChatBtn) {
      sendChatBtn.addEventListener("click", () => sendChatMessage());
    }
    if (chatInput) {
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }

    quickChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const cmd = chip.dataset.cmd;
        if (cmd) sendChatMessage(cmd);
      });
    });

    if (refDropzone && refFileInput) {
      refDropzone.addEventListener("click", () => refFileInput.click());
      refFileInput.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataUrl = ev.target.result;
          try {
            const res = await API.post("/api/canvas/upload-reference", { dataUrl });
            if (res && res.ok) {
              this.canvasState.references.push(res.url);
              this.renderCanvasReferences();
            }
          } catch (err) {
            alert(`Не удалось загрузить референс: ${err.message}`);
          }
        };
        reader.readAsDataURL(file);
      });

      refDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        refDropzone.style.borderColor = "var(--primary)";
      });
      refDropzone.addEventListener("dragleave", () => {
        refDropzone.style.borderColor = "";
      });
      refDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        refDropzone.style.borderColor = "";
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith("image/")) {
          const reader = new FileReader();
          reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            try {
              const res = await API.post("/api/canvas/upload-reference", { dataUrl });
              if (res && res.ok) {
                this.canvasState.references.push(res.url);
                this.renderCanvasReferences();
              }
            } catch (err) {
              alert(`Не удалось загрузить референс: ${err.message}`);
            }
          };
          reader.readAsDataURL(file);
        }
      });
    }

    if (copyPromptBtn && visualPromptText) {
      copyPromptBtn.addEventListener("click", async () => {
        const text = visualPromptText.value?.trim();
        if (!text) return;
        await navigator.clipboard.writeText(text).catch(() => {});
        copyPromptBtn.innerHTML = '<i class="ph ph-check"></i> Скопировано!';
        setTimeout(() => {
          copyPromptBtn.innerHTML = '<i class="ph ph-copy"></i> Копировать промпт';
        }, 2000);
      });
    }

    if (copyAllBtn) {
      copyAllBtn.addEventListener("click", async () => {
        const hook = hookText?.value?.trim() || "";
        const script = scriptText?.value?.trim() || "";
        const cta = ctaText?.value?.trim() || "";
        const tags = tagsText?.value?.trim() || "";
        const allText = [hook, script, cta, tags].filter(Boolean).join("\n\n");
        if (!allText) {
          alert("Холст пуст.");
          return;
        }
        await navigator.clipboard.writeText(allText).catch(() => {});
        copyAllBtn.innerHTML = '<i class="ph ph-check"></i> Скопировано!';
        setTimeout(() => {
          copyAllBtn.innerHTML = '<i class="ph ph-copy"></i> Копировать всё';
        }, 2000);
      });
    }

    if (saveDraftBtn) {
      saveDraftBtn.addEventListener("click", async () => {
        const currentCreative = this.canvasState.creative || {};
        if (hookText) currentCreative.hook = hookText.value;
        if (scriptText) currentCreative.script = scriptText.value;
        if (ctaText) currentCreative.cta = ctaText.value;
        if (visualPromptText) currentCreative.visualPrompt = visualPromptText.value;
        if (tagsText) currentCreative.tags = tagsText.value;

        try {
          const res = await API.post("/api/canvas/drafts", currentCreative);
          if (res && res.ok) {
            saveDraftBtn.innerHTML = '<i class="ph ph-check"></i> Сохранено!';
            setTimeout(() => {
              saveDraftBtn.innerHTML = '<i class="ph ph-floppy-disk"></i> Сохранить черновик';
            }, 2000);
          }
        } catch (err) {
          alert(`Не удалось сохранить: ${err.message}`);
        }
      });
    }

    const sendToCalendarHandler = () => {
      const hook = hookText?.value?.trim() || "";
      const script = scriptText?.value?.trim() || "";
      const cta = ctaText?.value?.trim() || "";
      const tags = tagsText?.value?.trim() || "";
      const fullCaption = [hook, script, cta, tags].filter(Boolean).join("\n\n");

      Router.navigate("calendar");
      this.openNewPostModal();

      if (this.els.calCaptionInput) {
        this.els.calCaptionInput.value = fullCaption;
      }
    };

    if (sendToCalBtn) {
      sendToCalBtn.addEventListener("click", sendToCalendarHandler);
    }
    if (bottomSendToCalBtn) {
      bottomSendToCalBtn.addEventListener("click", sendToCalendarHandler);
    }
  },

  async loadCanvasReferences() {
    try {
      const res = await API.get("/api/canvas/references");
      if (res && res.ok && Array.isArray(res.references)) {
        this.canvasState.references = res.references.map((r) => r.url);
        this.renderCanvasReferences();
      }
    } catch (err) {
      console.warn("Failed to load references:", err.message);
    }
  },

  renderCanvasReferences() {
    const gallery = document.getElementById("canvasRefGallery");
    const count = document.getElementById("canvasRefCount");
    if (!gallery) return;

    if (count) count.textContent = this.canvasState.references.length;

    gallery.innerHTML = this.canvasState.references
      .map(
        (url) => `
      <div class="canvas-ref-thumb" title="Референс стиля">
        <img src="${url}" alt="Reference">
      </div>
    `
      )
      .join("");
  },

  bindEvents() {
    if (this.els.brandSelect) {
      this.els.brandSelect.addEventListener("change", (event) =>
        this.handleBrandSelect(event.target.value)
      );
    }
    if (this.els.addBrandBtn) {
      this.els.addBrandBtn.addEventListener("click", () => this.handleAddBrand());
    }
    if (this.els.saveBrandBtn) {
      this.els.saveBrandBtn.addEventListener("click", () => this.handleCreateBrand());
    }
    if (this.els.cancelBrandBtn) {
      this.els.cancelBrandBtn.addEventListener("click", () => this.hideBrandCreator());
    }
    if (this.els.brandNameInput) {
      this.els.brandNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.handleCreateBrand();
        } else if (event.key === "Escape") {
          this.hideBrandCreator();
        }
      });
    }

    if (this.els.ttStartBtn) {
      this.els.ttStartBtn.addEventListener("click", () => this.handleAction("/api/start"));
    }
    if (this.els.ttStopBtn) {
      this.els.ttStopBtn.addEventListener("click", () => this.handleAction("/api/stop"));
    }
    if (this.els.ttRunBtn) {
      this.els.ttRunBtn.addEventListener("click", () => this.handleAction("/api/run-once"));
    }
    if (this.els.ttUpdateScheduleBtn) {
      this.els.ttUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(true)
      );
    }
    if (this.els.ttPlanType) {
      this.els.ttPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanTime) {
      this.els.ttPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanWeekday) {
      this.els.ttPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanTimes) {
      this.els.ttPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanApplyBtn) {
      this.els.ttPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("tiktok")
      );
    }
    if (this.els.ttInstantPostToggle) {
      this.els.ttInstantPostToggle.addEventListener("change", (e) =>
        this.handleInstantPostToggle("tiktok", e.target.checked)
      );
    }

    if (this.els.ttAutoAddSoundToggle) {
      this.els.ttAutoAddSoundToggle.addEventListener("change", async (e) => {
        try {
          const result = await API.post("/api/settings/save", {
            payload: { AUTO_ADD_SOUND: e.target.checked }
          });
          if (result?.ok === false && result?.error) {
            alert(result.error);
            e.target.checked = !e.target.checked; // Revert visually on error
          }
          this.refresh();
        } catch (err) {
          alert(`Failed to save auto-add sound setting: ${err.message}`);
          e.target.checked = !e.target.checked;
        }
      });
    }
    if (this.els.setupRefreshBtn) {
      this.els.setupRefreshBtn.addEventListener("click", () => this.refreshSetupHealth());
    }
    if (this.els.setupFoldersList) {
      this.els.setupFoldersList.addEventListener("click", (event) =>
        this.handleSetupFolderClick(event)
      );
    }
    document.addEventListener("autosocial:viewchange", (event) => {
      if (event.detail?.viewName === "setup") {
        this.refreshSetupHealth();
      }
    });

    if (this.els.ttSoundQuerySaveBtn) {
      this.els.ttSoundQuerySaveBtn.addEventListener("click", () =>
        this.handleSaveTextSetting(
          "DEFAULT_SOUND_QUERY",
          this.els.ttSoundQueryInput,
          this.els.ttSoundQuerySaveBtn,
          "Save Sound",
          "Sound query"
        )
      );
    }

    if (this.els.ttRandomQueueToggle) {
      this.els.ttRandomQueueToggle.addEventListener("change", (e) =>
        this.handleRandomQueueToggle(e.target.checked)
      );
    }

    if (this.els.igStartBtn) {
      this.els.igStartBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/start")
      );
    }
    if (this.els.igStopBtn) {
      this.els.igStopBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/stop")
      );
    }
    if (this.els.igRunBtn) {
      this.els.igRunBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/run-once")
      );
    }
    if (this.els.igUpdateScheduleBtn) {
      this.els.igUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(false, true)
      );
    }
    if (this.els.igPlanType) {
      this.els.igPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanTime) {
      this.els.igPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanWeekday) {
      this.els.igPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanTimes) {
      this.els.igPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanApplyBtn) {
      this.els.igPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("instagram")
      );
    }
    if (this.els.igInstantPostToggle) {
      this.els.igInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("instagram", this.els.igInstantPostToggle.checked)
      );
    }
    if (this.els.igRandomQueueToggle) {
      this.els.igRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.igRandomQueueToggle.checked)
      );
    }
    if (this.els.ytStartBtn) {
      this.els.ytStartBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/start")
      );
    }
    if (this.els.ytStopBtn) {
      this.els.ytStopBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/stop")
      );
    }
    if (this.els.ytRunBtn) {
      this.els.ytRunBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/run-once")
      );
    }
    if (this.els.ytUpdateScheduleBtn) {
      this.els.ytUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(false, false, true)
      );
    }
    if (this.els.ytPlanType) {
      this.els.ytPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanTime) {
      this.els.ytPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanWeekday) {
      this.els.ytPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanTimes) {
      this.els.ytPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanApplyBtn) {
      this.els.ytPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("youtube")
      );
    }
    if (this.els.ytInstantPostToggle) {
      this.els.ytInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("youtube", this.els.ytInstantPostToggle.checked)
      );
    }
    if (this.els.ytRandomQueueToggle) {
      this.els.ytRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.ytRandomQueueToggle.checked)
      );
    }

    // Telegram listeners
    if (this.els.tgStartBtn) {
      this.els.tgStartBtn.addEventListener("click", () =>
        this.handleAction("/api/telegram/start")
      );
    }
    if (this.els.tgStopBtn) {
      this.els.tgStopBtn.addEventListener("click", () =>
        this.handleAction("/api/telegram/stop")
      );
    }
    if (this.els.tgRunBtn) {
      this.els.tgRunBtn.addEventListener("click", () =>
        this.handleAction("/api/telegram/run-once")
      );
    }
    if (this.els.tgPlanType) {
      this.els.tgPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("telegram")
      );
    }
    if (this.els.tgPlanTime) {
      this.els.tgPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("telegram")
      );
    }
    if (this.els.tgPlanWeekday) {
      this.els.tgPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("telegram")
      );
    }
    if (this.els.tgPlanTimes) {
      this.els.tgPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("telegram")
      );
    }
    if (this.els.tgPlanApplyBtn) {
      this.els.tgPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("telegram")
      );
    }
    if (this.els.tgInstantPostToggle) {
      this.els.tgInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("telegram", this.els.tgInstantPostToggle.checked)
      );
    }
    if (this.els.tgRandomQueueToggle) {
      this.els.tgRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.tgRandomQueueToggle.checked)
      );
    }
    if (this.els.tgSaveConfigBtn) {
      this.els.tgSaveConfigBtn.addEventListener("click", async () => {
        const token = this.els.tgBotTokenInput?.value?.trim() || "";
        const chatId = this.els.tgChatIdInput?.value?.trim() || "";
        await this.handleSaveTextSetting("TELEGRAM_BOT_TOKEN", { value: token }, null, "", "Bot Token");
        await this.handleSaveTextSetting("TELEGRAM_CHAT_ID", { value: chatId }, this.els.tgSaveConfigBtn, "Save Telegram Settings", "Chat ID");
      });
    }

    // X (Twitter) listeners
    if (this.els.xStartBtn) {
      this.els.xStartBtn.addEventListener("click", () =>
        this.handleAction("/api/x/start")
      );
    }
    if (this.els.xStopBtn) {
      this.els.xStopBtn.addEventListener("click", () =>
        this.handleAction("/api/x/stop")
      );
    }
    if (this.els.xRunBtn) {
      this.els.xRunBtn.addEventListener("click", () =>
        this.handleAction("/api/x/run-once")
      );
    }
    if (this.els.xPlanType) {
      this.els.xPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("x")
      );
    }
    if (this.els.xPlanTime) {
      this.els.xPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("x")
      );
    }
    if (this.els.xPlanWeekday) {
      this.els.xPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("x")
      );
    }
    if (this.els.xPlanTimes) {
      this.els.xPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("x")
      );
    }
    if (this.els.xPlanApplyBtn) {
      this.els.xPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("x")
      );
    }
    if (this.els.xInstantPostToggle) {
      this.els.xInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("x", this.els.xInstantPostToggle.checked)
      );
    }
    if (this.els.xRandomQueueToggle) {
      this.els.xRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.xRandomQueueToggle.checked)
      );
    }
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-platform][data-action]");
      if (!button) return;
      const { platform, action } = button.dataset;
      if (action === "login") this.handlePlatformLogin(platform, button);
      if (action === "close") this.handlePlatformCloseLogin(platform, button);
    });

    if (this.els.uniqStartBtn) {
      this.els.uniqStartBtn.addEventListener("click", () => this.handleUniquifierStart());
    }
    if (this.els.uniqStopBtn) {
      this.els.uniqStopBtn.addEventListener("click", () => this.handleUniquifierStop());
    }
    if (this.els.uniqOpenInputBtn) {
      this.els.uniqOpenInputBtn.addEventListener("click", () =>
        this.handleOpenFolder("input", this.els.uniqInputDir?.value)
      );
    }
    if (this.els.uniqOpenOutputBtn) {
      this.els.uniqOpenOutputBtn.addEventListener("click", () =>
        this.handleOpenFolder("output", this.els.uniqOutputDir?.value)
      );
    }

    // Auto-download events
    if (this.els.adStartBtn) {
      this.els.adStartBtn.addEventListener("click", () => this.handleAutoDownloadAction("/api/autodownload/start"));
    }
    if (this.els.adStopBtn) {
      this.els.adStopBtn.addEventListener("click", () => this.handleAutoDownloadAction("/api/autodownload/stop"));
    }
    if (this.els.adSaveSettingsBtn) {
      this.els.adSaveSettingsBtn.addEventListener("click", () => this.handleAutoDownloadSave());
    }
    if (this.els.defaultCaptionSaveBtn) {
      this.els.defaultCaptionSaveBtn.addEventListener("click", () =>
        this.handleSaveTextSetting(
          "DEFAULT_CAPTION",
          this.els.defaultCaptionInput,
          this.els.defaultCaptionSaveBtn,
          "Save Caption",
          "Default caption"
        )
      );
    }

    // Profile Downloader Listeners
    if (this.els.pdStartBtn) {
      this.els.pdStartBtn.addEventListener("click", () => this.handleProfileDownloadStart(false));
    }
    if (this.els.pdScanBtn) {
      this.els.pdScanBtn.addEventListener("click", () => this.handleProfileDownloadStart(true));
    }
    if (this.els.pdOpenFolderBtn) {
      this.els.pdOpenFolderBtn.addEventListener("click", () => this.handleProfileDownloadOpenFolder());
    }
  },

  async handleAddBrand() {
    if (!this.els.brandCreateRow) {
      const name = prompt("Brand name?");
      if (!name || !name.trim()) return;
      try {
        const result = await API.post("/api/accounts/add", { name: name.trim() });
        if (result?.ok === false && result?.error) {
          alert(result.error);
        }
        await this.refresh();
      } catch (err) {
        alert(`Could not add brand: ${err.message}`);
      }
      return;
    }

    this.els.brandCreateRow.classList.remove("hidden");
    if (this.els.brandNameInput) {
      this.els.brandNameInput.value = "";
      this.els.brandNameInput.focus();
    }
  },

  hideBrandCreator() {
    if (!this.els.brandCreateRow) return;
    this.els.brandCreateRow.classList.add("hidden");
    if (this.els.brandNameInput) {
      this.els.brandNameInput.value = "";
    }
  },

  async handleCreateBrand() {
    const name = this.els.brandNameInput?.value?.trim();
    if (!name) return;
    try {
      const result = await API.post("/api/accounts/add", { name });
      if (result?.ok === false && result?.error) {
        alert(result.error);
        return;
      }
      this.hideBrandCreator();
      await this.refresh();
    } catch (err) {
      alert(`Could not add brand: ${err.message}`);
    }
  },

  async handleBrandSelect(accountId) {
    if (!accountId || accountId === this.accountState.activeBrandId) return;
    try {
      await API.post("/api/accounts/select", { accountId });
      await this.refresh();
      document.dispatchEvent(new CustomEvent("autosocial:accountchange", { detail: { accountId } }));
      if (this.isViewActive("setup")) {
        await this.refreshSetupHealth();
      }
    } catch (err) {
      alert(`Could not switch brand: ${err.message}`);
    }
  },

  isViewActive(viewName) {
    return document.getElementById(`view-${viewName}`)?.classList.contains("active");
  },

  statusMeta(status) {
    const map = {
      ok: { label: "Ready", icon: "ph-check-circle", className: "ok" },
      warn: { label: "Needs attention", icon: "ph-warning-circle", className: "warn" },
      fail: { label: "Blocked", icon: "ph-x-circle", className: "fail" },
    };
    return map[status] || map.warn;
  },

  async refreshSetupHealth() {
    if (this.els.setupRefreshBtn) {
      this.els.setupRefreshBtn.disabled = true;
      this.els.setupRefreshBtn.innerHTML = '<i class="ph ph-circle-notch"></i> Checking';
    }

    try {
      const health = await API.get("/api/setup/health");
      this.renderSetupHealth(health);
    } catch (err) {
      if (this.els.setupSummaryTitle) this.els.setupSummaryTitle.textContent = "Setup check failed";
      if (this.els.setupSummaryMeta) this.els.setupSummaryMeta.textContent = err.message;
      if (this.els.setupChecksList) {
        this.els.setupChecksList.innerHTML = `
          <div class="setup-empty error">Could not load setup health: ${escapeHtml(err.message)}</div>
        `;
      }
    } finally {
      if (this.els.setupRefreshBtn) {
        this.els.setupRefreshBtn.disabled = false;
        this.els.setupRefreshBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Refresh';
      }
    }
  },

  renderSetupHealth(health) {
    if (!health || typeof health !== "object") return;
    const summary = this.statusMeta(health.overall);
    const activeBrand = health.activeAccount?.name || "Default";
    const updated = health.generatedAt ? new Date(health.generatedAt).toLocaleTimeString() : "just now";

    if (this.els.setupSummaryIcon) {
      this.els.setupSummaryIcon.className = `setup-summary-icon ${summary.className}`;
      this.els.setupSummaryIcon.innerHTML = `<i class="ph ${summary.icon}"></i>`;
    }
    if (this.els.setupSummaryTitle) {
      this.els.setupSummaryTitle.textContent =
        health.overall === "ok" ? "This workstation is ready" : "Review setup items before posting";
    }
    if (this.els.setupSummaryMeta) {
      this.els.setupSummaryMeta.textContent = `Active brand: ${activeBrand} - Last checked ${updated}`;
    }
    if (this.els.setupMetrics) {
      const counts = health.counts || {};
      this.els.setupMetrics.innerHTML = `
        <div class="setup-metric">
          <span class="setup-metric-value ok">${counts.ok ?? 0}</span>
          <span class="setup-metric-label">Ready</span>
        </div>
        <div class="setup-metric">
          <span class="setup-metric-value warn">${counts.warn ?? 0}</span>
          <span class="setup-metric-label">Warnings</span>
        </div>
        <div class="setup-metric">
          <span class="setup-metric-value fail">${counts.fail ?? 0}</span>
          <span class="setup-metric-label">Blocking</span>
        </div>
      `;
    }

    if (this.els.setupChecksList) {
      this.els.setupChecksList.innerHTML = (health.checks || [])
        .map((check) => {
          const meta = this.statusMeta(check.status);
          return `
            <div class="setup-check-item ${meta.className}">
              <div class="setup-check-icon"><i class="ph ${meta.icon}"></i></div>
              <div class="setup-check-body">
                <div class="setup-check-title">${escapeHtml(check.label)}</div>
                <div class="setup-check-detail">${escapeHtml(check.detail)}</div>
                ${check.status === "ok" ? "" : `<div class="setup-check-action">${escapeHtml(check.action)}</div>`}
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupSessionsList) {
      this.els.setupSessionsList.innerHTML = (health.sessions || [])
        .map((session) => {
          const meta = this.statusMeta(session.saved ? "ok" : "warn");
          const isTelegram = session.platform === "telegram";
          const actionBtn = isTelegram
            ? `<button class="control-btn-small" data-platform="telegram" data-action="login" style="margin-top:8px;"><i class="ph ph-gear"></i> Configure Bot</button>`
            : `<div style="display:flex; gap:6px; margin-top:8px;">
                <button class="control-btn-small primary" data-platform="${session.platform}" data-action="login"><i class="ph ph-sign-in"></i> ${session.saved ? "Re-login" : "Connect Account"}</button>
                <button class="control-btn-small danger" data-platform="${session.platform}" data-action="close" title="Close login browser"><i class="ph ph-x-circle"></i> Close Browser</button>
               </div>`;
          return `
            <div class="setup-check-item ${meta.className}">
              <div class="setup-check-icon"><i class="ph ${meta.icon}"></i></div>
              <div class="setup-check-body" style="flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <div class="setup-check-title">${escapeHtml(session.label)}</div>
                  <span class="status-badge ${session.saved ? "active" : ""}">${session.saved ? "Connected" : "Not connected"}</span>
                </div>
                <div class="setup-check-detail">${escapeHtml(session.saved ? "Saved session found" : "No saved session yet")}</div>
                <div class="setup-path">${escapeHtml(session.profileDir)}</div>
                ${actionBtn}
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupFoldersList) {
      this.els.setupFoldersList.innerHTML = (health.folders || [])
        .map((folder) => {
          const meta = this.statusMeta(folder.exists ? "ok" : "fail");
          return `
            <div class="setup-folder-item">
              <div class="setup-folder-main">
                <div class="setup-folder-title">
                  <span class="setup-check-icon ${meta.className}"><i class="ph ${meta.icon}"></i></span>
                  ${escapeHtml(folder.label)}
                </div>
                <div class="setup-check-detail">${escapeHtml(folder.hint)}</div>
                <div class="setup-path">${escapeHtml(folder.path)}</div>
                <div class="setup-folder-meta">${folder.pendingCount ?? 0} video file(s) - ${escapeHtml((folder.supported || []).join(", "))}</div>
              </div>
              <button class="control-btn-small" data-setup-folder="${escapeHtml(folder.key)}">
                <i class="ph ph-folder-open"></i> Open
              </button>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupNextSteps) {
      this.els.setupNextSteps.innerHTML = (health.nextSteps || [])
        .map(
          (step, index) => `
            <div class="setup-step">
              <span class="setup-step-number">${index + 1}</span>
              <span>${escapeHtml(step)}</span>
            </div>
          `
        )
        .join("");
    }
  },

  async handleSetupFolderClick(event) {
    const button = event.target.closest("button[data-setup-folder]");
    if (!button) return;
    button.disabled = true;
    try {
      await API.post("/api/setup/open-folder", { key: button.dataset.setupFolder });
    } catch (err) {
      alert(`Could not open folder: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  },

  async handleAction(endpoint) {
    try {
      const result = await API.post(endpoint);
      if (result && result.skipped && result.reason) {
        alert(result.reason);
      } else if (result && result.ok === false && result.error) {
        alert(result.error);
      }
      this.refresh();
    } catch (err) {
      alert(`Action failed: ${err.message}`);
    }
  },

  getPlatformScheduleControls(platform) {
    const map = {
      tiktok: {
        type: this.els.ttPlanType,
        time: this.els.ttPlanTime,
        times: this.els.ttPlanTimes,
        weekday: this.els.ttPlanWeekday,
        cronInput: this.els.ttCronInput,
      },
      instagram: {
        type: this.els.igPlanType,
        time: this.els.igPlanTime,
        times: this.els.igPlanTimes,
        weekday: this.els.igPlanWeekday,
        cronInput: this.els.igCronInput,
      },
      youtube: {
        type: this.els.ytPlanType,
        time: this.els.ytPlanTime,
        times: this.els.ytPlanTimes,
        weekday: this.els.ytPlanWeekday,
        cronInput: this.els.ytCronInput,
      },
      telegram: {
        type: this.els.tgPlanType,
        time: this.els.tgPlanTime,
        times: this.els.tgPlanTimes,
        weekday: this.els.tgPlanWeekday,
        cronInput: this.els.tgCronInput,
      },
      x: {
        type: this.els.xPlanType,
        time: this.els.xPlanTime,
        times: this.els.xPlanTimes,
        weekday: this.els.xPlanWeekday,
        cronInput: this.els.xCronInput,
      },
    };
    return map[platform];
  },

  getPlatformEndpoints(platform) {
    const map = {
      tiktok: { schedule: "/api/schedule", runOnce: "/api/run-once" },
      instagram: { schedule: "/api/instagram/schedule", runOnce: "/api/instagram/run-once" },
      youtube: { schedule: "/api/youtube/schedule", runOnce: "/api/youtube/run-once" },
      telegram: { schedule: "/api/telegram/schedule", runOnce: "/api/telegram/run-once" },
      x: { schedule: "/api/x/schedule", runOnce: "/api/x/run-once" },
    };
    return map[platform];
  },

  markScheduleDraftDirty(platform, dirty = true) {
    if (!Object.prototype.hasOwnProperty.call(this.scheduleDraftDirty, platform)) return;
    this.scheduleDraftDirty[platform] = dirty;
  },

  isScheduleDraftDirty(platform) {
    return Boolean(this.scheduleDraftDirty[platform]);
  },

  handleFriendlyScheduleDraftChange(platform) {
    this.markScheduleDraftDirty(platform, true);
    this.updateFriendlyScheduleVisibility(platform);
  },

  updateFriendlyScheduleVisibility(platform) {
    const controls = this.getPlatformScheduleControls(platform);
    if (
      !controls?.type ||
      !controls?.time ||
      !controls?.times ||
      !controls?.weekday ||
      !controls?.cronInput
    ) {
      return;
    }
    const mode = controls.type.value;
    controls.weekday.style.display = mode === "weekly" ? "" : "none";
    controls.time.style.display = /^every\d+h$/.test(mode) || mode === "dailyTimes" ? "none" : "";
    controls.times.style.display = mode === "dailyTimes" ? "" : "none";
    controls.cronInput.disabled = mode !== "custom";
  },

  parseCronToFriendly(cronExpression) {
    const cron = (cronExpression || "").trim();
    const daily = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
    if (daily) {
      const minute = String(Number(daily[1])).padStart(2, "0");
      const hour = String(Number(daily[2])).padStart(2, "0");
      return { mode: "daily", time: `${hour}:${minute}` };
    }

    const weekly = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])$/);
    if (weekly) {
      const minute = String(Number(weekly[1])).padStart(2, "0");
      const hour = String(Number(weekly[2])).padStart(2, "0");
      return { mode: "weekly", time: `${hour}:${minute}`, weekday: weekly[3] };
    }

    const everyNh = cron.match(/^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/);
    if (everyNh) {
      const step = Number(everyNh[2]);
      if ([2, 3, 4, 6, 8, 12].includes(step)) {
        return { mode: `every${step}h` };
      }
    }

    return { mode: "custom" };
  },

  applyFriendlyScheduleFromCron(platform, cronExpression) {
    if (this.isScheduleDraftDirty(platform)) {
      this.updateFriendlyScheduleVisibility(platform);
      return;
    }
    const controls = this.getPlatformScheduleControls(platform);
    if (!controls?.type) return;
    const parsed = this.parseCronToFriendly(cronExpression);
    if (controls.type && document.activeElement !== controls.type) {
      controls.type.value = parsed.mode;
    }
    if (controls.time && parsed.time && document.activeElement !== controls.time) {
      controls.time.value = parsed.time;
    }
    if (controls.weekday && parsed.weekday && document.activeElement !== controls.weekday) {
      controls.weekday.value = parsed.weekday;
    }
    this.updateFriendlyScheduleVisibility(platform);
  },

  applySchedulePlanFromStatus(platform, statusData) {
    const controls = this.getPlatformScheduleControls(platform);
    if (!controls?.type) return;
    const plan = statusData?.schedulePlan;
    if (plan?.type === "daily-times") {
      if (!this.isScheduleDraftDirty(platform)) {
        controls.type.value = "dailyTimes";
        if (controls.times && document.activeElement !== controls.times) {
          controls.times.value = (plan.times || []).join(", ");
        }
      }
      this.updateFriendlyScheduleVisibility(platform);
      return;
    }

    this.applyFriendlyScheduleFromCron(platform, statusData?.cronExpression || "");
  },

  buildCronFromFriendly(mode, timeValue, weekdayValue) {
    const everyMatch = /^every(\d+)h$/.exec(mode || "");
    if (everyMatch) {
      const step = Number(everyMatch[1]);
      if ([2, 3, 4, 6, 8, 12].includes(step)) {
        return `0 */${step} * * *`;
      }
    }
    if (mode === "daily" || mode === "weekly") {
      const [hourRaw, minuteRaw] = (timeValue || "12:00").split(":");
      const hour = Math.min(Math.max(Number(hourRaw) || 0, 0), 23);
      const minute = Math.min(Math.max(Number(minuteRaw) || 0, 0), 59);
      if (mode === "daily") {
        return `${minute} ${hour} * * *`;
      }
      const weekday = ["0", "1", "2", "3", "4", "5", "6"].includes(String(weekdayValue))
        ? String(weekdayValue)
        : "1";
      return `${minute} ${hour} * * ${weekday}`;
    }
    return null;
  },

  parseTimesInput(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },

  async handleFriendlySchedule(platform) {
    const controls = this.getPlatformScheduleControls(platform);
    const endpoints = this.getPlatformEndpoints(platform);
    if (!controls?.type || !endpoints) return;

    const mode = controls.type.value;
    if (mode === "once") {
      this.markScheduleDraftDirty(platform, false);
      await this.handleAction(endpoints.runOnce);
      return;
    }

    if (mode === "dailyTimes") {
      const parsedTimes = this.parseTimesInput(controls.times?.value);
      if (!parsedTimes.length) {
        alert("Please enter at least one time, e.g. 09:30, 13:15, 20:45");
        return;
      }
      try {
        await API.post(`${endpoints.schedule}-plan`, {
          type: "daily-times",
          times: parsedTimes,
        });
        this.markScheduleDraftDirty(platform, false);
        await this.refresh();
      } catch (err) {
        alert(`Schedule update failed: ${err.message}`);
      }
      return;
    }

    if (mode === "custom") {
      const cronExpression = controls.cronInput?.value?.trim();
      if (!cronExpression) {
        alert("Please enter a cron expression.");
        return;
      }
      try {
        await API.post(endpoints.schedule, { expression: cronExpression });
        this.markScheduleDraftDirty(platform, false);
        await this.refresh();
      } catch (err) {
        alert(`Schedule update failed: ${err.message}`);
      }
      return;
    }

    const cronExpression = this.buildCronFromFriendly(
      mode,
      controls.time?.value,
      controls.weekday?.value
    );
    if (!cronExpression) return;
    try {
      await API.post(endpoints.schedule, { expression: cronExpression });
      this.markScheduleDraftDirty(platform, false);
      await this.refresh();
    } catch (err) {
      alert(`Schedule update failed: ${err.message}`);
    }
  },

  async handleUpdateSchedule(
    fromTikTokView,
    fromInstagramView = false,
    fromYouTubeView = false
  ) {
    const platform = fromYouTubeView
      ? "youtube"
      : fromInstagramView
        ? "instagram"
        : "tiktok";
    const input = platform === "youtube"
      ? this.els.ytCronInput
      : platform === "instagram"
        ? this.els.igCronInput
        : this.els.ttCronInput;
    const saveBtn = platform === "youtube"
      ? this.els.ytUpdateScheduleBtn
      : platform === "instagram"
        ? this.els.igUpdateScheduleBtn
        : this.els.ttUpdateScheduleBtn;
    if (!input || !saveBtn) return;

    const expression = input.value.trim();
    if (!expression) return;

    try {
      const defaultLabel = "Save Schedule";
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.textContent = defaultLabel;
      }, 2000);

      const endpoint = fromYouTubeView
        ? "/api/youtube/schedule"
        : fromInstagramView
          ? "/api/instagram/schedule"
          : "/api/schedule";
      await API.post(endpoint, { expression });
      this.markScheduleDraftDirty(platform, false);
      this.refresh();
    } catch (err) {
      alert(`Schedule update failed: ${err.message}`);
    }
  },

  async handleUniquifierStart() {
    try {
      await API.post("/api/uniquifier/start", {
        inputDir: this.els.uniqInputDir?.value?.trim(),
        outputDir: this.els.uniqOutputDir?.value?.trim(),
        logoImage: this.els.uniqLogoImage?.value?.trim(),
      });
      await this.refresh();
    } catch (err) {
      alert(`Uniquifier start failed: ${err.message}`);
    }
  },

  async handleUniquifierStop() {
    try {
      await API.post("/api/uniquifier/stop");
      await this.refresh();
    } catch (err) {
      alert(`Uniquifier stop failed: ${err.message}`);
    }
  },

  async handleOpenFolder(kind, folderPath) {
    try {
      await API.post("/api/uniquifier/open-folder", {
        kind,
        folderPath: folderPath || undefined,
      });
    } catch (err) {
      alert(`Could not open folder: ${err.message}`);
    }
  },

  async handleInstantPostToggle(platform, enabled) {
    const endpointMap = {
      tiktok: "/api/instant-post",
      instagram: "/api/instagram/instant-post",
      youtube: "/api/youtube/instant-post",
      telegram: "/api/telegram/instant-post",
      x: "/api/x/instant-post",
    };
    const toggleMap = {
      tiktok: this.els.ttInstantPostToggle,
      instagram: this.els.igInstantPostToggle,
      youtube: this.els.ytInstantPostToggle,
      telegram: this.els.tgInstantPostToggle,
      x: this.els.xInstantPostToggle,
    };
    try {
      await API.post(endpointMap[platform], { enabled });
      this.refresh();
    } catch (err) {
      alert(`Could not toggle instant post: ${err.message}`);
      if (toggleMap[platform]) {
        toggleMap[platform].checked = !enabled;
      }
    }
  },

  async handleRandomQueueToggle(enabled) {
    const toggles = [
      this.els.ttRandomQueueToggle,
      this.els.igRandomQueueToggle,
      this.els.ytRandomQueueToggle,
      this.els.tgRandomQueueToggle,
      this.els.xRandomQueueToggle,
    ].filter(Boolean);
    try {
      const result = await API.post("/api/settings/save", {
        payload: { RANDOM_QUEUE_ORDER: enabled },
      });
      if (result?.ok === false && result?.error) {
        throw new Error(result.error);
      }
      this.refresh();
    } catch (err) {
      alert(`Could not update random queue order: ${err.message}`);
      toggles.forEach((toggle) => {
        toggle.checked = !enabled;
      });
    }
  },

  async handleSaveTextSetting(envKey, inputEl, buttonEl, idleLabel, label) {
    if (!inputEl) return;

    try {
      const result = await API.post("/api/settings/save", {
        payload: { [envKey]: inputEl.value || "" },
      });
      if (result?.ok === false && result?.error) {
        throw new Error(result.error);
      }
      if (buttonEl) {
        buttonEl.innerHTML = '<i class="ph ph-check"></i> Saved!';
        setTimeout(() => {
          buttonEl.textContent = idleLabel;
        }, 2000);
      }
      this.refresh();
    } catch (err) {
      alert(`${label} save failed: ${err.message}`);
    }
  },

  async handleInstagramLogin() {
    await this.handlePlatformLogin("instagram");
  },

  async handleYouTubeLogin() {
    await this.handlePlatformLogin("youtube");
  },

  async handlePlatformLogin(platform, triggerBtn) {
    if (platform === "telegram") {
      alert("Telegram uses the Bot API. Please enter your Bot Token and Chat ID in Settings.");
      const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
      if (settingsNav) settingsNav.click();
      return;
    }
    const endpointMap = {
      tiktok: "/api/tiktok/login",
      instagram: "/api/instagram/login",
      youtube: "/api/youtube/login",
      x: "/api/x/login",
    };
    const labelMap = {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
      x: "X (Twitter)",
    };
    const originalText = triggerBtn ? triggerBtn.innerHTML : "";
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = `<i class="ph ph-spinner ph-spin"></i> Opening browser...`;
    }
    try {
      const result = await API.post(endpointMap[platform]);
      await this.refresh();
    } catch (err) {
      alert(`Ошибка запуска: ${err.message}\n\nПодсказка: Вы также можете запустить окно входа через файл "login-${platform}.bat" в папке проекта.`);
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = originalText;
      }
    }
  },

  async handlePlatformCloseLogin(platform, triggerBtn) {
    if (platform === "telegram") {
      alert("Telegram uses Bot API (no browser session to close).");
      return;
    }
    const endpointMap = {
      tiktok: "/api/tiktok/login/close",
      instagram: "/api/instagram/login/close",
      youtube: "/api/youtube/login/close",
      x: "/api/x/login/close",
    };
    const labelMap = {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
      x: "X (Twitter)",
    };
    const originalText = triggerBtn ? triggerBtn.innerHTML : "";
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = `<i class="ph ph-spinner ph-spin"></i> Closing...`;
    }
    try {
      const result = await API.post(endpointMap[platform]);
      if (!result.alreadyClosed) {
        alert(`${labelMap[platform]} login browser closed.`);
      }
      await this.refresh();
    } catch (err) {
      alert(`Could not close ${labelMap[platform]} login browser: ${err.message}`);
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = originalText;
      }
    }
  },

  async handleAccountsTableClick(event) {
    const button = event.target.closest("button[data-platform][data-action]");
    if (!button) return;
    const { platform, action } = button.dataset;
    if (action === "login") {
      await this.handlePlatformLogin(platform);
      return;
    }
    if (action === "close") {
      await this.handlePlatformCloseLogin(platform);
    }
  },

  startPolling() {
    this.refresh();
    setInterval(() => this.refresh(), 3000);
  },

  async refresh() {
    try {
      const [
        status,
        instagramStatus,
        youtubeStatus,
        telegramStatus,
        xStatus,
        uniquifier,
        accounts,
        tiktokLoginStatus,
        instagramLoginStatus,
        youtubeLoginStatus,
        xLoginStatus,
      ] = await Promise.all([
        API.get("/api/status"),
        API.get("/api/instagram/status"),
        API.get("/api/youtube/status"),
        API.get("/api/telegram/status"),
        API.get("/api/x/status"),
        API.get("/api/uniquifier/status"),
        API.get("/api/accounts"),
        API.get("/api/tiktok/login/status"),
        API.get("/api/instagram/login/status"),
        API.get("/api/youtube/login/status"),
        API.get("/api/x/login/status"),
      ]);
      // Fetch autodownload status in parallel but don't block others
      API.get("/api/autodownload/status").then((ad) => this.renderAutoDownloadStatus(ad)).catch(() => { });
      API.get("/api/profile-download/status").then((pd) => this.renderProfileDownloadStatus(pd)).catch(() => { });
      API.get("/api/overview").then((ov) => this.renderOverview(ov)).catch(() => { });
      this.fetchCalendarPosts();

      this.renderStatus(status);
      this.renderInstagramStatus(instagramStatus);
      this.renderYouTubeStatus(youtubeStatus);
      this.renderTelegramStatus(telegramStatus);
      this.renderXStatus(xStatus);
      this.renderUniquifierStatus(uniquifier);
      this.renderBrandSelector(accounts);
      this.accountState = {
        tiktok: {
          loginOpen: Boolean(tiktokLoginStatus?.open),
          sessionSaved: Boolean(tiktokLoginStatus?.saved),
          schedulerRunning: Boolean(status?.running),
        },
        instagram: {
          loginOpen: Boolean(instagramLoginStatus?.open),
          sessionSaved: Boolean(instagramLoginStatus?.saved),
          schedulerRunning: Boolean(instagramStatus?.running),
        },
        youtube: {
          loginOpen: Boolean(youtubeLoginStatus?.open),
          sessionSaved: Boolean(youtubeLoginStatus?.saved),
          schedulerRunning: Boolean(youtubeStatus?.running),
        },
        telegram: {
          loginOpen: false,
          sessionSaved: Boolean(telegramStatus?.configured || (this.els.tgBotTokenInput?.value && this.els.tgChatIdInput?.value)),
          schedulerRunning: Boolean(telegramStatus?.running),
        },
        x: {
          loginOpen: Boolean(xLoginStatus?.open),
          sessionSaved: Boolean(xLoginStatus?.saved),
          schedulerRunning: Boolean(xStatus?.running),
        },
        brands: accounts?.accounts || [],
        activeBrandId: accounts?.activeAccountId || null,
        activeBrandName: accounts?.activeAccount?.name || "",
      };
      this.renderAccounts();
    } catch (err) {
      console.warn("Polling error", err);
    }
  },

  updateLogContainer(container, html) {
    if (!container) return;
    const nextHtml = html || "";
    if (container.innerHTML === nextHtml) return;

    const topThreshold = 24;
    const wasNearTop = container.scrollTop <= topThreshold;
    const bottomOffset = Math.max(
      0,
      container.scrollHeight - container.clientHeight - container.scrollTop
    );

    container.innerHTML = nextHtml;

    if (wasNearTop) {
      container.scrollTop = 0;
      return;
    }

    container.scrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight - bottomOffset
    );
  },

  renderBrandSelector(data) {
    if (!this.els.brandSelect || !data) return;
    const brands = Array.isArray(data.accounts) ? data.accounts : [];
    const activeAccountId = data.activeAccountId || brands[0]?.id || "";
    const currentValue = this.els.brandSelect.value;

    this.els.brandSelect.innerHTML = brands
      .map((brand) => `<option value="${escapeHtml(brand.id)}">${escapeHtml(brand.name)}</option>`)
      .join("");

    if (brands.some((brand) => brand.id === currentValue)) {
      this.els.brandSelect.value = currentValue;
    } else {
      this.els.brandSelect.value = activeAccountId;
    }
  },

  renderOverview(overviewData) {
    if (!overviewData || typeof overviewData !== "object") return;
    const container = this.els.overviewProfilesContainer;
    if (!container) return;

    const platformMeta = {
      tiktok: {
        label: "TikTok",
        icon: "ph-tiktok-logo",
        color: "#ff0050",
        bg: "linear-gradient(135deg,#00f2ea,#ff0050)",
      },
      instagram: {
        label: "Instagram",
        icon: "ph-instagram-logo",
        color: "#E1306C",
        bg: "linear-gradient(135deg,#833AB4,#E1306C,#F77737)",
      },
      youtube: {
        label: "YouTube",
        icon: "ph-youtube-logo",
        color: "#FF0000",
        bg: "#FF0000",
      },
      telegram: {
        label: "Telegram",
        icon: "ph-paper-plane-tilt",
        color: "#2AABEE",
        bg: "#2AABEE",
      },
      x: {
        label: "X (Twitter)",
        icon: "ph-x-logo",
        color: "#ffffff",
        bg: "#000000",
      },
    };

    const escapeHtml = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    const getProfileName = (profileId) => {
      const brands = this.accountState?.brands || [];
      const match = brands.find((brand) => brand.id === profileId);
      return match?.name || profileId;
    };

    const formatSchedule = (status) => {
      if (status?.schedulePlan?.type === "daily-times") {
        const times = Array.isArray(status.schedulePlan.times) && status.schedulePlan.times.length
          ? status.schedulePlan.times.join(", ")
          : "Not set";
        return `Daily: ${times}`;
      }
      if (status?.cronExpression) {
        return `Cron: ${status.cronExpression}`;
      }
      return "Not scheduled";
    };

    const formatLastRun = (status) => (
      status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "Never"
    );

    const getBadge = (status) => {
      if (status?.isPosting) {
        return { text: "Posting", color: "var(--status-warn)" };
      }
      if (status?.running) {
        return { text: "Running", color: "var(--status-good)" };
      }
      return { text: "Stopped", color: "var(--status-bad)" };
    };

    let totalPending = 0;
    let totalPosted = 0;
    let totalFailed = 0;
    let activeSchedulers = 0;
    const allLogs = [];
    const profileSections = [];

    for (const [profileId, statuses] of Object.entries(overviewData)) {
      const profileName = getProfileName(profileId);
      const cards = [];

      for (const [platformKey, meta] of Object.entries(platformMeta)) {
        const status = statuses?.[platformKey];
        if (!status) continue;

        const queueCounts = status.queue?.counts || {};
        const pending = Number(queueCounts.pending || 0);
        const posted = Number(queueCounts.posted || 0);
        const failed = Number(queueCounts.failed || 0);
        const badge = getBadge(status);

        totalPending += pending;
        totalPosted += posted;
        totalFailed += failed;
        if (status.running) {
          activeSchedulers += 1;
        }

        for (const log of status.logs || []) {
          allLogs.push({ ...log, platform: meta.label, profile: profileName });
        }

        const platformState = this.accountState?.[platformKey] || {};
        const isConnected = Boolean(platformState.sessionSaved);
        cards.push(`
          <div class="card" style="border-left:3px solid ${meta.color};">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
              <div class="brand-icon" style="background:${meta.bg}; width:34px; height:34px; font-size:18px;">
                <i class="ph ${meta.icon}"></i>
              </div>
              <div style="min-width:0; flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="font-weight:600; font-size:15px;">${escapeHtml(meta.label)}</div>
                  <span class="status-badge ${isConnected ? "active" : ""}" style="font-size:11px; padding:2px 8px;">
                    <i class="ph ${isConnected ? "ph-check-circle" : "ph-x-circle"}"></i> ${isConnected ? "Connected" : "Not connected"}
                  </span>
                </div>
                <div class="status-badge" style="margin-top:4px; font-size:11px; color:${badge.color}; border:1px solid ${badge.color}; background:rgba(255,255,255,0.03); display:inline-block;">
                  Scheduler: ${escapeHtml(badge.text)}
                </div>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; text-align:center;">
              <div>
                <div style="font-size:22px; font-weight:700;">${pending}</div>
                <div style="font-size:11px; color:var(--text-muted);">Pending</div>
              </div>
              <div>
                <div style="font-size:22px; font-weight:700; color:var(--success);">${posted}</div>
                <div style="font-size:11px; color:var(--text-muted);">Posted</div>
              </div>
              <div>
                <div style="font-size:22px; font-weight:700; color:var(--danger);">${failed}</div>
                <div style="font-size:11px; color:var(--text-muted);">Failed</div>
              </div>
            </div>
            <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; color:var(--text-muted);">
              <div><i class="ph ph-clock"></i> ${escapeHtml(formatSchedule(status))}</div>
              <div style="margin-top:4px;"><i class="ph ph-calendar-blank"></i> Last: ${escapeHtml(formatLastRun(status))}</div>
            </div>
          </div>
        `);
      }

      if (cards.length > 0) {
        profileSections.push(`
          <div style="margin-bottom:22px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; font-size:14px; font-weight:600; color:var(--text-primary);">
              <i class="ph ph-user"></i>
              <span>${escapeHtml(profileName)}</span>
            </div>
            <div class="overview-platform-grid">
              ${cards.join("")}
            </div>
          </div>
        `);
      }
    }

    container.innerHTML = profileSections.join("") || `
      <div class="card full-width">
        <div style="text-align:center; padding:28px; color:var(--text-muted);">No profile overview data yet.</div>
      </div>
    `;

    const setValue = (el, value) => {
      if (el) el.textContent = value;
    };
    setValue(this.els.pendingCount, totalPending);
    setValue(this.els.successCount, totalPosted);
    setValue(this.els.failedCount, totalFailed);
    setValue(this.els.activeAccountsCount, activeSchedulers);

    allLogs.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    const recentLogs = allLogs.slice(0, 50);

    const logsHtml = recentLogs.length
      ? recentLogs.map((logEntry) => {
        const time = logEntry.at ? new Date(logEntry.at).toLocaleTimeString() : "";
        const color = logEntry.level === "error" ? "var(--danger)" : "var(--text-muted)";
        const platformColor = logEntry.platform === "TikTok"
          ? "#ff0050"
          : logEntry.platform === "Instagram"
            ? "#E1306C"
            : logEntry.platform === "Telegram"
              ? "#2AABEE"
              : logEntry.platform === "X"
                ? "#ffffff"
                : "#FF0000";
        return `<div class="log-entry" style="color:${color}">
          <span style="opacity:0.5;">${escapeHtml(time)}</span>
          <span style="color:${platformColor}; font-weight:600; font-size:11px;">[${escapeHtml(logEntry.platform)}]</span>
          <span style="opacity:0.4; font-size:10px;">${escapeHtml(logEntry.profile || "")}</span>
          ${escapeHtml(logEntry.message || "")}
        </div>`;
      }).join("")
      : '<div style="text-align:center; padding:20px; color:#666;">No logs yet</div>';
    this.updateLogContainer(this.els.logsContainer, logsHtml);
  },
  renderStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt
      ? new Date(data.lastRunAt).toLocaleString()
      : "Never";


    if (this.els.ttPendingCount) this.els.ttPendingCount.textContent = pending;
    if (this.els.ttPostedCount) this.els.ttPostedCount.textContent = posted;
    if (this.els.ttFailedCount) this.els.ttFailedCount.textContent = failed;
    if (this.els.ttSchedulerState) {
      this.els.ttSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.ttSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.ttSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.ttInstantPostToggle && document.activeElement !== this.els.ttInstantPostToggle) {
      this.els.ttInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.ttAutoAddSoundToggle && document.activeElement !== this.els.ttAutoAddSoundToggle) {
      this.els.ttAutoAddSoundToggle.checked = Boolean(data.autoAddSound);
    }

    if (this.els.ttSoundQueryInput && document.activeElement !== this.els.ttSoundQueryInput) {
      this.els.ttSoundQueryInput.value = data.defaultSoundQuery || "";
    }

    if (this.els.ttRandomQueueToggle && document.activeElement !== this.els.ttRandomQueueToggle) {
      this.els.ttRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.ttLogsContainer, logHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.ttQueueList) this.els.ttQueueList.innerHTML = queueHtml;

    if (
      this.els.ttCronInput &&
      document.activeElement !== this.els.ttCronInput &&
      !this.isScheduleDraftDirty("tiktok")
    ) {
      this.els.ttCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("tiktok", data);

    if (this.els.ttTimezoneLabel) this.els.ttTimezoneLabel.textContent = timezone;
    if (this.els.ttLastRunLabel) this.els.ttLastRunLabel.textContent = lastRunText;
    if (this.els.defaultCaptionInput && document.activeElement !== this.els.defaultCaptionInput) {
      this.els.defaultCaptionInput.value = data.defaultCaption || "";
    }

    if (this.els.statusBadge) {
      const textEl = this.els.statusBadge.querySelector("span");
      const dot = this.els.statusBadge.querySelector(".connection-dot");
      const isPosting = Boolean(data.isPosting);
      const running = Boolean(data.running);
      if (textEl) {
        textEl.textContent = isPosting
          ? "Posting in progress"
          : running
            ? "Scheduler running"
            : "Scheduler stopped";
      }
      if (dot) {
        const color = isPosting
          ? "var(--status-warn)"
          : running
            ? "var(--status-good)"
            : "var(--status-bad)";
        dot.style.backgroundColor = color;
        dot.style.boxShadow = `0 0 8px ${color}`;
      }
    }
  },

  renderInstagramStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.igPendingCount) this.els.igPendingCount.textContent = pending;
    if (this.els.igPostedCount) this.els.igPostedCount.textContent = posted;
    if (this.els.igFailedCount) this.els.igFailedCount.textContent = failed;
    if (this.els.igSchedulerState) {
      this.els.igSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.igSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.igSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.igInstantPostToggle && document.activeElement !== this.els.igInstantPostToggle) {
      this.els.igInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.igRandomQueueToggle && document.activeElement !== this.els.igRandomQueueToggle) {
      this.els.igRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.igLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.igQueueList) this.els.igQueueList.innerHTML = queueHtml;

    if (
      this.els.igCronInput &&
      document.activeElement !== this.els.igCronInput &&
      !this.isScheduleDraftDirty("instagram")
    ) {
      this.els.igCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("instagram", data);
    if (this.els.igTimezoneLabel) this.els.igTimezoneLabel.textContent = timezone;
    if (this.els.igLastRunLabel) this.els.igLastRunLabel.textContent = lastRunText;
  },

  renderYouTubeStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.ytPendingCount) this.els.ytPendingCount.textContent = pending;
    if (this.els.ytPostedCount) this.els.ytPostedCount.textContent = posted;
    if (this.els.ytFailedCount) this.els.ytFailedCount.textContent = failed;
    if (this.els.ytSchedulerState) {
      this.els.ytSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.ytSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.ytSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.ytInstantPostToggle && document.activeElement !== this.els.ytInstantPostToggle) {
      this.els.ytInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.ytRandomQueueToggle && document.activeElement !== this.els.ytRandomQueueToggle) {
      this.els.ytRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.ytLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.ytQueueList) this.els.ytQueueList.innerHTML = queueHtml;

    if (
      this.els.ytCronInput &&
      document.activeElement !== this.els.ytCronInput &&
      !this.isScheduleDraftDirty("youtube")
    ) {
      this.els.ytCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("youtube", data);
    if (this.els.ytTimezoneLabel) this.els.ytTimezoneLabel.textContent = timezone;
    if (this.els.ytLastRunLabel) this.els.ytLastRunLabel.textContent = lastRunText;
  },

  renderTelegramStatus(data) {
    if (!data) return;
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.tgPendingCount) this.els.tgPendingCount.textContent = pending;
    if (this.els.tgPostedCount) this.els.tgPostedCount.textContent = posted;
    if (this.els.tgFailedCount) this.els.tgFailedCount.textContent = failed;
    if (this.els.tgSchedulerState) {
      this.els.tgSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.tgSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.tgSchedulerState.classList.toggle("error", !data.running);
    }

    if (this.els.tgInstantPostToggle && document.activeElement !== this.els.tgInstantPostToggle) {
      this.els.tgInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.tgRandomQueueToggle && document.activeElement !== this.els.tgRandomQueueToggle) {
      this.els.tgRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.tgLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.tgQueueList) this.els.tgQueueList.innerHTML = queueHtml;

    if (
      this.els.tgCronInput &&
      document.activeElement !== this.els.tgCronInput &&
      !this.isScheduleDraftDirty("telegram")
    ) {
      this.els.tgCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("telegram", data);
    if (this.els.tgTimezoneLabel) this.els.tgTimezoneLabel.textContent = timezone;
    if (this.els.tgLastRunLabel) this.els.tgLastRunLabel.textContent = lastRunText;

    if (data.configured) {
      if (this.els.tgBotTokenInput && document.activeElement !== this.els.tgBotTokenInput && !this.els.tgBotTokenInput.value) {
        if (data.botToken) this.els.tgBotTokenInput.value = data.botToken;
      }
      if (this.els.tgChatIdInput && document.activeElement !== this.els.tgChatIdInput && !this.els.tgChatIdInput.value) {
        if (data.chatId) this.els.tgChatIdInput.value = data.chatId;
      }
    }
  },

  renderXStatus(data) {
    if (!data) return;
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.xPendingCount) this.els.xPendingCount.textContent = pending;
    if (this.els.xPostedCount) this.els.xPostedCount.textContent = posted;
    if (this.els.xFailedCount) this.els.xFailedCount.textContent = failed;
    if (this.els.xSchedulerState) {
      this.els.xSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.xSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.xSchedulerState.classList.toggle("error", !data.running);
    }

    if (this.els.xInstantPostToggle && document.activeElement !== this.els.xInstantPostToggle) {
      this.els.xInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.xRandomQueueToggle && document.activeElement !== this.els.xRandomQueueToggle) {
      this.els.xRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.xLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.xQueueList) this.els.xQueueList.innerHTML = queueHtml;

    if (
      this.els.xCronInput &&
      document.activeElement !== this.els.xCronInput &&
      !this.isScheduleDraftDirty("x")
    ) {
      this.els.xCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("x", data);
    if (this.els.xTimezoneLabel) this.els.xTimezoneLabel.textContent = timezone;
    if (this.els.xLastRunLabel) this.els.xLastRunLabel.textContent = lastRunText;
  },

  renderUniquifierStatus(data) {
    if (!data) return;

    if (this.els.uniqInputDir && document.activeElement !== this.els.uniqInputDir) {
      this.els.uniqInputDir.value = data.inputDir || "";
    }
    if (this.els.uniqOutputDir && document.activeElement !== this.els.uniqOutputDir) {
      this.els.uniqOutputDir.value = data.outputDir || "";
    }
    if (this.els.uniqLogoImage && document.activeElement !== this.els.uniqLogoImage) {
      this.els.uniqLogoImage.value = data.logoImage || "";
    }

    if (this.els.uniqState) {
      this.els.uniqState.textContent = data.running ? "Running" : "Idle";
      this.els.uniqState.classList.toggle("success", Boolean(data.running));
      this.els.uniqState.classList.toggle("error", !data.running);
    }

    const processed = data.progress?.processed ?? 0;
    const total = data.progress?.total ?? 0;
    const succeeded = data.progress?.succeeded ?? 0;
    const failed = data.progress?.failed ?? 0;
    if (this.els.uniqProgress) this.els.uniqProgress.textContent = `${processed} / ${total}`;
    if (this.els.uniqSucceeded) this.els.uniqSucceeded.textContent = String(succeeded);
    if (this.els.uniqFailed) this.els.uniqFailed.textContent = String(failed);

    if (this.els.uniqStartBtn) this.els.uniqStartBtn.disabled = Boolean(data.running);
    if (this.els.uniqStopBtn) this.els.uniqStopBtn.disabled = !data.running;

    const inputFiles = data.inputFiles || [];
    const outputFiles = data.outputFiles || [];

    if (this.els.uniqInputFiles) {
      this.els.uniqInputFiles.innerHTML = inputFiles.length
        ? inputFiles
          .map(
            (fileName) => `
        <div class="queue-item">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="ph ph-file-video" style="font-size:20px;"></i>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="status-badge active">Input</span>
        </div>
      `
          )
          .join("")
        : '<div style="text-align:center; padding:20px; color:#666;">No videos in input folder</div>';
    }

    if (this.els.uniqOutputFiles) {
      this.els.uniqOutputFiles.innerHTML = outputFiles.length
        ? outputFiles
          .map(
            (fileName) => `
        <div class="queue-item">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="ph ph-file-video" style="font-size:20px;"></i>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="status-badge active">Output</span>
        </div>
      `
          )
          .join("")
        : '<div style="text-align:center; padding:20px; color:#666;">No videos in output folder</div>';
    }

    const logs = data.logs || [];
    if (this.els.uniqLogs) {
      this.els.uniqLogs.innerHTML = logs
        .slice()
        .reverse()
        .map(
          (logEntry) => `
        <div class="log-entry">
          <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
          <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
        </div>
      `
        )
        .join("");
    }
  },

  renderAccounts() {
    const rows = [
      {
        platformKey: "tiktok",
        platform: "TikTok",
        icon: "ph-tiktok-logo",
      },
      {
        platformKey: "instagram",
        platform: "Instagram",
        icon: "ph-instagram-logo",
      },
      {
        platformKey: "youtube",
        platform: "YouTube",
        icon: "ph-youtube-logo",
      },
      {
        platformKey: "telegram",
        platform: "Telegram",
        icon: "ph-paper-plane-tilt",
      },
      {
        platformKey: "x",
        platform: "X (Twitter)",
        icon: "ph-x-logo",
      },
    ];

    const activeCount = rows.filter(
      (row) =>
        this.accountState[row.platformKey]?.loginOpen ||
        this.accountState[row.platformKey]?.sessionSaved
    ).length;
    if (this.els.activeAccountsCount) {
      this.els.activeAccountsCount.textContent = String(activeCount);
    }
    if (this.els.activeBrandLabel) {
      const suffix = this.accountState.activeBrandName
        ? `- ${this.accountState.activeBrandName}`
        : "";
      this.els.activeBrandLabel.textContent = suffix;
    }
    // Sync platform header badges and buttons across all tabs
    const badgeMap = {
      tiktok: this.els.ttSessionStatusBadge,
      instagram: this.els.igSessionStatusBadge,
      youtube: this.els.ytSessionStatusBadge,
      telegram: this.els.tgSessionStatusBadge,
      x: this.els.xSessionStatusBadge,
    };
    for (const [key, badgeEl] of Object.entries(badgeMap)) {
      const st = this.accountState[key] || {};
      if (badgeEl) {
        if (key === "telegram") {
          badgeEl.className = `status-badge ${st.sessionSaved ? "active" : ""}`;
          badgeEl.textContent = st.sessionSaved ? "Configured" : "Not configured";
        } else {
          if (st.sessionSaved) {
            badgeEl.className = "status-badge active";
            badgeEl.textContent = st.loginOpen ? "Connected (Open)" : "Connected";
          } else if (st.loginOpen) {
            badgeEl.className = "status-badge warn";
            badgeEl.textContent = "Logging in...";
          } else {
            badgeEl.className = "status-badge";
            badgeEl.textContent = "Not connected";
          }
        }
      }

      // Update header buttons
      const headerLoginBtn = document.querySelector(`.view-header button[data-platform="${key}"][data-action="login"]`);
      if (headerLoginBtn) {
        if (st.sessionSaved) {
          headerLoginBtn.innerHTML = '<i class="ph ph-check-circle"></i> Connected (Re-login)';
          headerLoginBtn.className = "control-btn-small";
        } else {
          headerLoginBtn.innerHTML = '<i class="ph ph-sign-in"></i> Connect Account';
          headerLoginBtn.className = "control-btn-small primary";
        }
      }
    }

    if (!this.els.accountsTableBody) return;

    this.els.accountsTableBody.innerHTML = rows
      .map(
        (row) => {
          const platformState = this.accountState[row.platformKey] || {};
          const isTelegram = row.platformKey === "telegram";
          const sessionBadge = isTelegram
            ? (platformState.sessionSaved ? '<span class="status-badge active">Configured</span>' : '<span class="status-badge">Not configured</span>')
            : (platformState.sessionSaved
              ? (platformState.loginOpen
                ? '<span class="status-badge active">Connected (Browser Open)</span>'
                : '<span class="status-badge active">Connected</span>')
              : (platformState.loginOpen
                ? '<span class="status-badge warn">Logging in...</span>'
                : '<span class="status-badge">Not connected</span>'));
          const actionButtons = isTelegram
            ? `<button class="control-btn-small" data-platform="${row.platformKey}" data-action="login"><i class="ph ph-gear"></i> Configure Bot</button>`
            : `
              <button class="control-btn-small ${platformState.sessionSaved ? "" : "primary"}" data-platform="${row.platformKey}" data-action="login"><i class="ph ${platformState.sessionSaved ? "ph-check-circle" : "ph-sign-in"}"></i> ${platformState.sessionSaved ? "Re-login" : "Connect Account"}</button>
              <button class="control-btn-small danger" data-platform="${row.platformKey}" data-action="close" title="Close login browser"><i class="ph ph-x-circle"></i> Close Browser</button>
            `;
          return `
      <tr>
        <td><div class="platform-cell"><span class="platform-icon"><i class="ph ${row.icon}"></i></span> ${row.platform}</div></td>
        <td>${sessionBadge}</td>
        <td><span class="status-badge ${platformState.schedulerRunning ? "active" : ""}">${platformState.schedulerRunning ? "Scheduler Running" : "Scheduler Stopped"}</span></td>
        <td><div style="display:flex; gap:6px;">${actionButtons}</div></td>
      </tr>
    `;
        }
      )
      .join("");
  },

  async handleAutoDownloadAction(endpoint) {
    try {
      const result = await API.post(endpoint);
      if (result?.ok === false && result?.error) alert(result.error);
      this.refresh();
    } catch (err) {
      alert(`Auto-download action failed: ${err.message}`);
    }
  },

  async handleAutoDownloadSave() {
    const platforms = [];
    if (this.els.adPlatTiktok?.checked) platforms.push("tiktok");
    if (this.els.adPlatInstagram?.checked) platforms.push("instagram");
    if (this.els.adPlatYoutube?.checked) platforms.push("youtube");
    if (this.els.adPlatTelegram?.checked) platforms.push("telegram");
    if (this.els.adPlatX?.checked) platforms.push("x");

    try {
      await API.post("/api/autodownload/configure", {
        channel: this.els.adChannel?.value || '',
        interval: parseInt(this.els.adInterval?.value, 10) || 10,
        maxVideos: parseInt(this.els.adMaxVideos?.value, 10) || 5,
        platforms
      });
      if (this.els.adSaveSettingsBtn) {
        this.els.adSaveSettingsBtn.innerHTML = '<i class="ph ph-check"></i> Saved!';
        setTimeout(() => {
          this.els.adSaveSettingsBtn.innerHTML = '<i class="ph ph-floppy-disk"></i> Save Settings';
        }, 2000);
      }
      this.refresh();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  },

  renderAutoDownloadStatus(data) {
    if (!data) return;

    if (this.els.adWatcherState) {
      this.els.adWatcherState.textContent = data.running ? "Running" : "Stopped";
      this.els.adWatcherState.classList.toggle("success", Boolean(data.running));
      this.els.adWatcherState.classList.toggle("error", !data.running);
    }
    if (this.els.adTotalDownloaded) {
      this.els.adTotalDownloaded.textContent = data.totalDownloaded ?? 0;
    }
    if (this.els.adLastCheck) {
      this.els.adLastCheck.textContent = data.lastCheckAt
        ? new Date(data.lastCheckAt).toLocaleTimeString()
        : "Never";
    }

    // Sync form fields only when user isn't focused
    if (this.els.adChannel && document.activeElement !== this.els.adChannel) {
      this.els.adChannel.value = data.channel || '';
      this.els.adInterval.value = data.interval || 10;
      this.els.adMaxVideos.value = data.maxVideos || 5;
      const platforms = data.platforms || [];
      if (this.els.adPlatTiktok) this.els.adPlatTiktok.checked = platforms.includes("tiktok");
      if (this.els.adPlatInstagram) this.els.adPlatInstagram.checked = platforms.includes("instagram");
      if (this.els.adPlatYoutube) this.els.adPlatYoutube.checked = platforms.includes("youtube");
      if (this.els.adPlatTelegram) this.els.adPlatTelegram.checked = platforms.includes("telegram");
      if (this.els.adPlatX) this.els.adPlatX.checked = platforms.includes("x");

      // Logs
      const logsHtml = (data.logs || [])
        .slice()
        .reverse()
        .map(
          (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
        )
        .join("");
      this.updateLogContainer(this.els.adLogsContainer, logsHtml);
    }
  },


  async handleProfileDownloadStart(scanOnly = false) {
    try {
      const channel = this.els.pdChannel?.value?.trim();
      const maxVideos = parseInt(this.els.pdMaxVideos?.value, 10) || 0;
      const minViews = parseInt(this.els.pdMinViews?.value, 10) || 0;

      if (!channel) {
        alert("Please provide a valid TikTok channel URL or username.");
        return;
      }

      const result = await API.post("/api/profile-download/start", {
        channel,
        maxVideos,
        minViews,
        scanOnly
      });

      if (result?.ok === false && result?.error) alert(result.error);
      this.refresh();
    } catch (err) {
      alert(`Profile downloader failed to start: ${err.message}`);
    }
  },

  async handleProfileDownloadOpenFolder() {
    try {
      await API.post("/api/profile-download/open-folder");
    } catch (err) {
      alert(`Could not open profile downloads folder: ${err.message}`);
    }
  },

  renderProfileDownloadStatus(data) {
    if (!data) return;

    if (this.els.pdStatusBadge) {
      this.els.pdStatusBadge.textContent = data.running ? "Scraping" : "Idle";
      this.els.pdStatusBadge.classList.toggle("success", Boolean(data.running));
      this.els.pdStatusBadge.classList.toggle("error", !data.running);
    }
    if (this.els.pdStartBtn) {
      this.els.pdStartBtn.disabled = Boolean(data.running);
    }
    if (this.els.pdScanBtn) {
      this.els.pdScanBtn.disabled = Boolean(data.running);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
    <div class="log-entry">
      <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
      <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
    </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.pdLogsContainer, logsHtml);
  },

  bindCalendarEvents() {
    this.els.calPrevMonthBtn?.addEventListener("click", () => {
      this.currentCalendarDate.setMonth(this.currentCalendarDate.getMonth() - 1);
      this.renderCalendar();
    });
    this.els.calNextMonthBtn?.addEventListener("click", () => {
      this.currentCalendarDate.setMonth(this.currentCalendarDate.getMonth() + 1);
      this.renderCalendar();
    });
    this.els.calTodayBtn?.addEventListener("click", () => {
      this.currentCalendarDate = new Date();
      this.renderCalendar();
    });
    this.els.calViewGridBtn?.addEventListener("click", () => {
      this.calendarViewMode = "grid";
      this.els.calViewGridBtn?.classList.add("primary");
      this.els.calViewListBtn?.classList.remove("primary");
      this.els.calMonthGridWrapper?.classList.remove("hidden");
      this.els.calListWrapper?.classList.add("hidden");
    });
    this.els.calViewListBtn?.addEventListener("click", () => {
      this.calendarViewMode = "list";
      this.els.calViewListBtn?.classList.add("primary");
      this.els.calViewGridBtn?.classList.remove("primary");
      this.els.calMonthGridWrapper?.classList.add("hidden");
      this.els.calListWrapper?.classList.remove("hidden");
    });

    this.els.calNewPostBtn?.addEventListener("click", () => {
      this.openNewPostModal();
    });
    this.els.calModalCloseBtn?.addEventListener("click", () => this.closeNewPostModal());
    this.els.calModalCancelBtn?.addEventListener("click", () => this.closeNewPostModal());
    this.els.calNewPostModal?.addEventListener("click", (e) => {
      if (e.target === this.els.calNewPostModal) this.closeNewPostModal();
    });

    const dropzone = this.els.calDropzone;
    if (dropzone) {
      dropzone.addEventListener("click", () => this.els.calMediaFileInput?.click());
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("drag-over");
      });
      dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("drag-over");
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag-over");
        if (e.dataTransfer?.files?.length) {
          this.handleFilesSelected(e.dataTransfer.files);
        }
      });
    }

    this.els.calMediaFileInput?.addEventListener("change", (e) => {
      if (e.target.files?.length) {
        this.handleFilesSelected(e.target.files);
        e.target.value = "";
      }
    });

    this.els.calRemoveFileBtn?.addEventListener("click", () => {
      this.clearSelectedFiles();
    });

    document.addEventListener("paste", (event) => {
      if (this.els.calNewPostModal?.classList.contains("hidden")) return;
      const files = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); this.handleFilesSelected(files); }
    });

    // Time presets for quick scheduling
    document.querySelectorAll(".time-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const timeVal = btn.dataset.time;
        const offsetHours = parseFloat(btn.dataset.offset);
        const input = this.els.calScheduleTimeInput;
        if (!input) return;
        const currentVal = input.value || new Date().toISOString().slice(0, 16);
        const pad = (n) => String(n).padStart(2, "0");

        if (timeVal) {
          const datePart = currentVal.split("T")[0];
          input.value = `${datePart}T${timeVal}`;
        } else if (offsetHours) {
          const d = new Date(currentVal);
          d.setHours(d.getHours() + offsetHours);
          const y = d.getFullYear();
          const m = pad(d.getMonth() + 1);
          const day = pad(d.getDate());
          const h = pad(d.getHours());
          const min = pad(d.getMinutes());
          input.value = `${y}-${m}-${day}T${h}:${min}`;
        }
        this.updateBatchTimelinePreview();
      });
    });

    this.els.calBatchIntervalSelect?.addEventListener("change", () => {
      this.updateBatchTimelinePreview();
    });

    this.els.calScheduleTimeInput?.addEventListener("change", () => {
      this.updateBatchTimelinePreview();
    });

    this.els.calSelectAllPlatsBtn?.addEventListener("click", () => {
      const checkboxes = document.querySelectorAll('input[name="calPlatform"]:not(:disabled)');
      const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
      checkboxes.forEach((cb) => {
        cb.checked = !allChecked;
      });
      if (this.els.calSelectAllPlatsBtn) {
        this.els.calSelectAllPlatsBtn.textContent = allChecked ? "Select All" : "Deselect All";
      }
    });

    this.els.calModalSubmitBtn?.addEventListener("click", () => {
      this.handleSchedulePostSubmit();
    });

    this.els.calDetailCloseBtn?.addEventListener("click", () => this.closePostDetailModal());
    this.els.calDetailModal?.addEventListener("click", (e) => {
      if (e.target === this.els.calDetailModal) this.closePostDetailModal();
    });
    this.els.calDetailDeleteBtn?.addEventListener("click", () => {
      if (this.selectedPostForDetail) {
        this.handleDeletePost(this.selectedPostForDetail.id);
      }
    });
    this.els.calDetailPublishNowBtn?.addEventListener("click", () => {
      if (this.selectedPostForDetail) {
        this.handlePublishPostNow(this.selectedPostForDetail.id);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeNewPostModal();
        this.closePostDetailModal();
      }
    });

    document.addEventListener("autosocial:viewchange", (e) => {
      if (e.detail?.viewName === "calendar") {
        this.fetchCalendarPosts();
      }
    });
  },

  isPhotoFile(file) {
    return file.type.startsWith("image/") || /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i.test(file.name);
  },

  handleFilesSelected(files) {
    if (!files?.length || this.calendarUploading) return;
    const next = [...this.selectedMediaFiles];
    const errors = [];
    for (const file of Array.from(files)) {
      const photo = this.isPhotoFile(file);
      if (!photo && !/\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|3gp|ts|mts)$/i.test(file.name)) { errors.push(file.name + ": выберите фото или видео поддерживаемого формата."); continue; }
      if (file.size > (photo ? 50 : 1000) * 1024 * 1024) { errors.push(file.name + (photo ? ": максимум 50 МБ." : ": максимум 1 ГБ.")); continue; }
      if (!next.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) next.push(file);
    }
    if (next.length > 30) { alert("Можно выбрать до 30 файлов за раз."); return; }
    this.selectedMediaFiles = next;
    this.renderSelectedFilesPreview();
    if (errors.length) alert(errors.join("\n"));
  },

  updatePhotoPlatforms() {
    const hasPhotos = this.selectedMediaFiles.some((f) => this.isPhotoFile(f));
    const onlyPhotos = this.selectedMediaFiles.length > 0 && this.selectedMediaFiles.every((f) => this.isPhotoFile(f));
    document.getElementById("calPhotoPlatformHint")?.classList.toggle("hidden", !hasPhotos);
    document.querySelectorAll('input[name="calPlatform"]').forEach((cb) => {
      if (!["tiktok", "youtube"].includes(cb.value)) return;
      if (onlyPhotos && !cb.disabled) { cb.dataset.beforePhoto = String(cb.checked); cb.checked = false; }
      if (!onlyPhotos && cb.disabled) cb.checked = cb.dataset.beforePhoto === "true";
      cb.disabled = onlyPhotos;
      cb.closest("label").style.opacity = onlyPhotos ? "0.4" : "1";
      cb.closest("label").title = onlyPhotos ? "Эта площадка доступна только для видео" : "";
    });
    const available = Array.from(document.querySelectorAll('input[name="calPlatform"]:not(:disabled)'));
    if (this.els.calSelectAllPlatsBtn) this.els.calSelectAllPlatsBtn.textContent = available.every((cb) => cb.checked) ? "Deselect All" : "Select All";
  },

  renderSelectedFilesPreview() {
    (this.calendarPreviewUrls || []).forEach((url) => URL.revokeObjectURL(url));
    this.calendarPreviewUrls = [];
    this.updatePhotoPlatforms();
    const list = this.els.calSelectedFilesList;
    const container = this.els.calSelectedFilesContainer;
    const dropzone = this.els.calDropzone;
    const batchWrapper = this.els.calBatchOptionsWrapper;
    const batchCountLabel = this.els.calBatchCountLabel;

    if (!this.selectedMediaFiles.length) {
      if (container) container.classList.add("hidden");
      if (dropzone) dropzone.classList.remove("hidden");
      if (batchWrapper) batchWrapper.classList.add("hidden");
      if (this.els.calModalSubmitBtn) {
        this.els.calModalSubmitBtn.innerHTML = '<i class="ph ph-calendar-check"></i> Запланировать пост';
      }
      return;
    }

    if (dropzone) dropzone.classList.remove("hidden");
    if (container) container.classList.remove("hidden");

    const isBatch = this.selectedMediaFiles.length > 1;
    if (batchWrapper) {
      batchWrapper.classList.toggle("hidden", !isBatch);
      if (isBatch && batchCountLabel) {
        batchCountLabel.textContent = `${this.selectedMediaFiles.length} файлов`;
      }
    }

    if (this.els.calModalSubmitBtn) {
      this.els.calModalSubmitBtn.innerHTML = isBatch
        ? `<i class="ph ph-calendar-check"></i> Запланировать все ${this.selectedMediaFiles.length} поста`
        : '<i class="ph ph-calendar-check"></i> Запланировать пост';
    }

    if (list) {
      list.innerHTML = this.selectedMediaFiles.map((file, idx) => {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        const photo = this.isPhotoFile(file);
        const url = photo && !/\.(heic|heif|tiff?|svg)$/i.test(file.name) ? URL.createObjectURL(file) : null;
        if (url) this.calendarPreviewUrls.push(url);
        const thumbnail = url ? '<img src="' + url + '" alt="Предпросмотр фото" style="width:44px;height:44px;object-fit:contain;border-radius:4px;">' : '';
        return `
          <div class="selected-file-row">
            <div class="selected-file-row-info">
              ${thumbnail}<i class="ph ${photo ? "ph-image" : "ph-film-slate"}" style="font-size:18px; color:var(--accent-color);"></i>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500;">${escapeHtml(file.name)}</span>
              <span style="color:var(--text-muted); font-size:11px;">(${mb} MB)</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="selected-file-row-time" id="calFileTime_${idx}">-</span>
              <button type="button" class="control-btn-small danger" style="padding:2px 6px; font-size:11px;" data-remove-idx="${idx}">
                <i class="ph ph-x"></i>
              </button>
            </div>
          </div>
        `;
      }).join("");

      list.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => { img.hidden = true; }));
      list.querySelectorAll("button[data-remove-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (this.calendarUploading) return;
          const idx = parseInt(btn.dataset.removeIdx, 10);
          this.selectedMediaFiles.splice(idx, 1);
          this.renderSelectedFilesPreview();
        });
      });
    }

    this.updateBatchTimelinePreview();
  },

  updateBatchTimelinePreview() {
    if (!this.selectedMediaFiles.length) return;
    const baseTimeStr = this.els.calScheduleTimeInput?.value;
    if (!baseTimeStr) return;
    const baseDate = new Date(baseTimeStr);
    const intervalHours = parseFloat(this.els.calBatchIntervalSelect?.value) || 3;

    const pad = (n) => String(n).padStart(2, "0");

    this.selectedMediaFiles.forEach((file, idx) => {
      const fileDate = new Date(baseDate.getTime() + idx * intervalHours * 3600 * 1000);
      const timeStr = `${pad(fileDate.getHours())}:${pad(fileDate.getMinutes())}`;
      const timeEl = document.getElementById(`calFileTime_${idx}`);
      if (timeEl) {
        timeEl.textContent = `Пост ${idx + 1}: ${timeStr}`;
      }
    });

    if (this.els.calBatchTimelinePreview && this.selectedMediaFiles.length > 1) {
      this.els.calBatchTimelinePreview.innerHTML = this.selectedMediaFiles.map((file, idx) => {
        const fileDate = new Date(baseDate.getTime() + idx * intervalHours * 3600 * 1000);
        const dayStr = fileDate.toLocaleDateString([], { month: "short", day: "numeric" });
        const timeStr = `${pad(fileDate.getHours())}:${pad(fileDate.getMinutes())}`;
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:4px 8px; border-radius:4px;">
            <span><strong style="color:#a5b4fc;">#${idx + 1}</strong> ${escapeHtml(file.name.slice(0, 30))}</span>
            <span style="font-family:monospace; color:#fff;">📅 ${dayStr} в ${timeStr}</span>
          </div>
        `;
      }).join("");
    }
  },

  clearSelectedFiles() {
    this.selectedMediaFiles = [];
    if (this.els.calMediaFileInput) this.els.calMediaFileInput.value = "";
    this.renderSelectedFilesPreview();
  },

  openNewPostModal(prefillDate) {
    this.clearSelectedFiles();
    if (this.els.calCaptionInput) this.els.calCaptionInput.value = "";

    const pad = (n) => String(n).padStart(2, "0");
    let targetYear, targetMonth, targetDay, targetHours, targetMinutes;
    let dayPosts = [];

    if (prefillDate) {
      const parts = String(prefillDate).split("-");
      if (parts.length === 3) {
        targetYear = parseInt(parts[0], 10);
        targetMonth = parseInt(parts[1], 10) - 1;
        targetDay = parseInt(parts[2], 10);
      } else {
        const d = new Date(prefillDate);
        targetYear = d.getFullYear();
        targetMonth = d.getMonth();
        targetDay = d.getDate();
      }

      // Find existing posts already scheduled for this day
      dayPosts = this.calendarPosts.filter((p) => {
        const pd = new Date(p.scheduledAt);
        return (
          pd.getFullYear() === targetYear &&
          pd.getMonth() === targetMonth &&
          pd.getDate() === targetDay
        );
      }).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

      if (dayPosts.length > 0) {
        // Find last scheduled post and recommend +3 hours slot
        const lastPost = dayPosts[dayPosts.length - 1];
        const lastTime = new Date(lastPost.scheduledAt);
        const nextTime = new Date(lastTime.getTime() + 3 * 3600 * 1000);
        targetHours = nextTime.getHours();
        targetMinutes = nextTime.getMinutes();
        if (targetHours >= 23 || nextTime.getDate() !== targetDay) {
          targetHours = 11;
          targetMinutes = 0;
        }
      } else {
        targetHours = 12;
        targetMinutes = 0;
      }
    } else {
      const now = new Date(Date.now() + 3600000);
      targetYear = now.getFullYear();
      targetMonth = now.getMonth();
      targetDay = now.getDate();
      targetHours = now.getHours();
      targetMinutes = now.getMinutes();

      dayPosts = this.calendarPosts.filter((p) => {
        const pd = new Date(p.scheduledAt);
        return (
          pd.getFullYear() === targetYear &&
          pd.getMonth() === targetMonth &&
          pd.getDate() === targetDay
        );
      }).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    }

    if (this.els.calScheduleTimeInput) {
      this.els.calScheduleTimeInput.value = `${targetYear}-${pad(targetMonth + 1)}-${pad(targetDay)}T${pad(targetHours)}:${pad(targetMinutes)}`;
    }

    // Existing posts banner
    if (this.els.calDayExistingPostsBanner) {
      if (dayPosts.length > 0) {
        const itemsHtml = dayPosts.map((p) => {
          const t = new Date(p.scheduledAt);
          const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
          const title = p.caption ? p.caption.slice(0, 25) : p.videoFilename;
          return `<span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:4px; font-weight:500;">⏱️ <strong>${time}</strong>: ${escapeHtml(title)}</span>`;
        }).join(" ");

        this.els.calDayExistingPostsBanner.innerHTML = `
          <div style="font-weight:600; margin-bottom:6px; display:flex; align-items:center; gap:6px;">
            <i class="ph ph-calendar-blank"></i> На этот день уже запланировано постов: ${dayPosts.length}
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; font-size:11px;">
            ${itemsHtml}
          </div>
        `;
        this.els.calDayExistingPostsBanner.classList.remove("hidden");
      } else {
        this.els.calDayExistingPostsBanner.classList.add("hidden");
      }
    }

    if (this.els.calTimeRecommendation) {
      this.els.calTimeRecommendation.textContent = dayPosts.length > 0
        ? `(Предложен свободный слот #${dayPosts.length + 1} в ${pad(targetHours)}:${pad(targetMinutes)})`
        : "";
    }

    document.querySelectorAll('input[name="calPlatform"]').forEach((cb) => {
      cb.checked = true;
    });
    if (this.els.calSelectAllPlatsBtn) this.els.calSelectAllPlatsBtn.textContent = "Deselect All";
    if (this.els.calUploadProgressWrapper) this.els.calUploadProgressWrapper.classList.add("hidden");
    if (this.els.calModalSubmitBtn) {
      this.els.calModalSubmitBtn.disabled = false;
      this.els.calModalSubmitBtn.innerHTML = '<i class="ph ph-calendar-check"></i> Запланировать пост';
    }

    this.els.calNewPostModal?.classList.remove("hidden");
  },

  closeNewPostModal() {
    if (this.calendarUploading) return;
    this.els.calNewPostModal?.classList.add("hidden");
    this.clearSelectedFiles();
  },

  async handleSchedulePostSubmit() {
    if (this.calendarUploading) return;
    const files = [...this.selectedMediaFiles];
    const platforms = Array.from(document.querySelectorAll('input[name="calPlatform"]:checked:not(:disabled)')).map((cb) => cb.value);
    const value = this.els.calScheduleTimeInput?.value;
    if (!files.length) return alert("Выберите фото или видео.");
    if (!platforms.length) return alert("Выберите хотя бы одну социальную сеть.");
    if (files.some((f) => this.isPhotoFile(f)) && !platforms.some((p) => ["instagram", "telegram", "x"].includes(p))) return alert("Для фото выберите Instagram, Telegram или X.");
    const date = new Date(value);
    if (!value || isNaN(date.getTime())) return alert("Укажите дату и время публикации.");
    const form = new FormData();
    files.forEach((file) => form.append("videos", file, file.name));
    form.append("caption", this.els.calCaptionInput?.value || "");
    form.append("platforms", JSON.stringify(platforms));
    form.append("scheduledAt", date.toISOString());
    form.append("intervalHours", this.els.calBatchIntervalSelect?.value || "3");
    this.calendarUploading = true;
    this.els.calModalSubmitBtn.disabled = true;
    this.els.calUploadProgressWrapper?.classList.remove("hidden");
    this.els.calUploadProgressBar.style.width = "0%";
    this.els.calUploadProgressLabel.textContent = "Загрузка файлов…";
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/calendar/posts/batch");
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) this.els.calUploadProgressBar.style.width = Math.round(event.loaded / event.total * 100) + "%";
        };
        xhr.upload.onload = () => { this.els.calUploadProgressLabel.textContent = "Обработка файлов и сохранение постов…"; };
        xhr.onload = () => {
          if (xhr.status === 401) { location.replace("/login"); return reject(new Error("Войдите снова.")); }
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 400 || !data.ok) return reject(new Error(data.error || "Не удалось сохранить посты."));
            resolve(data);
          } catch (error) { reject(new Error(error.message || "Некорректный ответ сервера.")); }
        };
        xhr.onerror = () => reject(new Error("Нет соединения с сервером. Повторите загрузку."));
        xhr.send(form);
      });
      this.calendarUploading = false;
      this.closeNewPostModal();
      await this.fetchCalendarPosts();
      if (result.posts.some((p) => p.skippedPlatforms?.length)) alert("Посты сохранены. Фото запланированы только для Instagram, Telegram и X; видео — для всех выбранных сетей.");
    } catch (error) {
      this.els.calUploadProgressLabel.textContent = error.message;
      alert(error.message);
    } finally {
      this.calendarUploading = false;
      this.els.calModalSubmitBtn.disabled = false;
      this.renderSelectedFilesPreview();
    }
  },

  async fetchCalendarPosts() {
    try {
      const res = await API.get("/api/calendar/posts");
      if (res && res.ok && Array.isArray(res.posts)) {
        this.calendarPosts = res.posts;
        this.renderCalendar();
      }
    } catch (err) {
      console.warn("Could not fetch calendar posts:", err.message);
    }
  },

  renderCalendar() {
    const year = this.currentCalendarDate.getFullYear();
    const month = this.currentCalendarDate.getMonth();

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    if (this.els.calMonthYearLabel) {
      this.els.calMonthYearLabel.textContent = `${monthNames[month]} ${year}`;
    }

    const scheduled = this.calendarPosts.filter((p) => p.status === "scheduled");
    const published = this.calendarPosts.filter((p) => p.status === "published" || p.status === "partial");
    const failed = this.calendarPosts.filter((p) => p.status === "failed");

    if (this.els.calScheduledCount) this.els.calScheduledCount.textContent = scheduled.length;
    if (this.els.calPublishedCount) this.els.calPublishedCount.textContent = published.length;
    if (this.els.calFailedCount) this.els.calFailedCount.textContent = failed.length;

    const upcoming = scheduled.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    if (this.els.calNextPostTime) {
      if (upcoming.length) {
        const nextDate = new Date(upcoming[0].scheduledAt);
        this.els.calNextPostTime.textContent = nextDate.toLocaleString([], {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
      } else {
        this.els.calNextPostTime.textContent = "None";
      }
    }

    const platIcons = {
      tiktok: '<i class="ph ph-tiktok-logo" title="TikTok"></i>',
      instagram: '<i class="ph ph-instagram-logo" title="Instagram"></i>',
      youtube: '<i class="ph ph-youtube-logo" title="YouTube"></i>',
      telegram: '<i class="ph ph-paper-plane-tilt" title="Telegram"></i>',
      x: '<i class="ph ph-x-logo" title="X"></i>',
    };

    if (this.els.calDaysGrid) {
      const firstDay = new Date(year, month, 1);
      let startDayOfWeek = firstDay.getDay() - 1;
      if (startDayOfWeek === -1) startDayOfWeek = 6;

      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const daysInPrevMonth = new Date(year, month, 0).getDate();

      let gridHtml = "";

      for (let i = startDayOfWeek - 1; i >= 0; i--) {
        const dayNum = daysInPrevMonth - i;
        const padDate = new Date(year, month - 1, dayNum);
        gridHtml += this.buildCalendarDayCell(padDate, true, []);
      }

      const today = new Date();
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, month, day);
        const dayPosts = this.calendarPosts.filter((p) => {
          const pDate = new Date(p.scheduledAt);
          return (
            pDate.getFullYear() === year &&
            pDate.getMonth() === month &&
            pDate.getDate() === day
          );
        });
        const isToday =
          today.getFullYear() === year &&
          today.getMonth() === month &&
          today.getDate() === day;

        gridHtml += this.buildCalendarDayCell(currentDate, false, dayPosts, isToday);
      }

      const totalCellsSoFar = startDayOfWeek + daysInMonth;
      const totalGridCells = totalCellsSoFar > 35 ? 42 : 35;
      const remainingDays = totalGridCells - totalCellsSoFar;
      for (let day = 1; day <= remainingDays; day++) {
        const nextPadDate = new Date(year, month + 1, day);
        gridHtml += this.buildCalendarDayCell(nextPadDate, true, []);
      }

      this.els.calDaysGrid.innerHTML = gridHtml;

      this.els.calDaysGrid.querySelectorAll(".calendar-day-cell").forEach((cell) => {
        cell.addEventListener("click", (e) => {
          const addBtn = e.target.closest(".cal-day-add-btn");
          if (addBtn) {
            e.stopPropagation();
            const dateStr = addBtn.dataset.date || cell.dataset.date;
            if (dateStr) this.openNewPostModal(dateStr);
            return;
          }
          const badge = e.target.closest(".calendar-post-badge");
          if (badge) {
            e.stopPropagation();
            const postId = badge.dataset.postId;
            this.openPostDetailModal(postId);
          } else {
            const dateStr = cell.dataset.date;
            if (dateStr) this.openNewPostModal(dateStr);
          }
        });
      });
    }

    if (this.els.calPostsListContainer) {
      if (!this.calendarPosts.length) {
        this.els.calPostsListContainer.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">No scheduled posts yet. Click "+ New Post" to schedule one.</div>';
      } else {
        const sorted = this.calendarPosts.slice().sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
        this.els.calPostsListContainer.innerHTML = sorted.map((p) => {
          const pDate = new Date(p.scheduledAt).toLocaleString();
          const icons = (p.platforms || []).map((pl) => platIcons[pl] || "").join(" ");
          const statusClass = `status-${p.status}`;
          return `
            <div class="calendar-post-row" data-post-id="${p.id}">
              <div style="display:flex; align-items:center; gap:12px; overflow:hidden;">
                <span class="status-badge ${p.status === "published" ? "active" : ""} ${statusClass}">${p.status.toUpperCase()}</span>
                <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
                  <strong style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.caption || p.videoFilename)}</strong>
                  <span style="font-size:12px; color:var(--text-muted);"><i class="ph ph-clock"></i> ${pDate} &bull; ${icons}</span>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <button class="control-btn-small" data-action="view"><i class="ph ph-eye"></i> View</button>
              </div>
            </div>
          `;
        }).join("");

        this.els.calPostsListContainer.querySelectorAll(".calendar-post-row").forEach((row) => {
          row.addEventListener("click", () => {
            this.openPostDetailModal(row.dataset.postId);
          });
        });
      }
    }
  },

  buildCalendarDayCell(dateObj, isOtherMonth, posts = [], isToday = false) {
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
    const platIcons = {
      tiktok: '<i class="ph ph-tiktok-logo"></i>',
      instagram: '<i class="ph ph-instagram-logo"></i>',
      youtube: '<i class="ph ph-youtube-logo"></i>',
      telegram: '<i class="ph ph-paper-plane-tilt"></i>',
      x: '<i class="ph ph-x-logo"></i>',
    };

    // Sort chronologically by time so multiple posts in a day appear in order (e.g. 10:00 -> 14:00 -> 19:00)
    const sortedPosts = posts.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    const postsHtml = sortedPosts.map((p) => {
      const pDate = new Date(p.scheduledAt);
      const timeStr = `${pad(pDate.getHours())}:${pad(pDate.getMinutes())}`;
      const icons = (p.platforms || []).map((pl) => platIcons[pl] || "").join("");
      const title = p.caption ? p.caption.slice(0, 25) : p.videoFilename;
      return `
        <div class="calendar-post-badge status-${p.status}" data-post-id="${p.id}" title="${escapeHtml(p.caption || p.videoFilename)} (в ${timeStr})">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span class="calendar-post-time">⏱️ ${timeStr}</span>
            <span class="calendar-post-platforms">${icons}</span>
          </div>
          <div class="calendar-post-title">${escapeHtml(title)}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="calendar-day-cell ${isOtherMonth ? "day-other-month" : ""} ${isToday ? "day-today" : ""}" data-date="${dateStr}">
        <div class="calendar-day-header">
          <span class="day-number">${dateObj.getDate()}</span>
          <div style="display:flex; align-items:center; gap:4px;">
            ${sortedPosts.length ? `<span class="day-posts-count-badge" title="${sortedPosts.length} постов на этот день">${sortedPosts.length}</span>` : ""}
            <button type="button" class="cal-day-add-btn" data-date="${dateStr}" title="Добавить пост на ${dateStr}"><i class="ph ph-plus"></i></button>
          </div>
        </div>
        <div class="calendar-day-posts">
          ${postsHtml}
        </div>
      </div>
    `;
  },

  openPostDetailModal(postId) {
    const post = this.calendarPosts.find((p) => p.id === postId);
    if (!post) return;
    this.selectedPostForDetail = post;

    const platLabels = {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
      telegram: "Telegram",
      x: "X (Twitter)",
    };

    const pDate = new Date(post.scheduledAt).toLocaleString();
    const results = post.results || {};

    const platformsHtml = (post.platforms || []).map((pl) => {
      const res = results[pl];
      let statusBadge = '<span class="status-badge">Pending</span>';
      let errorMsg = "";
      if (res) {
        if (res.ok) {
          statusBadge = '<span class="status-badge success">Success</span>';
        } else {
          statusBadge = '<span class="status-badge error">Failed</span>';
          errorMsg = `<div style="font-size:11px; color:#ff5555; margin-top:2px;">${escapeHtml(res.error || "Unknown error")}</div>`;
        }
      }
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
          <div>
            <strong>${platLabels[pl] || pl}</strong>
            ${errorMsg}
          </div>
          ${statusBadge}
        </div>
      `;
    }).join("");

    if (this.els.calDetailBody) {
      this.els.calDetailBody.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Status</div>
            <div style="font-size:14px; margin-top:2px;"><span class="status-badge status-${post.status}">${post.status.toUpperCase()}</span></div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Scheduled For</div>
            <div style="font-size:14px; margin-top:2px;"><i class="ph ph-clock"></i> ${pDate}</div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">${post.mediaType === "photo" ? "Фото" : "Видео"}</div>
            <div style="font-size:14px; margin-top:2px;"><i class="ph ph-film-strip"></i> ${escapeHtml(post.mediaFilename || post.videoFilename)}</div>
            ${post.mediaType === "photo" ? `<img src="/api/calendar/posts/${encodeURIComponent(post.id)}/media" alt="Фото поста" style="max-width:100%;max-height:300px;object-fit:contain;margin-top:8px;border-radius:8px;">` : ""}
          </div>
          ${post.caption ? `
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Caption / Text</div>
            <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px; font-size:13px; margin-top:4px; white-space:pre-wrap;">${escapeHtml(post.caption)}</div>
          </div>` : ""}
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:4px;">Platforms Status</div>
            ${platformsHtml}
          </div>
        </div>
      `;
    }

    if (this.els.calDetailPublishNowBtn) {
      this.els.calDetailPublishNowBtn.disabled = post.status === "publishing";
      this.els.calDetailPublishNowBtn.style.display = post.status === "published" ? "none" : "inline-flex";
    }

    this.els.calDetailModal?.classList.remove("hidden");
  },

  closePostDetailModal() {
    this.selectedPostForDetail = null;
    this.els.calDetailModal?.classList.add("hidden");
  },

  async handleDeletePost(postId) {
    if (!confirm("Are you sure you want to delete this scheduled post?")) return;
    try {
      const res = await API.delete(`/api/calendar/posts/${postId}`);
      if (res && res.ok) {
        this.closePostDetailModal();
        this.fetchCalendarPosts();
      } else {
        alert(res?.error || "Failed to delete post.");
      }
    } catch (err) {
      alert(`Delete error: ${err.message}`);
    }
  },

  async handlePublishPostNow(postId) {
    if (!confirm("Publish this post to selected platforms right now?")) return;
    try {
      if (this.els.calDetailPublishNowBtn) {
        this.els.calDetailPublishNowBtn.disabled = true;
        this.els.calDetailPublishNowBtn.innerHTML = '<i class="ph ph-circle-notch"></i> Publishing...';
      }
      const res = await API.post(`/api/calendar/posts/${postId}/publish-now`);
      if (res && res.ok) {
        alert("Publication process completed!");
        this.closePostDetailModal();
        this.fetchCalendarPosts();
      } else {
        alert(res?.error || "Publication error.");
      }
    } catch (err) {
      alert(`Publish error: ${err.message}`);
    } finally {
      if (this.els.calDetailPublishNowBtn) {
        this.els.calDetailPublishNowBtn.disabled = false;
        this.els.calDetailPublishNowBtn.innerHTML = '<i class="ph ph-paper-plane-right"></i> Publish Now';
      }
    }
  },
};

document.addEventListener("DOMContentLoaded", () => UI.init());
