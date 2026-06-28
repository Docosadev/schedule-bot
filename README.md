# Discord Schedule Bot

Discord 用の日程調整 BOT です。
`/schedule` から Web 作成画面を開き、カレンダー UI で候補日を選んで Discord に投稿できます。
投票は候補日ごとのリアクションで行い、締切後は結果メッセージと投票マトリクス画像を投稿します。

## 主な機能

- `/schedule` で Web 作成画面を発行
- カレンダー UI で候補日を選択
- 開始時間と終了時間を候補日に自動付与
- `⭕ 参加 / ❌ 不参加 / 🔺 未定（行けたら行く）` で投票
- 1候補につき1リアクションだけになるよう補正
- 投票済みメンバー一覧をリアルタイム更新
- 締切前リマインドを複数設定可能
- 締切時に Discord リアクションを再取得して集計
- 結果通知にロールメンションと投票マトリクス画像を添付
- 日程調整結果から開催情報のまとめメッセージを投稿
- 開催情報から `.ics` 形式のカレンダー追加ボタンを表示
- 利用総額と現地参加人数から参加費を自動計算
- 手動締切、締切延長、キャンセル、削除
- 削除時に関連 Discord メッセージも削除
- SQLite または Postgres/Neon にアンケート情報を保存

## セットアップ

### 1. 依存関係

```bash
npm install
```

### 2. 環境変数

`.env.example` を参考に `.env` を作成します。

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_server_id
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
DATABASE_PATH=./data/schedule-bot.sqlite
BOT_TIMEZONE=Asia/Tokyo
REMINDER_HOURS_BEFORE=24,3
DOCOSA_MENTION=
DOCOSA_ROLE_ID=your_docosa_role_id
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
WEB_PORT=3000
WEB_HOST=0.0.0.0
WEB_BASE_URL=http://localhost:3000
```

主な設定:

- `DISCORD_TOKEN`: Discord Bot Token
- `DISCORD_CLIENT_ID`: Discord Application Client ID
- `DISCORD_GUILD_ID`: コマンド登録先サーバーID。設定すると反映が速いギルドコマンドになります
- `DATABASE_URL`: Neon などの Postgres 接続文字列。本番運用では設定推奨です
- `DATABASE_PATH`: `DATABASE_URL` 未設定時の SQLite 保存先
- `DOCOSA_ROLE_ID`: 結果通知でメンションするロールID
- `GOOGLE_MAPS_API_KEY`: 開催情報にGoogle Static Maps画像を表示する場合に設定
- `WEB_BASE_URL`: `/schedule` で返す WebUI のURL。Renderでは省略すると `RENDER_EXTERNAL_URL` を使います

`DOCOSA_ROLE_ID` を使う場合、対象ロールがメンション可能になっているか、BOTに十分な権限があることを確認してください。

### 3. Discord Bot 権限

Bot に以下の権限を付けてサーバーへ招待します。

- Send Messages
- Embed Links
- Add Reactions
- Read Message History
- Manage Messages
- Mention Everyone
- Use Slash Commands

`Manage Messages` は、同じ候補日に複数リアクションが付いたとき、BOTが余分なリアクションを外すために必要です。
`Mention Everyone` は、開催情報の確定通知で `@everyone` を送るために必要です。

### 4. コマンド登録

```bash
npm run commands:register
```

コマンド定義を変更した場合も、再度このコマンドを実行してください。

### 5. 起動

開発時:

```bash
npm run dev
```

本番相当:

```bash
npm run build
npm start
```

## Render デプロイ

Render では Web Service として起動します。
このプロジェクトは 1つの Node.js プロセスで Discord BOT と WebUI の両方を動かします。

推奨設定:

```text
Runtime: Node
Build Command: npm install && npm run build
Start Command: npm start
Instance Type: Free
```

Render 環境変数の例:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_server_id
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
BOT_TIMEZONE=Asia/Tokyo
DOCOSA_ROLE_ID=your_docosa_role_id
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
WEB_HOST=0.0.0.0
```

Renderでは `WEB_PORT` は省略して問題ありません。Renderが設定する `PORT` を使います。
`WEB_BASE_URL` も通常は省略できます。独自ドメインを使う場合だけ明示してください。

### UptimeRobot

Render無料枠のスリープ対策として、UptimeRobot などで以下を監視します。

```text
https://your-render-service.onrender.com/healthz
```

推奨:

```text
Monitor Type: HTTP(s)
Interval: 5 minutes
```

