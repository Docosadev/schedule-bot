import type { Client } from "discord.js";
import { getOpenPolls } from "./db.js";
import { checkDuePolls, checkReminders } from "./pollService.js";
import { parseReminderMinutesJson } from "./reminders.js";
import { registerPollScheduleRefresh } from "./schedulerHooks.js";
import type { PollWithOptions } from "./types.js";

const RECONCILIATION_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const REFRESH_DEBOUNCE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_000_000;

let actionTimer: NodeJS.Timeout | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let running = false;
let refreshAfterRun = false;
let channelsFetch: ((channelId: string) => Promise<unknown>) | null = null;

export async function startPollScheduler(client: Client): Promise<void> {
  channelsFetch = (channelId) => client.channels.fetch(channelId);
  registerPollScheduleRefresh(queuePollScheduleRefresh);
  await refreshPollSchedule();

  reconciliationTimer = setInterval(() => {
    queuePollScheduleRefresh();
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
}

export function queuePollScheduleRefresh(): void {
  if (running) {
    refreshAfterRun = true;
    return;
  }
  if (refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshPollSchedule();
  }, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref();
}

async function refreshPollSchedule(): Promise<void> {
  if (running) {
    refreshAfterRun = true;
    return;
  }
  running = true;
  try {
    scheduleNextAction(await getOpenPolls());
  } catch (error) {
    console.error("poll schedule refresh failed", error);
    scheduleRetry();
  } finally {
    running = false;
    runDeferredRefresh();
  }
}

async function runPollMaintenance(): Promise<void> {
  if (!channelsFetch) {
    return;
  }
  if (running) {
    refreshAfterRun = true;
    return;
  }
  running = true;
  try {
    await checkDuePolls(channelsFetch);
    await checkReminders(channelsFetch);
    scheduleNextAction(await getOpenPolls());
  } catch (error) {
    console.error("scheduled poll maintenance failed", error);
    scheduleRetry();
  } finally {
    running = false;
    runDeferredRefresh();
  }
}

function scheduleNextAction(polls: PollWithOptions[]): void {
  clearActionTimer();
  const nextActionAt = findNextActionAt(polls, Date.now());
  if (nextActionAt === null) {
    console.log("poll scheduler idle: no open polls");
    return;
  }

  const delay = Math.max(0, Math.min(nextActionAt - Date.now(), MAX_TIMEOUT_MS));
  actionTimer = setTimeout(() => {
    actionTimer = null;
    void runPollMaintenance();
  }, delay);
  actionTimer.unref();
  console.log(`poll scheduler next run: ${new Date(Date.now() + delay).toISOString()}`);
}

function findNextActionAt(polls: PollWithOptions[], now: number): number | null {
  let nextActionAt: number | null = null;
  for (const poll of polls) {
    const deadline = new Date(poll.deadline).getTime();
    if (!Number.isFinite(deadline)) {
      continue;
    }
    nextActionAt = earlier(nextActionAt, Math.max(now, deadline));

    const createdAt = new Date(poll.createdAt).getTime();
    const reminded = new Set(parseReminderMinutesJson(poll.remindedMinutes, []));
    for (const minutes of parseReminderMinutesJson(poll.reminderMinutes)) {
      const reminderAt = deadline - minutes * 60_000;
      const pollExistedBeforeReminder = Number.isFinite(createdAt) && deadline - createdAt >= minutes * 60_000;
      if (pollExistedBeforeReminder && !reminded.has(minutes)) {
        nextActionAt = earlier(nextActionAt, Math.max(now, reminderAt));
      }
    }
  }
  return nextActionAt;
}

function earlier(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function scheduleRetry(): void {
  clearActionTimer();
  actionTimer = setTimeout(() => {
    actionTimer = null;
    void refreshPollSchedule();
  }, 5 * 60_000);
  actionTimer.unref();
}

function clearActionTimer(): void {
  if (actionTimer) {
    clearTimeout(actionTimer);
    actionTimer = null;
  }
}

function runDeferredRefresh(): void {
  if (!refreshAfterRun) {
    return;
  }
  refreshAfterRun = false;
  queuePollScheduleRefresh();
}
