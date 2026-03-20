# Tenjo Desktop

複数のAIプロバイダー（LM Studio、Ollama）とMCP（Model Context Protocol）に対応したデスクトップAIチャットアプリです。

## ダウンロード

[Releases](https://github.com/netalkGB/tenjo-desktop/releases)ページから最新版をダウンロードしてください。

## FAQ

**AIプロバイダーへの接続方法は？**
設定画面からプロバイダーのエンドポイントを追加してください。

**画像を含むプロンプトがうまく動かない**
接続先のモデルがビジョンに対応している必要があります。画像を使用する場合はビジョン対応モデルを使用してください。

**MCPのツールが動かない**
接続先のモデルがfunction callingに対応している必要があります。対応していないモデルではツール呼び出しは機能しません。対応していても、モデルの性能によってはうまく呼び出せないことがあります。

## ライセンス

[MIT](LICENSE) &copy; netalkGB
