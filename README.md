# Discord Schedule Bot

Discord 用の日程調整 BOT です。
スラッシュコマンドで候補日を作成し、リアクションで投票できます。
締切後は自動集計し、指定したユーザーまたはロールへメンションして結果を通知します。

## 主な機能

- `/schedule` でWeb作成画面を開く
- 候補ごとの独立メッセージに `○ / × / △` リアクションで投票
- リアクションの押し直しに対応
- 投票数はDiscordのリアクション数で確認
- 末尾に投票済みメンバー一覧をリアルタイム表示
- 締切後に自動集計して通知
- 締切時にDiscordリアクションを再取得して投票結果を補正
- 締切後に追加されたリアクションは自動で取り消し
- アンケートごとの締切前リマインド
- 投票者一覧
- 匿名表示モード
- 手動締切、締切延長、キャンセル、削除
- 削除時は関連するDiscordメッセージも削除
- 候補日ごとの個別メッセージは通知を抑制
- SQLiteまたはPostgres/Neonにアンケート情報を保存

## セットアップ

### 1. 依存関係をインストール

```bash
npm install
```

### 2. 環境変数を作成

`.env.example` を参考に `.env` を作成します。

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_test_guild_id
DATABASE_URL=
DATABASE_PATH=./data/schedule-bot.sqlite
BOT_TIMEZONE=Asia/Tokyo
REMINDER_HOURS_BEFORE=24,3
DOCOSA_MENTION=
WEB_PORT=3000
WEB_HOST=0.0.0.0
WEB_BASE_URL=http://localhost:3000
```

`DISCORD_GUILD_ID` を設定すると、そのサーバーだけにコマンドを登録します。
検証中はこちらが反映も速くおすすめです。
未設定の場合はグローバルコマンドとして登録します。

`DOCOSA_MENTION` は任意です。
未設定の場合はサーバー内の `Docosa` ロールを探してメンションします。
ユーザーや別ロールを確実にメンションしたい場合は、`<@ユーザーID>` または `<@&ロールID>` を設定してください。

`DATABASE_URL` は任意です。
NeonなどのPostgresを使う場合は接続文字列を設定してください。
未設定の場合は `DATABASE_PATH` のSQLiteファイルを使います。

`WEB_BASE_URL` は `/schedule` で返す作成画面URLです。
ローカル検証では `http://localhost:3000` で動きます。
他の端末や外部メンバーにも使わせる場合は、トンネルやデプロイ先のURLに変更してください。
Renderにデプロイする場合は、未設定ならRenderの自動環境変数 `RENDER_EXTERNAL_URL` を使います。

`WEB_HOST=0.0.0.0` にすると、同じLAN内の別デバイスからもWeb作成画面へアクセスできます。

### 3. Discord Developer Portal の設定

Bot に以下の権限を付けてサーバーへ招待してください。

- Send Messages
- Embed Links
- Add Reactions
- Read Message History
- Manage Messages
- Use Slash Commands

`Manage Messages` は、同じ候補日に `⭕ / ❌ / 🔺` が複数付いたとき、BOTが余分なリアクションを外すために必要です。

Privileged Gateway Intents は通常不要です。
この BOT はリアクションイベントとスラッシュコマンドを使います。

### 4. スラッシュコマンドを登録

```bash
npm run commands:register
```

### 5. BOT を起動

```bash
npm run dev
```

本番運用では以下を使います。

```bash
npm run build
npm start
```

## 他の人に使ってもらう

同じDiscordサーバーの他メンバーに使ってもらう場合、BOT本体とWeb作成画面の両方が動いている必要があります。

### 重要: `localhost` のままでは他の人は開けません

`.env` の `WEB_BASE_URL` が以下のままだと、作成画面はBOTを動かしているPC本人からしか開けません。

```env
WEB_BASE_URL=http://localhost:3000
```

他の人にも `/schedule` の作成画面を開いてもらうには、`WEB_BASE_URL` を他の人のブラウザからアクセスできるURLに変更してください。

例:

```env
WEB_BASE_URL=https://your-public-url.example
```

公開方法の選択肢:

- 同じLAN内だけで使う: BOTを動かしているPCのLAN内IPを使う
- インターネット越しに使う: トンネル、リバースプロキシ、VPS、PaaSなどで公開URLを用意する
- 安定運用する: PCではなく常時起動できるサーバーで `npm start` を動かす

### 公開前チェック

