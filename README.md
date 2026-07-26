# Discord Schedule Bot

Discord 用の日程調整 BOT です。
`/schedule` から Web 作成画面を開き、カレンダー UI で候補日を選んで Discord に投稿できます。
日程調整は自動作成された専用スレッド内で行い、投票は候補日ごとのリアクションで行います。
締切後はスレッド内に結果メッセージと投票マトリクス画像を投稿し、確定した開催情報だけ本流チャンネルへ投稿します。

## 主な機能

- `/schedule` で Web 作成画面を発行
- 日程調整ごとに専用スレッドを自動作成
- カレンダー UI で候補日を選択
- 開始時間と終了時間を候補日に自動付与
- `⭕ 参加 / ❌ 不参加 / 🔺 未定` で投票
- 1候補につき1リアクションだけになるよう補正
- 投票済みメンバー一覧をリアルタイム更新
- 締切前リマインドを複数設定可能
- 締切時に Discord リアクションを再取得して集計
- 結果通知にロールメンションと投票マトリクス画像を添付
- 日程調整結果から開催情報のまとめメッセージを投稿
- 利用総額と現地参加人数から参加費を自動計算
- 手動締切、締切延長、キャンセル、削除
- 削除時に関連 Discord メッセージも削除
- SQLite または Postgres/Neon にアンケート情報を保存
- ポケモンセンターオンラインの商品追加を定期チェックしてDiscordへ通知

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
SCHEDULE_NOTIFY_ROLE_ID=your_schedule_notify_role_id
DOCOSA_MENTION=
DOCOSA_ROLE_ID=your_docosa_role_id
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
POKEMON_PRODUCT_NOTIFY_CHANNEL_ID=1522540129879851158
POKEMON_PRODUCT_CHECK_TIMES=09:00,15:00,21:00
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
- `POKEMON_PRODUCT_NOTIFY_CHANNEL_ID`: ポケモンセンターオンラインの商品追加通知先チャンネルID
- `POKEMON_PRODUCT_CHECK_TIMES`: 商品チェック時刻。`BOT_TIMEZONE` 基準でカンマ区切り指定
- `WEB_BASE_URL`: `/schedule` で返す WebUI のURL。Renderでは省略すると `RENDER_EXTERNAL_URL` を使います
- `PERSONAL_GUILD_ID`: 個人口調と商品監視を許可する自分のサーバーID
- `MAX_OPEN_POLLS_PER_GUILD`: サーバーごとの受付中アンケート上限
- `CLOSED_POLL_RETENTION_DAYS`: 終了済みアンケートの保存日数

通知ロールの初期値はDiscord上の `/schedule-settings` で設定します。

### 3. Discord Bot 権限

Bot に以下の権限を付けてサーバーへ招待します。

- Send Messages
- Create Public Threads
- Send Messages in Threads
- Embed Links
- Attach Files
- Add Reactions
- Read Message History
- Manage Messages
- Manage Threads
- Change Nickname
- Use Slash Commands

`Manage Messages` は、同じ候補日に複数リアクションが付いたとき、BOTが余分なリアクションを外すために必要です。
`Create Public Threads` は、日程調整専用スレッドを自動作成するために必要です。
`Send Messages in Threads` は、日程調整スレッド内へ候補日や結果を投稿するために必要です。
`Manage Threads` は、アンケート削除時に日程調整スレッドごと片付けるために必要です。
`Change Nickname` は、個人サーバーでBot名を変更するために必要です。
全体メンションは送信しないため、`Mention Everyone` 権限は不要です。

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
POKEMON_PRODUCT_NOTIFY_CHANNEL_ID=1522540129879851158
POKEMON_PRODUCT_CHECK_TIMES=09:00,15:00,21:00
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

### Neon の Compute 節約

Discord BOT を動かす Render は常時起動しますが、Neon は必要なときだけ起動する構成です。

- BOT 起動時に受付中アンケートを読み込み、次のリマインドまたは締切時刻を `setTimeout` で予約します
- アンケートの作成、延長、締切、キャンセル、削除時に予約を再計算します
- 再起動時の復元に加え、取りこぼし対策として12時間ごとに予約を整合確認します
- 商品チェックは1分ごとの監視ではなく、`POKEMON_PRODUCT_CHECK_TIMES` の次回時刻へ直接予約します
- PostgreSQL 接続プールは最大2接続、アイドル接続は10秒で解放します

アンケートがない間は、商品チェックと12時間ごとの整合確認以外でDBを定期ポーリングしません。
Neon Free Plan の Scale to Zero を妨げないよう、5分未満の間隔でDBへ死活監視を行わないでください。

## コマンド

### `/schedule`

Web 作成画面のURLを返します。
リンクは30分間有効です。
WebUIから投稿すると、実行したチャンネル配下に `{タイトル} 日程調整` というスレッドを作成します。
スレッドの自動アーカイブ期間は7日を指定します。Discord側で利用できない場合は24時間へフォールバックします。

