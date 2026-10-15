import assert from "node:assert/strict";
import test from "node:test";
import { Collection, ModalSubmitFields } from "discord.js";

process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_CLIENT_ID = "test-client";
const { handleCreateEventModal, CREATE_EVENT_MODAL_ID } = await import("../dist/eventService.js");

function fixture(channelValue = "", channels = []) {
  const calls = [];
  const values = {
    event_price: "4,719", event_attendees: "4", event_address: "テスト会場",
    event_channel: channelValue, event_custom_message: ""
  };
  const result = { author: { bot: true }, content:
    "## テスト 日程調整結果\n> 2026-10-20(火) 12:00-14:00\n> 2026-10-21(水) 12:00-14:00" };
  const interaction = {
    id: "test-interaction", createdTimestamp: Date.now(), customId: CREATE_EVENT_MODAL_ID,
    guildId: "test-guild", user: { id: "test-user" },
    guild: { members: { me: {} }, channels: { fetch: async (id) => {
      calls.push("channels");
      return id ? channels.find(c => c.id === id) : new Collection(channels.map(c => [c.id, c]));
    } } },
    memberPermissions: { has: () => { calls.push("permissions"); return true; } },
    channel: { send() {}, permissionsFor: () => ({ has: () => true }), messages: {
      fetch: async () => { calls.push("messages"); return new Collection([["result", result]]); }
    } },
    fields: new ModalSubmitFields(Object.entries(values).map(([customId, value]) => ({
      type: 1, components: [{ type: 4, customId, value }]
    }))),
    deferReply: async () => { calls.push("ack"); },
    editReply: async (reply) => { calls.push("reply"); interaction.lastReply = reply; }
  };
  return { interaction, calls };
}

for (const blank of ["", "　 \n "]) {
  test(`comma price and blank optional channel (${JSON.stringify(blank)}) reach candidate selection`, async () => {
    const { interaction, calls } = fixture(blank);
    await handleCreateEventModal(interaction);
    assert.equal(calls[0], "ack");
    assert.equal(calls.includes("channels"), false);
    assert.equal(interaction.lastReply.components[0].toJSON().components[0].options.length, 2);
  });
}

const channel = { id: "123456789012345678", name: "一般", isTextBased: () => true, isVoiceBased: () => false };
for (const value of ["#一般", "一般", `<#${channel.id}>`, channel.id]) {
  test(`channel ${value} resolves after acknowledgement`, async () => {
    const { interaction, calls } = fixture(value, [channel]);
    await handleCreateEventModal(interaction);
    assert.equal(calls[0], "ack");
    assert.ok(calls.includes("messages"));
    assert.ok(interaction.lastReply.components);
  });
}

test("invalid channel returns actionable error after acknowledgement", async () => {
  const { interaction, calls } = fixture("存在しないチャンネル");
  await handleCreateEventModal(interaction);
  assert.equal(calls[0], "ack");
  assert.match(interaction.lastReply, /チャンネルが見つかりません/);
  assert.equal(calls.includes("messages"), false);
});

test("ambiguous channel names are not silently selected", async () => {
  const { interaction } = fixture("#一般", [channel, { ...channel, id: "223456789012345678" }]);
  await handleCreateEventModal(interaction);
  assert.match(interaction.lastReply, /同名のチャンネルが複数/);
});

test("validation and permission failures are reported after acknowledgement", async () => {
  const { interaction, calls } = fixture();
  interaction.memberPermissions.has = () => false;
  await handleCreateEventModal(interaction);
  assert.equal(calls[0], "ack");
  assert.match(interaction.lastReply, /権限/);
});

test("missing result message is reported after acknowledgement", async () => {
  const { interaction, calls } = fixture();
  interaction.channel.messages.fetch = async () => new Collection();
  await handleCreateEventModal(interaction);
  assert.equal(calls[0], "ack");
  assert.match(interaction.lastReply, /日程調整結果が見つかりません/);
});
