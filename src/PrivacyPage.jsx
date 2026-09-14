import React from 'react';

export default function PrivacyPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#1B1F2A',
      color: '#F2EFE9',
      fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif",
      padding: '48px 24px',
    }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <h1 style={{ fontSize: 24, marginBottom: 24 }}>隱私權政策</h1>

        <p style={{ color: '#A9AFC3', lineHeight: 1.8, marginBottom: 16 }}>
          「音樂創作課」是一個給高中生使用的音樂創作教學工具。這裡說明我們如何處理你的資料。
        </p>

        <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>我們收集什麼資料</h2>
        <p style={{ color: '#A9AFC3', lineHeight: 1.8, marginBottom: 16 }}>
          當你使用 Google 帳號登入時，我們會取得你的姓名與電子郵件地址，用來識別你的帳號。
          我們也會儲存你在平台上建立的內容，例如和弦進行、旋律，以及各章節的學習進度。
        </p>

        <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>資料用途</h2>
        <p style={{ color: '#A9AFC3', lineHeight: 1.8, marginBottom: 16 }}>
          這些資料只用來讓你登入後能看到、編輯自己先前儲存的創作內容，不會用於廣告，
          也不會分享或販售給第三方。
        </p>

        <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>資料保存與刪除</h2>
        <p style={{ color: '#A9AFC3', lineHeight: 1.8, marginBottom: 16 }}>
          資料會保存在你的帳號底下，直到你要求刪除為止。如果想刪除你的資料，請透過下方聯絡方式與我們聯繫。
        </p>

        <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>聯絡我們</h2>
        <p style={{ color: '#A9AFC3', lineHeight: 1.8 }}>
          如有任何關於資料使用的問題，歡迎透過你登入時使用的管道聯繫平台管理者。
        </p>
      </div>
    </div>
  );
}