1. `.env` の `WEB_BASE_URL` を公開URLにする
2. `npm run commands:register` を実行する
3. `npm run build` を実行する
4. `npm start` でBOTを起動する
5. Discordで `/schedule` を実行する
6. 返ってきたURLを別の端末や別の人に開いてもらう
7. 作成したアンケートがDiscordに投稿されることを確認する

`DISCORD_GUILD_ID` を設定している場合、コマンドはそのサーバーだけに登録されます。
複数サーバーで使う場合は、`DISCORD_GUILD_ID` を外してグローバルコマンドとして登録するか、サーバーごとに登録方針を調整してください。

### LAN内で別デバイスから確認する

同じWi-Fiや有線LAN内だけで確認する場合は、PCのLAN内IPを `WEB_BASE_URL` に設定します。

例:

```env
WEB_PORT=3000
WEB_HOST=0.0.0.0
WEB_BASE_URL=http://100.64.1.25:3000
```

その後、BOTを再起動してDiscordで `/schedule` を実行します。
返ってきたURLをスマホや別PCで開ければOKです。

開けない場合は以下を確認してください。

- BOTを起動しているPCと確認用デバイスが同じネットワークにいる
- `npm run dev` または `npm start` が起動したままになっている
- Windows Defender ファイアウォールが Node.js の通信をブロックしていない
- URLのIPアドレスが現在のPCのIPアドレスと一致している

## Renderで無料枠デプロイを試す

Renderにデプロイする場合は、GitHubリポジトリからWeb Serviceとして起動します。
このBOTは1つのNode.jsプロセスでDiscord BOTとWebUIの両方を動かします。

### Renderの設定

Renderで新しいWeb Serviceを作成し、GitHubリポジトリを選択します。

推奨設定:

```text
Runtime: Node
Build Command: npm install && npm run build
Start Command: npm start
Instance Type: Free
```

環境変数:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_server_id
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
BOT_TIMEZONE=Asia/Tokyo
REMINDER_HOURS_BEFORE=24,3
DOCOSA_MENTION=
WEB_HOST=0.0.0.0
```

`DATABASE_URL` にはNeonの接続文字列を設定します。
`DATABASE_URL` を設定した場合、`DATABASE_PATH` は不要です。

Renderでは `WEB_BASE_URL` は初回から省略できます。
省略した場合、Renderが自動で用意する `RENDER_EXTERNAL_URL` を使って `/schedule` の作成画面URLを生成します。
`WEB_PORT` も省略し、Renderが自動で設定する `PORT` を使います。
独自ドメインなどに変えたい場合だけ、`WEB_BASE_URL=https://your-domain.example` を追加してください。

### UptimeRobotでスリープ対策

Renderの無料Web Serviceは無通信が続くとスリープするため、UptimeRobotなどでヘルスチェックURLを定期的に叩きます。

監視URL:

```text
https://your-render-service.onrender.com/healthz
```

推奨:

```text
Monitor Type: HTTP(s)
Interval: 5 minutes
```

`/healthz` はWebプロセスが起きているかだけを確認する軽い監視用URLです。
Discord接続完了まで含めて確認したい場合は `/readyz` を使えますが、Renderのスリープ復帰直後にDown判定されやすいため、UptimeRobotでは `/healthz` を推奨します。
トップページではなく、必ず `/healthz` まで含めたURLを監視してください。

### Render無料枠での注意点

- 無料Web Serviceはスリープするため、起動直後の反応が遅くなることがある
- `DATABASE_URL` を設定しない場合、ローカルSQLiteの永続性に不安がある
- `DATABASE_URL` を設定しない場合、再デプロイや再起動で `./data/schedule-bot.sqlite` が失われる可能性がある
- 長期運用でデータを確実に残すならNeonなどの外部Postgresを使う
- BOTトークンや `.env` はGitHubにpushしない

## Koyebで無料枠デプロイを試す

Koyebにデプロイする場合は、GitHubリポジトリからWeb Serviceとして起動します。
このBOTは1つのNode.jsプロセスでDiscord BOTとWebUIの両方を動かします。

### 事前準備

1. GitHubにリポジトリを作る
2. このプロジェクトをpushする
3. `.env` はpushしない
4. Discord Developer Portalで、必要ならBOTトークンを再発行する
5. ローカルで `npm run commands:register` を実行してDiscordコマンドを登録する

### Koyebの設定

Koyebで新しいAppまたはServiceを作成し、GitHubリポジトリを選択します。

推奨設定:

```text
Service type: Web Service
Builder: Buildpack
Build command: npm run build
Run command: npm start
Instance: Free
Port: 3000
```

