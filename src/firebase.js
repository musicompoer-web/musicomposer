import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// 這組設定不是機密資料，可以放心留在程式碼裡（Firebase 官方文件也是這樣建議）。
// 真正的安全防線是 Firestore 的權限規則，不是隱藏這幾個欄位。
const firebaseConfig = {
  apiKey: 'AIzaSyCVDN74-_MkjXqkMUy_TBFFl9OAvmJImBo',
  authDomain: 'musicomposer-59b8a.firebaseapp.com',
  projectId: 'musicomposer-59b8a',
  storageBucket: 'musicomposer-59b8a.firebasestorage.app',
  messagingSenderId: '1078555912289',
  appId: '1:1078555912289:web:59c2420278ba29ebc5e220',
  measurementId: 'G-Z3YSSN3HKJ',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
