type RefreshHandler = () => void;

let pollScheduleRefreshHandler: RefreshHandler | null = null;

export function registerPollScheduleRefresh(handler: RefreshHandler): void {
  pollScheduleRefreshHandler = handler;
}

export function requestPollScheduleRefresh(): void {
  pollScheduleRefreshHandler?.();
}
