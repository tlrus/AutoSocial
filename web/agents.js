(() => {
  const $ = (id) => document.getElementById(id);
  const active = (run) => ["queued", "running"].includes(run?.status);
  const labels = { queued: "В очереди", running: "Работает…", done: "Готово", "needs-input": "Нужны данные", failed: "Ошибка", cancelled: "Остановлен" };
  let catalog = [], selected = new Set(), run = null, ready = false, busyElsewhere = false;
  let timer, epoch = 0, filter = "all", toCalendar, initialized = false, hasSelection = false, starting = false;

  async function request(url, method = "GET", body) {
    const response = await fetch(url, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || "Не удалось связаться с сервисом."), { status: response.status });
    return data;
  }

  function message(text, error = false) {
    $("agentsFormMessage").textContent = text;
    $("agentsFormMessage").classList.toggle("is-error", error);
  }

  function controls() {
    const working = active(run) || starting;
    $("agentsRunButton").disabled = working || !ready || !selected.size || busyElsewhere;
    $("agentsRunButton").textContent = starting ? "Запускаем…" : active(run) ? "Агенты работают…" : "Создать пост";
    $("agentsCancelRun").classList.toggle("hidden", !active(run));
    $("agentsSelectedCount").textContent = `Выбрано ${selected.size} из ${catalog.length || 17}`;
    $("agentsPostText").readOnly = working;
    $("agentsPostText").setAttribute("aria-busy", String(working));
    for (const id of ["agentsSaveDraft", "agentsToCalendar", "agentsCopyPost"]) $(id).disabled = working || !run || !$("agentsPostText").value.trim();
    for (const id of ["agentsTopic", "agentsBrief", "agentsFormat", "agentsPlatform", "agentsModel", "agentsSelectAll", "agentsSelectNone"]) $(id).disabled = working;
    for (const button of $("agentsToggleGrid").querySelectorAll("button")) button.disabled = working;
  }

  function toggles() {
    const grid = $("agentsToggleGrid");
    grid.replaceChildren();
    for (const agent of catalog) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-toggle";
      button.dataset.agentId = agent.id;
      button.hidden = filter !== "all" && !agent.category.split(" ").includes(filter);
      button.setAttribute("aria-pressed", String(selected.has(agent.id)));
      button.setAttribute("aria-label", agent.name + ": " + agent.label);
      button.title = agent.name;
      const icon = document.createElement("i");
      icon.className = "ph " + agent.icon;
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span"); name.className = "agent-toggle-name"; name.textContent = agent.label;
      const state = document.createElement("span"); state.className = "agent-toggle-state"; state.textContent = selected.has(agent.id) ? "Включён" : "Выключен";
      button.append(icon, name, state);
      button.addEventListener("click", () => {
        if (selected.has(agent.id)) selected.delete(agent.id); else selected.add(agent.id);
        button.setAttribute("aria-pressed", String(selected.has(agent.id)));
        state.textContent = selected.has(agent.id) ? "Включён" : "Выключен";
        controls();
      });
      grid.append(button);
    }
    controls();
  }

  function textCount() { $("agentsTextCount").textContent = `${$("agentsPostText").value.length} символов`; controls(); }

  function renderRun(next, restore = false) {
    const isNew = run?.id !== next.id;
    const wasActive = active(run);
    run = next;
    if (restore) {
      $("agentsTopic").value = run.topic;
      $("agentsBrief").value = run.brief;
      $("agentsFormat").value = run.format;
      $("agentsPlatform").value = run.platform;
      if (Array.from($("agentsModel").options).some((o) => o.value === run.model)) $("agentsModel").value = run.model;
      selected = new Set(run.agentIds);
      toggles();
    }
    if (isNew || restore || wasActive || active(run)) $("agentsPostText").value = run.postText || "";
    $("agentsOutputCard").classList.remove("hidden");
    const complete = run.steps.filter((s) => s.status === "done").length;
    const needed = run.steps.filter((s) => s.status === "needs-input").length;
    const failed = run.steps.filter((s) => s.status === "failed").length;
    const current = run.steps.find((s) => s.status === "running");
    $("agentsRunProgress").textContent = active(run)
      ? `${complete} из ${run.steps.length} готово${current ? " · Сейчас: " + current.label : " · Подготовка модели…"}`
      : `${run.status === "cancelled" ? "Запуск остановлен" : run.status === "interrupted" ? "Запуск прерван" : run.status === "failed" ? "Не удалось создать пост" : "Результаты готовы"}: ${complete} из ${run.steps.length}${needed ? " · Нужны данные: " + needed : ""}${failed ? " · Ошибки: " + failed : ""}`;
    $("agentsDraftStatus").textContent = active(run) ? "Черновик дополняется по мере готовности" : run.error || "Черновик сохранён на компьютере";
    for (const step of run.steps) {
      let details = $("agentsStepResults").querySelector(`[data-step-id="${step.id}"]`);
      if (!details || isNew) {
        if (isNew && step === run.steps[0]) $("agentsStepResults").replaceChildren();
        details = document.createElement("details"); details.className = "agent-step-result"; details.dataset.stepId = step.id;
        const summary = document.createElement("summary");
        const name = document.createElement("span"); name.className = "agent-step-name"; name.textContent = step.label;
        const status = document.createElement("span"); status.className = "agent-step-status";
        const output = document.createElement("pre"); output.className = "agent-step-text";
        summary.append(name, status); details.append(summary, output); $("agentsStepResults").append(details);
      }
      details.dataset.status = step.status;
      details.querySelector(".agent-step-status").textContent = labels[step.status] || step.status;
      details.querySelector(".agent-step-text").textContent = step.result || (step.status === "running" ? "Модель готовит ответ…" : step.status === "cancelled" ? "Этот агент не завершил работу." : "Этот агент запустится в своей очереди.");
    }
    textCount();
  }

  async function poll(id, version) {
    if (version !== epoch) return;
    try {
      const data = await request(`/api/agents/runs/${id}`);
      if (version !== epoch) return;
      renderRun(data.run);
      if (active(data.run)) timer = setTimeout(() => poll(id, version), 1500);
      else { $("agentsCancelRun").disabled = false; message(data.run.error || (data.run.status === "failed" ? "Генерация не завершилась. Проверьте ответы агентов и повторите запуск." : "Можно отредактировать текст и перенести его в календарь."), data.run.status === "failed"); }
    } catch (error) {
      if (version !== epoch) return;
      if (error.status === 404) return loadStatus(true);
      message("Не удалось обновить результат. Повторяем подключение…", true);
      timer = setTimeout(() => poll(id, version), 4000);
    }
  }

  async function loadStatus(restore = false) {
    const version = ++epoch;
    clearTimeout(timer);
    try {
      const data = await request("/api/agents/status");
      if (version !== epoch) return;
      ready = data.available;
      catalog = data.agents;
      if (!hasSelection || restore) { selected = new Set(data.defaultAgents); hasSelection = true; }
      const previousModel = $("agentsModel").value;
      $("agentsModel").replaceChildren();
      for (const model of data.models) { const option = document.createElement("option"); option.value = model.name; option.textContent = model.name; $("agentsModel").append(option); }
      if (!data.models.length) { const option = document.createElement("option"); option.textContent = "Нет доступных моделей"; option.value = ""; $("agentsModel").append(option); }
      $("agentsModel").value = data.models.some((m) => m.name === previousModel) ? previousModel : data.defaultModel;
      $("agentsConnectionStatus").textContent = ready ? "Ollama подключена · бесплатно" : "Ollama недоступна";
      $("agentsConnectionStatus").classList.toggle("active", ready);
      busyElsewhere = data.busy && !active(data.latestRun);
      toggles();
      if (data.latestRun && (!run || restore || active(data.latestRun))) renderRun(data.latestRun, !run || restore);
      if (restore && !data.latestRun) {
        run = null; $("agentsPostText").value = ""; $("agentsStepResults").replaceChildren(); $("agentsOutputCard").classList.add("hidden");
        $("agentsTopic").value = ""; $("agentsBrief").value = ""; $("agentsRunProgress").textContent = "После запуска здесь появятся ответы выбранных агентов и текст поста.";
      }
      message(data.error || (busyElsewhere ? "Для другого бренда идёт генерация. Дождитесь её завершения." : ""), Boolean(data.error));
      controls();
      if (active(run)) timer = setTimeout(() => poll(run.id, version), 1500);
      else if (busyElsewhere) timer = setTimeout(() => loadStatus(), 5000);
    } catch (error) { ready = false; message(error.message, true); controls(); }
  }

  async function start(event) {
    event.preventDefault();
    if (active(run) || starting || !selected.size || !ready) return;
    starting = true;
    controls();
    message("Запускаем выбранных агентов…");
    try {
      const data = await request("/api/agents/runs", "POST", {
        topic: $("agentsTopic").value, brief: $("agentsBrief").value, format: $("agentsFormat").value,
        platform: $("agentsPlatform").value, agentIds: [...selected], model: $("agentsModel").value,
      });
      starting = false;
      const version = ++epoch; clearTimeout(timer); renderRun(data.run);
      $("agentsResults").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      message("Выбранные агенты работают последовательно. Ответы появятся ниже.");
      timer = setTimeout(() => poll(data.run.id, version), 1000);
    } catch (error) { starting = false; message(error.message, true); controls(); }
  }

  window.AutoSocialAgents = {
    init(options) {
      if (initialized) return;
      initialized = true; toCalendar = options.toCalendar;
      $("agentsCreateForm").addEventListener("submit", start);
      $("agentsSelectAll").addEventListener("click", () => { selected = new Set(catalog.map((a) => a.id)); toggles(); });
      $("agentsSelectNone").addEventListener("click", () => { selected.clear(); toggles(); });
      document.querySelectorAll("#view-skills .skills-filter-btn").forEach((button) => button.addEventListener("click", () => {
        filter = button.dataset.filter;
        document.querySelectorAll("#view-skills .skills-filter-btn").forEach((b) => b.classList.toggle("active", b === button));
        toggles();
      }));
      $("agentsCancelRun").addEventListener("click", async () => {
        $("agentsCancelRun").disabled = true;
        try { await request(`/api/agents/runs/${run.id}/cancel`, "POST", {}); message("Останавливаем текущий агент…"); }
        catch (error) { message(error.message, true); $("agentsCancelRun").disabled = false; }
      });
      $("agentsPostText").addEventListener("input", () => { $("agentsDraftStatus").textContent = "Есть несохранённые изменения"; textCount(); });
      $("agentsSaveDraft").addEventListener("click", async () => {
        $("agentsSaveDraft").disabled = true;
        try { const data = await request(`/api/agents/runs/${run.id}`, "PATCH", { postText: $("agentsPostText").value }); run = data.run; $("agentsDraftStatus").textContent = "Изменения сохранены"; }
        catch (error) { message(error.message, true); }
        finally { controls(); }
      });
      $("agentsCopyPost").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText($("agentsPostText").value); $("agentsDraftStatus").textContent = "Текст скопирован"; }
        catch { $("agentsPostText").focus(); $("agentsPostText").select(); $("agentsDraftStatus").textContent = "Выделили текст — нажмите Ctrl+C"; }
      });
      $("agentsToCalendar").addEventListener("click", () => { toCalendar({ postText: $("agentsPostText").value, platform: run.platform }); });
      document.addEventListener("autosocial:accountchange", () => { run = null; loadStatus(true); });
      document.addEventListener("autosocial:viewchange", (event) => { if (event.detail.viewName === "skills" && !active(run)) loadStatus(); });
      $("agentsRefreshModels")?.addEventListener("click", () => loadStatus());
      loadStatus();
    },
  };
})();
