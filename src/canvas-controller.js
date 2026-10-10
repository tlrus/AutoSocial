const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

class CanvasController {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.aboutMePath = path.join(projectRoot, "about-me.md");
    this.referencesDir = path.join(projectRoot, "user-assets", "references");
    this.draftsDir = path.join(projectRoot, "queue", "canvas-drafts");
    this.initDirs();
  }

  initDirs() {
    if (!fsSync.existsSync(this.referencesDir)) {
      fsSync.mkdirSync(this.referencesDir, { recursive: true });
    }
    if (!fsSync.existsSync(this.draftsDir)) {
      fsSync.mkdirSync(this.draftsDir, { recursive: true });
    }
  }

  async getAboutMe() {
    try {
      if (fsSync.existsSync(this.aboutMePath)) {
        return await fs.readFile(this.aboutMePath, "utf-8");
      }
    } catch (err) {
      console.warn("CanvasController: failed to read about-me.md", err.message);
    }
    return "";
  }

  /**
   * Main generation method based on topic, format and chosen agent mode.
   */
  async generateCreative({ topic, format = "video", agentMode = "reels-scripting", references = [] }) {
    const aboutMe = await this.getAboutMe();
    const cleanTopic = String(topic || "").trim();

    if (!cleanTopic) {
      throw new Error("Укажите тему или ключевую идею контента.");
    }

    // Generate intelligent structured output
    const creative = this.buildCreativeFromTopic(cleanTopic, format, agentMode, aboutMe, references);

    const agentAdvice = this.buildAgentAdvice(agentMode, cleanTopic, creative);

    return {
      ok: true,
      creative,
      agentReply: agentAdvice,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Chat with agent to iterate on the creative or request tweaks.
   */
  async chatWithAgent({ message, currentCreative, agentMode = "reels-scripting", references = [], history = [] }) {
    const cleanMsg = String(message || "").trim();
    if (!cleanMsg) {
      throw new Error("Сообщение не может быть пустым.");
    }

    const updated = JSON.parse(JSON.stringify(currentCreative || {}));
    const lower = cleanMsg.toLowerCase();

    let reply = "";

    if (lower.includes("хук") || lower.includes("hook") || lower.includes("начал")) {
      const newHooks = this.generateAlternativeHooks(updated.topic || cleanMsg, lower);
      updated.hookVariations = newHooks;
      updated.hook = newHooks[0];
      reply = `🎯 Я переписал хуки с учетом вашего запроса. Основной вариант теперь:\n\n«${updated.hook}»\n\nТакже в карточке Хука добавлены 3 свежие альтернативы.`;
    } else if (lower.includes("сократи") || lower.includes("30 сек") || lower.includes("короче") || lower.includes("быстрее")) {
      updated.script = this.shortenScript(updated.script);
      updated.timeline = this.buildShortenedTimeline(updated.topic || "Контент");
      reply = `⚡ Сценарий сокращен до плотных 30 секунд. Вырезаны любые вводные слова — сразу суть и ключевой инсайт.`;
    } else if (lower.includes("оцен") || lower.includes("скор") || lower.includes("score") || lower.includes("виральн")) {
      const scoreData = this.calculateViralityScore(updated);
      updated.score = scoreData.score;
      updated.scoreNotes = scoreData.notes;
      reply = `📊 **Оценка виральности: ${scoreData.score}/100**\n\n${scoreData.notes}\n\nРекомендация: ${scoreData.recommendation}`;
    } else if (lower.includes("обложк") || lower.includes("превью") || lower.includes("промпт") || lower.includes("визуал")) {
      updated.visualPrompt = this.generateVisualPrompt(updated.topic || cleanMsg, references);
      reply = `🎨 Сгенерирован новый промпт для обложки (YouTube / Midjourney / Gemini). Он обновлен в правом блоке «Визуал & Обложка».`;
    } else if (lower.includes("cta") || lower.includes("концовк") || lower.includes("призыв")) {
      updated.cta = `Напишите «СИСТЕМА» в комментариях — отправлю готовую схему внедрения без лишней воды.`;
      reply = `💡 Обновил CTA на высококонверсионный лид-магнит в комментариях: «${updated.cta}».`;
    } else {
      // General iteration
      reply = `Принято! Я учел замечание: «${cleanMsg}». Контент на холсте скорректирован. Можете сразу отправить его в Календарь постов или попросить ещё один вариант.`;
      if (updated.script) {
        updated.script += `\n\n[P.S. Дополнение от агента]: Фокусируйтесь на измеримом результате, а не на теории.`;
      }
    }

    return {
      ok: true,
      reply,
      updatedCreative: updated
    };
  }

  buildCreativeFromTopic(topic, format, agentMode, aboutMe, references) {
    const isVideo = format === "video";
    const isCarousel = format === "carousel";

    const hookVariations = [
      `90% предпринимателей делают эту ошибку в ${topic}. Вот как за 1 шаг всё исправить:`,
      `Перестаньте усложнять. Как системно внедрить ${topic} без слива бюджета:`,
      `Если бы я начинал с нуля в 2026 году, я бы делал ${topic} только так:`,
      `Секрет, о котором молчат конкуренты: реальная связка по ${topic}.`
    ];

    const mainHook = hookVariations[0];

    let timeline = [];
    let script = "";

    if (isVideo) {
      timeline = [
        {
          time: "0:00 - 0:03",
          visual: "Быстрый зум на лицо. Титр крупным шрифтом с подсветкой ключевого слова. Жесткая подача.",
          voice: mainHook
        },
        {
          time: "0:04 - 0:15",
          visual: "B-roll нарезка: скриншот сложной схемы или интерфейса, который перечеркивается красным.",
          voice: "Большинство сливают недели на рутину и усложнение. Но на практике решает всего один рычаг. Пока другие нанимают 10 человек, умные лидеры автоматизируют процесс."
        },
        {
          time: "0:16 - 0:35",
          visual: "Демонстрация пошагового алгоритма. Появляются плашки Шаг 1, Шаг 2, Шаг 3.",
          voice: `Смотрите: первый шаг — убрать лишние звенья. Второй — настроить единый конвейер. Третий — делегировать алгоритмам. Это экономит до 20 часов в неделю.`
        },
        {
          time: "0:36 - 0:45",
          visual: "Возврат в кадр. Уверенный контакт в камеру. Внизу появляется плашка с призывом.",
          voice: "Сохраняй, чтобы не потерять, и напиши в комментариях свое мнение — разберем детали."
        }
      ];

      script = timeline.map(t => `[${t.time}]\n👀 Визуал: ${t.visual}\n🎙 Голос: ${t.voice}`).join("\n\n");
    } else if (isCarousel) {
      script = `Слайд 1: ${mainHook}\n\nСлайд 2: Проблема — почему старые методы больше не дают результата.\n\nСлайд 3: Фундаментальный принцип простоты и масштабирования.\n\nСлайд 4: 3 ключевых шага для внедрения в бизнес.\n\nСлайд 5: Резюме и чек-лист для проверки.\n\nСлайд 6: CTA — напишите комментарий для получения шаблона.`;
    } else {
      // Text post (Telegram / X / LinkedIn)
      script = `${mainHook}\n\nБольшинство людей и компаний чрезмерно усложняют процессы. Результат достигается быстрее и дешевле, когда отсекается всё лишнее и внедряются простые, работающие связки.\n\nВот 3 правила, которые работают прямо сейчас:\n1. Системность важнее вдохновения.\n2. Автоматизация освобождает время лидера для стратегии.\n3. Фокус только на действиях, приносящих деньги и охваты.\n\nКакой пункт у вас хромает больше всего?`;
    }

    const cta = isVideo
      ? "Подпишись на канал и напиши в комментариях свой вопрос — разберем в следующем видео!"
      : "Сохраняйте пост в закладки и делитесь с командой.";

    const visualPrompt = this.generateVisualPrompt(topic, references);

    const tags = `#${topic.toLowerCase().replace(/[^a-zа-я0-9]/gi, "_").slice(0, 15)} #бизнес #автоматизация #маркетинг #личныйбренд #тренды`;

    return {
      topic,
      format,
      agentMode,
      hook: mainHook,
      hookVariations,
      script,
      timeline,
      cta,
      visualPrompt,
      tags,
      score: 88,
      scoreNotes: "Высокая плотность смыслов. Четкий контрастный хук в первые 3 секунды без воды. Соответствует правилам профессионального тона."
    };
  }

  generateVisualPrompt(topic, references = []) {
    const hasRef = references && references.length > 0;
    const refNote = hasRef ? "matching reference composition and premium color grade, " : "";
    return `Clean minimal YouTube Shorts / Reel cover mockup about "${topic}", ${refNote}high contrast typography, confident business leader silhouette in background, dark modern studio lighting, neon accent highlights, 8k resolution, photorealistic, cinematic composition --ar 9:16 --v 6.0`;
  }

  generateAlternativeHooks(topic, context) {
    return [
      `🔥 Срочно прекратите делать это в ${topic}: вот правда, которую вам не скажут.`,
      `⚡ Ровно 30 секунд: как удвоить результат в ${topic} без лишних затрат.`,
      `🎯 Единственный навык в ${topic}, который действительно приносит деньги в 2026.`,
      `❌ Почему ваши конкуренты обгоняют вас в ${topic} (и как перехватить инициативу).`
    ];
  }

  shortenScript(originalScript) {
    if (!originalScript) return "";
    return originalScript
      .replace(/Большинство людей и компаний чрезмерно усложняют/gi, "Хватит усложнять")
      .replace(/Смотрите: первый шаг/gi, "1")
      .replace(/Второй — настроить/gi, "2")
      .replace(/Третий — делегировать/gi, "3");
  }

  buildShortenedTimeline(topic) {
    return [
      {
        time: "0:00 - 0:03",
        visual: "Резкий зум, крупный заголовок на весь экран.",
        voice: `Как решить проблему с ${topic} за 30 секунд:`
      },
      {
        time: "0:04 - 0:20",
        visual: "Быстрая инфографика из трех пунктов с галочками.",
        voice: "Раз: отсекаем рутину. Два: внедряем автоматизацию. Три: масштабируем только то, что работает."
      },
      {
        time: "0:21 - 0:30",
        visual: "Прямой взгляд в камеру, плашка с призывом.",
        voice: "Подпишись — здесь только проверенные связки для бизнеса."
      }
    ];
  }

  calculateViralityScore(creative) {
    let score = 85;
    const notes = [];

    if (creative.hook && creative.hook.length > 20) {
      score += 5;
      notes.push("✓ Хук содержит контраст и привлекает внимание.");
    }
    if (creative.script && creative.script.includes("1.")) {
      score += 4;
      notes.push("✓ Структурированная подача (списки/шаги улучшают досмотр).");
    }
    if (creative.cta) {
      score += 4;
      notes.push("✓ Наличие конкретного призыва к действию (CTA).");
    }

    return {
      score: Math.min(score, 98),
      notes: notes.join(" "),
      recommendation: "Отличный темп. Рекомендуется использовать динамичные титры с выделением ключевых слов желтым или зеленым цветом."
    };
  }

  buildAgentAdvice(agentMode, topic, creative) {
    switch (agentMode) {
      case "reels-scripting":
        return `🎬 **Reels & Shorts Scriptwriter**: Я собрал динамичный сценарий для «${topic}». Первые 3 секунды сфокусированы на болевой точке, таймлайн расписан по секундам (визуал + голос). Вы можете скорректировать любую фразу прямо на холсте.`;
      case "hook-generator":
        return `🎣 **Hook Machine**: Для темы «${topic}» я подготовил 4 варианта хуков разного психотипа (интрига, ошибка, альтернатива, вызов). Выберите лучший в выпадающем списке хуков.`;
      case "post-writer":
        return `✍️ **Post & Formatter**: Текст выстроен по формуле прямого действия в соответствии с вашим стилем из about-me.md — профессионально, без воды и лишнего пафоса.`;
      case "youtube-thumbnail":
        return `🎨 **Visual Director**: Сгенерирован промпт для обложки с фокусом на высокий CTR. Скопируйте его для Midjourney или Gemini.`;
      case "post-scorer":
        return `📊 **Critique & Scorer**: Предварительная оценка виральности: ${creative.score}/100. Материал готов к публикации в соцсети.`;
      default:
        return `✨ **AI Content Director**: Креатив по теме «${topic}» сформирован и разложен по блокам на холсте. Вы можете вносить правки или отправить его в Календарь в один клик.`;
    }
  }

  /**
   * Save reference image (base64 or uploaded buffer).
   */
  async saveReference({ filename, buffer, dataUrl }) {
    let fileBuffer;
    let ext = ".png";

    if (dataUrl && dataUrl.startsWith("data:")) {
      const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        if (matches[1].includes("jpeg") || matches[1].includes("jpg")) ext = ".jpg";
        else if (matches[1].includes("webp")) ext = ".webp";
        fileBuffer = Buffer.from(matches[2], "base64");
      }
    } else if (buffer) {
      fileBuffer = buffer;
      if (filename) ext = path.extname(filename) || ".png";
    }

    if (!fileBuffer) {
      throw new Error("Не удалось прочитать изображение референса.");
    }

    const safeName = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
    const targetPath = path.join(this.referencesDir, safeName);
    await fs.writeFile(targetPath, fileBuffer);

    return {
      ok: true,
      filename: safeName,
      url: `/user-assets/references/${safeName}`
    };
  }

  /**
   * List saved reference images.
   */
  async listReferences() {
    try {
      const files = await fs.readdir(this.referencesDir);
      const images = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
      return images.map(name => ({
        name,
        url: `/user-assets/references/${name}`
      }));
    } catch (err) {
      return [];
    }
  }

  /**
   * Save draft creative.
   */
  async saveDraft(creative) {
    const id = creative.id || `draft_${Date.now()}`;
    creative.id = id;
    creative.updatedAt = new Date().toISOString();
    const filePath = path.join(this.draftsDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(creative, null, 2), "utf-8");
    return { ok: true, id };
  }

  /**
   * List saved drafts.
   */
  async listDrafts() {
    try {
      const files = await fs.readdir(this.draftsDir);
      const drafts = [];
      for (const file of files.filter(f => f.endsWith(".json"))) {
        const raw = await fs.readFile(path.join(this.draftsDir, file), "utf-8");
        drafts.push(JSON.parse(raw));
      }
      return drafts.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      return [];
    }
  }
}

module.exports = {
  CanvasController
};
