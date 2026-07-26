import type { Client } from "discord.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { getGuildSettings } from "./db.js";
import { isGuildTextChannel, publishSchedulePoll } from "./pollService.js";
import { REMINDER_CHOICES, normalizeReminderMinutes } from "./reminders.js";
import { consumeWebSession, getWebSession } from "./webSessions.js";

type CreatePollRequest = {
  title?: string;
  selectedDates?: string[];
  candidateStartTime?: string;
  candidateEndTime?: string;
  deadlineDate?: string;
  deadlineTime?: string;
  reminderMinutes?: number[];
  initialNotifyRoleId?: string | null;
  reminderNotifyRoleId?: string | null;
  resultNotifyRoleId?: string | null;
  eventNotifyRoleId?: string | null;
};

type PublishErrorResult = { ok: false; statusCode: number; message: string };

export function startWebServer(client: Client): void {
  const server = createServer((request, response) => {
    void handleRequest(client, request, response).catch((error) => {
      console.error("web server request failed", error);
      sendJson(response, 500, { ok: false, message: "サーバーエラーが発生しました。" });
    });
  });

  server.listen(config.webPort, config.webHost, () => {
    console.log(`Schedule web UI listening on ${config.webBaseUrl}`);
  });
}

async function handleRequest(client: Client, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", config.webBaseUrl);

  if (request.method === "GET" && url.pathname === "/schedule/new") {
    const token = url.searchParams.get("token") ?? "";
    const session = await getWebSession(token);
    if (!session) {
      sendHtml(response, 404, renderExpiredPage());
      return;
    }

    const guild = await client.guilds.fetch(session.guildId).catch(() => null);
    const roles = guild
      ? [...(await guild.roles.fetch().catch(() => new Map())).values()]
          .filter((role) => role && role.id !== guild.id && role.mentionable && !role.managed)
          .map((role) => ({ id: role!.id, name: role!.name }))
          .sort((a, b) => a.name.localeCompare(b.name, "ja"))
      : [];
    const settings = await getGuildSettings(session.guildId);
    sendHtml(response, 200, renderCreatePage(token, roles, {
      initial: settings.defaultInitialNotifyRoleId,
      reminder: settings.defaultReminderNotifyRoleId,
      result: settings.defaultResultNotifyRoleId,
      event: settings.defaultEventNotifyRoleId
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/schedule/new") {
    const token = url.searchParams.get("token") ?? "";
    const session = await getWebSession(token);
    if (!session) {
      sendJson(response, 404, { ok: false, message: "リンクの有効期限が切れています。Discordから作成画面を開き直してください。" });
      return;
    }

    const body = await readJsonBody<CreatePollRequest>(request);
    const title = (body.title ?? "").trim();
    const selectedDates = Array.isArray(body.selectedDates) ? body.selectedDates : [];
    const candidateStartTime = (body.candidateStartTime ?? "").trim();
    const candidateEndTime = (body.candidateEndTime ?? "").trim();
    const deadlineDate = (body.deadlineDate ?? "").trim();
    const deadlineTime = (body.deadlineTime ?? "").trim();
    const reminderMinutes = normalizeReminderMinutes(
      body.reminderMinutes,
      new Set(REMINDER_CHOICES.map((choice) => choice.minutes))
    );
    const requestedRoleIds = {
      initial: body.initialNotifyRoleId || null,
      reminder: body.reminderNotifyRoleId || null,
      result: body.resultNotifyRoleId || null,
      event: body.eventNotifyRoleId || null
    };

    if (!title || title.length > 100) {
      sendJson(response, 400, { ok: false, message: "タイトルを100文字以内で入力してください。" });
      return;
    }
    if (selectedDates.some((date) => typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
        new Set(selectedDates).size !== selectedDates.length) {
      sendJson(response, 400, { ok: false, message: "候補日の形式が正しくありません。" });
      return;
    }
    if (selectedDates.length === 0) {
      sendJson(response, 400, { ok: false, message: "候補日を1つ以上選択してください。" });
      return;
    }
    if (selectedDates.length > 10) {
      sendJson(response, 400, { ok: false, message: "候補日は最大10件までです。" });
      return;
    }
    if (!candidateStartTime || !candidateEndTime || !deadlineDate || !deadlineTime) {
      sendJson(response, 400, { ok: false, message: "候補時間と締切を入力してください。" });
      return;
    }
    if (candidateEndTime <= candidateStartTime) {
      sendJson(response, 400, { ok: false, message: "終了時間は開始時間より後にしてください。" });
      return;
    }
    if (reminderMinutes.length === 0) {
      sendJson(response, 400, { ok: false, message: "リマインド時間を1つ以上選択してください。" });
      return;
    }

    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!isGuildTextChannel(channel) || channel.guild.id !== session.guildId) {
      sendJson(response, 400, { ok: false, message: "投稿先チャンネルを確認できませんでした。" });
      return;
    }
    const guildRoles = await channel.guild.roles.fetch();
    const validateRole = (roleId: string | null): string | null => {
      if (!roleId) return null;
      const role = guildRoles.get(roleId);
      return role && role.guild.id === session.guildId && role.mentionable && !role.managed ? role.id : null;
    };
    const validatedRoles = {
      initial: validateRole(requestedRoleIds.initial),
      reminder: validateRole(requestedRoleIds.reminder),
      result: validateRole(requestedRoleIds.result),
      event: validateRole(requestedRoleIds.event)
    };
    if (Object.entries(requestedRoleIds).some(([key, value]) => value && validatedRoles[key as keyof typeof validatedRoles] !== value)) {
      sendJson(response, 400, { ok: false, message: "選択された通知ロールを利用できません。画面を開き直してください。" });
      return;
    }

    const datesInput = [...selectedDates].sort().map((date) => `${date} ${candidateStartTime}`).join("\n");
    const deadlineInput = `${deadlineDate} ${deadlineTime}`;
    const result = await publishSchedulePoll(channel, {
      guildId: session.guildId,
      channelId: session.channelId,
      creatorId: session.creatorId,
      title,
      datesInput,
      deadlineInput,
      candidateEndTime,
      reminderMinutes,
      notifyTarget: validatedRoles.result ? `<@&${validatedRoles.result}>` : null,
      initialNotifyRoleId: validatedRoles.initial,
      reminderNotifyRoleId: validatedRoles.reminder,
      eventNotifyRoleId: validatedRoles.event,
      anonymous: false
    }).catch((error) => {
      const formatted = formatPublishError(error);
      console.error("schedule publish failed", { guildId: session.guildId, channelId: session.channelId }, error);
      return formatted;
    });

    if (isPublishErrorResult(result)) {
      sendJson(response, result.statusCode, { ok: false, message: result.message });
      return;
    }

    await consumeWebSession(token);
    sendJson(response, 200, { ok: true, messageUrl: result.messageUrl, pollId: result.pollId });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    sendHtml(response, 200, renderIndexPage(), request.method === "HEAD");
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/healthz") {
    logHealthCheck(request, url.pathname, 200);
    sendJson(response, 200, { ok: true }, request.method === "HEAD");
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/readyz") {
    const ready = client.isReady();
    logHealthCheck(request, url.pathname, ready ? 200 : 503);
    sendJson(response, ready ? 200 : 503, { ok: ready, discordReady: ready }, request.method === "HEAD");
    return;
  }

  sendHtml(response, 404, renderNotFoundPage());
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 64_000) {
        request.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendHtml(response: ServerResponse, statusCode: number, html: string, headOnly = false): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(headOnly ? undefined : html);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headOnly = false): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(headOnly ? undefined : JSON.stringify(body));
}

function logHealthCheck(request: IncomingMessage, path: string, statusCode: number): void {
  const userAgent = request.headers["user-agent"] ?? "";
  const forwardedFor = request.headers["x-forwarded-for"] ?? "";
  console.log(`health check ${request.method} ${path} ${statusCode} ua="${userAgent}" forwarded="${forwardedFor}"`);
}

function isPublishErrorResult(result: unknown): result is PublishErrorResult {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function formatPublishError(error: unknown): PublishErrorResult {
  const rawMessage = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";

  if (["50001", "50013"].includes(code) || /Missing (Access|Permissions)/i.test(rawMessage)) {
    return {
      ok: false,
      statusCode: 500,
      message: "Discordへの投稿に失敗しました。BOTに「メッセージ送信」「リアクション追加」「メッセージ履歴を読む」の権限があるか確認してください。"
    };
  }

  if (["締切日時", "候補日", "最大10件", "締切は現在より後"].some((text) => rawMessage.includes(text))) {
    return { ok: false, statusCode: 400, message: rawMessage };
  }

  return {
    ok: false,
    statusCode: 500,
    message: rawMessage ? `Discordへの投稿に失敗しました: ${rawMessage}` : "Discordへの投稿に失敗しました。"
  };
}

function renderIndexPage(): string {
  return renderShell("Schedule Bot", `<main class="narrow"><h1>Schedule Bot</h1><p>Discordで <code>/schedule</code> を実行して作成画面を開いてください。</p></main>`);
}

function renderExpiredPage(): string {
  return renderShell("リンク期限切れ", `<main class="narrow"><h1>リンクの有効期限が切れています</h1><p>Discordで <code>/schedule</code> を実行し直してください。</p></main>`);
}

function renderNotFoundPage(): string {
  return renderShell("Not Found", `<main class="narrow"><h1>Not Found</h1><p>ページが見つかりません。</p></main>`);
}

function renderCreatePage(
  token: string,
  roles: { id: string; name: string }[],
  defaults: { initial: string | null; reminder: string | null; result: string | null; event: string | null }
): string {
  const reminderChoicesJson = JSON.stringify(REMINDER_CHOICES);
  const rolesJson = JSON.stringify(roles);
  const roleOptions = (selected: string | null) =>
    `<option value="">メンションなし</option>${roles.map((role) =>
      `<option value="${escapeHtml(role.id)}"${role.id === selected ? " selected" : ""}>@${escapeHtml(role.name)}</option>`
    ).join("")}`;

  return renderShell(
    "日程調整を作成",
    `
      <main>
        <form id="scheduleForm" class="layout">
          <section class="panel form-panel">
            <h1>日程調整を作成</h1>

            <label>
              タイトル
              <input id="title" name="title" type="text" maxlength="100" placeholder="定例会" required>
            </label>

            <div class="two-col">
              <label>
                開始時間
                <input id="candidateStartTime" name="candidateStartTime" type="time" value="13:00" required>
              </label>
              <label>
                終了時間
                <input id="candidateEndTime" name="candidateEndTime" type="time" value="18:00" required>
              </label>
            </div>

            <div class="two-col">
              <label>
                締切日
                <input id="deadlineDate" name="deadlineDate" type="date" required>
              </label>
              <label>
                締切時間
                <input id="deadlineTime" name="deadlineTime" type="time" value="23:59" required>
              </label>
            </div>

            <section class="reminder-section">
              <h2>リマインド設定</h2>
              <div id="reminderList" class="reminder-list"></div>
              <button type="button" id="addReminderButton" class="secondary-button">＋追加</button>
            </section>

            <section class="reminder-section">
              <h2>通知先</h2>
              <label>初回投稿<select id="initialNotifyRoleId">${roleOptions(defaults.initial)}</select></label>
              <label>締切前リマインド<select id="reminderNotifyRoleId">${roleOptions(defaults.reminder)}</select></label>
              <label>締切・集計結果<select id="resultNotifyRoleId">${roleOptions(defaults.result)}</select></label>
              <label>開催情報<select id="eventNotifyRoleId">${roleOptions(defaults.event)}</select></label>
              <p class="hint">通知可能として設定されたロールだけを表示しています。</p>
            </section>

            <div class="actions">
              <button type="submit" id="submitButton">Discordに投稿</button>
              <span id="status" role="status"></span>
            </div>
          </section>

          <section class="panel calendar-panel">
            <div class="calendar-head">
              <button type="button" id="prevMonth" class="icon-button" aria-label="前の月">‹</button>
              <h2 id="monthLabel"></h2>
              <button type="button" id="nextMonth" class="icon-button" aria-label="次の月">›</button>
            </div>
            <div class="weekdays">
              <span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span>
            </div>
            <div id="calendarGrid" class="calendar-grid"></div>
          </section>

          <section class="panel preview-panel">
            <h2>候補日</h2>
            <p id="selectedCount">0 / 10</p>
            <ol id="previewList"></ol>
          </section>
        </form>
      </main>

      <script>
        const token = ${JSON.stringify(token)};
        const reminderChoices = ${reminderChoicesJson};
        const availableRoles = ${rolesJson};
        const selectedDates = new Set();
        const cursor = new Date();
        cursor.setDate(1);

        const titleInput = document.getElementById("title");
        const candidateStartTimeInput = document.getElementById("candidateStartTime");
        const candidateEndTimeInput = document.getElementById("candidateEndTime");
        const deadlineDateInput = document.getElementById("deadlineDate");
        const deadlineTimeInput = document.getElementById("deadlineTime");
        const monthLabel = document.getElementById("monthLabel");
        const calendarGrid = document.getElementById("calendarGrid");
        const previewList = document.getElementById("previewList");
        const selectedCount = document.getElementById("selectedCount");
        const status = document.getElementById("status");
        const submitButton = document.getElementById("submitButton");
        const reminderList = document.getElementById("reminderList");
        const addReminderButton = document.getElementById("addReminderButton");

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        deadlineDateInput.value = toDateKey(tomorrow);

        document.getElementById("prevMonth").addEventListener("click", () => {
          cursor.setMonth(cursor.getMonth() - 1);
          renderCalendar();
        });
        document.getElementById("nextMonth").addEventListener("click", () => {
          cursor.setMonth(cursor.getMonth() + 1);
          renderCalendar();
        });
        candidateStartTimeInput.addEventListener("input", renderPreview);
        candidateEndTimeInput.addEventListener("input", renderPreview);
        addReminderButton.addEventListener("click", () => addReminderRow(nextReminderValue()));

        document.getElementById("scheduleForm").addEventListener("submit", async (event) => {
          event.preventDefault();
          status.textContent = "";

          const selected = [...selectedDates].sort();
          if (selected.length === 0) {
            status.textContent = "候補日を選択してください。";
            return;
          }
          if (selected.length > 10) {
            status.textContent = "候補日は最大10件までです。";
            return;
          }
          if (isDeadlinePastOrNow()) {
            status.textContent = "締切は現在より後の日時にしてください。";
            return;
          }
          const reminderMinutes = getReminderMinutes();
          if (reminderMinutes.length === 0) {
            status.textContent = "リマインド時間を1つ以上選択してください。";
            return;
          }

          submitButton.disabled = true;
          status.textContent = "投稿しています...";

          try {
            const response = await fetch("/api/schedule/new?token=" + encodeURIComponent(token), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: titleInput.value,
                selectedDates: selected,
                candidateStartTime: candidateStartTimeInput.value,
                candidateEndTime: candidateEndTimeInput.value,
                deadlineDate: deadlineDateInput.value,
                deadlineTime: deadlineTimeInput.value,
                reminderMinutes
                ,initialNotifyRoleId: document.getElementById("initialNotifyRoleId").value || null
                ,reminderNotifyRoleId: document.getElementById("reminderNotifyRoleId").value || null
                ,resultNotifyRoleId: document.getElementById("resultNotifyRoleId").value || null
                ,eventNotifyRoleId: document.getElementById("eventNotifyRoleId").value || null
              })
            });
            const result = await response.json();
            if (!response.ok || !result.ok) {
              throw new Error(result.message || "投稿に失敗しました。");
            }
            status.innerHTML = '<a href="' + escapeHtml(result.messageUrl) + '" target="_blank" rel="noreferrer">Discordで開く</a>';
            submitButton.textContent = "投稿済み";
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : "投稿に失敗しました。";
            submitButton.disabled = false;
          }
        });

        function renderCalendar() {
          calendarGrid.innerHTML = "";
          const year = cursor.getFullYear();
          const month = cursor.getMonth();
          monthLabel.textContent = year + "年" + String(month + 1).padStart(2, "0") + "月";

          const firstDay = new Date(year, month, 1).getDay();
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          for (let i = 0; i < firstDay; i += 1) {
            const spacer = document.createElement("span");
            spacer.className = "day empty";
            calendarGrid.appendChild(spacer);
          }

          for (let day = 1; day <= daysInMonth; day += 1) {
            const key = toDateKey(new Date(year, month, day));
            const button = document.createElement("button");
            button.type = "button";
            button.className = selectedDates.has(key) ? "day selected" : "day";
            button.textContent = String(day);
            button.addEventListener("click", () => {
              if (selectedDates.has(key)) {
                selectedDates.delete(key);
              } else if (selectedDates.size < 10) {
                selectedDates.add(key);
              }
              renderCalendar();
              renderPreview();
            });
            calendarGrid.appendChild(button);
          }
        }

        function renderPreview() {
          const startTime = candidateStartTimeInput.value || "--:--";
          const endTime = candidateEndTimeInput.value || "--:--";
          const selected = [...selectedDates].sort();
          selectedCount.textContent = selected.length + " / 10";
          previewList.innerHTML = "";
          for (const date of selected) {
            const item = document.createElement("li");
            item.textContent = date + " " + startTime + "-" + endTime;
            previewList.appendChild(item);
          }
        }

        function toDateKey(date) {
          return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
        }

        function isDeadlinePastOrNow() {
          const deadlineDate = deadlineDateInput.value;
          const deadlineTime = deadlineTimeInput.value;
          if (!deadlineDate || !deadlineTime) {
            return false;
          }
          return new Date(deadlineDate + "T" + deadlineTime).getTime() <= Date.now();
        }

        function addReminderRow(value) {
          const row = document.createElement("div");
          row.className = "reminder-row";

          const label = document.createElement("label");
          label.textContent = "リマインド時間";

          const select = document.createElement("select");
          select.className = "reminderSelect";
          for (const choice of reminderChoices) {
            const option = document.createElement("option");
            option.value = String(choice.minutes);
            option.textContent = choice.label;
            select.appendChild(option);
          }
          select.value = String(value || reminderChoices[0].minutes);
          select.addEventListener("change", syncReminderRows);

          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "remove-reminder-button";
          removeButton.setAttribute("aria-label", "リマインド時間を削除");
          removeButton.textContent = "×";
          removeButton.addEventListener("click", () => {
            row.remove();
            syncReminderRows();
          });

          label.appendChild(select);
          row.appendChild(label);
          row.appendChild(removeButton);
          reminderList.appendChild(row);
          syncReminderRows();
        }

        function syncReminderRows() {
          const rows = [...reminderList.querySelectorAll(".reminder-row")];
          for (const row of rows) {
            const removeButton = row.querySelector(".remove-reminder-button");
            removeButton.hidden = rows.length <= 1;
          }
          addReminderButton.disabled = getReminderMinutes().length >= reminderChoices.length;
        }

        function getReminderMinutes() {
          const values = [...reminderList.querySelectorAll(".reminderSelect")]
            .map((select) => Number(select.value))
            .filter((value) => Number.isFinite(value) && value > 0);
          return [...new Set(values)].sort((a, b) => b - a);
        }

        function nextReminderValue() {
          const selected = new Set(getReminderMinutes());
          return reminderChoices.find((choice) => !selected.has(choice.minutes))?.minutes || reminderChoices[0].minutes;
        }

        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
        }

        addReminderRow();
        renderCalendar();
        renderPreview();
      </script>
    `
  );
}

function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2328;
      --muted: #667085;
      --line: #d8dee8;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --ok: #15803d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: var(--bg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(1120px, calc(100vw - 32px)); margin: 32px auto; }
    main.narrow { width: min(680px, calc(100vw - 32px)); }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; line-height: 1.25; }
    h2 { font-size: 18px; line-height: 1.3; }
    .layout {
      display: grid;
      grid-template-columns: 320px minmax(360px, 1fr) 280px;
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .form-panel { display: grid; gap: 16px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; color: var(--muted); }
    input,
    select {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    input:focus,
    select:focus {
      outline: 2px solid var(--accent-soft);
      border-color: var(--accent);
    }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .reminder-section {
      display: grid;
      gap: 10px;
      padding-top: 2px;
    }
    .reminder-section h2 { font-size: 15px; }
    .reminder-list { display: grid; gap: 8px; }
    .reminder-row {
      display: grid;
      grid-template-columns: 1fr 40px;
      gap: 8px;
      align-items: end;
    }
    .actions { display: flex; align-items: center; gap: 12px; min-height: 40px; }
    button {
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: var(--accent);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { cursor: default; opacity: 0.65; }
    button[type="submit"] { height: 40px; padding: 0 16px; }
    .secondary-button {
      justify-self: start;
      height: 36px;
      padding: 0 12px;
      color: var(--accent);
      background: var(--accent-soft);
    }
    .remove-reminder-button {
      width: 40px;
      height: 40px;
      color: var(--muted);
      background: #eef2f7;
      font-size: 20px;
      line-height: 1;
    }
    #status { color: var(--muted); font-size: 14px; }
    .hint { color: var(--muted); font-size: 12px; }
    #status a { color: var(--accent); font-weight: 700; }
    .calendar-head {
      display: grid;
      grid-template-columns: 40px 1fr 40px;
      gap: 8px;
      align-items: center;
      margin-bottom: 14px;
    }
    .calendar-head h2 { text-align: center; }
    .icon-button {
      width: 40px;
      height: 40px;
      color: var(--text);
      background: #eef2f7;
      font-size: 24px;
      line-height: 1;
    }
    .weekdays, .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 6px;
    }
    .weekdays {
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-align: center;
    }
    .day {
      aspect-ratio: 1;
      min-width: 0;
      color: var(--text);
      background: #f1f4f8;
      border: 1px solid transparent;
      border-radius: 6px;
      font-weight: 700;
    }
    .day.empty { background: transparent; border: 0; }
    .day.selected {
      color: #fff;
      background: var(--ok);
    }
    .preview-panel { display: grid; gap: 10px; }
    #selectedCount { color: var(--muted); font-size: 13px; }
    ol { margin: 0; padding-left: 22px; }
    li { padding: 5px 0; font-variant-numeric: tabular-nums; }
    code {
      padding: 2px 5px;
      border-radius: 4px;
      background: #eef2f7;
    }
    @media (max-width: 920px) {
      .layout { grid-template-columns: 1fr; }
      main { margin: 16px auto; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return map[char] ?? char;
  });
}
