# kyoto-land-tracker

京都市11区 + 八幡市 の土地物件を SUUMO / athome / 不動産ジャパン から自動取得し、条件フィルタ・重複排除・運転時間付きで一覧化する。

## 閲覧

**https://bjork999.github.io/kyoto-land-tracker/**

## 条件

- エリア: 京都市11区 + 八幡市
- 価格: 100万 〜 2000万円
- 土地面積: 109m² (33坪) 以上
- 起点: 京都府京都市伏見区下鳥羽南円面田町52
- 運転時間: OSRM 推定 (渋滞・信号待ち除外)
- NEW 保持期間: 3日

## 動作

- GitHub Actions が毎日 12:00 / 17:00 JST に自動実行
- Actions タブから手動実行可 (`workflow_dispatch`)
- スクレイプ → フィルタ → ジオコード (GSI) → OSRM → 重複排除 → HTML 生成
- 変更があれば `index.html` と `known_ids.json` をコミット
- GitHub Pages にデプロイ

## 手動実行

ローカルで:

```bash
npm install
npm run scrape
```

## ファイル

- `scripts/scrape.mjs` — スクレイパ本体
- `index.html` — 出力 (Actions が更新)
- `known_ids.json` — 物件ID + 初出日の追跡 (NEW判定用)
- `.github/workflows/daily.yml` — cron 実行
- `.github/workflows/deploy-pages.yml` — Pages デプロイ
