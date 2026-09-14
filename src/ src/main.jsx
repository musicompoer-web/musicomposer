import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import PrivacyPage from './PrivacyPage.jsx';
import './index.css';

const isPrivacyPage = window.location.pathname.replace(/\/+$/, '') === '/privacy';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isPrivacyPage ? <PrivacyPage /> : <App />}
  </React.StrictMode>
);
