# 音樂創作課平台

給高中生的歌曲創作教學工具：歌曲架構分析、歌詞創作、和弦進行、旋律寫作，接上 Google 登入，每個帳號的作品各自儲存。

## 本機測試

需要先安裝 [Node.js](https://nodejs.org/)（建議 18 以上版本）。

```bash
npm install
npm run dev
```

打開終端機顯示的網址（通常是 http://localhost:5173）就能看到畫面。

## 部署前，還要在 Firebase 做一件事

### 設定 Firestore 安全規則

到 Firebase Console → Firestore Database → 規則分頁，貼上這個專案裡 `firestore.rules` 的內容再發布。
這條規則的意思是：每個人只能讀寫自己帳號底下的資料，不能看到別人的作品。

## 部署到 Vercel

1. 把這個資料夾推到一個 GitHub repository
2. 到 [vercel.com](https://vercel.com) 用 GitHub 帳號登入，選擇「Import Project」，選這個 repository
3. Vercel 會自動偵測到這是 Vite 專案，框架設定不用改，直接按 Deploy
4. 部署完成後會拿到一個網址（例如 `your-project.vercel.app`），這個就是可以分享出去的網址

### 重要：把 Vercel 網域加進 Firebase 的授權網域

到 Firebase Console → Authentication → Settings →「Authorized domains」，把 Vercel 給的網域加進去（例如 `your-project.vercel.app`）。
沒加的話，Google 登入在正式網址上會失敗（本機測試用的 `localhost` Firebase 預設就有加，所以本機測試不會遇到這個問題）。

## 部署完成後，回到 Google Cloud 補「品牌」資料

拿到 Vercel 網址之後，回到 Google Cloud Console →「Google Auth Platform」→「品牌」，把還缺的欄位補上：

- **應用程式首頁連結**：填你的 Vercel 網址，例如 `https://your-project.vercel.app`
- **隱私權政策連結**：填 `https://your-project.vercel.app/privacy`（這個頁面已經包含在專案裡了，`src/PrivacyPage.jsx`）
- **服務條款連結**：可以先留空，或跟隱私權政策填同一個網址

補完之後回到「目標對象」頁面，「發布應用程式」按鈕就會從灰色變成可以按，點下去確認就完成了。

## 之後要調整內容

課程內容（章節文字、範例歌曲、和弦範本）都在 `src/App.jsx` 裡，直接找對應的區塊修改文字即可，不需要改動 Firebase 或部署設定的部分。