`/healthz` は Web プロセスの生存確認です。
Discord 接続完了まで確認したい場合は `/readyz` も使えますが、スリープ復帰直後はDown判定されやすいため、監視URLは `/healthz` 推奨です。

## コマンド

### `/schedule`

Web 作成画面のURLを返します。
リンクは30分間有効です。

作成画面では以下を入力します。

- タイトル
- 締切日、締切時間
- 開始時間、終了時間
- リマインド時間
- 候補日

投稿例:

```text
# 定例会 日程調整
締切: 2026-07-01(水) 23:59
ID: poll_xxx

@everyone
下記の候補日に、参加できるかをリアクションで教えてほしいのじゃ。
⭕ 参加 / ❌ 不参加 / 🔺 未定（行けたら行く）
予定が変わったら、リアクションを押し直してよいぞ。
```

候補日は個別メッセージとして投稿されます。

```text
> ## 2026-07-03(金) 13:00-18:00
```

### `/schedule-admin list`

受付中のアンケート一覧を表示します。

### `/schedule-admin show poll_id:poll_xxx`

アンケートの詳細を表示します。

### `/schedule-admin voters poll_id:poll_xxx`

投票者一覧を表示します。

### `/schedule-admin close poll_id:poll_xxx`

アンケートを手動で締め切り、結果を投稿します。

結果メッセージ例:

```text
@Docosa
# 定例会 日程調整結果
投票はここで締め切りじゃ。みんな、協力ありがとう。

## 実施候補
> ## 2026-07-03(金) 13:00-18:00
〇 参加 5票

くわしい投票状況は、添付の画像にまとめておいたぞ。
```

結果には投票者と候補日ごとの参加可否マトリクス画像が添付されます。

### `/schedule-admin extend poll_id:poll_xxx deadline:2026-07-02 23:59`

締切を延長します。

### `/schedule-admin cancel poll_id:poll_xxx`

アンケートをキャンセルします。

### `/schedule-admin delete poll_id:poll_xxx`

アンケート情報と関連 Discord メッセージを削除します。
すでに手動削除済みのメッセージは無視します。

### `/create-event price:5500 attendees:3 location:会場名 venue_url:https://example.com`

直近100件のメッセージから日程調整結果を探し、開催情報のまとめを投稿します。

主な挙動:

- `price / attendees` を切り上げて参加費を計算
- 日程調整結果が1件ならそのまま開催情報を投稿
- 同票などで複数候補がある場合は、実行者だけが選べるセレクトメニューを表示
- `location` は開催場所名、住所、またはURLを指定
- `venue_url` は任意。`location` にURLを入れた場合は省略できます
- `GOOGLE_MAPS_API_KEY` を設定している場合、`location` の住所から地図画像を表示します
- 地図画像そのものはDiscord仕様上Google Mapsへ直接リンクできないため、開催場所欄のURLから開けるようにします
- 開催情報には `📅 カレンダーに追加` ボタンが付き、端末の標準カレンダーで予定作成画面を開けます

対象メッセージを明示したい場合は `message_url` を指定できます。

```text
/create-event price:5500 attendees:3 location:会場名 venue_url:https://example.com message_url:https://discord.com/channels/...
```

完了メッセージ例:

```text
@everyone
開催情報が確定したぞ。確認しておくんじゃ。

[埋め込み]
右上サムネイル: カレンダーアイコン

定例会

🗓️ 開催日時: 2026-07-03(金) 13:00-18:00
💰 今回の参加費: 1,834円
🧾 利用総額 / 現地参加: 5,500円 / 3人
📍 開催場所: 会場名
          https://example.com

[地図画像]

[📅 カレンダーに追加]

みんなもポケモン、ゲットじゃぞ～！
```

## 動作確認

1. `.env` を設定する
2. `npm run commands:register` を実行する
3. `npm run dev` または `npm start` で起動する
4. Discordで `/schedule` を実行する
5. WebUIからアンケートを投稿する
6. 候補日に `⭕ / ❌ / 🔺` を付ける
7. 投票済みメッセージが更新されることを確認する
8. `/schedule-admin close` で結果と画像を確認する
9. `/create-event` で開催情報のまとめが投稿されることを確認する

## 注意点

- Bot Token や `.env` は GitHub に push しないでください
- Render無料枠ではスリープや再起動が発生します
- 本番運用では `DATABASE_URL` に Neon などの外部 Postgres を設定してください
- `DATABASE_URL` 未設定時は SQLite を使いますが、PaaS上では永続性に注意してください
- 既存アンケートの表示文言は、作成時点のメッセージが残ります。表示確認は新しいアンケートで行ってください
