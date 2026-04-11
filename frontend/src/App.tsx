import TempMail from './components/TempMail';

export default function App() {
  return (
    <main className="simple-shell">
      <header className="simple-header">
        <div>
          <p className="eyebrow">gradaide.xyz</p>
          <h1>Mailhouse 信箱中心</h1>
          <p className="subtitle">只保留兩個核心功能：`10 分鐘信箱` 與 `保留信箱`，透過上方 navbar 快速切換。</p>
        </div>
        <span className="topbar-badge">Cloudflare + Firestore</span>
      </header>

      <TempMail />
    </main>
  );
}
