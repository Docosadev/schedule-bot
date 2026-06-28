export type PollStatus = "open" | "closed" | "cancelled";
export type VoteStatus = "yes" | "maybe" | "no";

export type Poll = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  voterMessageId: string | null;
  creatorId: string;
  title: string;
  deadline: string;
  notifyTarget: string | null;
  multipleChoice: boolean;
  anonymous: boolean;
  reminderMinutes: string;
  remindedMinutes: string;
  status: PollStatus;
  remindedHours: string;
  createdAt: string;
  closedAt: string | null;
};

export type PollOption = {
  id: string;
  pollId: string;
  messageId: string | null;
  position: number;
  emoji: string;
  startsAt: string;
  label: string;
};

export type Vote = {
  pollId: string;
  optionId: string;
  userId: string;
  status: VoteStatus;
  createdAt: string;
};

export type PollWithOptions = Poll & {
  options: PollOption[];
};