作成画面では以下を入力します。

- タイトル
- 締切日、締切時間
- 開始時間、終了時間
- リマインド時間
- 候補日

投稿例:

```text
# スレッド名: 定例会 日程調整

# 定例会 日程調整
締切: 2026-07-01(水) 23:59
ID: poll_xxx

<@&schedule_notify_role_id>
参加できる候補日にリアクションしてください。
⭕ 参加 / ❌ 不参加 / 🔺 未定
予定が変わった場合はリアクションを押し直せます。
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

アンケートを手動で締め切り、日程調整スレッドへ結果を投稿します。

結果メッセージ例:

```text
@Docosa
## 定例会 日程調整結果
投票を締め切りました。ご協力ありがとうございました。

実施候補日
> 2026-07-03(金) 13:00-18:00
参加5票、不参加1票、未定2票

詳しい投票状況は添付画像をご確認ください。
```

結果には投票者と候補日ごとの参加可否マトリクス画像が添付されます。

### `/schedule-admin extend poll_id:poll_xxx deadline:2026-07-02 23:59`

締切を延長します。

### `/schedule-admin cancel poll_id:poll_xxx`

アンケートをキャンセルします。

### `/schedule-admin delete poll_id:poll_xxx`

アンケート情報と関連 Discord メッセージを削除します。
スレッド作成後のアンケートでは、日程調整スレッドごと削除します。
すでに手動削除済みのメッセージは無視します。

### `/create-event`

Discord標準の入力画面を開き、利用総額、現地参加人数、開催場所などをまとめて入力します。各項目は任意ですが、いずれか1項目以上を入力してください。
送信後は直近100件のメッセージから日程調整結果を探し、開催情報のまとめを投稿します。
日程調整スレッド内で実行した場合、開催情報は親の本流チャンネルへ投稿します。

主な挙動:

- 入力された項目だけを開催情報に表示
- 利用総額と現地参加人数を両方入力した場合だけ、1人あたりの参加費を計算
- 日程調整結果が1件ならそのまま開催情報を投稿
- 同票などで複数候補がある場合は、実行者だけが選べるセレクトメニューを表示
- `location` は開催場所名、住所、またはURLを指定
- `venue_url` は任意。`location` にURLを入れた場合は省略できます
- `GOOGLE_MAPS_API_KEY` を設定している場合、`location` の住所から地図画像を表示します
- 地図画像そのものはDiscord仕様上Google Mapsへ直接リンクできないため、開催場所欄のURLから開けるようにします

対象メッセージを明示したい場合は、入力画面の「結果メッセージURL」に同じサーバーのメッセージURLを入力できます。

完了メッセージ例:

```text
@設定した開催情報通知ロール
開催情報が決定しました。内容をご確認ください。

[埋め込み]
右上サムネイル: カレンダーアイコン

定例会

🗓️ 開催日時: 2026-07-03(金) 13:00-18:00

💰 今回の参加費: 1,834円
🧾 利用総額 / 現地参加: 5,500円 / 3人

📍 開催場所: 会場名
          https://example.com

[地図画像]

開催情報をご確認ください。
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
- UptimeRobot の監視先はDBへアクセスしない `/healthz` を使用してください
- `DATABASE_URL` 未設定時は SQLite を使いますが、PaaS上では永続性に注意してください
- 既存アンケートの表示文言は、作成時点のメッセージが残ります。表示確認は新しいアンケートで行ってください

## 一般公開向け設定

サーバー管理者は `/schedule-settings notifications` のDiscord標準入力画面から、初回投稿、締切前リマインド、締切・集計結果、開催情報の通知ロールをまとめて設定できます。選択しなかった項目はメンションなしになります。個別に変更する場合は `/schedule-settings notify-role` も利用できます。未設定のサーバーでは通知なし・標準スタイル・個人機能OFFで動作します。

個人用のメッセージスタイル、ポケモン商品監視、サーバー固有のBot名・アイコンは、`PERSONAL_GUILD_ID`にだけ登録される `/schedule-personal` で管理します。このコマンドは一般サーバーには登録されず、実行時にもサーバーIDを検証します。プロフィールは `/schedule-personal profile` で変更できます。

Web作成画面には、そのチャンネルでBotが通知できる通常ロールだけが表示されます。ロール自体がメンション可能、またはBotに「@everyone、@here、すべてのロールにメンション」権限がある場合に選択できます。自由入力のメンション、`@everyone`、`@here` は送信しません。Web作成リンクはDBへハッシュ化して保存され、30分で失効します。

公開前の確認事項は [限定公開チェックリスト](docs/PUBLIC_RELEASE_CHECKLIST.md)、データの扱いは [プライバシーポリシー](docs/PRIVACY.md)、利用条件は [利用規約](docs/TERMS.md) を参照してください。