環境変数:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_server_id
DATABASE_PATH=./data/schedule-bot.sqlite
BOT_TIMEZONE=Asia/Tokyo
REMINDER_HOURS_BEFORE=24,3
DOCOSA_MENTION=
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_BASE_URL=https://your-koyeb-url
```

最初のデプロイ時点ではKoyebのURLがまだ分からないため、仮の `WEB_BASE_URL` で一度デプロイします。
デプロイ後、KoyebのService画面に表示される公開URLをコピーし、`WEB_BASE_URL` に設定して再デプロイしてください。

### UptimeRobotでスリープ対策

Koyeb Free Instanceは無通信が続くとscale downするため、UptimeRobotなどでヘルスチェックURLを定期的に叩きます。

監視URL:

```text
https://your-koyeb-url/healthz
```

推奨:

```text
Monitor Type: HTTP(s)
Interval: 5 minutes
```

### Koyeb無料枠での注意点

- Free Instanceはリソースが小さいため、まずは小規模運用向け
- 無料枠ではローカルSQLiteの永続性に不安がある
- 再デプロイや再起動で `./data/schedule-bot.sqlite` が失われる可能性がある
- 長期運用でデータを確実に残すなら外部DB化を検討する
- BOTトークンや `.env` はGitHubにpushしない

## コマンド

### アンケート作成

```text
/schedule
```

BOTが作成画面URLを返します。
ブラウザで開くと、カレンダーUIで候補日を選択できます。
開始時間と終了時間に入力した時間帯が、選択したすべての日付へ自動で付きます。
開始時間の初期値は `13:00`、終了時間の初期値は `18:00` です。
リマインドは `24時間前`、`12時間前`、`1時間前`、`30分前`、`15分前`、`10分前` から複数選択できます。
初期状態では `24時間前` が1件設定されています。

投稿イメージ:

```text
# 日程調整: 定例会の日程調整
締切: 2026-07-01(水) 23:59
ID: poll_xxx

@everyone
下記の候補日に参加可否を⭕ / ❌ / 🔺で投票してください。

> ## 2026-07-03(金) 20:00

投票済み：まだ誰も投票していません。
```

例:

```text
開始時間: 13:00
終了時間: 18:00
選択日: 2026-07-03, 2026-07-04
リマインド: 24時間前, 30分前
```

作成される候補:

```text
2026-07-03 13:00-18:00
2026-07-04 13:00-18:00
```

リンクは30分間有効です。

### 一覧

```text
/schedule-admin list
```

### 詳細

```text
/schedule-admin show poll_id:poll_xxx
```

### 投票者一覧

```text
/schedule-admin voters poll_id:poll_xxx
```

匿名表示モードで作成したアンケートでは投票者一覧を表示しません。

### 手動締切

```text
/schedule-admin close poll_id:poll_xxx
```

結果メッセージ例:

```text
@Docosa
# 日程調整結果: 定例会の日程調整
投票が締め切られました。

## 実施候補
> ## 2026-07-03(金) 20:00
○ 5票

## 全結果
1. 2026-07-03(金) 20:00　○ 5票
2. 2026-07-04(土) 21:00　○ 3票
```

### 締切延長

```text
/schedule-admin extend poll_id:poll_xxx deadline:2026-07-02 23:59
```

### キャンセル

```text
/schedule-admin cancel poll_id:poll_xxx
```

### 削除

```text
/schedule-admin delete poll_id:poll_xxx
```

アンケート本体、候補日メッセージ、投票済みメッセージをまとめて削除します。
既に手動で消されているメッセージは無視します。

## 動作検証の流れ

1. `.env` に検証用サーバーの `DISCORD_GUILD_ID` を入れる
2. `npm run commands:register` を実行
3. `npm run dev` で起動
4. Discord で `/schedule` を実行
5. BOT が投稿した候補ごとのメッセージに `⭕ / ❌ / 🔺` リアクションを押す
6. Discordのリアクション数が増減することを確認
7. `/schedule-admin voters` で投票者一覧を確認
8. `/schedule-admin close` で手動集計を確認

コマンドの説明や選択肢を変更した場合は、BOTを起動し直すだけでなく、もう一度 `npm run commands:register` を実行してください。
既存のアンケートは古い表示のままなので、表示確認は新しく `/schedule` で作成してください。

コマンド体系を変更した後は、必ず `npm run commands:register` を実行してください。

## 注意点

Renderなどの無料ホスティングではスリープや再起動が発生することがあります。
リマインドは1分ごとの定期チェックで送信するため、無料枠のスリープ復帰直後は多少遅れる可能性があります。
