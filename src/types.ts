export type PollStatus = "open" | "closed" | "cancelled";
export type VoteStatus = "yes" | "maybe" | "no";

export type Poll = {
  id: string;
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  messageId: string | null;
  voterMessageId: string | null;
  creatorId: string;
  title: string;
  deadline: string;
  timezone: string;
  notifyTarget: string | null;
  initialNotifyRoleId: string | null;
  reminderNotifyRoleId: string | null;
  eventNotifyRoleId: string | null;
  multipleChoice: boolean;
  anonymous: boolean;
  reminderMinutes: string;
  remindedMinutes: string;
  status: PollStatus;
  remindedHours: string;
  createdAt: string;
  closedAt: string | null;
};

export type MessageStyle = "standard" | "personal";

export type GuildSettings = {
  guildId: string;
  timezone: string;
  messageStyle: MessageStyle;
  defaultInitialNotifyRoleId: string | null;
  defaultReminderNotifyRoleId: string | null;
  defaultResultNotifyRoleId: string | null;
  defaultEventNotifyRoleId: string | null;
  allowEveryoneMentions: boolean;
  pokemonWatcherEnabled: boolean;
  pokemonNotifyChannelId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebSession = {
  tokenHash: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
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

export type PokemonProduct = {
  sourceKey: string;
  productKey: string;
  name: string;
  url: string;
  price: string | null;
  status: string | null;
  imageUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type PokemonProductInput = Omit<PokemonProduct, "firstSeenAt" | "lastSeenAt">;
